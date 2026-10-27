# 스핀 클래시 온라인 서버 (친구와 방 코드 1:1)

- `index.html` : 게임
- `server.js` : 서버. 게임 파일을 보여주고(/), WebSocket(/ws)으로 두 사람의 입력을 이어준다. 전투 계산은 서버가 안 한다(두 폰이 같은 계산을 한다).
- `accounts.js` : 계정(아이디/비밀번호 가입·로그인, 닉네임, 선택 이메일 재설정). Postgres 필요, 없으면 꺼짐
- `package.json` : `ws`(웹소켓), `pg`(Postgres)

## 내 컴퓨터에서 실행해 보기 (Node.js 18 이상)
```
npm install
node server.js
```
브라우저 두 개로 `http://localhost:8080` 을 열어서 "친구와 온라인 대전" → 방 만들기 / 코드로 참가.

## 인터넷에 올리기
Node 서버를 돌릴 수 있는 곳(예: Render)에 이 폴더를 올리고
- Build command: `npm install`
- Start command: `node server.js`
로 설정하면 된다. 포트는 `PORT` 환경변수를 자동으로 읽는다. 주소는 https 로 열리고, 게임이 알아서 wss 로 접속한다.

## 참고
- 게임을 고치면 `index.html` 만 새 버전으로 바꿔 올리면 된다.
- 서버는 방 정보를 메모리에만 들고 있어서, 서버가 재시작되면 방이 사라진다.
- 테스트용 환경변수: `LAT_MS`, `JIT_MS` (인위적 지연, 실제 서비스에서는 비워둘 것)

## 계정 기능 켜기 (환경변수)
- `DATABASE_URL` : Postgres 접속 문자열 (예: Neon). 이게 없거나 연결이 안 되면 계정 기능만 꺼지고 게임은 손님으로 계속 된다. `/health` 에 `acc=ok|off|err` 로 표시.
- `OWNER_USERNAME` : 제작자 아이디(소문자). 이 아이디로 가입하면 제작자 계정이 되어 닉네임 "유령"을 쓸 수 있다. **배포 직후 가장 먼저 이 아이디로 가입할 것.**
- `BASE_URL` : 메일 속 링크 주소 (예: https://spinclash-online.onrender.com). 비우면 접속 주소를 그대로 쓴다.
- 메일(비밀번호 재설정용, 선택): `MAIL_PROVIDER`=`brevo`|`resend`, `BREVO_API_KEY` 또는 `RESEND_API_KEY`, `MAIL_FROM`(보내는 주소), `MAIL_FROM_NAME`. Render 무료 서버는 SMTP 포트(25/465/587)가 막혀 있어서 HTTP API 방식만 쓴다.
- 테스트용: `REG_PER_HOUR`(IP당 시간당 가입 수, 기본 5), `MAIL_FILE`(메일 대신 파일에 기록)
