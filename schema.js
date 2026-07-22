// 스키마 생성 + 마이그레이션. pool을 인자로 받아 Slack/앱 의존 없이 단독 실행·테스트 가능.

// ---------- 1. 스키마 초기화 ----------
async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      application_count INTEGER DEFAULT 0,
      pending_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      host TEXT,
      location TEXT,
      event_date DATE,
      event_time TIME,
      luma_url TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      event_id INTEGER REFERENCES events(id),
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (student_id, event_id)
    );

    CREATE OR REPLACE FUNCTION update_student_counts() RETURNS TRIGGER AS $$
    BEGIN
      UPDATE students SET
        application_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id)),
        pending_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id) AND status = '승인 대기 중')
      WHERE id = COALESCE(NEW.student_id, OLD.student_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_update_student_counts ON applications;
    CREATE TRIGGER trg_update_student_counts
    AFTER INSERT OR UPDATE OR DELETE ON applications
    FOR EACH ROW EXECUTE FUNCTION update_student_counts();
  `);

  await migrateDedupKey(pool);
}

// 이벤트 중복 방지 키를 luma_url → dedup_key(title+날짜)로 옮긴다.
// luma_url은 붙여넣기마다 Claude가 뽑을 때도, 못 뽑을 때도 있어서 같은 이벤트가
// 서로 다른 키를 갖게 되고(= 중복 행), 여러 명이 같은 이벤트를 올리면 반드시 재발한다.
// 전체가 idempotent라 매 기동마다 실행해도 안전하다.
async function migrateDedupKey(pool) {
  await pool.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS dedup_key TEXT`);
  // 기존 행 백필: 제목 공백 정규화 + 소문자 + 날짜
  await pool.query(`
    UPDATE events
    SET dedup_key = lower(regexp_replace(btrim(title), '\\s+', ' ', 'g'))
                    || '|' || COALESCE(event_date::text, '')
    WHERE dedup_key IS NULL
  `);

  // 유일성은 이제 dedup_key가 담당한다. 아래 URL 정리/병합 과정에서 luma_url이 일시적으로
  // 겹칠 수 있으므로 제약을 먼저 푼다.
  await pool.query(`ALTER TABLE events DROP CONSTRAINT IF EXISTS events_luma_url_key`);

  // 구버전은 URL이 없으면 'title-date' 합성 문자열을 luma_url에 넣었다. 진짜 URL이 아니므로 비운다.
  await pool.query(`UPDATE events SET luma_url = NULL WHERE luma_url IS NOT NULL AND luma_url NOT LIKE 'http%'`);

  // 같은 dedup_key 그룹에서 가장 작은 id를 대표로 삼아 신청을 옮기고 중복 행을 정리한다.
  const CANON = `(SELECT dedup_key, MIN(id) AS keep_id FROM events GROUP BY dedup_key)`;
  // 0) 중복 행 중 진짜 URL이 있으면 대표 행으로 옮겨 살린다 (병합 시 유실 방지)
  await pool.query(`
    UPDATE events k
    SET luma_url = src.luma_url
    FROM ${CANON} c
    JOIN LATERAL (
      SELECT d.luma_url FROM events d
      WHERE d.dedup_key = c.dedup_key AND d.luma_url IS NOT NULL
      ORDER BY d.id LIMIT 1
    ) src ON TRUE
    WHERE k.id = c.keep_id AND k.luma_url IS NULL
  `);
  // 1) 대표 이벤트로 신청 이동 (이미 같은 학생 신청이 있으면 건너뜀 — UNIQUE 충돌 방지)
  await pool.query(`
    UPDATE applications a
    SET event_id = c.keep_id
    FROM events e JOIN ${CANON} c ON c.dedup_key = e.dedup_key
    WHERE a.event_id = e.id AND e.id <> c.keep_id
      AND NOT EXISTS (
        SELECT 1 FROM applications x
        WHERE x.student_id = a.student_id AND x.event_id = c.keep_id
      )
  `);
  // 2) 위에서 못 옮긴(중복 신청) 잔여분 제거
  await pool.query(`
    DELETE FROM applications a
    USING events e JOIN ${CANON} c ON c.dedup_key = e.dedup_key
    WHERE a.event_id = e.id AND e.id <> c.keep_id
  `);
  // 3) 중복 이벤트 행 제거
  await pool.query(`
    DELETE FROM events e
    USING ${CANON} c
    WHERE e.dedup_key = c.dedup_key AND e.id <> c.keep_id
  `);

  // luma_url은 이제 순수 참고용(중복 허용), dedup_key가 유일성을 담당
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_key_idx ON events (dedup_key)`);
}

module.exports = { initSchema, migrateDedupKey };
