// 슬래시 커맨드 출력 포맷 회귀 테스트. 외부 의존(DB/API) 없이 실행된다.
const assert = require('assert');
const {
  fmtWhen, weekdaySuffix, buildScheduleText, buildEventStatsText, buildStudentStatsText,
  dedupKey, MAX_SLACK_TEXT,
} = require('./format');

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    pass++;
  } catch (e) {
    console.log(`❌ ${name}\n   ${e.message}`);
    fail++;
  }
}

check('fmtWhen: 날짜+시간', () => {
  assert.strictEqual(fmtWhen({ event_date: '2026-07-27', event_time: '15:30' }), '2026-07-27 15:30');
});

check('fmtWhen: 시간 없으면 날짜만', () => {
  assert.strictEqual(fmtWhen({ event_date: '2026-07-27', event_time: null }), '2026-07-27');
});

check('fmtWhen: 날짜 없으면 미정', () => {
  assert.strictEqual(fmtWhen({ event_date: null, event_time: null }), 'TBD');
});

check('weekdaySuffix: 2026-07-27은 월요일', () => {
  assert.strictEqual(weekdaySuffix('2026-07-27'), ' (Mon)');
});

check('weekdaySuffix: 파싱 불가 문자열은 빈 문자열', () => {
  assert.strictEqual(weekdaySuffix('Date TBD'), '');
});

check('buildScheduleText: 빈 결과', () => {
  assert.strictEqual(buildScheduleText([]), 'No registrations yet.');
});

check('buildScheduleText: 날짜 그룹 + 상태별 참석자 + 멘션', () => {
  const rows = [
    { event_date: '2026-07-27', event_time: '15:30', status: 'Going', cnt: 2, members: ['U1', 'U2'] },
    { event_date: '2026-07-27', event_time: '15:30', status: 'Pending approval', cnt: 1, members: ['U3'] },
    { event_date: '2026-07-28', event_time: '11:00', status: 'Going', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);

  // 날짜 헤더(요일 포함)가 각각 한 번씩
  assert.ok(out.includes('📅 *2026-07-27 (Mon)*'), '07-27 헤더 없음');
  assert.ok(out.includes('📅 *2026-07-28 (Tue)*'), '07-28 헤더 없음');
  // 같은 시간대에 상태가 2개여도 시간은 첫 줄에만
  assert.strictEqual(out.split('`15:30`').length - 1, 1, '같은 시간대가 중복 출력됨');
  // 상태별 인원/멘션
  assert.ok(out.includes('*Going 2* · <@U1> <@U2>'), '참석 줄 형식 불일치');
  assert.ok(out.includes('*Pending approval 1* · <@U3>'), '대기 줄 형식 불일치');
  // 이벤트명은 표시하지 않는다
  assert.ok(!out.includes('title'), '이벤트명이 노출됨');
});

check('buildScheduleText: 같은 시간대의 서로 다른 이벤트가 한 줄로 합쳐짐', () => {
  // 쿼리가 date+time+status로 집계하므로 이벤트가 달라도 한 행으로 들어온다
  const rows = [
    { event_date: '2026-07-29', event_time: '15:00', status: 'Going', cnt: 2, members: ['U1', 'U2'] },
  ];
  const out = buildScheduleText(rows);
  assert.strictEqual(out.split('`15:00`').length - 1, 1, '시간대가 여러 줄로 쪼개짐');
  assert.ok(out.includes('*Going 2* · <@U1> <@U2>'), '합산 표시 불일치');
});

check('buildScheduleText: 시간/날짜 미정 처리', () => {
  const rows = [
    { event_date: null, event_time: null, status: 'Going', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);
  assert.ok(out.includes('📅 *Date TBD*'), '날짜 미정 그룹 없음');
  assert.ok(out.includes('`Time TBD`'), '시간미정 표기 없음');
});

check('buildScheduleText: 길이 상한 초과 시 생략 표기', () => {
  // 상한값을 하드코딩하지 않고 실제 설정값을 넉넉히 넘기도록 생성한다
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    event_date: '2026-07-27', event_time: `${String(i % 24).padStart(2, '0')}:00`,
    status: 'Going', cnt: 20, members: Array.from({ length: 20 }, (_, j) => `USER${i}_${j}`),
  }));
  const out = buildScheduleText(rows);
  assert.ok(out.includes('truncated'), '생략 표기 없음');
  // 생략 안내 문구가 상한 뒤에 붙으므로 약간의 여유를 둔다
  assert.ok(out.length <= MAX_SLACK_TEXT + 100, `길이 상한 초과: ${out.length} (상한 ${MAX_SLACK_TEXT})`);
});

