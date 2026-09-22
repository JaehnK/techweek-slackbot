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
  dedupKey, partitionByDateWindow, isPastPaste, buildDeletePickerBlocks,
  STATUS_GOING, STATUS_VALUES,
} = require('./format');
const { initSchema } = require('./schema');
const {
  createAdminHandler, fetchDashboardData, computeUnregistered, renderDashboard,
} = require('./dashboard');

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'DATABASE_URL', 'ANTHROPIC_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`⚠️ Missing environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const MAX_INPUT_LENGTH = 50000; // Luma 메인 페이지 전체 복붙(여러 주 분량)까지 허용
const CLAUDE_MODEL = 'claude-haiku-4-5';

// 행사 기간. 이 봇은 한 주짜리 TechWeek 전용이라 이 창 밖 날짜는 파싱 오류로 보고 저장하지 않는다.
// (파서가 월을 7월→1월로 틀리게 찍는 사례가 반복돼 방어한다.) 다른 행사에 재사용하려면 env로 덮어쓴다.
const EVENT_WINDOW = {
  from: process.env.EVENT_WINDOW_FROM || '2026-07-24',
  to: process.env.EVENT_WINDOW_TO || '2026-07-31',
};

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 관리자 대시보드는 공개 도메인에 노출되므로 토큰이 설정된 경우에만 활성화한다.
// 토큰이 없으면 핸들러가 404를 돌려주어 교육생 정보가 새어나가지 않게 한다.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

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
    {
      path: '/admin',
      method: ['GET'],
      handler: createAdminHandler({ token: ADMIN_TOKEN, buildHtml: buildDashboardHtml }),
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
  return `다음은 Luma 캘린더 메인 페이지 전체(여러 이벤트) 또는 개별 이벤트 상세 페이지(한 개)를 복사한 텍스트야. 여기 있는 모든 이벤트를 추출해줘.

**이 행사(TechWeek)는 ${EVENT_WINDOW.from} ~ ${EVENT_WINDOW.to} 한 주 동안만 열려. 모든 event_date는 반드시 이 범위 안이어야 해.**
날짜 섹션 헤더에 월이 안 보이거나 애매하면 요일과 이 범위로 역산해서 맞춰. 절대 이 범위 밖(특히 다른 월)의 날짜를 쓰지 마.

주의할 점:
1. 시간 표기 — event_date/event_time에는 **항상 행사 현지시각**을 넣어. Luma는 보는 사람의 타임존에 따라 시간을 1개 또는 2개로 표시해:
   - **시간이 2개 있으면** (예: "오전 7:30 · 7월 27일 오후 3:30 GMT-7"): 뒤쪽의 "GMT±N"이 붙은 날짜/시간이 행사 현지시각이야. **그 날짜와 시간을 사용해** (위 예시는 event_date=2026-07-27, event_time=15:30). 앞의 타임존 없는 시간은 보는 사람 로컬 시간이니 무시해.
   - **시간이 1개뿐이면** (GMT 표기 없음): 보는 사람 타임존과 행사 타임존이 같다는 뜻이라 그 시간이 곧 현지시각이야. 그 시간을 그대로 쓰고, 날짜는 위쪽 날짜 섹션 헤더(예: "7월 28일 화요일")를 사용해.
   - 주의: 시간이 2개일 때 날짜 섹션 헤더는 보는 사람 기준 날짜라 행사 현지 날짜와 다를 수 있어. 이 경우 **섹션 헤더가 아니라 GMT 표기 옆의 날짜**를 따라야 해.
2. "이벤트 만들기", "탐색", "가격", "도움말" 같은 네비게이션 문구, "...의 커버 이미지" 같은 이미지 설명, "+39" 같은 참석자 수 표시는 이벤트 정보가 아니니 무시해.
3. 호스트가 여러 명이면("&", "외 N 명" 등) 있는 그대로 host 필드에 담아.
4. status는 원문 언어와 무관하게 아래 영어 값 중 하나로 정규화해서 넣어:
   - 참석 / 참석함 / 참석 확정 / Going / Attending / Attended / Registered / Confirmed / You're In → "Going"
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
// Slack ID로 학생 행을 확보한다 (사전 신청/참여 기록 공용).
async function upsertStudent(slackUserId) {
  const res = await pool.query(
    `INSERT INTO students (name) VALUES ($1)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slackUserId]
  );
  return res.rows[0].id;
}

