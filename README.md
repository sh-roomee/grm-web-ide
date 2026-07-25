# gitshow (grm-web-ide)

터미널에서 AI로 개발하다가 **git 변경사항을 보려고 IDE를 켜는 일**을 없애기 위한
브라우저 git 뷰어.

```
cd ~/work/my-project
gitshow
```

브라우저가 열리고, 현재 디렉토리의 변경된 파일 목록과 side-by-side diff가 뜬다.
AI가 파일을 고치면 브라우저가 스스로 따라온다.

## 설치

```bash
npm install
npm run build      # 프론트엔드 빌드 (web/dist)
npm link           # gitshow 명령을 전역에 등록
```

`npm link` 대신 직접 실행해도 된다: `node /path/to/grm-web-ide/bin/gitshow.js`

## 사용법

```
gitshow [경로] [옵션]

  -p, --port <번호>   시작 포트 (기본 4317, 사용 중이면 다음 포트로)
      --no-open       브라우저를 자동으로 열지 않는다
  -h, --help          도움말
```

경로를 주지 않으면 현재 디렉토리를 쓴다. 서브 디렉토리에서 실행해도 저장소
루트를 스스로 찾는다.

## 화면

| 영역 | 내용 |
| --- | --- |
| 상단 | 저장소 이름, 브랜치, HEAD 커밋, 확인 진행률, 마지막 갱신 시각 |
| | gitshow를 끄면 "연결 끊김"이 뜬다. 다시 켠 뒤 "다시 연결"을 누르면 이어진다 |
| 좌측 | 충돌 / Staged / Changes 그룹별 변경 파일 목록 (+추가 −삭제 줄 수) |
| 우측 | side-by-side diff, 문법 강조, 단어 단위 하이라이트, 변경 위치 눈금 |

### 보기 범위

상단에서 세 가지 중 고른다. 고른 값은 저장되어 다음에 열 때도 유지된다.

| 버튼 | 보이는 것 |
| --- | --- |
| **변경 부분** | 변경 주변 3줄만 (기본) |
| **± 8줄** | 변경 주변 8줄. 앞뒤 맥락이 조금 더 필요할 때 |
| **파일 전체** | 파일 전체를 보면서 변경된 곳을 확인 |

파일 전체 보기에서는 변경된 곳이 긴 내용 사이에 흩어진다. 그래서 오른쪽
가장자리에 변경 위치를 눈금으로 찍어 두었다 — 색은 추가(초록)/삭제(빨강)/수정(파랑)이고,
누르면 그 자리로 이동한다. 상단 `↑` `↓`와 `3 / 5` 표시로도 변경 사이를 오갈 수 있다.

### 문법 강조

언어별 플러그인 구조다. 지원: **js/ts · vue · html · css/scss · json**.
그 외 확장자는 색 없이 나온다.

`.vue`는 한 파일 안의 `<template>` / `<script>` / `<style>`을 각각 다른 언어로
칠하고, Vue 디렉티브(`v-if`, `:class`, `@click`)의 값과 `{{ }}` 안쪽은 JS 식으로
칠한다.

색은 전경색만 쓴다. 배경색은 diff(추가/삭제/변경된 단어)가 쓰므로 서로 겹치지
않는다. 언어를 추가하려면 `web/src/highlight/languages/`에 파일을 하나 만들고
`web/src/highlight/index.js`에 등록한 뒤, `server/language.js`의 확장자 표에 같은
id를 넣는다. 자세한 규약은
[ARCHITECTURE](docs/ARCHITECTURE.md#문법-강조는-클라이언트-플러그인) 참고.

### 단축키

| 키 | 동작 |
| --- | --- |
| `j` / `k` | 다음 / 이전 파일 |
| `space` | 현재 파일을 "확인함"으로 토글 |

### 확인 체크박스

AI가 만든 변경은 파일이 수십 개라 어디까지 봤는지가 곧 진행률이다. 파일마다
체크할 수 있고 브라우저에 저장된다. **그 파일이 다시 바뀌면 체크가 자동으로
풀린다** — 이미 본 내용이 아니기 때문이다.

### stage / unstage

목록에서 파일에 마우스를 올리면 오른쪽에 `+` / `−` 가 나온다. push, pull,
rebase 같은 원격 조작은 일부러 넣지 않았다 (터미널이 더 빠르다).

## 개발

```bash
npm run dev     # 서버(4317) + vite dev server(5173) 동시 실행
npm test        # diff 파서 테스트
npm run build   # 배포용 프론트엔드 빌드
```

`npm run dev`는 현재 디렉토리를 대상 저장소로 잡는다. 다른 저장소를 보려면
`GITSHOW_DEV=1 node bin/gitshow.js <경로> --no-open --port 4317`을 직접 실행하고
`npm run dev:web`을 따로 띄운다.

dev 서버가 출력한 URL의 `?t=<토큰>`을 붙여 `http://localhost:5173/?t=<토큰>`으로
접속해야 한다.

## 보안

저장소 내용을 그대로 노출하는 서버이므로:

- `127.0.0.1`에만 바인딩한다. 외부 바인딩 옵션은 제공하지 않는다.
- 실행마다 임의 토큰을 만들고 `/api/*` 전체에 요구한다. 같은 머신의 다른
  프로세스나 브라우저에서 열어둔 웹사이트가 마음대로 붙지 못한다.
- 토큰은 URL로 한 번 전달된 뒤 즉시 `sessionStorage`로 옮기고 주소창에서 지운다.
- 저장소 밖 경로 요청은 서버에서 거부한다.

## 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 구조와 설계 결정
- [docs/API.md](docs/API.md) — HTTP API
- [docs/ROADMAP.md](docs/ROADMAP.md) — 진행 상황과 다음 단계
- [CLAUDE.md](CLAUDE.md) — 작업 규칙 (범위 / 문서화)
