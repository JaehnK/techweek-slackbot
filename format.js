// 슬래시 커맨드 출력 포맷팅. Slack/DB에 의존하지 않는 순수 함수라 단독 테스트 가능.

// event_date/event_time은 쿼리에서 TO_CHAR로 문자열화됨. 날짜 없으면 '미정', 시간 있으면 뒤에 붙임.
function fmtWhen(r) {
  const date = r.event_date || '미정';
  return r.event_time ? `${date} ${r.event_time}` : date;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 'YYYY-MM-DD' → ' (화)'. UTC로 파싱해 실행 환경 타임존에 따라 요일이 밀리지 않게 한다.
function weekdaySuffix(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : ` (${WEEKDAYS[d.getUTCDay()]})`;
}

// Slack 메시지 길이 상한에 걸리지 않도록 줄 단위로 잘라 붙인다.
const MAX_SLACK_TEXT = 2900;
function joinWithinLimit(lines) {
  const out = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > MAX_SLACK_TEXT) {
      out.push('… (내용이 많아 이후 생략됨)');
      break;
    }
    out.push(line);
    len += line.length + 1;
  }
  return out.join('\n');
}

// /schedule 쿼리 결과(날짜×시간×상태 단위 행)를 날짜별 타임라인 텍스트로 만든다.
// 이벤트명은 표시하지 않고 같은 시간대는 한 줄로 묶는다 (누가 언제 비는지 보는 용도).
function buildScheduleText(rows) {
  if (!rows.length) return '신청 내역이 없습니다.';

  // 날짜 → 시간 → 상태별 참석자로 묶는다 (Map이라 쿼리의 정렬 순서가 유지됨)
  const byDate = new Map();
  for (const r of rows) {
    const dateKey = r.event_date || '날짜 미정';
    const timeKey = r.event_time || '시간미정';
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const slots = byDate.get(dateKey);
    if (!slots.has(timeKey)) slots.set(timeKey, []);
    slots.get(timeKey).push({ status: r.status, cnt: r.cnt, members: r.members });
  }

  const lines = ['🗓 *시간대별 참석 현황* _(행사 현지시각 기준)_'];
  for (const [date, slots] of byDate) {
    lines.push('', `📅 *${date}${weekdaySuffix(date)}*`);
    for (const [time, statuses] of slots) {
      statuses.forEach((st, i) => {
        const who = st.members.map((m) => `<@${m}>`).join(' ');
        // 같은 시간대에 상태가 여러 개면 첫 줄에만 시간을 쓰고 나머지는 들여쓴다
        const prefix = i === 0 ? `\`${time}\`` : '　　　　';
        lines.push(`${prefix}  ${st.status} ${st.cnt}명 · ${who}`);
      });
    }
  }
  return joinWithinLimit(lines);
}

// /event-stats 쿼리 결과(이벤트×상태 단위 행)를 이벤트별 통계 텍스트로 만든다.
// '대기'처럼 특정 상태를 하드코딩해 세면 Luma에 새 상태(예: '대기자 명단')가 등장할 때
// 조용히 누락되므로, 실제로 존재하는 상태를 그대로 나열한다.
function buildEventStatsText(rows) {
  if (!rows.length) return '이벤트가 없습니다.';

  const byEvent = new Map();
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) {
      byEvent.set(r.event_id, { date: r.event_date, time: r.event_time, title: r.title, statuses: [] });
    }
    byEvent.get(r.event_id).statuses.push({ status: r.status, cnt: r.cnt });
  }

  const lines = ['📊 *이벤트별 신청 통계* _(행사 현지시각 기준)_'];
  for (const ev of byEvent.values()) {
    const total = ev.statuses.reduce((sum, s) => sum + s.cnt, 0);
    const breakdown = ev.statuses.map((s) => `${s.status} ${s.cnt}`).join(', ');
    lines.push(`${fmtWhen({ event_date: ev.date, event_time: ev.time })} | ${ev.title} — 총 ${total}명 · ${breakdown}`);
  }
  return joinWithinLimit(lines);
}

// 이벤트 중복 판정 키. 제목의 공백/대소문자 차이로 같은 이벤트가 갈라지지 않게 정규화한다.
// migrateDedupKey()의 SQL 백필과 동일한 규칙을 유지해야 한다.
function dedupKey(title, eventDate) {
  const normalized = String(title || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return `${normalized}|${eventDate || ''}`;
}

module.exports = {
  fmtWhen, weekdaySuffix, joinWithinLimit, buildScheduleText, buildEventStatsText, dedupKey,
};
