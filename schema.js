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

    -- 행사 후 Luma '지난(Past)' 탭 복붙으로 수집하는 실제 참여 기록.
    -- applications(사전 신청)와 분리해 두 데이터가 서로 덮어쓰지 않게 한다.
    CREATE TABLE IF NOT EXISTS attendances (
      id SERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id),
      event_id INTEGER REFERENCES events(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (student_id, event_id)
    );

    -- pending_count는 '아직 참석 확정이 아닌' 신청 수. 특정 대기 상태를 하드코딩하면
    -- Luma에 새 상태가 생길 때 조용히 누락되므로 'Going'이 아닌 것을 센다.
    CREATE OR REPLACE FUNCTION update_student_counts() RETURNS TRIGGER AS $$
    BEGIN
      UPDATE students SET
        application_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id)),
        pending_count = (SELECT COUNT(*) FROM applications WHERE student_id = COALESCE(NEW.student_id, OLD.student_id) AND status <> 'Going')
      WHERE id = COALESCE(NEW.student_id, OLD.student_id);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_update_student_counts ON applications;
    CREATE TRIGGER trg_update_student_counts
    AFTER INSERT OR UPDATE OR DELETE ON applications
    FOR EACH ROW EXECUTE FUNCTION update_student_counts();
  `);

  // 대시보드는 Slack 렌더링(<@ID>)을 못 쓰므로 표시 이름을 따로 보관한다.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS display_name TEXT`);

  await migrateDedupKey(pool);
  await migrateStatusesToEnglish(pool);
  // 중복 병합·상태 정규화가 끝난 정리된 데이터를 스냅샷 뜬다 (순서 중요)
  await snapshotPreRegistrations(pool);

  // 트리거 함수가 바뀌어도 기존 행은 다음 변경 때까지 옛 값이 남으므로 즉시 재계산한다.
  await pool.query(`
    UPDATE students s SET
      application_count = COALESCE(x.total, 0),
      pending_count     = COALESCE(x.pending, 0)
    FROM (
      SELECT st.id,
             COUNT(a.id)                                   AS total,
             COUNT(a.id) FILTER (WHERE a.status <> 'Going') AS pending
      FROM students st LEFT JOIN applications a ON a.student_id = st.id
      GROUP BY st.id
    ) x
    WHERE s.id = x.id
      AND (s.application_count IS DISTINCT FROM COALESCE(x.total, 0)
        OR s.pending_count     IS DISTINCT FROM COALESCE(x.pending, 0))
  `);
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
  // 1-b/2-b) 참여 기록도 동일하게 대표 이벤트로 이동 후 잔여분 제거 (FK가 남으면 3)이 실패)
  await pool.query(`
    UPDATE attendances a
    SET event_id = c.keep_id
    FROM events e JOIN ${CANON} c ON c.dedup_key = e.dedup_key
    WHERE a.event_id = e.id AND e.id <> c.keep_id
      AND NOT EXISTS (
        SELECT 1 FROM attendances x
        WHERE x.student_id = a.student_id AND x.event_id = c.keep_id
      )
  `);
  await pool.query(`
    DELETE FROM attendances a
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

// 기존에 Luma 원문(한국어)으로 저장된 상태값을 정규화된 영어 값으로 옮긴다.
// 코드가 상태를 문자열로 비교하므로(역행 방지, pending_count) 값이 언어에 따라
// 갈리면 로직이 조용히 깨진다. 한국어 값만 매칭하므로 재실행해도 안전하다.
async function migrateStatusesToEnglish(pool) {
  await pool.query(`
    UPDATE applications SET status = CASE status
      WHEN '참석'         THEN 'Going'
      WHEN '승인 대기 중'  THEN 'Pending approval'
      WHEN '대기자 명단'   THEN 'Waitlist'
      WHEN '초대됨'       THEN 'Invited'
      WHEN '알수없음'      THEN 'Unknown'
      ELSE status
    END
    WHERE status IN ('참석', '승인 대기 중', '대기자 명단', '초대됨', '알수없음')
  `);
}

// 행사 종료 후 참여 기록(attendances) 수집이 시작되면서, 그때까지 모인 사전 신청 결과를
// 별개 테이블에 보존한다. applications는 봇이 계속 upsert하는 라이브 테이블이라
// '그 시점의 결과'가 남지 않기 때문. FK 없이 값으로 복사해 이후 이벤트 병합/수정/삭제의
// 영향을 받지 않는 완전한 스냅샷으로 만든다.
// 테이블이 비어 있을 때 한 번만 채우므로 매 기동마다 실행해도 안전하다.
async function snapshotPreRegistrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pre_registrations (
      id SERIAL PRIMARY KEY,
      student_name TEXT,
      student_display TEXT,
      event_title TEXT,
      event_date DATE,
      event_time TIME,
      luma_url TEXT,
      status TEXT,
      applied_at TIMESTAMPTZ,
      snapshotted_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pre_registrations`);
  if (rows[0].n > 0) return 0;
  const ins = await pool.query(`
    INSERT INTO pre_registrations
      (student_name, student_display, event_title, event_date, event_time, luma_url, status, applied_at)
    SELECT s.name, s.display_name, e.title, e.event_date, e.event_time, e.luma_url, a.status, a.created_at
    FROM applications a
    JOIN students s ON s.id = a.student_id
    JOIN events   e ON e.id = a.event_id
  `);
  if (ins.rowCount) console.log(`pre-registration snapshot saved: ${ins.rowCount} rows`);
  return ins.rowCount;
}

module.exports = { initSchema, migrateDedupKey, migrateStatusesToEnglish, snapshotPreRegistrations };
