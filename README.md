# techweek-slackbot

> **상태: 운영 종료 (archived).** 2026 Seattle Tech Week(7/24–7/31) 기간 동안 42 Seoul / 42 Gyeongsan 교육생 원정단의 일정 취합용으로 운영했고, 행사 후 참여 기록까지 수집한 뒤 배포를 내렸다. 코드는 그대로 실행 가능하다.

Luma 페이지를 Slack DM에 그대로 붙여넣으면 Claude가 이벤트 목록을 구조화해 Postgres에 저장하고, 슬래시 커맨드와 웹 대시보드로 "누가·언제·어디에" 가는지 한눈에 보게 해 주는 봇.

- **구성**: Slack 봇(DM 파싱 + 슬래시 커맨드) + **운영진 전용 웹 어드민 페이지**(`/admin`, 토큰 보호) — 같은 Node 프로세스에서 서빙
- **규모**: 교육생 29명, 이벤트 89개, 신청 185건 (운영 종료 시점)
- **스택**: Node.js 18+ · `@slack/bolt` (HTTP mode) · `@anthropic-ai/sdk` (structured outputs, `claude-haiku-4-5`) · `pg` · Railway
- **테스트**: `npm test` — 외부 의존 없는 순수 함수 회귀 테스트 48개

---

## 왜 만들었나

