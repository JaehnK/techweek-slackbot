# techweek-slackbot

테크위크 이벤트 신청 현황을 관리하는 Slack 봇. Slack DM으로 Luma 페이지 텍스트를 붙여넣으면 Claude(`claude-haiku-4-5`)가 이벤트 목록을 JSON으로 구조화 추출해 Postgres에 저장하고, 슬래시 커맨드로 전체/개인 신청 현황을 조회할 수 있다.

## 아키텍처

- `@slack/bolt` — Slack Events API + 슬래시 커맨드 (HTTP 모드, Express 내장 리시버)
- `@anthropic-ai/sdk` — Claude structured outputs로 이벤트 목록 파싱
- `pg` — Postgres. 최초 실행 시 `students` / `events` / `applications` 테이블과 트리거를 자동 생성

## 로컬 개발

```bash
npm install
cp .env.example .env   # 값 채우기
npm start
```

`/health` 엔드포인트로 헬스체크 가능 (`GET http://localhost:3000/health`).

## Slack 앱 설정 (api.slack.com/apps)

1. **Socket Mode는 사용하지 않음** — Events API(HTTP)로 동작하므로 배포 후 공개 URL이 필요하다.
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `im:history`, `im:read`, `commands`
3. **Event Subscriptions**: Request URL = `https://<railway-도메인>/slack/events` (배포 후 설정). Subscribe to bot events: `message.im`
4. **Slash Commands**: 아래 4개 각각 Request URL = `https://<railway-도메인>/slack/events`

   | Command | 설명 |
   |---|---|
   | `/events` | 전체 신청 현황 (평면 목록) |
   | `/schedule` | 시간대별 참석 현황 (날짜별 타임라인) |
   | `/event-stats` | 이벤트별 신청 통계 (날짜별, 상태 분해) |
   | `/students` | 인당 신청 현황 (사람별 합계 + 상태 분해) |
   | `/my-events` | 내 신청 내역 |
5. **Basic Information**에서 Signing Secret 확인 → `SLACK_SIGNING_SECRET`
6. 앱을 워크스페이스에 설치 후 Bot User OAuth Token(`xoxb-...`) 확인 → `SLACK_BOT_TOKEN`

## 배포 현황 (Railway)

Railway CLI로 배포 완료.

- **프로젝트**: `techweek-slackbot` (Railway)
- **서비스**: `techweek-app`(앱) + `Postgres`(DB)
- **공개 도메인**: https://techweek-app-production.up.railway.app
- **환경변수**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`는 CLI로 설정됨. `DATABASE_URL`은 `${{Postgres.DATABASE_URL}}` 참조로 연결(내부 네트워크). `PORT`는 Railway가 자동 주입.
- **빌드**: Railway가 `package.json` 감지 → `npm install` → `npm start`.

### ⚠️ 남은 작업 — 유효한 Slack 토큰 필요

현재 앱은 빌드·DB 연결·스키마 생성까지 정상이지만, `SLACK_BOT_TOKEN`이 유효하지 않아 기동 직후 Slack `invalid_auth`로 크래시-루프 중이다. 아래를 완료하면 정상 상주한다:

1. api.slack.com/apps에서 앱을 만들고 워크스페이스에 설치해 **유효한 Bot User OAuth Token(`xoxb-...`)** 확보
2. 토큰 교체 (값이 로그에 안 남게 stdin으로):
   ```bash
   printf '%s' 'xoxb-실제토큰' | railway variable set --service techweek-app --stdin SLACK_BOT_TOKEN
   ```
   `SLACK_SIGNING_SECRET`도 같은 방식으로 실제 값인지 확인/교체.
3. Slack 앱 설정에서 **Event Subscriptions**(`message.im`)와 **Slash Commands**(`/events`, `/schedule`, `/event-stats`, `/students`, `/my-events`)의 Request URL을 아래로 지정:
   `https://techweek-app-production.up.railway.app/slack/events`
4. `GET https://techweek-app-production.up.railway.app/health` → `ok` 확인 후 DM 테스트

### 참고 — CLI로 처음부터 다시 배포하는 절차

```bash
railway init --name techweek-slackbot     # 프로젝트 생성 + 디렉토리 링크
railway add --database postgres            # Postgres 추가
railway add --service techweek-app         # 앱 서비스 생성
# 시크릿(stdin) + DB 참조 변수 설정
printf '%s' "$SLACK_BOT_TOKEN"      | railway variable set -s techweek-app --skip-deploys --stdin SLACK_BOT_TOKEN
printf '%s' "$SLACK_SIGNING_SECRET" | railway variable set -s techweek-app --skip-deploys --stdin SLACK_SIGNING_SECRET
printf '%s' "$ANTHROPIC_API_KEY"    | railway variable set -s techweek-app --skip-deploys --stdin ANTHROPIC_API_KEY
railway variable set -s techweek-app --skip-deploys 'DATABASE_URL=${{Postgres.DATABASE_URL}}'
railway up --service techweek-app          # 로컬 디렉토리 업로드 → 빌드/배포
railway domain --service techweek-app      # 공개 도메인 발급
```

> `.env`와 `node_modules`는 `.gitignore`에 있어 `railway up` 업로드에서 자동 제외된다 (시크릿은 Railway 환경변수로만 관리).

