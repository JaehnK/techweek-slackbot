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
  const [summary, events, students, studentEvents] = await Promise.all([
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
    // 사람별 신청 내역(이벤트 단위). People 탭에서 사람을 펼치면 일별로 보여준다.
    pool.query(`
      SELECT a.student_id,
             TO_CHAR(e.event_date, 'YYYY-MM-DD') AS event_date,
             TO_CHAR(e.event_time, 'HH24:MI')    AS event_time,
             e.title, e.location, e.luma_url, a.status
      FROM applications a
      JOIN events e ON e.id = a.event_id
      ORDER BY a.student_id, e.event_date NULLS LAST, e.event_time NULLS LAST, e.title
    `),
  ]);

  return {
    summary: summary.rows[0],
    eventRows: events.rows,
    studentRows: students.rows,
    studentEventRows: studentEvents.rows,
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

// 미등록자 산출용. 코호트(교육생) 판별은 42 캠퍼스 접미사로 한다. 운영/멘토(_IA, _GSIA,
// 영문 이름 등)를 걸러내기 위한 휴리스틱이며, 기준이 바뀌면 이 정규식만 고치면 된다.
const COHORT_RE = /_42\s*(seoul|gyeongsan)/i;
function normName(s) { return String(s || '').toLowerCase().replace(/[\s_]+/g, ''); }

// 워크스페이스 로스터에서 "코호트인데 봇에 등록 안 한 사람"을 뽑는다. 순수 함수.
// - 등록 여부는 Slack 계정 ID로 대조한다(봇이 저장하는 키가 ID라서).
// - 이름이 같은 중복 계정은 한 사람으로 합치되, 계정 ID는 모두 보존한다.
// - 이름이 이미 등록자 명단에 있으면(다른 ID로 등록한 부계정 가능성) alt로 표시만 하고 목록에는 남긴다.
function computeUnregistered({ rosterMembers, registeredIds, registeredNames }) {
  const idSet = registeredIds instanceof Set ? registeredIds : new Set(registeredIds || []);
  const nameSet = new Set((registeredNames || []).map(normName));
  const byName = new Map();
  for (const m of rosterMembers || []) {
    if (!COHORT_RE.test(m.name)) continue;
    if (idSet.has(m.id)) continue;
    const key = normName(m.name);
    if (!byName.has(key)) byName.set(key, { name: m.name, ids: [], alt: nameSet.has(key) });
    byName.get(key).ids.push(m.id);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// <script type="application/json"> 안에 안전하게 넣기 위한 직렬화.
// '<'를 이스케이프하면 </script> 조기 종료와 <!-- 주입을 막을 수 있고, JSON.parse 결과는 동일하다.
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/[<\u2028\u2029]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// href에 넣어도 안전한 URL만 통과시킨다(javascript: 등 스킴 차단). 아니면 null.
function safeUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : null;
}

// 상태값을 색상 클래스 슬러그로. 정규화 값이 바뀌어도 접두어 매칭이라 잘 견딘다.
function statusSlug(status) {
  const s = String(status || '').toLowerCase();
  if (s.startsWith('going')) return 'going';
  if (s.startsWith('pending')) return 'pending';
  if (s.startsWith('wait')) return 'waitlist';
  if (s.startsWith('invit')) return 'invited';
  return 'unknown';
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
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#5c6470;--line:#e6e8ec;--card:#f6f7f9;--hover:#f0f2f5;--accent:#2f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8e8ea;--muted:#9aa0a6;--line:#272b33;--card:#1a1d23;--hover:#1f232a;--accent:#6ea8ff}}
*{box-sizing:border-box}
body{margin:0;padding:28px 24px 64px;background:var(--bg);color:var(--fg);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
.wrap{max-width:1040px;margin:0 auto}
h1{font-size:25px;font-weight:700;letter-spacing:-.01em;margin:0 0 4px}
h2{font-size:16px;font-weight:700;letter-spacing:.01em;margin:34px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
.meta{color:var(--muted);font-size:13px;margin-bottom:24px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.card{flex:1 1 150px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.card .n{font-size:30px;font-weight:750;line-height:1.1;letter-spacing:-.02em}
.card .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-top:2px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;font-size:14px;min-width:600px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--hover)}
thead th{position:sticky;top:0;background:var(--bg);color:var(--muted);font-weight:600;font-size:11px;
  text-transform:uppercase;letter-spacing:.05em;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:600}
.day{margin:26px 0 10px;font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.day::before{content:"";width:4px;height:15px;border-radius:2px;background:var(--accent);display:inline-block}
code{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:2px 7px;
  font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
.brk{margin:2px 0}
.tag{--tc:var(--muted);display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;
  font-weight:600;margin:0 5px 5px 0;white-space:nowrap;color:var(--tc);
  background:color-mix(in srgb,var(--tc) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--tc) 34%,transparent)}
.st-going{--tc:#137333}.st-pending{--tc:#a15c00}.st-waitlist{--tc:#4f46e5}
.st-invited{--tc:#0e7490}.st-unknown{--tc:#6b7280}
@media (prefers-color-scheme:dark){
  .st-going{--tc:#4ade80}.st-pending{--tc:#fbbf24}.st-waitlist{--tc:#a5b4fc}
  .st-invited{--tc:#67e8f9}.st-unknown{--tc:#9aa0a6}}
.who{color:var(--muted);font-size:13px;line-height:1.5}
.acc{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.acc-item{border-bottom:1px solid var(--line)}
.acc-item:last-child{border-bottom:0}
.acc-sum{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 16px}
.acc-sum::-webkit-details-marker{display:none}
.acc-sum::before{content:"\\25B8";color:var(--muted);font-size:12px;transition:transform .15s;flex:0 0 auto}
details[open] .acc-sum::before{transform:rotate(90deg)}
.acc-sum:hover{background:var(--hover)}
.acc-name{flex:1 1 180px;font-weight:600;display:flex;flex-direction:column;gap:1px;min-width:0}
.acc-name .who{font-weight:400}
.acc-total{font-variant-numeric:tabular-nums;font-weight:700;min-width:26px;text-align:right}
.acc-tags{display:flex;flex-wrap:wrap;gap:0;justify-content:flex-end;align-items:center}
.acc-body{padding:2px 16px 16px 40px;background:var(--card)}
.acc-body .day{margin:14px 0 6px}
.ev{display:flex;align-items:baseline;gap:10px;padding:4px 0}
.ev-title{flex:1;min-width:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.empty{color:var(--muted);padding:20px 0}
.tabs{display:flex;gap:2px;flex-wrap:wrap;margin:20px 0 4px;border-bottom:1px solid var(--line)}
.tab{background:none;border:0;color:var(--muted);font:inherit;font-size:14px;padding:8px 12px;
  cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tab:hover{color:var(--fg)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.tab-panel{padding-top:12px}
body.js .tab-panel{display:none}
body.js .tab-panel.active{display:block}
.hint{color:var(--muted);font-size:13px;margin:0 0 12px}
.subhead{font-weight:700;margin:24px 0 6px}
.grp{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em;font-weight:600;margin:16px 0 8px}
.people-grid{display:flex;flex-wrap:wrap;gap:8px}
.person{display:inline-flex;align-items:center;gap:6px;background:var(--card);border:1px solid var(--line);
  border-radius:8px;padding:6px 11px;font-size:14px}
.person .badge{color:var(--accent);font-size:11px;font-weight:600;border:1px solid var(--accent);
  border-radius:5px;padding:0 5px;line-height:1.5}
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
.tag.has-members{cursor:help;text-decoration:underline dotted;text-underline-offset:2px}
.tip{position:fixed;z-index:50;max-width:300px;background:var(--fg);color:var(--bg);
  padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.45;pointer-events:none;
  box-shadow:0 6px 20px rgba(0,0,0,.28)}
.tip-head{font-weight:600;font-size:12px;opacity:.8;margin-bottom:3px}
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
  function statusSlug(s) {
    s = (s || '').toLowerCase();
    if (s.indexOf('going') === 0) return 'going';
    if (s.indexOf('pending') === 0) return 'pending';
    if (s.indexOf('wait') === 0) return 'waitlist';
    if (s.indexOf('invit') === 0) return 'invited';
    return 'unknown';
  }

  // 상태 태그에 커서를 올리면 참석자 명단을 띄우는 공용 툴팁.
  // 이름은 외부 문자열이라 textContent로만 넣는다(속성/innerHTML 미사용).
  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.style.display = 'none';
  document.body.appendChild(tip);
  function attachTip(node, status, members) {
    node.addEventListener('mouseenter', function () {
      tip.textContent = '';
      tip.appendChild(el('div', 'tip-head', status + '  ' + members.length));
      tip.appendChild(el('div', null, members.join(', ')));
      tip.style.display = 'block';
    });
    node.addEventListener('mousemove', function (e) {
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + tip.offsetWidth > window.innerWidth - 8) x = e.clientX - tip.offsetWidth - 14;
      if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 14;
      tip.style.left = x + 'px';
      tip.style.top = y + 'px';
    });
    node.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
  }

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
      ev.statuses.forEach(function (st) {
        var cls = 'tag st-' + statusSlug(st.status);
        var tag = el('span', cls, st.status + ' ' + st.cnt);
        if (st.members && st.members.length) {
          tag.className = cls + ' has-members';
          attachTip(tag, st.status, st.members);
        }
        tags.appendChild(tag);
      });
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
      const url = safeUrl(ev.luma_url);
      const title = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ev.title)}</a>`
        : escapeHtml(ev.title);
      const where = ev.location ? `<div class="who">${escapeHtml(ev.location)}</div>` : '';
      const breakdown = ev.statuses.map((s) => {
        const who = (s.members || []).map((m) => escapeHtml(m)).join(', ');
        return `<div class="brk"><span class="tag st-${statusSlug(s.status)}">${escapeHtml(s.status)} ${s.cnt}</span>`
          + `<span class="who">${who}</span></div>`;
      }).join('');
      html += `<tr><td><code>${escapeHtml(ev.time || 'TBD')}</code></td>`
        + `<td>${title}${where}</td><td class="num">${total}</td><td>${breakdown}</td></tr>`;
    }
    html += '</tbody></table></div>';
  }
  return html;
}

// 한 사람의 신청 내역을 일별로 묶어 렌더한다(아코디언 본문).
function renderPersonSchedule(events) {
  if (!events || !events.length) return '<p class="who">no registrations</p>';
  const byDate = new Map();
  for (const e of events) {
    const key = e.event_date || 'Date TBD';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(e);
  }
  let html = '';
  for (const [date, evs] of byDate) {
    html += `<div class="day">${escapeHtml(date)}${escapeHtml(weekdaySuffix(date))}</div>`;
    for (const e of evs) {
      const url = safeUrl(e.luma_url);
      const title = url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.title)}</a>`
        : escapeHtml(e.title);
      const loc = e.location ? `<span class="who"> · ${escapeHtml(e.location)}</span>` : '';
      html += `<div class="ev"><code>${escapeHtml(e.event_time || 'TBD')}</code>`
        + `<span class="ev-title">${title}${loc}</span>`
        + `<span class="tag st-${statusSlug(e.status)}">${escapeHtml(e.status)}</span></div>`;
    }
  }
  return html;
}

// 학생 행(학생×상태)을 사람별 아코디언으로 만든다. 헤더를 누르면 신청 스케줄이 일별로 펼쳐진다.
function renderStudents(studentRows, studentEventRows = []) {
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

  const eventsByStudent = new Map();
  for (const r of studentEventRows || []) {
    if (!eventsByStudent.has(r.student_id)) eventsByStudent.set(r.student_id, []);
    eventsByStudent.get(r.student_id).push(r);
  }

  let html = '<div class="acc">';
  for (const [id, st] of byStudent) {
    const tags = st.statuses.length
      ? st.statuses.map((s) => `<span class="tag st-${statusSlug(s.status)}">${escapeHtml(s.status)} ${s.cnt}</span>`).join('')
      : '<span class="who">no registrations</span>';
    // 표시 이름을 못 받아온 경우 label이 곧 Slack ID이므로 중복 표기하지 않는다
    const sub = st.label === st.slackId ? '' : `<span class="who">${escapeHtml(st.slackId)}</span>`;
    html += '<details class="acc-item"><summary class="acc-sum">'
      + `<span class="acc-name">${escapeHtml(st.label)}${sub}</span>`
      + `<span class="acc-total">${st.total}</span>`
      + `<span class="acc-tags">${tags}</span></summary>`
      + `<div class="acc-body">${renderPersonSchedule(eventsByStudent.get(id))}</div>`
      + '</details>';
  }
  return `${html}</div>`;
}

// 미등록 교육생 목록. unregistered가 null이면 로스터를 못 받은 것(스코프/네트워크)이라 그걸 알린다.
// 읽기 쉽도록 캠퍼스별로 묶고, 중복되는 _42 접미사는 떼서 사람 이름만 칩으로 보여준다.
function renderUnregistered(unregistered) {
  if (unregistered == null) {
    return '<div class="subhead">Not registered</div>'
      + '<p class="who">Roster unavailable — the bot needs the <code>users:read</code> scope to list who has not registered.</p>';
  }
  if (!unregistered.length) {
    return '<div class="subhead">Not registered — 0</div>'
      + '<p class="who">Everyone in the cohort has registered a schedule.</p>';
  }

  // 캠퍼스별로 분류하고 접미사를 제거한다
  const groups = { Seoul: [], Gyeongsan: [], Other: [] };
  for (const u of unregistered) {
    const m = /_?42\s*(seoul|gyeongsan)/i.exec(u.name);
    const campus = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
    const person = u.name.replace(/_?42\s*(seoul|gyeongsan)/i, '').replace(/[_\s]+$/, '').trim() || u.name;
    (campus && groups[campus] ? groups[campus] : groups.Other).push({ person, alt: u.alt, ids: u.ids });
  }

  const chip = (p) => {
    const badges = (p.ids && p.ids.length > 1 ? `<span class="badge">×${p.ids.length}</span>` : '')
      + (p.alt ? '<span class="badge" title="Same name already registered under another ID">alt?</span>' : '');
    return `<span class="person">${escapeHtml(p.person)}${badges}</span>`;
  };
  const section = (label, list) => (list.length
    ? `<div class="grp">${label} · ${list.length}</div>`
      + `<div class="people-grid">${list.map(chip).join('')}</div>`
    : '');

  return `<div class="subhead">Not registered — ${unregistered.length}</div>`
    + '<p class="hint">Cohort members (42 campuses) with no schedule in the bot yet.</p>'
    + section('42 Seoul', groups.Seoul)
    + section('42 Gyeongsan', groups.Gyeongsan)
    + section('Other', groups.Other);
}

function renderDashboard({
  summary, eventRows, studentRows, studentEventRows, unregistered, generatedAt,
}) {
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
${renderStudents(studentRows, studentEventRows)}
${renderUnregistered(unregistered)}
</section>

<script type="application/json" id="ts-data">${jsonForScript(payload)}</script>
<script>document.body.classList.add('js');</script>
<script>${CLIENT_JS}</script>
</div></body></html>`;
}

module.exports = {
  createAdminHandler, tokenMatches, fetchDashboardData, buildTimeSlotPayload, computeUnregistered,
  renderDashboard, renderEventsByDate, renderStudents, renderUnregistered, escapeHtml,
};
