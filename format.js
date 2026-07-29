// 슬래시 커맨드 출력 포맷팅. Slack/DB에 의존하지 않는 순수 함수라 단독 테스트 가능.

// 상태값은 파싱 시점에 아래 값들로 정규화된다(STATUS_VALUES). 코드가 상태를 문자열로
// 비교하는 곳이 있어(역행 방지, pending_count), Luma 표시 언어와 무관하게 값이 고정돼야 한다.
const STATUS_GOING = 'Going';
const STATUS_VALUES = [STATUS_GOING, 'Pending approval', 'Waitlist', 'Invited', 'Unknown'];

// event_date/event_time은 쿼리에서 TO_CHAR로 문자열화됨. 날짜 없으면 TBD, 시간 있으면 뒤에 붙임.
function fmtWhen(r) {
  const date = r.event_date || 'TBD';
  return r.event_time ? `${date} ${r.event_time}` : date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 'YYYY-MM-DD' → ' (Mon)'. UTC로 파싱해 실행 환경 타임존에 따라 요일이 밀리지 않게 한다.
function weekdaySuffix(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : ` (${WEEKDAYS[d.getUTCDay()]})`;
}

// Slack 메시지 길이 상한에 걸리지 않도록 줄 단위로 잘라 붙인다.
// Slack의 text 상한은 4만자라 여유가 있지만, 인원이 늘어도 잘리지 않으면서
// 한 메시지가 감당 가능한 선으로 둔다(초과분은 Slack이 '더 보기'로 접는다).
const MAX_SLACK_TEXT = 12000;
function joinWithinLimit(lines) {
  const out = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_SLACK_TEXT) {
      out.push('… (truncated — too many entries to show)');
      break;
    }
    out.push(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

const DATE_TBD = 'Date TBD';
const TIME_TBD = 'Time TBD';

// /schedule 쿼리 결과(날짜×시간×상태 단위 행)를 날짜별 타임라인 텍스트로 만든다.
// 이벤트명은 표시하지 않고 같은 시간대는 한 줄로 묶는다 (누가 언제 비는지 보는 용도).
function buildScheduleText(rows) {
  if (!rows.length) return 'No registrations yet.';

  // 날짜 → 시간 → 상태별 참석자로 묶는다 (Map이라 쿼리의 정렬 순서가 유지됨)
  const byDate = new Map();
  for (const r of rows) {
    const dateKey = r.event_date || DATE_TBD;
    const timeKey = r.event_time || TIME_TBD;
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const slots = byDate.get(dateKey);
    if (!slots.has(timeKey)) slots.set(timeKey, []);
    slots.get(timeKey).push({ status: r.status, cnt: r.cnt, members: r.members });
  }

  const lines = ['🗓 *Attendance by time slot* _(event local time)_'];
  for (const [date, slots] of byDate) {
    lines.push('', `📅 *${date}${weekdaySuffix(date)}*`);
    for (const [time, statuses] of slots) {
      statuses.forEach((st, i) => {
        const who = st.members.map((m) => `<@${m}>`).join(' ');
        // 같은 시간대에 상태가 여러 개면 첫 줄에만 시간을 쓰고 나머지는 들여쓴다
        const prefix = i === 0 ? `\`${time}\`` : '　　　　';
        lines.push(`${prefix}  *${st.status} ${st.cnt}* · ${who}`);
      });
    }
  }
  return joinWithinLimit(lines);
}

// /event-stats 쿼리 결과(이벤트×상태 단위 행)를 날짜별 통계 텍스트로 만든다.
// 특정 상태를 하드코딩해 세면 새 상태가 등장할 때 조용히 누락되므로 실제 상태를 그대로 나열한다.
function buildEventStatsText(rows) {
  if (!rows.length) return 'No events yet.';

  // 날짜 → 이벤트 → 상태별 집계 (Map이라 쿼리의 정렬 순서가 유지됨)
  const byDate = new Map();
  for (const r of rows) {
    const dateKey = r.event_date || DATE_TBD;
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const events = byDate.get(dateKey);
    if (!events.has(r.event_id)) {
      events.set(r.event_id, { time: r.event_time, title: r.title, statuses: [] });
    }
    events.get(r.event_id).statuses.push({ status: r.status, cnt: r.cnt });
  }

  const lines = ['📊 *Registrations by event* _(event local time)_'];
  for (const [date, events] of byDate) {
    lines.push('', `📅 *${date}${weekdaySuffix(date)}*`);
    for (const ev of events.values()) {
      const total = ev.statuses.reduce((sum, s) => sum + s.cnt, 0);
      const breakdown = ev.statuses.map((s) => `${s.status} ${s.cnt}`).join(', ');
      lines.push(`\`${ev.time || TIME_TBD}\`  ${ev.title}`);
      lines.push(`　　　　Total *${total}* · ${breakdown}`);
    }
  }
  return joinWithinLimit(lines);
}

// /students 쿼리 결과(학생×상태 단위 행)를 사람별 요약 텍스트로 만든다.
// 신청이 많은 순으로 정렬돼 들어오므로, 참여가 적은 사람이 아래에 모여 눈에 띈다.
function buildStudentStatsText(rows) {
  if (!rows.length) return 'No one has registered a schedule yet.';

  // 학생 → 상태별 건수 (Map이라 쿼리의 정렬 순서가 유지됨)
  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) {
      byStudent.set(r.student_id, { name: r.name, total: r.total, statuses: [] });
    }
    // LEFT JOIN이라 신청이 하나도 없는 학생은 status가 null로 한 행 들어온다
    if (r.status && r.cnt > 0) {
      byStudent.get(r.student_id).statuses.push({ status: r.status, cnt: r.cnt });
    }
  }

  const lines = ['👥 *Registrations by person*', ''];
  for (const st of byStudent.values()) {
    const breakdown = st.statuses.length
      ? st.statuses.map((s) => `${s.status} ${s.cnt}`).join(', ')
      : '_no registrations_';
    lines.push(`<@${st.name}> — Total *${st.total}* · ${breakdown}`);
  }
  return joinWithinLimit(lines);
}

// 이벤트 중복 판정 키. 제목의 공백/대소문자 차이로 같은 이벤트가 갈라지지 않게 정규화한다.
// migrateDedupKey()의 SQL 백필과 동일한 규칙을 유지해야 한다.
function dedupKey(title, eventDate) {
  const normalized = String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${normalized}|${eventDate || ''}`;
}

// 행사 기간(from~to, 'YYYY-MM-DD') 밖의 날짜를 걸러낸다. 이 봇은 한 주짜리 행사용이라
// 기간 밖 날짜는 파싱 오류(월을 잘못 찍는 등)로 단정할 수 있다. 날짜 미정(null)은 통과시킨다.
function partitionByDateWindow(events, from, to) {
  const keep = [];
  const skip = [];
  for (const ev of events || []) {
    const d = ev.event_date;
    if (d && (d < from || d > to)) skip.push(ev);
    else keep.push(ev);
  }
  return { keep, skip };
}

module.exports = {
  fmtWhen, weekdaySuffix, joinWithinLimit, buildScheduleText, buildEventStatsText,
  buildStudentStatsText, dedupKey, partitionByDateWindow, MAX_SLACK_TEXT, STATUS_GOING, STATUS_VALUES,
};