<details>
<summary>대안: GitHub 연동 방식 (dashboard)</summary>

1. GitHub 저장소에 push (이미 완료: https://github.com/JaehnK/techweek-slackbot)
2. [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** → 저장소 선택
3. Postgres 플러그인 추가, 위와 동일한 환경변수 설정
4. push할 때마다 자동 재배포
</details>

<details>
<summary>(구) 수동 배포 단계 메모</summary>

1. GitHub에 새 저장소 생성 후 이 프로젝트 push
   ```bash
   git remote add origin git@github.com:<user>/techweek-slackbot.git
   git push -u origin main
   ```
2. [railway.app](https://railway.app) → New Project → **Deploy from GitHub repo** → 위 저장소 선택
3. Railway 프로젝트에 **Postgres 플러그인 추가** → `DATABASE_URL`이 자동으로 서비스 환경변수에 주입됨
4. 서비스 Variables에 아래 값 추가:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `ANTHROPIC_API_KEY`
   - (`DATABASE_URL`, `PORT`는 Railway가 자동 설정)
5. Railway가 Nixpacks로 `package.json`을 감지해 `npm install` → `npm start`로 빌드/실행 (별도 설정 파일 불필요)
6. 배포 후 발급되는 공개 도메인(`https://<app>.up.railway.app`)을 Slack 앱의 Event Subscriptions / Slash Commands Request URL에 등록
7. `/health`로 정상 기동 확인 후 DM 테스트

</details>

## 알아둘 점

- 봇은 **DM에서만** 텍스트를 파싱한다 (`channel_type === 'im'` 체크). 채널 멘션에는 반응하지 않는다.
- Luma 캘린더 **메인 페이지 전체**를 복붙하는 것을 전제로 파싱 프롬프트가 작성되어 있다. 입력 텍스트가 50,000자를 넘으면 파싱을 거부한다 (Claude 호출 비용/토큰 보호).
- **날짜/시간은 항상 행사 현지시각으로 저장한다.** Luma는 보는 사람 타임존에 따라 시간을 1~2개로 표시하므로 규칙이 필요하다:
  - 시간이 **2개**면 (`오전 7:30 · 7월 27일 오후 3:30 GMT-7`) → `GMT±N`이 붙은 쪽이 현지시각. **그 옆의 날짜까지** 사용한다 (위 예시 → `2026-07-27 15:30`).
  - 시간이 **1개**면 (GMT 표기 없음) → 보는 사람 타임존 = 행사 타임존이라는 뜻이므로 그대로 쓰고, 날짜는 섹션 헤더를 사용한다.
  - ⚠️ 시간이 2개일 때 **날짜 섹션 헤더(`7월 28일 화요일`)를 따라가면 안 된다** — 그건 보는 사람 로컬 날짜라 행사 현지 날짜와 하루 어긋난다. 한국에서 보면 Luma 화면이 봇 출력보다 하루 뒤로 보이는 게 정상.
  - 이 규칙 덕에 어느 타임존에서 붙여넣어도 같은 값이 나와 중복 row가 안 생긴다. 슬래시 커맨드 출력에도 `(행사 현지시각 기준)`을 명시한다.
- 출력 포맷팅은 `format.js`(순수 함수)로 분리해 DB/Slack 없이 테스트할 수 있다. `index.js`에서 Bolt `App`을 생성하면 그 시점에 `auth.test`가 호출되므로, 포맷 로직을 `index.js`에 두면 테스트에서도 유효한 Slack 토큰이 필요해진다.
- 테스트:
  - `npm test` — 출력 포맷 회귀 테스트 (외부 의존 없음, 빠름)
  - `npm run test:parse` — 실제 Luma 샘플을 Claude에 보내 날짜/시간/상태를 검증 (실제 API 호출 → `ANTHROPIC_API_KEY` 필요, 소량 과금)
- `luma_url`이 텍스트에서 보이지 않으면(대부분의 경우) `title-event_date` 조합을 대신 유니크 키로 사용한다. 위 타임존 규칙이 깨지면 이 키도 흔들려 중복이 생기니 주의.
- 신청 상태(`applications.status`)가 한 번 `참석`으로 확정되면, 오래된 텍스트를 다시 붙여넣어도 `승인 대기 중`으로 되돌아가지 않는다 (그 외 상태 전이는 항상 최신값으로 덮어씀).
- **재붙여넣기 = 예정 일정 동기화.** 붙여넣기를 "그 시점의 예정 일정 전체"로 보고, 빠진 예정 일정은 취소된 것으로 간주해 그 학생의 신청에서 제거한다. Luma `예정된` 탭에는 미래 일정만 나오므로 **지난 일정(참석 기록)은 삭제 대상에서 제외**한다 (서버 UTC ↔ 시애틀 UTC-7 경계를 감안해 `CURRENT_DATE - 1일`을 기준으로 둔다). 파싱 결과가 비면 삭제를 아예 건너뛴다(기존 일정 전멸 방지). 제거된 항목은 DM 응답에 목록으로 알려 일부만 복사해 보낸 경우 본인이 즉시 알아챌 수 있게 한다.
- `students.name` 컬럼에는 표시 이름이 아니라 **Slack user ID**가 저장된다 (조회 커맨드의 조인 키로 사용).
