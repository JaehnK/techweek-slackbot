// 일회성 복구: 2026-01-xx 로 잘못 파싱된 이벤트 9건 정리.
// 전부 한 메시지(배치) 안에서 월만 틀린 파싱 오류로, 기존 7월 이벤트와 제목·시각이 일치한다.
// 근거: bad.title[..25] == good.title[..25] 매칭 + 같은 배치 내 날짜 간격 보존으로 확정.
//
//   node scripts/fix-dates-20260730.js          # dry-run
//   node scripts/fix-dates-20260730.js --apply  # 트랜잭션 적용
require('dotenv').config({ quiet: true });
const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 15000 });

// bad_id -> good_id : 잘못된 1월 중복을 기존 7월 원본으로 병합
const MERGES = [
  [239, 57],   // From Zero to $1M+ in ARR         01-20 → 07-28
  [240, 153],  // STW Showcase (Live Demos)        01-20 → 07-28
  [241, 154],  // Morning Yoga + Clarity           01-21 → 07-29 (2세션 중 29일)
  [242, 133],  // AI GTM | Thinkspace              01-21 → 07-29
  [243, 156],  // Inside the AI Startup            01-21 → 07-29
  [248, 42],   // You Vibe-Coded an App            01-08 → 07-29
  [249, 5],    // Tech BBQ Throwdown               01-08 → 07-29
  [251, 5],    // Tech BBQ Throwdown               01-14 → 07-29
];

// 7월 트윈이 없어 날짜만 교정 (배치 간격상 07-28로 추정, Luma 미검증 → 확인 필요)
const DATE_FIXES = { 250: '2026-07-28' };

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [bad, good] of MERGES) {
      const moved = await client.query(
        `UPDATE applications a SET event_id = $2
         WHERE a.event_id = $1
           AND NOT EXISTS (SELECT 1 FROM applications x WHERE x.student_id = a.student_id AND x.event_id = $2)
         RETURNING a.student_id`, [bad, good]);
      const dropped = await client.query(
        `DELETE FROM applications WHERE event_id = $1 RETURNING student_id`, [bad]);
      await client.query(`DELETE FROM events WHERE id = $1`, [bad]);
      console.log(`[병합] #${bad} → #${good} | 신청 이동 ${moved.rowCount}, 중복 신청 삭제 ${dropped.rowCount}`);
    }
    for (const [id, date] of Object.entries(DATE_FIXES)) {
      const r = await client.query(`UPDATE events SET event_date = $2 WHERE id = $1 RETURNING title`, [id, date]);
      console.log(`[날짜수정] #${id} → ${date} | ${r.rows[0]?.title.slice(0, 45)}`);
    }
    // 남은 기간 밖 이상치 점검
    const left = await client.query(
      `SELECT COUNT(*)::int n FROM events WHERE event_date IS NULL OR event_date < '2026-07-24' OR event_date > '2026-07-31'`);
    console.log(`\n적용 후 기간 밖 이상치: ${left.rows[0].n} 건`);

    if (APPLY) { await client.query('COMMIT'); console.log('✅ COMMIT'); }
    else { await client.query('ROLLBACK'); console.log('↩︎ DRY-RUN (ROLLBACK) — 적용하려면 --apply'); }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ 롤백:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
main();
