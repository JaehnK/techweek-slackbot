// techweek-slackbot: 1개 파일로 동작하는 Slack 봇
// 테크위크 이벤트 신청 현황을 Claude로 파싱해 Postgres에 저장하고, 슬래시 커맨드로 조회한다.
//
// 필요한 환경변수:
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, DATABASE_URL, ANTHROPIC_API_KEY, PORT(선택)

require('dotenv').config();

const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const { fmtWhen, buildScheduleText, buildEventStatsText, dedupKey } = require('./format');
const { initSchema } = require('./schema');

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`⚠️ 누락된 환경변수: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const MAX_INPUT_LENGTH = 50000; // Luma 메인 페이지 전체 복붙(여러 주 분량)까지 허용
const CLAUDE_MODEL = 'claude-haiku-4-5';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  // Railway 헬스체크용 GET /health (Bolt v4 기본 HTTPReceiver의 customRoutes)
  customRoutes: [
    {
      path: '/health',
      method: ['GET'],
      handler: (req, res) => {
        res.writeHead(200);
        res.end('ok');
      },
    },
  ],
});


// ---------- 2. Claude로 파싱 (structured outputs) ----------
const EVENT_LIST_SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          host: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          event_date: { type: ['string', 'null'], description: 'YYYY-MM-DD 형식. 연도가 없으면 2026년으로 추정' },
          event_time: { type: ['string', 'null'], description: 'HH:MM (24시간제) 형식' },
          luma_url: { type: ['string', 'null'] },
          status: { type: 'string', description: '예: 참석, 승인 대기 중' },
        },
        required: ['title', 'host', 'location', 'event_date', 'event_time', 'luma_url', 'status'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
};

function buildParsePrompt(text) {
  return `다음은 Luma 캘린더 메인 페이지 전체를 복사한 텍스트야. 여기 있는 모든 이벤트를 추출해줘.

주의할 점:
1. 시간 표기 — event_date/event_time에는 **항상 행사 현지시각**을 넣어. Luma는 보는 사람의 타임존에 따라 시간을 1개 또는 2개로 표시해:
   - **시간이 2개 있으면** (예: "오전 7:30 · 7월 27일 오후 3:30 GMT-7"): 뒤쪽의 "GMT±N"이 붙은 날짜/시간이 행사 현지시각이야. **그 날짜와 시간을 사용해** (위 예시는 event_date=2026-07-27, event_time=15:30). 앞의 타임존 없는 시간은 보는 사람 로컬 시간이니 무시해.
   - **시간이 1개뿐이면** (GMT 표기 없음): 보는 사람 타임존과 행사 타임존이 같다는 뜻이라 그 시간이 곧 현지시각이야. 그 시간을 그대로 쓰고, 날짜는 위쪽 날짜 섹션 헤더(예: "7월 28일 화요일")를 사용해.
   - 주의: 시간이 2개일 때 날짜 섹션 헤더는 보는 사람 기준 날짜라 행사 현지 날짜와 다를 수 있어. 이 경우 **섹션 헤더가 아니라 GMT 표기 옆의 날짜**를 따라야 해.
2. "이벤트 만들기", "탐색", "가격", "도움말" 같은 네비게이션 문구, "...의 커버 이미지" 같은 이미지 설명, "+39" 같은 참석자 수 표시는 이벤트 정보가 아니니 무시해.
3. 호스트가 여러 명이면("&", "외 N 명" 등) 있는 그대로 host 필드에 담아.
4. status는 원문에 보이는 그대로 사용해 (예: 참석, 승인 대기 중).
5. 페이지에 luma_url(링크)이 보이지 않으면 luma_url은 null로 둬.

텍스트:
${text}`;
}

async function parseWithClaude(text) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    output_config: { format: { type: 'json_schema', schema: EVENT_LIST_SCHEMA } },
    messages: [
      {
        role: 'user',
        content: buildParsePrompt(text),
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude가 요청을 거부했어요.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) return [];

  const parsed = JSON.parse(textBlock.text);
  return parsed.events;
}

// ---------- 3. DB upsert (무조건 덮어쓰기) ----------
async function upsertAll(slackUserId, events) {
  const studentRes = await pool.query(
    `INSERT INTO students (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slackUserId]
  );
  const studentId = studentRes.rows[0].id;

  for (const ev of events) {
    // 중복 키는 항상 제목+날짜에서 만든다. luma_url은 붙여넣기마다 있을 수도, 없을 수도 있어
    // 키로 쓰면 같은 이벤트가 여러 행으로 갈라진다.
    const key = dedupKey(ev.title, ev.event_date);
    const eventRes = await pool.query(
      `INSERT INTO events (title, host, location, event_date, event_time, luma_url, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (dedup_key) DO UPDATE SET
         title = EXCLUDED.title, host = EXCLUDED.host,
         location = EXCLUDED.location, event_date = EXCLUDED.event_date,
         event_time = EXCLUDED.event_time,
         -- URL은 한 번이라도 확보되면 유지 (URL 없는 붙여넣기가 덮어쓰지 않게)
         luma_url = COALESCE(EXCLUDED.luma_url, events.luma_url)
       RETURNING id`,
      [ev.title, ev.host || null, ev.location || null, ev.event_date || null, ev.event_time || null,
       ev.luma_url || null, key]
    );
    const eventId = eventRes.rows[0].id;

    // '참석'으로 확정된 신청을, 오래된 붙여넣기로 인해 '승인 대기 중'으로 되돌리지 않도록 방지
    await pool.query(
      `INSERT INTO applications (student_id, event_id, status)
       VALUES ($1,$2,$3)
       ON CONFLICT (student_id, event_id) DO UPDATE SET
         status = CASE
           WHEN applications.status = '참석' AND EXCLUDED.status = '승인 대기 중' THEN applications.status
           ELSE EXCLUDED.status
         END,
         created_at = CASE
           WHEN applications.status = '참석' AND EXCLUDED.status = '승인 대기 중' THEN applications.created_at
           ELSE now()
         END`,
      [studentId, eventId, ev.status || '알수없음']
    );
  }
}

