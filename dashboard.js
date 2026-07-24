// 관리자 대시보드. 조회·렌더·HTTP 핸들러 모두 의존성을 인자로 받아 Slack 앱 없이 단독 테스트 가능.
const crypto = require('crypto');
const { weekdaySuffix, STATUS_VALUES } = require('./format');

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

// 이벤트×상태 행을 시간대 뷰용 페이로드로 접는다. 순수 함수라 단독 테스트 가능하고,
// 브라우저가 이 JSON을 받아 분포/타임라인을 실시간으로 다시 그린다(새로고침 없이 필터).
function buildTimeSlotPayload(eventRows) {
  const byEvent = new Map();
  const statusSet = new Set();
  for (const r of eventRows) {
    if (!byEvent.has(r.event_id)) {
      byEvent.set(r.event_id, {
        id: r.event_id,
        date: r.event_date || null,
        time: r.event_time || null,
        title: r.title,
        location: r.location || null,
        // javascript: 같은 스킴이 클라이언트에서 링크로 실행되지 않도록 http(s)만 통과시킨다
        url: /^https?:\/\//i.test(r.luma_url || '') ? r.luma_url : null,
        statuses: [],
      });
    }
    if (r.status) {
      statusSet.add(r.status);
      byEvent.get(r.event_id).statuses.push({
        status: r.status,
        cnt: r.cnt,
        members: r.members || [],
      });
    }
  }
  const events = [...byEvent.values()];
  const dateSet = new Set(events.map((e) => e.date));
  const dates = [...dateSet].filter(Boolean).sort();
  // 정규화된 상태 순서를 우선하고, 목록에 없는 값은 뒤에 알파벳순으로 붙인다
  const statuses = [...statusSet].sort((a, b) => {
    const ia = STATUS_VALUES.indexOf(a);
    const ib = STATUS_VALUES.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  return { events, dates, hasTBD: dateSet.has(null), statuses };
}

// <script type="application/json"> 안에 안전하게 넣기 위한 직렬화.
// '<'를 이스케이프하면 </script> 조기 종료와 <!-- 주입을 막을 수 있고, JSON.parse 결과는 동일하다.
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/[<\u2028\u2029]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
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
.tabs{display:flex;gap:2px;flex-wrap:wrap;margin:20px 0 4px;border-bottom:1px solid var(--line)}
.tab{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:8px 12px;
  cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--fg)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.tab-panel{padding-top:12px}
body.js .tab-panel{display:none}
body.js .tab-panel.active{display:block}
.hint{color:var(--muted);font-size:13px;margin:0 0 12px}
.filter{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 16px}
.chip{display:inline-flex;align-items:center;gap:4px;background:var(--card);border:1px solid var(--line);
  border-radius:999px;padding:3px 10px;font-size:13px;cursor:pointer;user-select:none}
.controls{display:flex;align-items:center;gap:8px;margin:2px 0 14px;flex-wrap:wrap}
select{font:inherit;font-size:14px;padding:5px 8px;background:var(--card);color:var(--fg);
  border:1px solid var(--line);border-radius:8px}
.bar-row{display:flex;align-items:center;gap:10px;margin:3px 0}
.bar-label{width:52px;color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px;text-align:right}
.bar-track{flex:1;background:var(--card);border-radius:6px;height:18px;overflow:hidden}
.bar-fill{height:100%;background:var(--accent);border-radius:6px;min-width:2px;transition:width .2s}
.bar-val{width:40px;font-variant-numeric:tabular-nums;font-size:13px}
.conflict{background:var(--card);border:1px solid var(--accent);border-radius:10px;padding:10px 12px;margin:4px 0 16px}
.conflict strong{display:block;margin-bottom:4px}
.tl-row{padding:10px 0;border-bottom:1px solid var(--line)}
.tl-row.concurrent{border-left:3px solid var(--accent);padding-left:11px;margin-left:-14px}
.tl-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tl-bar{display:flex;align-items:center;gap:10px;margin:6px 0 4px;max-width:520px}
.tl-bar .bar-track{height:14px}
.tl-tags{margin-top:2px}
.flag{color:var(--accent);font-size:12px;white-space:nowrap}
`;

// 브라우저에서 실행되는 인터랙션 코드. 임베드된 JSON을 읽어 분포·타임라인을 다시 그린다.
// 외부 문자열(제목/장소/참석자명)은 전부 textContent로만 넣어 DOM XSS를 원천 차단한다.
// 바깥 템플릿 리터럴과 충돌하지 않도록 이 문자열 안에서는 백틱과 ${}를 쓰지 않는다.
const CLIENT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('ts-data').textContent);
  var events = data.events, statuses = data.statuses, dates = data.dates, hasTBD = data.hasTBD;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }
  function hourOf(t) { return t ? parseInt(t.slice(0, 2), 10) : null; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---- 탭 전환 ----
  var tabs = [].slice.call(document.querySelectorAll('.tab'));
  var panels = [].slice.call(document.querySelectorAll('.tab-panel'));
  function activate(name) {
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    panels.forEach(function (p) { p.classList.toggle('active', p.dataset.panel === name); });
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { activate(t.dataset.tab); }); });

  // ---- View A: 시간대 분포 ----
  var active = {};
  statuses.forEach(function (s) { active[s] = true; });
  var distBody = document.getElementById('dist-body');
  var distFilter = document.getElementById('dist-filter');
  var distDate = document.getElementById('dist-date');

  function renderDist() {
    var only = distDate.value;
    var byHour = {}, maxv = 0, tbd = 0;
    events.forEach(function (ev) {
      if (only !== '__ALL__' && ev.date !== (only === '__TBD__' ? null : only)) return;
      var sum = 0;
      ev.statuses.forEach(function (st) { if (active[st.status]) sum += st.cnt; });
      if (!sum) return;
      var h = hourOf(ev.time);
      if (h == null) { tbd += sum; return; }
      byHour[h] = (byHour[h] || 0) + sum;
      if (byHour[h] > maxv) maxv = byHour[h];
    });
    distBody.textContent = '';
    var hours = Object.keys(byHour).map(Number).sort(function (a, b) { return a - b; });
    if (!hours.length) {
      distBody.appendChild(el('p', 'empty', 'No attendees for the selected filters.'));
      return;
    }
    hours.forEach(function (h) {
      var row = el('div', 'bar-row');
      row.appendChild(el('span', 'bar-label', pad2(h) + ':00'));
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (maxv ? byHour[h] / maxv * 100 : 0) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'bar-val', byHour[h]));
      distBody.appendChild(row);
    });
    if (tbd) distBody.appendChild(el('p', 'who', 'Time TBD: ' + tbd));
  }

  statuses.forEach(function (s) {
    var lab = el('label', 'chip');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', function () { active[s] = cb.checked; renderDist(); });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(s));
    distFilter.appendChild(lab);
  });
  var optAll = document.createElement('option');
  optAll.value = '__ALL__';
  optAll.textContent = 'All dates';
  distDate.appendChild(optAll);
  dates.forEach(function (d) {
    var o = document.createElement('option');
    o.value = d; o.textContent = d;
    distDate.appendChild(o);
  });
  if (hasTBD) {
    var oT = document.createElement('option');
    oT.value = '__TBD__'; oT.textContent = 'Date TBD';
    distDate.appendChild(oT);
  }
  distDate.addEventListener('change', renderDist);

  // ---- View B: 날짜별 타임라인 ----
  var tlSelect = document.getElementById('tl-date');
  var tlBody = document.getElementById('tl-body');
  var tlDates = dates.slice();
  if (hasTBD) tlDates.push('__TBD__');
  tlDates.forEach(function (d) {
    var o = document.createElement('option');
    o.value = d;
    o.textContent = d === '__TBD__' ? 'Date TBD' : d;
    tlSelect.appendChild(o);
  });

  function eventsForDate(d) {
    var want = d === '__TBD__' ? null : d;
    return events.filter(function (ev) { return ev.date === want; })
      .sort(function (a, b) {
        return (a.time || '~').localeCompare(b.time || '~') || a.title.localeCompare(b.title);
      });
  }
  function goingMembers(ev) {
    var m = [];
    ev.statuses.forEach(function (st) { if (st.status === 'Going') m = m.concat(st.members); });
    return m;
  }
  function renderTimeline() {
    var evs = eventsForDate(tlSelect.value);
    tlBody.textContent = '';
    if (!evs.length) { tlBody.appendChild(el('p', 'empty', 'No events on this date.')); return; }

    var byTime = {};
    evs.forEach(function (ev) { var k = ev.time || 'TBD'; (byTime[k] = byTime[k] || []).push(ev); });

    // 같은 시각에 Going이 겹치는 사람(개인 일정 충돌)
    var conflicts = [];
    Object.keys(byTime).forEach(function (t) {
      if (byTime[t].length < 2) return;
      var seen = {};
      byTime[t].forEach(function (ev) {
        goingMembers(ev).forEach(function (m) { (seen[m] = seen[m] || []).push(ev.title); });
      });
      Object.keys(seen).forEach(function (m) {
        if (seen[m].length > 1) conflicts.push({ who: m, time: t, titles: seen[m] });
      });
    });
    if (conflicts.length) {
      var warn = el('div', 'conflict');
      warn.appendChild(el('strong', null, 'Time conflicts (' + conflicts.length + ')'));
      conflicts.forEach(function (c) {
        warn.appendChild(el('div', 'who', c.who + '  ' + c.time + ' : ' + c.titles.join(' / ')));
      });
      tlBody.appendChild(warn);
    }

    var maxTotal = 0;
    evs.forEach(function (ev) {
      var tot = 0;
      ev.statuses.forEach(function (st) { tot += st.cnt; });
      ev._tot = tot;
      if (tot > maxTotal) maxTotal = tot;
    });
    evs.forEach(function (ev) {
      var concurrent = byTime[ev.time || 'TBD'].length > 1;
      var row = el('div', 'tl-row' + (concurrent ? ' concurrent' : ''));
      var head = el('div', 'tl-head');
      head.appendChild(el('code', null, ev.time || 'TBD'));
      if (ev.url) {
        var a = el('a', null, ev.title);
        a.href = ev.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        head.appendChild(a);
      } else {
        head.appendChild(el('span', null, ev.title));
      }
      if (concurrent) head.appendChild(el('span', 'flag', 'concurrent'));
      row.appendChild(head);
      if (ev.location) row.appendChild(el('div', 'who', ev.location));

      var bar = el('div', 'tl-bar');
      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill');
      fill.style.width = (maxTotal ? ev._tot / maxTotal * 100 : 0) + '%';
      track.appendChild(fill);
      bar.appendChild(track);
      bar.appendChild(el('span', 'bar-val', ev._tot));
      row.appendChild(bar);

      var tags = el('div', 'tl-tags');
      ev.statuses.forEach(function (st) { tags.appendChild(el('span', 'tag', st.status + ' ' + st.cnt)); });
      row.appendChild(tags);
      tlBody.appendChild(row);
    });
  }
  tlSelect.addEventListener('change', renderTimeline);

  renderDist();
  renderTimeline();
  activate('overview');
})();
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
  const payload = buildTimeSlotPayload(eventRows);
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

<div class="tabs" role="tablist">
  <button class="tab" data-tab="overview">By time slot</button>
  <button class="tab" data-tab="timeline">Timeline</button>
  <button class="tab" data-tab="schedule">Schedule</button>
  <button class="tab" data-tab="people">People</button>
</div>

<section class="tab-panel" data-panel="overview">
  <p class="hint">Total attendees per hour, summed across the selected dates and statuses.</p>
  <div class="controls">
    <label for="dist-date">Date</label><select id="dist-date"></select>
  </div>
  <div class="filter" id="dist-filter"></div>
  <div id="dist-body"></div>
</section>

<section class="tab-panel" data-panel="timeline">
  <p class="hint">Events on a single day in time order. Concurrent slots are highlighted, and people going to two events at the same time are listed as conflicts.</p>
  <div class="controls">
    <label for="tl-date">Date</label><select id="tl-date"></select>
  </div>
  <div id="tl-body"></div>
</section>

<section class="tab-panel" data-panel="schedule">
${renderEventsByDate(eventRows)}
</section>

<section class="tab-panel" data-panel="people">
${renderStudents(studentRows)}
</section>

<script type="application/json" id="ts-data">${jsonForScript(payload)}</script>
<script>document.body.classList.add('js');</script>
<script>${CLIENT_JS}</script>
</div></body></html>`;
}

module.exports = {
  createAdminHandler, tokenMatches, fetchDashboardData, buildTimeSlotPayload,
  renderDashboard, renderEventsByDate, renderStudents, escapeHtml,
};
