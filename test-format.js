// 슬래시 커맨드 출력 포맷 회귀 테스트. 외부 의존(DB/API) 없이 실행된다.
const assert = require('assert');
const { fmtWhen, weekdaySuffix, buildScheduleText, buildEventStatsText, dedupKey } = require('./format');

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
  assert.strictEqual(fmtWhen({ event_date: null, event_time: null }), '미정');
});

check('weekdaySuffix: 2026-07-27은 월요일', () => {
  assert.strictEqual(weekdaySuffix('2026-07-27'), ' (월)');
});

check('weekdaySuffix: 파싱 불가 문자열은 빈 문자열', () => {
  assert.strictEqual(weekdaySuffix('날짜 미정'), '');
});

check('buildScheduleText: 빈 결과', () => {
  assert.strictEqual(buildScheduleText([]), '신청 내역이 없습니다.');
});

check('buildScheduleText: 날짜 그룹 + 상태별 참석자 + 멘션', () => {
  const rows = [
    { event_date: '2026-07-27', event_time: '15:30', status: '참석', cnt: 2, members: ['U1', 'U2'] },
    { event_date: '2026-07-27', event_time: '15:30', status: '승인 대기 중', cnt: 1, members: ['U3'] },
    { event_date: '2026-07-28', event_time: '11:00', status: '참석', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);

  // 날짜 헤더(요일 포함)가 각각 한 번씩
  assert.ok(out.includes('📅 *2026-07-27 (월)*'), '07-27 헤더 없음');
  assert.ok(out.includes('📅 *2026-07-28 (화)*'), '07-28 헤더 없음');
  // 같은 시간대에 상태가 2개여도 시간은 첫 줄에만
  assert.strictEqual(out.split('`15:30`').length - 1, 1, '같은 시간대가 중복 출력됨');
  // 상태별 인원/멘션
  assert.ok(out.includes('참석 2명 · <@U1> <@U2>'), '참석 줄 형식 불일치');
  assert.ok(out.includes('승인 대기 중 1명 · <@U3>'), '대기 줄 형식 불일치');
  // 이벤트명은 표시하지 않는다
  assert.ok(!out.includes('title'), '이벤트명이 노출됨');
});

check('buildScheduleText: 같은 시간대의 서로 다른 이벤트가 한 줄로 합쳐짐', () => {
  // 쿼리가 date+time+status로 집계하므로 이벤트가 달라도 한 행으로 들어온다
  const rows = [
    { event_date: '2026-07-29', event_time: '15:00', status: '참석', cnt: 2, members: ['U1', 'U2'] },
  ];
  const out = buildScheduleText(rows);
  assert.strictEqual(out.split('`15:00`').length - 1, 1, '시간대가 여러 줄로 쪼개짐');
  assert.ok(out.includes('참석 2명 · <@U1> <@U2>'), '합산 표시 불일치');
});

check('buildScheduleText: 시간/날짜 미정 처리', () => {
  const rows = [
    { event_date: null, event_time: null, status: '참석', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);
  assert.ok(out.includes('📅 *날짜 미정*'), '날짜 미정 그룹 없음');
  assert.ok(out.includes('`시간미정`'), '시간미정 표기 없음');
});

check('buildScheduleText: 길이 상한 초과 시 생략 표기', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    event_date: '2026-07-27', event_time: `${String(i % 24).padStart(2, '0')}:00`,
    status: '참석', cnt: 20, members: Array.from({ length: 20 }, (_, j) => `USER${i}_${j}`),
  }));
  const out = buildScheduleText(rows);
  assert.ok(out.includes('생략됨'), '생략 표기 없음');
  assert.ok(out.length <= 3000, `길이 상한 초과: ${out.length}`);
});

check('buildEventStatsText: 빈 결과', () => {
  assert.strictEqual(buildEventStatsText([]), '이벤트가 없습니다.');
});

check('buildEventStatsText: 상태별로 분해해서 표시', () => {
  const rows = [
    { event_id: 1, event_date: '2026-07-27', event_time: '18:30', title: 'Kickoff', status: '대기자 명단', cnt: 1 },
    { event_id: 2, event_date: '2026-07-29', event_time: '15:00', title: 'BBQ', status: '참석', cnt: 2 },
    { event_id: 2, event_date: '2026-07-29', event_time: '15:00', title: 'BBQ', status: '승인 대기 중', cnt: 1 },
  ];
  const out = buildEventStatsText(rows);
  // '대기자 명단'이 누락되지 않고 그대로 노출되어야 함 (예전엔 '대기 0'으로 사라졌음)
  assert.ok(out.includes('Kickoff — 총 1명 · 대기자 명단 1'), `대기자 명단 표시 불일치:\n${out}`);
  // 상태가 여러 개면 합계 + 상태별 분해
  assert.ok(out.includes('BBQ — 총 3명 · 참석 2, 승인 대기 중 1'), `복수 상태 표시 불일치:\n${out}`);
  // 같은 이벤트는 한 줄로
  assert.strictEqual(out.split('BBQ —').length - 1, 1, '같은 이벤트가 중복 출력됨');
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

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
