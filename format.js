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

// /schedule 쿼리 결과(이벤트×상태 단위 행)를 날짜별 타임라인 텍스트로 만든다.
function buildScheduleText(rows) {
  if (!rows.length) return '신청 내역이 없습니다.';

  // 날짜 → 이벤트 → 상태별 참석자로 묶는다 (Map이라 쿼리의 정렬 순서가 유지됨)
  const byDate = new Map();
  for (const r of rows) {
    const dateKey = r.event_date || '날짜 미정';
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const events = byDate.get(dateKey);
    if (!events.has(r.event_id)) {
      events.set(r.event_id, { time: r.event_time, title: r.title, statuses: [] });
    }
    events.get(r.event_id).statuses.push({ status: r.status, cnt: r.cnt, members: r.members });
  }

  const lines = ['🗓 *시간대별 참석 현황* _(행사 현지시각 기준)_'];
  for (const [date, events] of byDate) {
    lines.push('', `📅 *${date}${weekdaySuffix(date)}*`);
    for (const ev of events.values()) {
      lines.push(`\`${ev.time || '시간미정'}\`  ${ev.title}`);
      for (const st of ev.statuses) {
        const who = st.members.map((m) => `<@${m}>`).join(' ');
        lines.push(`　　${st.status} ${st.cnt}명 · ${who}`);
      }
    }
  }
  return joinWithinLimit(lines);
}

module.exports = { fmtWhen, weekdaySuffix, joinWithinLimit, buildScheduleText };
