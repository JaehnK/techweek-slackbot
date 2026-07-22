// techweek-slackbot: 1개 파일로 동작하는 Slack 봇
// 테크위크 이벤트 신청 현황을 Claude로 파싱해 Postgres에 저장하고, 슬래시 커맨드로 조회한다.
//
// 필요한 환경변수:
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, DATABASE_URL, ANTHROPIC_API_KEY, PORT(선택)

require('dotenv').config();

const { App } = require('@slack/bolt');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');

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

// ---------- 1. 스키마 초기화 ----------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      application_count INTEGER DEFAULT 0,
      pending_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      host TEXT,
      location TEXT,
      event_date DATE,
      event_time TIME,
      luma_url TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      event_id INTEGER REFERENCES events(id),
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (student_id, event_id)
    );

    CREATE OR REPLACE FUNCTION update_student_counts() RETURNS TRIGGER AS $$
    BEGIN
      UPDATE students SET
        application_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id)),
        pending_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id) AND status = '승인 대기 중')
      WHERE id = COALESCE(NEW.student_id, OLD.student_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_update_student_counts ON applications;
    CREATE TRIGGER trg_update_student_counts
    AFTER INSERT OR UPDATE OR DELETE ON applications
    FOR EACH ROW EXECUTE FUNCTION update_student_counts();
  `);
}

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
1. 시간 표기: 각 이벤트 줄에는 시간이 두 번 나올 수 있어. 예: "오전 7:30 · 7월 27일 오후 3:30 GMT-7"
   - 앞의 시간(타임존 표기 없음)은 보는 사람 로컬 시간이니 무시해.
   - "GMT±N" 같은 타임존이 붙은 뒤쪽 날짜/시간이 이벤트 실제 현지 시각이야. event_date/event_time에는 이 값을 사용해.
   - 만약 타임존 표기가 붙은 시간이 없다면, 날짜 섹션 헤더(예: "7월 28일 화요일")와 그 아래 있는 시간을 사용해.
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
    const key = ev.luma_url || `${ev.title}-${ev.event_date}`;
    const eventRes = await pool.query(
      `INSERT INTO events (title, host, location, event_date, event_time, luma_url)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (luma_url) DO UPDATE SET
         title = EXCLUDED.title, host = EXCLUDED.host,
         location = EXCLUDED.location, event_date = EXCLUDED.event_date,
         event_time = EXCLUDED.event_time
       RETURNING id`,
      [ev.title, ev.host || null, ev.location || null, ev.event_date || null, ev.event_time || null, key]
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
// event_date/event_time은 쿼리에서 TO_CHAR로 문자열화됨. 날짜 없으면 '미정', 시간 있으면 뒤에 붙임.
function fmtWhen(r) {
  const date = r.event_date || '미정';
  return r.event_time ? `${date} ${r.event_time}` : date;
}

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
  const text = res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — <@${r.name}> (${r.status})`).join('\n')
    || '신청 내역이 없습니다.';
  await respond({ text, response_type: 'in_channel' });
});

app.command('/event-stats', async ({ ack, respond }) => {
  await ack();
  const res = await pool.query(`
    SELECT e.title,
           TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
           TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE a.status = '승인 대기 중') AS pending
    FROM applications a
    JOIN events e ON e.id = a.event_id
    GROUP BY e.id, e.title, e.event_date, e.event_time
    ORDER BY e.event_date, e.event_time
  `);
  const text = res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — 총 ${r.total}명 (대기 ${r.pending})`).join('\n')
    || '이벤트가 없습니다.';
  await respond({ text, response_type: 'in_channel' });
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
  const text = res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — ${r.status}`).join('\n')
    || '신청 내역이 없습니다.';
  await respond(text);
});

// ---------- 6. 실행 ----------
(async () => {
  await initSchema();
  await app.start(process.env.PORT || 3000);
  console.log('⚡️ techweek-slackbot running');
})().catch((err) => {
  console.error('❌ 시작 실패:', err);
  process.exit(1);
});