check('buildEventStatsText: 빈 결과', () => {
  assert.strictEqual(buildEventStatsText([]), 'No events yet.');
});

check('buildEventStatsText: 날짜별 단락 + 상태별 분해', () => {
  const rows = [
    { event_id: 1, event_date: '2026-07-27', event_time: '18:30', title: 'Kickoff', status: 'Waitlist', cnt: 1 },
    { event_id: 2, event_date: '2026-07-29', event_time: '15:00', title: 'BBQ', status: 'Going', cnt: 2 },
    { event_id: 2, event_date: '2026-07-29', event_time: '15:00', title: 'BBQ', status: 'Pending approval', cnt: 1 },
  ];
  const out = buildEventStatsText(rows);

  // 날짜별 헤더(요일 포함)로 단락이 나뉘어야 함
  assert.ok(out.includes('📅 *2026-07-27 (Mon)*'), `07-27 헤더 없음:\n${out}`);
  assert.ok(out.includes('📅 *2026-07-29 (Wed)*'), `07-29 헤더 없음:\n${out}`);
  // 날짜 헤더 앞에는 빈 줄이 있어야 단락이 분리됨
  assert.ok(out.includes('\n\n📅 *2026-07-29'), '날짜 단락 사이 빈 줄 없음');
  // 시간은 백틱, 합계는 볼드
  assert.ok(out.includes('`18:30`  Kickoff'), `시간 백틱 표기 불일치:\n${out}`);
  assert.ok(out.includes('Total *1* · Waitlist 1'), `대기자 명단/볼드 표시 불일치:\n${out}`);
  // 상태가 여러 개면 합계 + 상태별 분해
  assert.ok(out.includes('Total *3* · Going 2, Pending approval 1'), `복수 상태 표시 불일치:\n${out}`);
  // 같은 이벤트 제목은 한 번만
  assert.strictEqual(out.split('BBQ').length - 1, 1, '같은 이벤트가 중복 출력됨');
});

check('buildEventStatsText: 시간/날짜 미정 처리', () => {
  const out = buildEventStatsText([
    { event_id: 9, event_date: null, event_time: null, title: '미정건', status: 'Going', cnt: 1 },
  ]);
  assert.ok(out.includes('📅 *Date TBD*'), '날짜 미정 그룹 없음');
  assert.ok(out.includes('`Time TBD`'), '시간미정 표기 없음');
});

check('buildStudentStatsText: 빈 결과', () => {
  assert.strictEqual(buildStudentStatsText([]), 'No one has registered a schedule yet.');
});

check('buildStudentStatsText: 사람별 합계 + 상태별 분해', () => {
  const rows = [
    { student_id: 1, name: 'U1', status: 'Going', cnt: 6, total: 8 },
    { student_id: 1, name: 'U1', status: 'Pending approval', cnt: 2, total: 8 },
    { student_id: 2, name: 'U2', status: 'Waitlist', cnt: 1, total: 1 },
  ];
  const out = buildStudentStatsText(rows);
  assert.ok(out.includes('<@U1> — Total *8* · Going 6, Pending approval 2'), `U1 표시 불일치:\n${out}`);
  assert.ok(out.includes('<@U2> — Total *1* · Waitlist 1'), `U2 표시 불일치:\n${out}`);
  // 같은 사람은 한 줄로
  assert.strictEqual(out.split('<@U1>').length - 1, 1, '같은 사람이 중복 출력됨');
  // 쿼리 정렬(합계 내림차순)이 유지되어야 함
  assert.ok(out.indexOf('<@U1>') < out.indexOf('<@U2>'), '정렬 순서가 유지되지 않음');
});

