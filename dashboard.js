// 관리자 대시보드. 조회·렌더·HTTP 핸들러 모두 의존성을 인자로 받아 Slack 앱 없이 단독 테스트 가능.
const crypto = require('crypto');
const { weekdaySuffix } = require('./format');

// 길이가 달라도 timingSafeEqual이 던지지 않도록 해시로 비교한다.
function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// GET /admin 핸들러. 토큰이 없으면 존재 자체를 숨기고(404), 틀리면 401.
function createAdminHandler({ token, buildHtml }) {
  return async (req, res) => {
    try {
      if (!token) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(token, url.searchParams.get('key') || bearer)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // 토큰이 URL에 담기므로 캐시/색인/리퍼러 유출을 막는다
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
      res.end(await buildHtml());
    } catch (err) {
      console.error('dashboard error:', err);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Internal error');
    }
  };
}

// 대시보드가 쓰는 세 갈래 집계. 서로 독립이라 병렬로 던진다.
async function fetchDashboardData(pool) {
  const [summary, events, students] = await Promise.all([
    pool.query(`
      SELECT (SELECT COUNT(*) FROM students)::int     AS students,
             (SELECT COUNT(*) FROM events)::int       AS events,
             (SELECT COUNT(*) FROM applications)::int AS applications
    `),
    pool.query(`
      SELECT e.id AS event_id, e.title, e.location, e.luma_url,
             TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
             TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
             a.status,
             COUNT(*)::int AS cnt,
             ARRAY_AGG(COALESCE(s.display_name, s.name)
                       ORDER BY COALESCE(s.display_name, s.name)) AS members
      FROM events e
      JOIN applications a ON a.event_id = e.id
      JOIN students s     ON s.id = a.student_id
      GROUP BY e.id, e.title, e.location, e.luma_url, e.event_date, e.event_time, a.status
      ORDER BY e.event_date NULLS LAST, e.event_time NULLS LAST, e.title, a.status
    `),
    // 신청이 0건인 사람도 보여야 하므로 students에서 LEFT JOIN 한다.
    // 그 경우 status는 null, COUNT(a.id)는 0이 되고 렌더 쪽에서 걸러낸다.
    pool.query(`
      SELECT s.id AS student_id,
             COALESCE(s.display_name, s.name) AS label,
             s.name                           AS slack_id,
             a.status,
             COUNT(a.id)::int                                 AS cnt,
             SUM(COUNT(a.id)) OVER (PARTITION BY s.id)::int   AS total
      FROM students s
      LEFT JOIN applications a ON a.student_id = s.id
      GROUP BY s.id, s.display_name, s.name, a.status
      ORDER BY total DESC, label, a.status
    `),
  ]);

  return {
    summary: summary.rows[0],
    eventRows: events.rows,
    studentRows: students.rows,
  };
}

// 이벤트 제목·장소·호스트는 Luma에서 파싱한 외부 문자열이라 반드시 이스케이프한다.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e5e5e5;--card:#f7f7f8;--accent:#2f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8e8ea;--muted:#9aa0a6;--line:#2a2e35;--card:#1c1f25;--accent:#6ea8ff}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
  font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.meta{color:var(--muted);font-size:13px;margin-bottom:20px}
