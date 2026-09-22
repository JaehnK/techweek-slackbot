// 일회성 복구 스크립트: Claude 파싱 오류로 생긴 날짜 이상치 + 중복 행 + URL 오염 복구.
//
// 근거 (모두 Luma 공식 소스로 검증):
//  - 기간 밖 이상치 18건: 정상 날짜 행과 제목·시간이 일치하는 중복 15건 + 날짜만 틀린 3건
//  - 기간 안에서도 같은 이벤트가 하루 어긋난 날짜로 중복된 5건 (157→1, 158→2, 159→56, 83→8, 121→10)
//    · Portal(7/27)·Cursor(7/24)는 Luma 이벤트 페이지 JSON-LD로, TEDx(7/27)는 TED 공식 페이지로,
//      Showbox Fair(7/28)는 Luma 공식 캘린더 API로 확정
//  - 요가(67=7/28, 154=7/29)는 실제 2세션 반복 이벤트 → 병합 대상 아님, 둘 다 유지
//  - luma_url 오염: 41은 다른 이벤트 URL 보유(정답 9vvemcxd), 119↔120 URL이 한 칸 밀림, 121은 깨진 URL
//  - 시간 오차: 15(16:00→15:00), 46(15:30→16:00) — Luma 공식 캘린더 기준
//
// 사용법:
//   node scripts/recover-dates.js          # dry-run: 변경 내용만 출력, DB 수정 없음
//   node scripts/recover-dates.js --apply  # 트랜잭션으로 실제 적용
require('dotenv').config();
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const WINDOW = { from: '2026-07-20', to: '2026-08-05' };

// 기간 안 중복 병합: bad_id → good_id (제목 매칭 자동화로 안 잡히는 건 포함)
const IN_RANGE_MERGES = [
  [157, 1],   // What's Space Got to Do With It: 7/28(오류) → 7/27 (Luma JSON-LD 확정)
  [158, 2],   // TEDxSeattle Salon: 7/28(오류) → 7/27 (TED 공식 페이지 확정)
  [159, 56],  // STW Startup Showcase (Startup Fair): 7/29(오류) → 7/28 (공식 캘린더 확정)
  [83, 8],    // Cursor Workshop: 7/27(오류) → 7/24 (Luma z7rig8sm 확정)
  [121, 10],  // AI & SaaS Drinks in the sun: 제목 축약+깨진 URL 중복 → 원본 행으로
];

// 짝 없는 이상치의 확정 날짜 (공식 캘린더 API로 검증됨) + 확인된 luma_url
const MANUAL_FIXES = {
  150: { date: '2026-07-28', url: 'https://luma.com/g8hmbr7c' }, // Reverse Pitch (EY x CDL)
  151: { date: '2026-07-28', url: null },                        // Building in Seattle
  153: { date: '2026-07-28', url: 'https://luma.com/zbb6j727' }, // Showbox (Live Demos)
};

// URL 오염 복구: id → 올바른 luma_url (null = 잘못된 URL 제거)
const URL_FIXES = {
  41: 'https://luma.com/9vvemcxd',  // Relationships are the Strategy (기존 URL은 From Zero의 것)
  120: 'https://luma.com/8024ch9r', // Agentic Commerce ASO (기존 URL은 Drinks in the sun의 것)
  119: null,                        // AEO: 현재 URL이 120의 것 — 진짜 URL 미확인이라 제거
  154: 'https://luma.com/pe2jvm4j', // 요가 7/29 세션의 실제 URL 백필
};

// 시간 오차 복구 (Luma 공식 캘린더 기준)
const TIME_FIXES = { 15: '15:00', 46: '16:00' };

const NORM = `lower(regexp_replace(btrim(title), '\\s+', ' ', 'g'))`;

