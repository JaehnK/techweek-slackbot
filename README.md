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
4. **Slash Commands**: `/events`, `/event-stats`, `/my-events` 각각 Request URL = `https://<railway-도메인>/slack/events`
5. **Basic Information**에서 Signing Secret 확인 → `SLACK_SIGNING_SECRET`
6. 앱을 워크스페이스에 설치 후 Bot User OAuth Token(`xoxb-...`) 확인 → `SLACK_BOT_TOKEN`

## Railway 배포 준비 (GitHub 연동 방식)

이 저장소는 GitHub에 푸시해서 Railway와 연동하는 것을 전제로 준비되어 있다. 아래는 실제 배포 시 진행할 단계 (직접 실행은 하지 않음):

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

## 알아둘 점

- 봇은 **DM에서만** 텍스트를 파싱한다 (`channel_type === 'im'` 체크). 채널 멘션에는 반응하지 않는다.
- 입력 텍스트가 20,000자를 넘으면 파싱을 거부한다 (Claude 호출 비용/토큰 보호).
- `students.name` 컬럼에는 표시 이름이 아니라 **Slack user ID**가 저장된다 (조회 커맨드의 조인 키로 사용).