// 이벤트 마스터 upsert (사전 신청/참여 기록 공용).
// 중복 키는 항상 제목+날짜에서 만든다. luma_url은 붙여넣기마다 있을 수도, 없을 수도 있어
// 키로 쓰면 같은 이벤트가 여러 행으로 갈라진다.
async function upsertEventRow(ev) {
  const key = dedupKey(ev.title, ev.event_date);
  const res = await pool.query(
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
  return res.rows[0].id;
}

// 붙여넣기를 '그 시점의 예정 일정 전체'로 보고, 빠진 예정 일정은 취소된 것으로 간주해 지운다.
// 지난 일정은 참석 기록이므로 건드리지 않는다 (Luma '예정된' 탭엔 미래만 나오기 때문).
async function upsertAll(slackUserId, events, { allowCancellation = true } = {}) {
  const studentId = await upsertStudent(slackUserId);
  const touchedEventIds = [];

  for (const ev of events) {
    const eventId = await upsertEventRow(ev);
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

  // 파싱 일부가 기간 밖으로 걸러졌다면(붙여넣기가 불완전하게 해석됨) 취소 처리를 건너뛴다.
  // 안 그러면 잘못 해석된 항목의 '진짜 일정'을 취소로 오인해 지울 수 있다.
  if (!allowCancellation) return { saved: touchedEventIds.length, removed: 0, removedTitles: [] };

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

// ---------- 3-a. 참여 기록 (행사 후 Luma '지난(Past)' 탭 복붙) ----------
// 사전 신청(applications)과 별개 테이블(attendances)에 쌓는다. 취소 동기화는 하지 않는다 —
// 참여 사실은 나중에 사라질 수 없고, 지난 탭 복붙이 전체 목록이 아닐 수도 있기 때문.
async function recordAttendances(slackUserId, events) {
  const studentId = await upsertStudent(slackUserId);
  let added = 0;
  for (const ev of events) {
    const eventId = await upsertEventRow(ev);
    const ins = await pool.query(
      `INSERT INTO attendances (student_id, event_id) VALUES ($1,$2)
       ON CONFLICT (student_id, event_id) DO NOTHING`,
      [studentId, eventId]
    );
    added += ins.rowCount;
  }
  return { total: events.length, added };
}

// ---------- 3-b. 관리자 대시보드 ----------
// 워크스페이스 로스터. 대시보드 로드마다 users.list를 때리지 않도록 5분 캐시한다.
let rosterCache = { at: 0, members: null };
const ROSTER_TTL_MS = 5 * 60 * 1000;

async function fetchRoster(client) {
  if (rosterCache.members && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.members;
  try {
    let raw = [];
    let cursor;
    do {
      const r = await client.users.list(cursor ? { limit: 200, cursor } : { limit: 200 });
      raw = raw.concat(r.members || []);
      cursor = r.response_metadata?.next_cursor;
    } while (cursor);
    // 사람만: 봇/삭제/Slackbot 제외, 표시 이름 우선
    const members = raw
      .filter((u) => !u.is_bot && !u.deleted && u.id !== 'USLACKBOT')
      .map((u) => ({ id: u.id, name: u.profile?.display_name || u.profile?.real_name || u.name }));
    rosterCache = { at: Date.now(), members };
    return members;
  } catch (err) {
    // 로스터를 못 받아도 대시보드는 그려야 한다(미등록 섹션만 안내 문구로 대체)
    console.warn('roster fetch skipped:', err.data?.error || err.message);
    return null;
  }
}

async function buildDashboardHtml() {
  const data = await fetchDashboardData(pool);
  const roster = await fetchRoster(app.client);
  let unregistered = null;
  if (roster) {
    unregistered = computeUnregistered({
      rosterMembers: roster,
      registeredIds: data.studentRows.map((r) => r.slack_id),
      registeredNames: data.studentRows.map((r) => r.label),
    });
  }
  return renderDashboard({
    ...data,
    unregistered,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });
}

// Slack 표시 이름을 저장해 둔다. 대시보드는 <@ID> 렌더링을 쓸 수 없어 ID만으론 알아볼 수 없다.
// users:read 스코프가 없으면 실패하므로, 실패해도 본 흐름을 막지 않는다(ID로 폴백).
async function rememberDisplayName(client, slackUserId) {
  try {
    const info = await client.users.info({ user: slackUserId });
    const p = info.user?.profile || {};
    const name = p.display_name || p.real_name || info.user?.name;
    if (!name) return false;
    await pool.query(
      `UPDATE students SET display_name = $2 WHERE name = $1 AND display_name IS DISTINCT FROM $2`,
      [slackUserId, name]
    );
    return true;
  } catch (err) {
    console.warn('display name lookup skipped:', err.data?.error || err.message);
    return false;
  }
}

// 기존 학생은 다시 DM을 보내기 전까지 display_name이 비어 대시보드에 Slack ID로만 보인다.
// 그래서 기동 시 한 번 미채움분을 메운다. 실패는 로그만 남기고 기동을 막지 않는다.
async function backfillDisplayNames(client) {
  const { rows } = await pool.query(
    `SELECT name FROM students WHERE display_name IS NULL ORDER BY id`
  );
  if (!rows.length) return;
  let filled = 0;
  for (const { name } of rows) {
    if (await rememberDisplayName(client, name)) filled += 1;
  }
  console.log(`display names backfilled: ${filled}/${rows.length}`);
}

// ---------- 4. DM 수신 → 파싱 → 저장 ----------
// DM에 'delete'라고만 보내면 복붙 파싱 대신 삭제 피커를 띄운다.
const DELETE_KEYWORD_RE = /^\s*(delete|del|삭제|delete\s*events?)\s*$/i;

// 본인 기록(참여/신청)을 select 메뉴로 보여준다. 동결 스냅샷(pre_registrations)은 대상이 아니다.
async function sendDeletePicker(slackUserId, say) {
  const [att, reg] = await Promise.all([
    pool.query(
      `SELECT a.id, e.title,
              TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
              TO_CHAR(e.event_time, 'HH24:MI')    AS event_time
       FROM attendances a
       JOIN events e   ON e.id = a.event_id
       JOIN students s ON s.id = a.student_id
       WHERE s.name = $1
       ORDER BY e.event_date, e.event_time`,
      [slackUserId]
    ),
    pool.query(
      `SELECT a.id, e.title, a.status,
              TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
              TO_CHAR(e.event_time, 'HH24:MI')    AS event_time
       FROM applications a
       JOIN events e   ON e.id = a.event_id
       JOIN students s ON s.id = a.student_id
       WHERE s.name = $1
       ORDER BY e.event_date, e.event_time`,
      [slackUserId]
    ),
  ]);
  const blocks = buildDeletePickerBlocks(att.rows, reg.rows);
  if (!blocks) {
    await say('Nothing to delete — you have no attendance records or registrations.');
    return;
  }
  await say({ text: 'Pick an event to delete', blocks });
}

// 피커에서 선택 → 해당 행 삭제. 값은 'att:<id>'/'app:<id>' 형태이고, 소유자(students.name =
// 누른 사람의 Slack ID)를 함께 검증해 남의 기록을 지울 수 없게 한다.
app.action('delete_event_pick', async ({ ack, body, action, respond }) => {
  await ack();
  try {
    const [kind, rawId] = String(action.selected_option?.value || '').split(':');
    const table = kind === 'att' ? 'attendances' : kind === 'app' ? 'applications' : null;
    if (!table || !/^\d+$/.test(rawId || '')) return;
    const del = await pool.query(
      `DELETE FROM ${table} a
       USING students s, events e
       WHERE a.id = $1 AND s.id = a.student_id AND s.name = $2 AND e.id = a.event_id
       RETURNING e.title`,
      [Number(rawId), body.user.id]
    );
    if (!del.rowCount) {
      // 피커가 이미 지운 항목을 들고 있던 경우(이중 클릭·오래된 메시지)
      await respond({ text: '⚠️ That record was already removed. Send `delete` again for a fresh list.', replace_original: true });
      return;
    }
    const label = kind === 'att' ? 'attendance record' : 'registration';
    await respond({ text: `🗑 Removed ${label}: ${del.rows[0].title}\nSend \`delete\` again to remove another.`, replace_original: true });
  } catch (err) {
    console.error(err);
    await respond({ text: '⚠️ Something went wrong while deleting. Please try again.', replace_original: true });
  }
});

app.message(async ({ message, say, client }) => {
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== 'im') return; // DM에서만 반응 (채널 멘션/일반 대화는 무시)
  if (!message.text || !message.text.trim()) return;

  if (DELETE_KEYWORD_RE.test(message.text)) {
    await sendDeletePicker(message.user, say);
    return;
  }

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
    // 행사 기간 밖 날짜는 파싱 오류로 보고 저장하지 않는다(월을 잘못 찍는 사례 방어).
    const { keep, skip } = partitionByDateWindow(parsed, EVENT_WINDOW.from, EVENT_WINDOW.to);
    if (skip.length) {
      console.warn(`skipped ${skip.length} out-of-window event(s):`,
        skip.map((e) => `${e.event_date} ${e.title}`).join(' | '));
    }
    // 걸러낸 항목은 날짜 오류일 가능성이 높으니 사용자에게 알린다.
    const skippedNote = skip.length
      ? `\n⚠️ Skipped ${skip.length} event(s) dated outside TechWeek (${EVENT_WINDOW.from} ~ ${EVENT_WINDOW.to}) — likely a date misread, so not saved:\n`
        + skip.map((e) => `  · ${e.event_date} — ${e.title}`).join('\n')
      : '';

    // 모든 날짜가 오늘 이전이면 Luma '지난(Past)' 탭 복붙으로 본다 (예정 탭엔 미래만 나옴).
    // 이 경우 사전 신청이 아니라 실제 참여 기록으로, 별개 테이블에 저장한다.
    const today = new Date().toISOString().slice(0, 10);
    if (isPastPaste(keep, today)) {
      // 단일 이벤트 복붙(상세 페이지)은 '이거 참여했어'라는 명시적 개별 추가로 보고 상태와
      // 무관하게 기록한다. 여러 건(지난 탭 목록)일 때만 승인 대기/대기자 등
      // 실제로 못 간 행사가 섞이므로 'Going'만 참여로 친다.
      const single = keep.length === 1;
      const attended = single ? keep : keep.filter((e) => e.status === STATUS_GOING);
      const notAttended = single ? [] : keep.filter((e) => e.status !== STATUS_GOING);
      const notAttendedNote = notAttended.length
        ? `\nℹ️ ${notAttended.length} event(s) weren't marked "Going" on Luma, so not counted as attended:\n`
          + notAttended.map((e) => `  · ${e.title} (${e.status})`).join('\n')
        : '';
      if (!attended.length) {
        await say(`No attended events found in this paste.${notAttendedNote}${skippedNote}`);
        return;
      }
      const { total, added } = await recordAttendances(message.user, attended);
      await rememberDisplayName(client, message.user); // 대시보드 표기용 (실패해도 무방)
      const dupNote = total - added ? ` (${total - added} already recorded)` : '';
      await say(`🎟 Recorded ${added} attended event(s)!${dupNote}${notAttendedNote}${skippedNote}`);
      return;
    }

    // 일부가 걸러졌으면 이번 붙여넣기는 불완전하므로 자동 취소 처리를 끈다.
    // 단일 이벤트(상세 페이지 복붙 = 개별 추가)도 '전체 목록'이 아니므로 취소 처리 대상이 아니다.
    const { saved, removed, removedTitles } = await upsertAll(message.user, keep, {
      allowCancellation: skip.length === 0 && keep.length > 1,
    });
    await rememberDisplayName(client, message.user); // 대시보드 표기용 (실패해도 무방)

    const removedNote = removed
      ? `\n🗑 Removed ${removed} cancelled event(s):\n`
        + removedTitles.map((t) => `  · ${t}`).join('\n')
        + `\nIf that wasn't intended, please copy and send the entire Luma page again.`
      : '';
    await say(`✅ Saved ${saved} event(s)!${removedNote}${skippedNote}`);
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
  // 참여 기록은 사전 신청과 별개 테이블이라 따로 조회해 섹션을 나눠 보여준다.
  const att = await pool.query(
    `SELECT e.title,
            TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
            TO_CHAR(e.event_time, 'HH24:MI')    AS event_time
     FROM attendances a
     JOIN events e ON e.id = a.event_id
     JOIN students s ON s.id = a.student_id
     WHERE s.name = $1
     ORDER BY e.event_date, e.event_time`,
    [command.user_id]
  );
  const regText = res.rows.length
    ? `🙋 *My registrations* _(event local time)_\n`
      + res.rows.map((r) => `${fmtWhen(r)} | ${r.title} — ${r.status}`).join('\n')
    : 'No registrations yet.';
  const attText = att.rows.length
    ? `\n\n🎟 *Attended* _(event local time)_\n`
      + att.rows.map((r) => `${fmtWhen(r)} | ${r.title}`).join('\n')
    : '';
  await respond(regText + attText);
});

// ---------- 6. 실행 ----------
// 직접 실행할 때만 서버를 띄운다. require로 불러오면 파서만 꺼내 쓸 수 있음(테스트용).
if (require.main === module) {
  (async () => {
    await initSchema(pool);
    await app.start(process.env.PORT || 3000);
    console.log('⚡️ techweek-slackbot running');
    if (ADMIN_TOKEN) {
      // 기동을 지연시키지 않도록 서버가 뜬 뒤 백그라운드로 돌린다
      backfillDisplayNames(app.client).catch((err) => {
        console.warn('display name backfill skipped:', err.message);
      });
    }
  })().catch((err) => {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  });
}

module.exports = { parseWithClaude, buildParsePrompt, EVENT_LIST_SCHEMA };