Tech Week 행사는 수십 개 세션이 [Luma](https://luma.com)에 흩어져 있고, 각자 자기 계정으로 신청한다. Luma에는 "우리 그룹이 어디에 신청했는지"를 모아 볼 API나 공유 기능이 없다. 운영진이 30명에게 매번 물어보는 대신, **이미 보고 있는 Luma 화면을 복사해서 DM으로 보내면 끝**나게 만드는 것이 목표였다.

## 사용 흐름

```
교육생                      봇                              운영진
──────                     ──                              ──────
Luma '예정된' 탭 전체 복사
  └─ DM에 붙여넣기 ──────▶ Claude 파싱 (JSON schema)
                            ├─ 행사 기간 밖 날짜 걸러냄
                            ├─ 이벤트 upsert (title+date 키)
                            ├─ 신청 upsert (Going 역행 방지)
                            └─ 빠진 예정 일정 = 취소로 동기화
                          ◀─ "✅ Saved 7 event(s)! 🗑 Removed 1 cancelled"
                                                             /schedule · /event-stats · /students
                                                             GET /admin (토큰 보호 대시보드)
행사 후: Luma '지난' 탭 복사
  └─ DM에 붙여넣기 ──────▶ 모든 날짜가 과거 → attendances에 기록
                            (사전 신청 테이블은 건드리지 않음)
```

### Slack 커맨드

| 커맨드 | 설명 |
|---|---|
| `/schedule` | 날짜 → 시간대별 참석자 (누가 언제 비는지) |
| `/event-stats` | 날짜별 이벤트 × 상태 집계 |
| `/students` | 사람별 신청 합계 + 상태 분해 (신청 0건인 사람도 표시) |
| `/events` | 전체 신청 평면 목록 |
| `/my-events` | 내 신청 내역 + 참여 기록 |
| DM `delete` | 내 기록 하나를 고르는 Block Kit 셀렉트 → 삭제 (본인 것만) |

## 운영진용 어드민 페이지 (`GET /admin?key=…`)

Slack 커맨드는 교육생 전원에게 공개되는 조회 수단이고, 운영진이 전체 그림을 보는 용도로는 **별도의 웹 어드민 페이지**가 있다. Bolt의 `customRoutes`로 Slack 이벤트 엔드포인트와 같은 서버에 붙어 있어 추가 배포나 프론트엔드 빌드 없이 동작하며, `ADMIN_TOKEN`을 설정한 경우에만 켜진다(보안 세부는 [설계 결정 8번](#8-대시보드-보안)).

서버가 렌더한 HTML 한 장 + 인라인 JS. 프레임워크·빌드 단계가 없고 읽기 전용이다. 상단에 인원/이벤트/신청/참여 요약 카드가 있고 아래 6개 탭으로 나뉜다.

| 탭 | 내용 |
|---|---|
| By time slot | 시간대별 참석 인원 분포 (날짜/상태 필터, 브라우저에서 즉시 재계산) |
| Timeline | 하루 일정을 시간순으로, 동시간대 겹침과 **한 사람이 두 곳에 신청한 충돌** 표시 |
| Schedule | 날짜별 이벤트 × 상태 × 참석자 |
| Attendance | 행사 후 수집한 실제 참여 기록 |
| Pre-registration | 행사 종료 시점의 사전 신청 동결 스냅샷 |
| People | 사람별 요약(펼치면 일별 스케줄) + 워크스페이스 로스터 대조로 **미등록 교육생** 목록 |

---

## 구조

```
index.js       진입점. Slack App, Claude 파싱, DB 쓰기, 커맨드 라우팅
format.js      슬래시 커맨드 출력·판정 로직 (순수 함수)
schema.js      DDL + idempotent 마이그레이션 (기동 시마다 실행)
dashboard.js   /admin 인증·집계·HTML 렌더 (pool/토큰을 주입받아 단독 테스트 가능)
test-format.js 회귀 테스트 (npm test)
test-parse.js  실제 Luma 샘플로 Claude 파싱 검증 (실 API 호출, npm run test:parse)
scripts/       운영 중 데이터 복구에 쓴 일회성 스크립트 (아래 '운영 기록' 참고)
```

### 데이터 모델

```
students          Slack user ID(name)를 키로. display_name은 users.info로 별도 보관
events            dedup_key = lower(title 공백정규화) | event_date  ← 유일성 담당
applications      (student, event) UNIQUE, status ∈ {Going, Pending approval, Waitlist, Invited, Unknown}
attendances       (student, event) UNIQUE. 행사 후 '지난' 탭 복붙으로만 쌓임
pre_registrations FK 없는 값 복사본. applications를 한 번 스냅샷 뜬 동결 테이블
```

`students.application_count / pending_count`는 트리거로 유지하고, 트리거 함수가 바뀌어도 기존 행이 어긋나지 않게 기동 시 재계산한다.

---

## 설계 결정과 겪은 문제

포트폴리오 관점에서 이 프로젝트의 핵심은 "LLM 파싱 결과를 믿고 DB에 쓰는" 구조에서 **데이터가 어떻게 깨지는지, 그걸 어떻게 막았는지**다.

### 1. 날짜/시간은 항상 행사 현지시각으로 저장

Luma는 보는 사람의 타임존에 따라 시간을 1개 또는 2개(`오전 7:30 · 7월 27일 오후 3:30 GMT-7`)로 보여준다. 한국에서 보면 날짜 섹션 헤더(`7월 28일 화요일`)가 시애틀 현지 날짜와 하루 어긋난다.

- 시간이 2개면 `GMT±N`이 붙은 쪽의 **날짜와 시간**을 쓴다 (섹션 헤더 무시).
- 시간이 1개면 보는 사람 = 행사 타임존이므로 그대로 쓰고 날짜는 헤더를 쓴다.

이 규칙이 없으면 한국에서 붙여넣은 사람과 시애틀에서 붙여넣은 사람이 **같은 이벤트를 다른 날짜로 저장**해 중복 행이 생긴다. 프롬프트에 규칙을 명시하고 `test-parse.js`로 회귀를 잡는다.

### 2. 이벤트 유일 키: `luma_url` → `title + date`

처음엔 `luma_url`을 UNIQUE 키로 썼다. 그런데 복사한 텍스트에 URL이 있을 때도, 없을 때도 있어서 같은 이벤트가 URL 유무에 따라 두 행으로 갈라졌다. 여러 명이 같은 이벤트를 올리면 반드시 재발하는 구조였다.

`dedup_key`(제목 공백·대소문자 정규화 + 날짜)로 옮기고, [schema.js](schema.js)의 `migrateDedupKey()`가 기존 중복 행을 대표 행으로 병합하면서 신청/참여 기록의 FK를 옮기고 URL은 살린다. 전 과정이 idempotent라 매 기동마다 돌려도 안전하다.

### 3. 상태값 정규화

Luma 표시 언어에 따라 `참석`/`Going`이 섞여 들어오면 `status = 'Going'` 비교가 조용히 깨진다. Claude 출력 스키마에서 `status`를 영어 enum으로 고정하고, 이미 저장된 한국어 값은 마이그레이션으로 옮겼다.

### 4. 재붙여넣기 = 예정 일정 동기화

Luma에서 신청을 취소하면 다시 붙여넣은 텍스트에 그 이벤트가 안 나온다. 그래서 붙여넣기를 "그 시점의 예정 일정 전체"로 보고, 빠진 예정 일정은 취소로 간주해 제거한다. 단, 잘못 지우는 것이 더 위험하므로 안전장치를 겹겹이 뒀다.

- 지난 일정(참석 기록)은 삭제 대상에서 제외 — Luma '예정된' 탭엔 미래만 나오기 때문. 서버 UTC ↔ 시애틀 UTC-7 경계를 감안해 `CURRENT_DATE - 1일` 기준.
- 파싱 결과가 비면 삭제를 건너뛴다 (기존 일정 전멸 방지).
- 일부 이벤트가 기간 밖으로 걸러졌다면 붙여넣기가 불완전하게 해석된 것이므로 삭제를 끈다.
- 단일 이벤트(상세 페이지 복붙)는 "전체 목록"이 아니므로 삭제를 끈다.
- 삭제된 항목은 DM 응답에 나열해 본인이 즉시 알아채게 한다.

### 5. `Going` 역행 방지

승인이 나서 `Going`이 된 뒤 오래된 텍스트를 다시 붙여넣으면 `Pending approval`로 되돌아간다. `ON CONFLICT … DO UPDATE`의 `CASE`로 `Going → 다른 상태` 전이만 막는다 (그 외 전이는 최신값으로 덮어씀).

### 6. LLM 파싱 오류 방어: 행사 기간 창

운영 중 파서가 **7월을 1월로** 찍는 사례가 반복됐다 (한 배치 안에서 월만 틀리고 날짜 간격은 보존되는 패턴). 봇은 한 주짜리 행사 전용이므로 `EVENT_WINDOW`(env로 덮어쓰기 가능) 밖 날짜는 파싱 오류로 단정하고 저장하지 않으며, 사용자에게 어떤 항목이 걸러졌는지 알린다. 프롬프트에도 기간을 명시해 1차로 막는다.

이 방어가 들어가기 전에 이미 오염된 데이터는 [`scripts/`](scripts/)의 복구 스크립트로 정리했다 (아래 '운영 기록').

### 7. 사전 신청과 실제 참여의 분리

행사가 끝나면 Luma '예정된' 탭은 비고 '지난' 탭에만 나온다. 모든 날짜가 오늘 이전인 붙여넣기는 '지난' 탭으로 판별(`isPastPaste`)해 별도 테이블 `attendances`에 기록한다. 이 경로는 취소 동기화를 하지 않는다 — 참여 사실은 나중에 사라질 수 없고, 지난 탭 복붙이 전체 목록이 아닐 수도 있어서다.

동시에, 계속 upsert되는 `applications`에는 "행사 종료 시점의 결과"가 남지 않으므로, 참여 수집을 시작하면서 한 번 `pre_registrations`로 값을 복사해 동결했다. FK 없이 값으로 복사해 이후 병합/삭제의 영향을 받지 않는다.

### 8. 대시보드 보안

공개 도메인에 교육생 이름·일정이 노출되는 페이지라 기본값은 "꺼짐"이다.

- `ADMIN_TOKEN` 미설정 시 `/admin`은 404 (존재 자체를 숨김). 틀리면 401.
- 토큰 비교는 SHA-256 해시 후 `timingSafeEqual` — 길이가 달라도 예외가 없고 타이밍 정보가 새지 않는다.
- 토큰이 URL에 실리므로 `cache-control: no-store`, `referrer-policy: no-referrer`, `x-robots-tag: noindex`.
- 이벤트 제목·장소·이름은 외부 입력이라 전부 HTML 이스케이프. 링크는 `http(s)`만 통과(`javascript:` 차단). `<script type="application/json">`에 넣는 페이로드는 `<`를 이스케이프해 조기 종료 주입을 막는다.

### 9. 테스트 가능한 구조

Bolt `App`을 생성하는 순간 `auth.test`가 호출되어 유효한 Slack 토큰이 필요해진다. 그래서 포맷/판정/렌더 로직을 `index.js` 밖의 순수 함수로 빼고 (`format.js`, `dashboard.js`), DB 풀과 토큰은 인자로 주입한다. `npm test`는 네트워크·DB 없이 1초 안에 끝난다.

---

## 운영 기록: 데이터 복구

LLM 파싱 오류로 생긴 이상치를 두 차례 정리했다. 두 스크립트 모두 `--apply` 없이 실행하면 트랜잭션 안에서 변경 내용만 출력하고 롤백하는 dry-run 방식이다.

- [`scripts/recover-dates.js`](scripts/recover-dates.js) (7/29) — 기간 밖 이상치 18건(정상 행과 제목·시간이 일치하는 중복 15건 + 날짜만 틀린 3건), 기간 안에서 하루 어긋난 중복 5건, 이벤트 간 URL이 한 칸 밀린 오염, 시간 오차 2건. 정답은 Luma 이벤트 페이지 JSON-LD·공식 캘린더 API·주최측 페이지로 하나씩 대조해 확정했다. 요가처럼 실제로 2세션인 이벤트는 병합 대상에서 제외.
- [`scripts/fix-dates-20260730.js`](scripts/fix-dates-20260730.js) (7/30) — 한 배치에서 `2026-01-xx`로 파싱된 9건을 7월 원본으로 병합. 이 사건이 계기가 되어 6번의 기간 창 방어가 들어갔다.

DB 덤프(`backup-*.json`)는 실명·Slack ID가 들어 있어 `.gitignore`로 막아 두었다.

---

## 로컬 실행

```bash
npm install
cp .env.example .env   # 값 채우기
npm start              # http://localhost:3000/health → ok
```

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `SLACK_BOT_TOKEN` | ✓ | `xoxb-…` |
| `SLACK_SIGNING_SECRET` | ✓ | |
| `DATABASE_URL` | ✓ | Postgres. 스키마는 기동 시 자동 생성 |
| `ANTHROPIC_API_KEY` | ✓ | |
| `PORT` | | 기본 3000 |
| `ADMIN_TOKEN` | | 설정해야 `/admin`이 켜진다. `openssl rand -hex 24` |
| `EVENT_WINDOW_FROM` / `_TO` | | 행사 기간. 기본 `2026-07-24` ~ `2026-07-31` |

```bash
npm test             # 포맷·판정·렌더 회귀 테스트 (외부 의존 없음)
npm run test:parse   # 실제 Luma 샘플을 Claude에 보내 날짜/시간/상태 검증 (실 API 호출, 소량 과금)
```

## 배포 (Railway)

Socket Mode를 쓰지 않고 Events API(HTTP)로 동작하므로 공개 URL이 필요하다. Railway CLI 기준:

```bash
railway init --name techweek-slackbot
railway add --database postgres
railway add --service techweek-app
printf '%s' "$SLACK_BOT_TOKEN"      | railway variable set -s techweek-app --skip-deploys --stdin SLACK_BOT_TOKEN
printf '%s' "$SLACK_SIGNING_SECRET" | railway variable set -s techweek-app --skip-deploys --stdin SLACK_SIGNING_SECRET
printf '%s' "$ANTHROPIC_API_KEY"    | railway variable set -s techweek-app --skip-deploys --stdin ANTHROPIC_API_KEY
railway variable set -s techweek-app --skip-deploys 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up --service techweek-app
railway domain --service techweek-app
```

Railway가 `package.json`을 감지해 `npm install` → `npm start`로 띄운다. `.env`와 `node_modules`는 `.gitignore`에 있어 업로드에서 제외된다. 로컬 개발에서 Railway DB에 붙을 땐 공개 프록시(`DATABASE_PUBLIC_URL`)를, 배포 환경에서는 내부 네트워크 주소를 써야 한다.

## Slack 앱 설정 (api.slack.com/apps)

1. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `im:history`, `im:read`, `commands`, `users:read`
   - `users:read`는 대시보드에 Slack ID 대신 표시 이름을 보여주고 미등록자를 대조하기 위한 것. 스코프를 추가하면 **워크스페이스에 앱을 재설치**해야 반영된다.
2. **Event Subscriptions**: Request URL `https://<도메인>/slack/events`, bot event `message.im`
3. **Interactivity & Shortcuts**: 켜고 Request URL 동일 (`delete` 셀렉트 메뉴용)
4. **Slash Commands**: `/events` `/schedule` `/event-stats` `/students` `/my-events` 각각 Request URL 동일
5. Signing Secret → `SLACK_SIGNING_SECRET`, 설치 후 Bot User OAuth Token → `SLACK_BOT_TOKEN`

---

## 한계와 회고

- **LLM 파싱을 그대로 믿으면 안 된다.** 스키마 강제(structured outputs)로 형식은 보장되지만 값(특히 월)은 틀렸다. 기간 창 같은 도메인 제약을 코드에서 검증하는 것이 프롬프트 개선보다 확실했다. 다시 한다면 날짜 헤더 같은 규칙적인 부분은 정규식으로 먼저 뽑고 LLM에는 매핑만 맡길 것이다.
- **입력이 "복붙"이라 완전성을 보장할 수 없다.** 그래서 삭제(취소 동기화)에 안전장치가 네 겹이나 필요했다. 일부만 복사한 사람에게 삭제 목록을 보여주는 것이 실제로 가장 효과적인 방어였다.
- 코호트 판별(`_42Seoul` 접미사 정규식), 행사 기간 기본값 등 **단일 행사에 맞춘 값이 코드에 박혀 있다.** 다른 행사에 재사용하려면 env/설정으로 빼야 한다.
- 이벤트별 DB 쓰기가 루프 안에서 순차 실행된다. 30명 규모에서는 문제 없었지만 그 이상이면 배치 upsert로 바꿔야 한다.
- 사전 신청 스냅샷은 "행사 종료 후 첫 기동"이라는 운영 타이밍에 의존하는 일회성 마이그레이션이다. 범용 기능이라면 명시적 커맨드나 날짜 트리거로 만들어야 한다.