check('buildStudentStatsText: 신청 0건인 사람도 표시', () => {
  // LEFT JOIN이라 신청 없는 학생은 status=null, cnt=0으로 한 행 들어온다
  const out = buildStudentStatsText([
    { student_id: 3, name: 'U3', status: null, cnt: 0, total: 0 },
  ]);
  assert.ok(out.includes('<@U3> — Total *0* · _no registrations_'), `0건 표시 불일치:\n${out}`);
});

check('dedupKey: 공백/대소문자 차이를 흡수', () => {
  assert.strictEqual(
    dedupKey('  Tech BBQ   Throwdown | WTIA  ', '2026-07-29'),
    dedupKey('Tech BBQ Throwdown | WTIA', '2026-07-29')
  );
});

check('dedupKey: 날짜가 다르면 다른 키', () => {
  assert.notStrictEqual(dedupKey('A', '2026-07-29'), dedupKey('A', '2026-07-30'));
});


// ---------- 관리자 대시보드 ----------
const { renderDashboard, escapeHtml } = require('./dashboard');

check('escapeHtml: HTML 특수문자 이스케이프', () => {
  assert.strictEqual(escapeHtml(`<script>"&'`), '&lt;script&gt;&quot;&amp;&#39;');
  assert.strictEqual(escapeHtml(null), '');
});

check('renderDashboard: 이벤트 제목의 XSS가 이스케이프됨', () => {
  // 제목/장소는 Luma에서 파싱한 외부 문자열이라 그대로 넣으면 스크립트가 실행된다
  const html = renderDashboard({
    summary: { students: 1, events: 1, applications: 1 },
    eventRows: [{
      event_id: 1, title: '<img src=x onerror=alert(1)>', location: '<b>loc</b>', luma_url: null,
      event_date: '2026-07-27', event_time: '15:30', status: 'Going', cnt: 1, members: ['<script>'],
    }],
    studentRows: [{ student_id: 1, label: 'Alice', slack_id: 'U1', status: 'Going', cnt: 1, total: 1 }],
    generatedAt: '2026-07-22 00:00 UTC',
  });
  assert.ok(!html.includes('<img src=x'), '제목이 이스케이프되지 않음');
  assert.ok(!html.includes('<script>'), '참석자명이 이스케이프되지 않음');
  assert.ok(html.includes('&lt;img src=x'), '이스케이프된 제목이 없음');
  assert.ok(html.includes('2026-07-27 (Mon)'), '날짜/요일 표기 없음');
});

check('renderDashboard: 요약 수치와 빈 상태', () => {
  const html = renderDashboard({
    summary: { students: 6, events: 12, applications: 30 },
    eventRows: [], studentRows: [], generatedAt: 'x',
  });
  assert.ok(html.includes('>6<') && html.includes('>12<') && html.includes('>30<'), '요약 수치 누락');
  assert.ok(html.includes('No events yet.'), '이벤트 빈 상태 문구 없음');
  assert.ok(html.includes('No one has registered'), '학생 빈 상태 문구 없음');
});

check('renderDashboard: 표시 이름이 없으면 Slack ID 중복 표기 안 함', () => {
  const html = renderDashboard({
    summary: { students: 1, events: 0, applications: 0 },
    eventRows: [],
    studentRows: [{ student_id: 1, label: 'U9', slack_id: 'U9', status: null, cnt: 0, total: 0 }],
    generatedAt: 'x',
  });
  assert.strictEqual(html.split('U9').length - 1, 1, 'Slack ID가 중복 표기됨');
  assert.ok(html.includes('no registrations'), '0건 표기 없음');
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
