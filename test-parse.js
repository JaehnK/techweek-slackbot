// 실제 Luma 붙여넣기 텍스트로 파싱 프롬프트를 검증한다.

const { parseWithClaude } = require('./index.js');

const SAMPLE = `이벤트
캘린더
탐색
오후 4:33 GMT+9
이벤트 만들기


이벤트

예정된

지난
7월 28일
화요일

What's Space Got to Do With It? | Seattle Tech Week | Hosted by Portal Space Systems의 커버 이미지
오전 7:30 · 7월 27일 오후 3:30 GMT-7
What's Space Got to Do With It? | Seattle Tech Week | Hosted by Portal Space Systems
​
Jen Scholten, Amy Miller, Jeff Thornburg & Shannon Lynott 주최
​
Ashurst Perkins Coie US LLP - Seattle
​
참석
+39

Creativity, Intent, and the Future of AI // A TEDxSeattle Salon at Seattle Tech Week의 커버 이미지
오전 10:00 · 7월 27일 오후 6:00 GMT-7
Creativity, Intent, and the Future of AI // A TEDxSeattle Salon at Seattle Tech Week
​
Paige Elger & Rob Hyman 주최
​
Art Love Salon
​
참석
7월 29일
수요일

Scaling Robotic Fleets | Thinkspace의 커버 이미지
오전 3:00 · 7월 28일 오전 11:00 GMT-7
Scaling Robotic Fleets | Thinkspace
​
Peter Chee, Anna McCallon & Craig Baerwaldt 주최
​
thinkspace SEATTLE
​
승인 대기 중
+106

TwelveLabs + Qdrant: AI Memory for Video Intelligence의 커버 이미지
오전 9:30 · 7월 28일 오후 5:30 GMT-7
TwelveLabs + Qdrant: AI Memory for Video Intelligence
​
Qdrant, Neil Kanungo, James Le, Union.ai 외 1 명
​
Union AI HQ
​
참석
+82
7월 30일
목요일

Tech BBQ Throwdown | WTIA의 커버 이미지
오전 7:00 · 7월 29일 오후 3:00 GMT-7
Tech BBQ Throwdown | WTIA
​
WTIA & Nick Ellingson 주최
​
Fluke Hall, University of Washington
​
참석
+202
탐색가격도움말`;

// GMT-7 표기 기준 기대값 (행사 현지시각)
const EXPECTED = [
  { t: "What's Space", date: '2026-07-27', time: '15:30', status: 'Going' },
  { t: 'Creativity',   date: '2026-07-27', time: '18:00', status: 'Going' },
  { t: 'Scaling',      date: '2026-07-28', time: '11:00', status: 'Pending approval' },
  { t: 'TwelveLabs',   date: '2026-07-28', time: '17:30', status: 'Going' },
  { t: 'Tech BBQ',     date: '2026-07-29', time: '15:00', status: 'Going' },
];

(async () => {
  const events = await parseWithClaude(SAMPLE);
  console.log(`파싱된 이벤트 수: ${events.length} (기대: 5)\n`);

  let pass = 0;
  for (const exp of EXPECTED) {
    const got = events.find((e) => (e.title || '').includes(exp.t));
    if (!got) { console.log(`❌ [${exp.t}] 이벤트 못 찾음`); continue; }
    const dOk = got.event_date === exp.date;
    const tOk = got.event_time === exp.time;
    const sOk = got.status === exp.status;
    const ok = dOk && tOk && sOk;
    if (ok) pass++;
    console.log(`${ok ? '✅' : '❌'} ${exp.t}`);
    console.log(`   date: ${got.event_date} ${dOk ? '' : `(기대 ${exp.date}) ←`}`);
    console.log(`   time: ${got.event_time} ${tOk ? '' : `(기대 ${exp.time}) ←`}`);
    console.log(`   status: ${got.status} ${sOk ? '' : `(기대 ${exp.status}) ←`}`);
    console.log(`   host: ${got.host} | loc: ${got.location}`);
  }
  console.log(`\n=== ${pass}/${EXPECTED.length} 통과 ===`);
  process.exit(pass === EXPECTED.length ? 0 : 1);
})().catch((e) => { console.error('테스트 실패:', e.message); process.exit(1); });