// ---------- 4. DM 수신 → 파싱 → 저장 ----------
app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== 'im') return; // DM에서만 반응 (채널 멘션/일반 대화는 무시)
  if (!message.text || !message.text.trim()) return;

  if (message.text.length > MAX_INPUT_LENGTH) {
    await say(`⚠️ 텍스트가 너무 길어요 (${message.text.length}자). ${MAX_INPUT_LENGTH}자 이하로 나눠서 보내주세요.`);
    return;
  }

  try {
    const parsed = await parseWithClaude(message.text);
    if (!parsed.length) {
      await say('파싱된 이벤트가 없어요. 텍스트를 확인해주세요.');
      return;
    }
    await upsertAll(message.user, parsed);
    await say(`✅ ${parsed.length}개 이벤트 저장 완료!`);
  } catch (err) {
    console.error(err);
    await say('⚠️ 처리 중 오류가 발생했어요.');
  }
});

// ---------- 5. 슬래시 커맨드 (전체 공개 조회) ----------
// 출력 포맷팅은 format.js(순수 함수)로 분리되어 있다.

app.command('/events', async ({ ack, respond }) => {
  await ack();
  const res = await pool.query(`
    SELECT s.name,
           e.title,
           TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
           TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
           a.status
    FROM applications a
    JOIN events e ON e.id = a.event_id
    JOIN students s ON s.id = a.student_id
    ORDER BY e.event_date, e.event_time, s.name
  `);
  const text = res.rows.length
    ? `🗓 *전체 신청 현황* _(행사 현지시각 기준)_\n`
      + res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — <@${r.name}> (${r.status})`).join('\n')
    : '신청 내역이 없습니다.';
  await respond({ text, response_type: 'in_channel' });
});

app.command('/event-stats', async ({ ack, respond }) => {
  await ack();
  // 이벤트×상태 단위로 집계한다. 특정 상태를 하드코딩해 세면 새 상태가 누락된다.
  const res = await pool.query(`
    SELECT e.id AS event_id,
           e.title,
           TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
           TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
           a.status,
           COUNT(*)::int AS cnt
    FROM applications a
    JOIN events e ON e.id = a.event_id
    GROUP BY e.id, e.title, e.event_date, e.event_time, a.status
    ORDER BY e.event_date NULLS LAST, e.event_time NULLS LAST, e.title, a.status
  `);
  await respond({ text: buildEventStatsText(res.rows), response_type: 'in_channel' });
});

// 날짜별 타임라인: 날짜 → 시간순 이벤트 → 상태별 참석자
app.command('/schedule', async ({ ack, respond }) => {
  await ack();
  // 같은 시간대는 이벤트가 달라도 한 묶음. 한 사람이 같은 시간에 여러 건을 신청했어도
  // DISTINCT로 한 번만 센다.
  const res = await pool.query(`
    SELECT TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
           TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
           a.status,
           COUNT(DISTINCT s.id)::int            AS cnt,
           ARRAY_AGG(DISTINCT s.name)           AS members
    FROM applications a
    JOIN events e ON e.id = a.event_id
    JOIN students s ON s.id = a.student_id
    GROUP BY e.event_date, e.event_time, a.status
    ORDER BY e.event_date NULLS LAST, e.event_time NULLS LAST, a.status
  `);

  await respond({ text: buildScheduleText(res.rows), response_type: 'in_channel' });
});

app.command('/my-events', async ({ command, ack, respond }) => {
  await ack();
  const res = await pool.query(
    `SELECT e.title,
            TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
            TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
            a.status
     FROM applications a
     JOIN events e ON e.id = a.event_id
     JOIN students s ON s.id = a.student_id
     WHERE s.name = $1
     ORDER BY e.event_date, e.event_time`,
    [command.user_id]
  );
  const text = res.rows.length
    ? `🙋 *내 신청 내역* _(행사 현지시각 기준)_\n`
      + res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — ${r.status}`).join('\n')
    : '신청 내역이 없습니다.';
  await respond(text);
});

// ---------- 6. 실행 ----------
// 직접 실행할 때만 서버를 띄운다. require로 불러오면 파서만 꺼내 쓸 수 있음(테스트용).
if (require.main === module) {
  (async () => {
    await initSchema(pool);
    await app.start(process.env.PORT || 3000);
    console.log('⚡️ techweek-slackbot running');
  })().catch((err) => {
    console.error('❌ 시작 실패:', err);
    process.exit(1);
  });
}

module.exports = { parseWithClaude, buildParsePrompt, EVENT_LIST_SCHEMA };
