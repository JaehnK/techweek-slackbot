// 슬래시 커맨드 출력 포맷 회귀 테스트. 외부 의존(DB/API) 없이 실행된다.
const assert = require('assert');
const { fmtWhen, weekdaySuffix, buildScheduleText } = require('./format');

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
    { event_id: 1, event_date: '2026-07-27', event_time: '15:30', title: 'A', status: '참석', cnt: 2, members: ['U1', 'U2'] },
    { event_id: 1, event_date: '2026-07-27', event_time: '15:30', title: 'A', status: '승인 대기 중', cnt: 1, members: ['U3'] },
    { event_id: 2, event_date: '2026-07-28', event_time: '11:00', title: 'B', status: '참석', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);

  // 날짜 헤더(요일 포함)가 각각 한 번씩
  assert.ok(out.includes('📅 *2026-07-27 (월)*'), '07-27 헤더 없음');
  assert.ok(out.includes('📅 *2026-07-28 (화)*'), '07-28 헤더 없음');
  // 같은 이벤트가 중복 출력되지 않아야 함 (상태 2행 → 제목은 1번)
  assert.strictEqual(out.split('`15:30`').length - 1, 1, '같은 이벤트 제목이 중복 출력됨');
  // 상태별 인원/멘션
  assert.ok(out.includes('참석 2명 · <@U1> <@U2>'), '참석 줄 형식 불일치');
  assert.ok(out.includes('승인 대기 중 1명 · <@U3>'), '대기 줄 형식 불일치');
});

check('buildScheduleText: 시간/날짜 미정 처리', () => {
  const rows = [
    { event_id: 9, event_date: null, event_time: null, title: '미정건', status: '참석', cnt: 1, members: ['U1'] },
  ];
  const out = buildScheduleText(rows);
  assert.ok(out.includes('📅 *날짜 미정*'), '날짜 미정 그룹 없음');
  assert.ok(out.includes('`시간미정`'), '시간미정 표기 없음');
});

check('buildScheduleText: 길이 상한 초과 시 생략 표기', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({
    event_id: i, event_date: '2026-07-27', event_time: '10:00',
    title: `아주 긴 이벤트 제목 ${i} `.repeat(3), status: '참석', cnt: 1, members: ['U1'],
  }));
  const out = buildScheduleText(rows);
  assert.ok(out.includes('생략됨'), '생략 표기 없음');
  assert.ok(out.length <= 3000, `길이 상한 초과: ${out.length}`);
});

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
