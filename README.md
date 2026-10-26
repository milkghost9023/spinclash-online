# 스핀 클래시 온라인 서버 (친구와 방 코드 1:1)

- `index.html` : 게임 (v510)
- `server.js` : 서버. 게임 파일을 보여주고(/), WebSocket(/ws)으로 두 사람의 입력을 이어준다. 전투 계산은 서버가 안 한다(두 폰이 같은 계산을 한다).
- `package.json` : 필요한 것은 `ws` 하나

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
