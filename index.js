// techweek-slackbot: 1개 파일로 동작하는 Slack 봇
// 테크위크 이벤트 신청 현황을 Claude로 파싱해 Postgres에 저장하고, 슬래시 커맨드로 조회한다.
//
// 필요한 환경변수:
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, DATABASE_URL, ANTHROPIC_API_KEY, PORT(선택)

require('dotenv').config();

const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const {
  fmtWhen, buildScheduleText, buildEventStatsText, buildStudentStatsText,
  dedupKey, STATUS_GOING, STATUS_VALUES,
} = require('./format');
const { initSchema } = require('./schema');

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`⚠️ Missing environment variables: ${missingEnv.join(', ')}`);
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
          // Luma 표시 언어와 무관하게 값을 고정한다. 코드가 상태를 문자열로 비교하므로
          // (역행 방지, pending_count) 원문을 그대로 저장하면 언어에 따라 로직이 깨진다.
          status: { type: 'string', enum: STATUS_VALUES },
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
4. status는 원문 언어와 무관하게 아래 영어 값 중 하나로 정규화해서 넣어:
   - 참석 / Going / Attending / Registered / Confirmed → "Going"
   - 승인 대기 중 / Pending Approval / Awaiting Approval → "Pending approval"
   - 대기자 명단 / Waitlist / Waiting List → "Waitlist"
   - 초대됨 / Invited → "Invited"
   - 위 어느 것에도 해당하지 않거나 판단이 어려우면 → "Unknown"
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
    throw new Error('Claude declined the request.');
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  if (!textBlock) return [];

  const parsed = JSON.parse(textBlock.text);
  return parsed.events;
}

// ---------- 3. DB upsert + 예정 일정 동기화 ----------
// 붙여넣기를 '그 시점의 예정 일정 전체'로 보고, 빠진 예정 일정은 취소된 것으로 간주해 지운다.
// 지난 일정은 참석 기록이므로 건드리지 않는다 (Luma '예정된' 탭엔 미래만 나오기 때문).
async function upsertAll(slackUserId, events) {
  const studentRes = await pool.query(
    `INSERT INTO students (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slackUserId]
  );
  const studentId = studentRes.rows[0].id;
  const touchedEventIds = [];

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
    touchedEventIds.push(eventId);

    // 'Going'으로 확정된 신청을, 오래된 붙여넣기로 인해 대기 상태로 되돌리지 않도록 방지
    await pool.query(
      `INSERT INTO applications (student_id, event_id, status)
       VALUES ($1,$2,$3)
       ON CONFLICT (student_id, event_id) DO UPDATE SET
         status = CASE
           WHEN applications.status = $4 AND EXCLUDED.status <> $4 THEN applications.status
           ELSE EXCLUDED.status
         END,
         created_at = CASE
           WHEN applications.status = $4 AND EXCLUDED.status <> $4 THEN applications.created_at
           ELSE now()
         END`,
      [studentId, eventId, ev.status || 'Unknown', STATUS_GOING]
    );
  }

  // 빈 파싱 결과로 기존 일정을 통째로 날리지 않도록 방어 (호출부에서도 막지만 이중 안전장치)
  if (!touchedEventIds.length) return { saved: 0, removed: 0, removedTitles: [] };

  // 이번 붙여넣기에 없는 '예정' 일정 = 취소된 것으로 보고 제거.
  // 서버는 UTC, 행사는 시애틀(UTC-7)이라 경계에서 하루 밀릴 수 있어 1일 여유를 둔다.
  const del = await pool.query(
    `DELETE FROM applications a
     USING events e
     WHERE a.event_id = e.id
       AND a.student_id = $1
       AND NOT (a.event_id = ANY($2::int[]))
       AND (e.event_date IS NULL OR e.event_date >= CURRENT_DATE - INTERVAL '1 day')
     RETURNING e.title`,
    [studentId, touchedEventIds]
  );

  return {
    saved: touchedEventIds.length,
    removed: del.rowCount,
    removedTitles: del.rows.map((r) => r.title),
  };
}

// ---------- 4. DM 수신 → 파싱 → 저장 ----------
app.message(async ({ message, say }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== 'im') return; // DM에서만 반응 (채널 멘션/일반 대화는 무시)
  if (!message.text || !message.text.trim()) return;

  if (message.text.length > MAX_INPUT_LENGTH) {
    await say(`⚠️ That's too long (${message.text.length} characters). Please split it into parts under ${MAX_INPUT_LENGTH} characters.`);
    return;
  }

  try {
    const parsed = await parseWithClaude(message.text);
    if (!parsed.length) {
      await say("No events found. Please check the text you pasted — copy the whole Luma page and try again.");
      return;
    }
    const { saved, removed, removedTitles } = await upsertAll(message.user, parsed);
    // 제거된 항목은 반드시 알려준다. 일부만 복사해 보냈을 때 본인이 바로 알아채야 하므로.
    const removedNote = removed
      ? `\n🗑 Removed ${removed} cancelled event(s):\n`
        + removedTitles.map((t) => `  · ${t}`).join('\n')
        + `\nIf that wasn't intended, please copy and send the entire Luma page again.`
      : '';
    await say(`✅ Saved ${saved} event(s)!${removedNote}`);
  } catch (err) {
    console.error(err);
    await say('⚠️ Something went wrong while processing your message. Please try again.');
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
    ? `🗓 *All registrations* _(event local time)_\n`
      + res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — <@${r.name}> (${r.status})`).join('\n')
    : 'No registrations yet.';
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

// 사람별 신청 요약. 신청이 하나도 없는 학생도 보이도록 students에서 LEFT JOIN 한다
// (동기화로 전부 취소된 경우를 운영진이 알아챌 수 있어야 하므로).
app.command('/students', async ({ ack, respond }) => {
  await ack();
  const res = await pool.query(`
    SELECT s.id AS student_id,
           s.name,
           a.status,
           COUNT(a.id)::int                        AS cnt,
           SUM(COUNT(a.id)) OVER (PARTITION BY s.id)::int AS total
    FROM students s
    LEFT JOIN applications a ON a.student_id = s.id
    GROUP BY s.id, s.name, a.status
    ORDER BY total DESC, s.name, a.status
  `);
  await respond({ text: buildStudentStatsText(res.rows), response_type: 'in_channel' });
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
    ? `🙋 *My registrations* _(event local time)_\n`
      + res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — ${r.status}`).join('\n')
    : 'No registrations yet.';
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
    console.error('❌ Startup failed:', err);
    process.exit(1);
  });
}

module.exports = { parseWithClaude, buildParsePrompt, EVENT_LIST_SCHEMA };