async function mergeEvent(client, badId, goodId, label) {
  const moved = await client.query(`
    UPDATE applications a SET event_id = $2
    WHERE a.event_id = $1
      AND NOT EXISTS (SELECT 1 FROM applications x WHERE x.student_id = a.student_id AND x.event_id = $2)
    RETURNING a.student_id`, [badId, goodId]);
  const dropped = await client.query(
    `DELETE FROM applications WHERE event_id = $1 RETURNING student_id`, [badId]);
  await client.query(`DELETE FROM events WHERE id = $1`, [badId]);
  console.log(`[병합] #${badId} → #${goodId} | 신청 이동 ${moved.rowCount}, 중복 삭제 ${dropped.rowCount} | ${label}`);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 기간 밖 이상치 ↔ 정상 행 병합 (제목 정규화 매칭)
    const { rows: pairs } = await client.query(`
      SELECT b.id AS bad_id, b.title, b.event_date::text AS bad_date,
             g.id AS good_id, g.event_date::text AS good_date
      FROM events b
      LEFT JOIN events g
        ON ${NORM.replace(/title/g, 'g.title')} = ${NORM.replace(/title/g, 'b.title')}
       AND g.event_date BETWEEN $1 AND $2
      WHERE b.event_date NOT BETWEEN $1 AND $2
      ORDER BY b.id`, [WINDOW.from, WINDOW.to]);

    for (const p of pairs.filter(p => p.good_id))
      await mergeEvent(client, p.bad_id, p.good_id, `${p.bad_date} → ${p.good_date} | ${p.title.slice(0, 60)}`);

    // 2) 짝 없는 이상치: 확정 날짜로 수정 (+ 확인된 URL 백필)
    for (const p of pairs.filter(p => !p.good_id)) {
      const fix = MANUAL_FIXES[p.bad_id];
      if (!fix) { console.log(`[보류] #${p.bad_id} (${p.bad_date}) 날짜 미확인 | ${p.title}`); continue; }
      await client.query(`
        UPDATE events SET event_date = $2::date,
          dedup_key = ${NORM} || '|' || $2::text,
          luma_url = COALESCE($3, luma_url)
        WHERE id = $1`, [p.bad_id, fix.date, fix.url]);
      console.log(`[수정] #${p.bad_id} ${p.bad_date} → ${fix.date} | ${p.title.slice(0, 60)}`);
    }

    // 3) 기간 안 중복 병합 (하루 어긋난 날짜 / 제목 변형 중복)
    for (const [badId, goodId] of IN_RANGE_MERGES) {
      const { rows: [b] } = await client.query(`SELECT title, event_date::text AS d FROM events WHERE id = $1`, [badId]);
      if (!b) { console.log(`[생략] #${badId} 이미 없음`); continue; }
      await mergeEvent(client, badId, goodId, `${b.d} | ${b.title.slice(0, 60)}`);
    }

    // 4) URL 오염 복구
    for (const [id, url] of Object.entries(URL_FIXES)) {
      const r = await client.query(`UPDATE events SET luma_url = $2 WHERE id = $1 RETURNING title`, [id, url]);
      if (r.rowCount) console.log(`[URL] #${id} → ${url ?? '(제거)'} | ${r.rows[0].title.slice(0, 50)}`);
    }

    // 5) 시간 오차 복구
    for (const [id, time] of Object.entries(TIME_FIXES)) {
      const r = await client.query(`UPDATE events SET event_time = $2::time WHERE id = $1 RETURNING title`, [id, time]);
      if (r.rowCount) console.log(`[시간] #${id} → ${time} | ${r.rows[0].title.slice(0, 50)}`);
    }

    // 6) 학생별 카운트 재계산
    await client.query(`
      UPDATE students s SET
        application_count = COALESCE(x.total, 0),
        pending_count     = COALESCE(x.pending, 0)
      FROM (
        SELECT st.id, COUNT(a.id) AS total,
               COUNT(a.id) FILTER (WHERE a.status <> 'Going') AS pending
        FROM students st LEFT JOIN applications a ON a.student_id = st.id
        GROUP BY st.id
      ) x WHERE s.id = x.id`);

    // 검증
    const { rows: [v1] } = await client.query(
      `SELECT COUNT(*) AS n FROM events WHERE event_date NOT BETWEEN $1 AND $2`, [WINDOW.from, WINDOW.to]);
    const { rows: dupCheck } = await client.query(`
      SELECT ${NORM} AS norm, COUNT(DISTINCT event_date) AS dates
      FROM events GROUP BY 1 HAVING COUNT(DISTINCT event_date) > 1`);
    console.log(`\n검증: 기간 밖 이상 행 ${v1.n}건, 복수 날짜 제목 ${dupCheck.length}건 (요가 등 실제 반복 세션 제외 기대값: 1)`);
    for (const d of dupCheck) console.log('  - 복수 날짜:', d.norm.slice(0, 60));

    if (APPLY) {
      await client.query('COMMIT');
      console.log('APPLIED: 변경 사항이 커밋되었습니다.');
    } else {
      await client.query('ROLLBACK');
      console.log('DRY-RUN: 롤백했습니다. 실제 적용은 --apply 플래그를 사용하세요.');
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('실패, 롤백됨:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