.cards{display:flex;gap:12px;flex-wrap:wrap}
.card{flex:1 1 150px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .n{font-size:26px;font-weight:700;line-height:1.2}
.card .l{color:var(--muted);font-size:13px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:640px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.day{margin:22px 0 8px;font-weight:700}
code{background:var(--card);border:1px solid var(--line);border-radius:5px;padding:1px 6px;
  font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.tag{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;
  padding:1px 9px;font-size:12px;margin:0 4px 4px 0;white-space:nowrap}
.who{color:var(--muted);font-size:13px}
a{color:var(--accent)}
.empty{color:var(--muted);padding:16px 0}
`;

// 이벤트 행(이벤트×상태)을 날짜별로 묶어 타임라인 테이블로 만든다.
function renderEventsByDate(eventRows) {
  const byDate = new Map();
  for (const r of eventRows) {
    const dateKey = r.event_date || 'Date TBD';
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const events = byDate.get(dateKey);
    if (!events.has(r.event_id)) {
      events.set(r.event_id, {
        time: r.event_time, title: r.title, location: r.location,
        luma_url: r.luma_url, statuses: [],
      });
    }
    events.get(r.event_id).statuses.push({ status: r.status, cnt: r.cnt, members: r.members });
  }

  if (!byDate.size) return '<p class="empty">No events yet.</p>';

  let html = '';
  for (const [date, events] of byDate) {
    html += `<div class="day">${escapeHtml(date)}${escapeHtml(weekdaySuffix(date))}</div>`;
    html += '<div class="scroll"><table><thead><tr>'
      + '<th>Time</th><th>Event</th><th class="num">Total</th><th>Breakdown</th></tr></thead><tbody>';
    for (const ev of events.values()) {
      const total = ev.statuses.reduce((sum, s) => sum + s.cnt, 0);
      const title = ev.luma_url
        ? `<a href="${escapeHtml(ev.luma_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ev.title)}</a>`
        : escapeHtml(ev.title);
      const where = ev.location ? `<div class="who">${escapeHtml(ev.location)}</div>` : '';
      const breakdown = ev.statuses.map((s) => {
        const who = (s.members || []).map((m) => escapeHtml(m)).join(', ');
        return `<div><span class="tag">${escapeHtml(s.status)} ${s.cnt}</span>`
          + `<span class="who">${who}</span></div>`;
      }).join('');
      html += `<tr><td><code>${escapeHtml(ev.time || 'TBD')}</code></td>`
        + `<td>${title}${where}</td><td class="num">${total}</td><td>${breakdown}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  return html;
}

// 학생 행(학생×상태)을 사람별 요약 테이블로 만든다.
function renderStudents(studentRows) {
  const byStudent = new Map();
  for (const r of studentRows) {
    if (!byStudent.has(r.student_id)) {
      byStudent.set(r.student_id, { label: r.label, slackId: r.slack_id, total: r.total, statuses: [] });
    }
    // LEFT JOIN이라 신청이 없는 학생은 status가 null로 한 행 들어온다
    if (r.status && r.cnt > 0) {
      byStudent.get(r.student_id).statuses.push({ status: r.status, cnt: r.cnt });
    }
  }

  if (!byStudent.size) return '<p class="empty">No one has registered a schedule yet.</p>';

  let html = '<div class="scroll"><table><thead><tr>'
    + '<th>Person</th><th class="num">Total</th><th>Breakdown</th></tr></thead><tbody>';
  for (const st of byStudent.values()) {
    const breakdown = st.statuses.length
      ? st.statuses.map((s) => `<span class="tag">${escapeHtml(s.status)} ${s.cnt}</span>`).join('')
      : '<span class="who">no registrations</span>';
    // 표시 이름을 못 받아온 경우 label이 곧 Slack ID이므로 중복 표기하지 않는다
    const sub = st.label === st.slackId ? '' : `<div class="who">${escapeHtml(st.slackId)}</div>`;
    html += `<tr><td>${escapeHtml(st.label)}${sub}</td>`
      + `<td class="num">${st.total}</td><td>${breakdown}</td></tr>`;
  }
  return `${html}</tbody></table></div>`;
}

function renderDashboard({ summary, eventRows, studentRows, generatedAt }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>TechWeek Manager — Admin</title>
<style>${STYLE}</style>
</head><body><div class="wrap">
<h1>TechWeek Manager — Admin Dashboard</h1>
<div class="meta">All dates and times are in event local time · Generated ${escapeHtml(generatedAt)}</div>

<div class="cards">
  <div class="card"><div class="n">${summary.students}</div><div class="l">People</div></div>
  <div class="card"><div class="n">${summary.events}</div><div class="l">Events</div></div>
  <div class="card"><div class="n">${summary.applications}</div><div class="l">Registrations</div></div>
</div>

<h2>Schedule by date</h2>
${renderEventsByDate(eventRows)}

<h2>Registrations by person</h2>
${renderStudents(studentRows)}
</div></body></html>`;
}

module.exports = {
  createAdminHandler, tokenMatches, fetchDashboardData,
  renderDashboard, renderEventsByDate, renderStudents, escapeHtml,
};
