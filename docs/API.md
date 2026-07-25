# HTTP API

모두 `127.0.0.1`에서만 응답한다. `/api/*` 전체가 토큰을 요구한다.

## 인증

```
x-gitshow-token: <토큰>
```

헤더를 붙일 수 없는 `EventSource`만 쿼리 파라미터를 허용한다: `?t=<토큰>`

토큰이 틀리면 `401 { "error": "토큰이 유효하지 않습니다" }`.

## GET /api/repo

```json
{
  "root": "/Users/me/work/project",
  "name": "project",
  "branch": "main",
  "head": {
    "sha": "cb1ba6719bfa4cbd06a14116e5c95a0b354c8750",
    "shortSha": "cb1ba67",
    "author": "test",
    "relativeDate": "25 seconds ago",
    "subject": "initial commit"
  }
}
```

`branch`는 detached HEAD면 `(detached cb1ba67)`, 커밋이 없으면 `(empty)`.
커밋이 없는 저장소는 `head`가 `null`.

## GET /api/status

```json
{
  "staged": [
    {
      "path": "a.txt",
      "origPath": null,
      "status": "modified",
      "staged": true,
      "additions": 2,
      "deletions": 1
    }
  ],
  "unstaged": [
    {
      "path": "untracked.txt",
      "origPath": null,
      "status": "untracked",
      "staged": false,
      "untracked": true,
      "additions": 1,
      "deletions": 0
    }
  ],
  "conflicted": []
}
```

- 한 파일이 `staged`와 `unstaged`에 **동시에** 나올 수 있다 (일부만 stage된 경우).
  따라서 클라이언트의 식별 키는 `path`가 아니라 `staged + path`다.
- `status`: `modified` `added` `deleted` `renamed` `copied` `typechange`
  `untracked` `conflicted` `unknown`
- `additions` / `deletions`가 `null`이면 바이너리.
- `origPath`는 rename/copy일 때만 채워진다.

## GET /api/diff

| 파라미터 | 필수 | 설명 |
| --- | --- | --- |
| `path` | O | 저장소 루트 기준 상대 경로 |
| `staged` | | `1`이면 `--cached` diff |
| `untracked` | | `1`이면 `--no-index`로 `/dev/null`과 비교 |
| `context` | | 컨텍스트 줄 수 = `git diff -U<n>` (기본 3). 화면의 "파일 전체"는 100000이며 파일 전체가 한 훅으로 온다 |

```json
{
  "path": "src/AudioTest.vue",
  "staged": false,
  "untracked": false,
  "binary": false,
  "truncated": false,
  "language": "vue",
  "sections": [
    { "start": 1, "end": 82, "lang": "markup" },
    { "start": 83, "end": 260, "lang": "javascript" },
    { "start": 262, "end": 400, "lang": "css" }
  ],
  "oldPath": "src/AudioTest.vue",
  "newPath": "src/AudioTest.vue",
  "changes": 1,
  "hunks": [
    {
      "header": "export default {",
      "oldStart": 83, "oldLines": 7,
      "newStart": 83, "newLines": 7,
      "changes": 1,
      "rows": [
        {
          "type": "context",
          "left":  { "num": 83, "text": "<script>" },
          "right": { "num": 83, "text": "<script>" }
        },
        {
          "type": "mod",
          "left":  { "num": 84, "text": "import {grmNoiseCancel} from \"…\"",
                     "words": [[8, 22]] },
          "right": { "num": 84, "text": "import {getNoiseCancel} from \"…\"",
                     "words": [[8, 22]] }
        }
      ]
    }
  ]
}
```

### row 규칙

| `type` | `left` | `right` | 의미 |
| --- | --- | --- | --- |
| `context` | 있음 | 있음 | 변경 없는 줄 |
| `mod` | 있음 | 있음 | 삭제/추가가 짝지어진 줄. 양쪽에 `words` |
| `del` | 있음 | `null` | 삭제만 |
| `add` | `null` | 있음 | 추가만 |

- `words`는 **바뀐 구간의 오프셋** `[[start, end], ...]`이다. `text` 안의 문자
  인덱스이고, 정렬되어 있으며 겹치지 않는다. `mod`에서만 채워지고, 줄이 너무
  길면(400 토큰 초과) `null`이다.
  - 문자열 조각이 아니라 오프셋인 이유: 클라이언트가 문법 강조 토큰(전경색)과
    이 구간(배경색)을 하나의 span 목록으로 합쳐야 한다. 두 구간은 서로 걸친다.
- `truncated: true`면 20,000행 제한에 걸려 뒷부분이 잘렸다.
- `binary: true`면 `hunks`는 비어 있다.

### 문법 강조 정보

| 필드 | 설명 |
| --- | --- |
| `language` | `javascript` `markup` `css` `json` `vue` `plain` 중 하나. 확장자로 판단 |
| `sections` | `.vue`처럼 한 파일에 여러 언어가 섞일 때만. 그 외에는 `null` |

`sections`는 `[{ start, end, lang }]`이고 줄 번호는 1부터, `end`는 포함이다.
워킹트리의 현재 파일 내용을 훑어 만들며, 파일을 읽을 수 없으면(삭제 등) `null`.

강조 자체는 클라이언트 플러그인이 한다
([ARCHITECTURE](ARCHITECTURE.md#문법-강조는-클라이언트-플러그인) 참고).
diff에는 파일 조각만 담기므로, `@@ -249,7 @@` 같은 훅이 `<script>` 안인지
화면 내용만으로는 알 수 없다. 그래서 구획 판단만 서버가 맡는다.

## POST /api/stage · POST /api/unstage

```json
{ "path": "src/AudioTest.vue" }
```

응답 `{ "ok": true }`. `stage`는 `git add`, `unstage`는 `git reset HEAD --`.

## GET /api/events (SSE)

```
event: changed
data: {}
```

워킹트리나 `.git/index`, `HEAD`가 바뀌면 200ms 디바운스 후 발행된다. 페이로드는
비어 있고, 클라이언트가 `/api/status`와 `/api/diff`를 다시 요청하는 신호로만 쓴다.
25초마다 `: ping` 주석을 보내 연결을 유지한다.

`retry: 3000`을 내려보내지만 클라이언트는 이 값에 의존하지 않는다. 브라우저의
자동 재접속에 맡기면 gitshow를 끈 뒤 페이지가 먹통이 되므로, 직접 재접속을
돌린다 (1·2·4·8·16초, 다섯 번 후 포기).
[ARCHITECTURE](ARCHITECTURE.md#재접속은-브라우저에-맡기지-않는다) 참고.

서버가 종료될 때는 열린 SSE 응답을 먼저 `end()`한다. 그러지 않으면 `server.close()`가
끝나기를 기다려 프로세스가 종료되지 않는다.

## 오류 응답

| 상태 | 상황 |
| --- | --- |
| 400 | `path` 파라미터 누락 |
| 401 | 토큰 불일치 |
| 403 | 저장소 밖 경로 요청 |
| 500 | git 명령 실패 |

본문은 항상 `{ "error": "<메시지>" }`.
