# HTTP API

모두 `127.0.0.1`에서만 응답한다. `/api/*` 전체가 토큰을 요구한다.

## 인증

```
x-grmide-token: <토큰>
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
  "conflicted": [],
  "baseline": { "tree": "32ba7d6e…", "freshCount": 2 }
}
```

- `baseline`은 기준점("마지막으로 확인한 시점")이 잡혀 있을 때만 채워진다.
  이때 각 파일에 `fresh: true|false`가 붙는다 — 기준점 이후 바뀌었는지다.
  기준점이 없으면 `baseline`은 `null`이고 비교 비용도 치르지 않는다.
- `freshCount`는 경로 기준 개수다. 화면에 보이는 "새 변경 N"은 여기서 **확인
  체크가 있는 파일을 뺀** 수다 — 개별 확인을 눌러도 표시가 남으면 안 되므로,
  "새 변경 = 기준점 이후 바뀜 AND 아직 확인 안 함"으로 정의한다.
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
| `base` | | `1`이면 HEAD가 아니라 **기준점 대비**로 본다. 이미 확인한 변경은 컨텍스트로 내려가고 새로 바뀐 것만 변경으로 뜬다 |
| `sha` | | 커밋 해시. 주면 워킹트리가 아니라 **그 커밋 안의 변경**을 본다. 이때 `staged`·`untracked`는 무시된다 |

`sha`는 `[0-9a-f]{4,40}` 만 통과한다. `HEAD~3`이나 `main..x` 같은 리비전 표현은
거부한다 — 클라이언트는 목록에서 받은 해시만 되돌려 보내면 되므로 좁게 막는다.

병합 커밋은 **첫 부모와 비교**한다. combined diff는 읽기 어렵다.

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

## GET /api/log

| 파라미터 | 기본 | 설명 |
| --- | --- | --- |
| `limit` | 100 | 한 번에 받을 커밋 수 (1~500) |
| `skip` | 0 | 건너뛸 개수. 더 보기용 |
| `all` | 1 | `1`이면 모든 브랜치(`--all`), `0`이면 HEAD 조상만 |
| `ref` | | 브랜치·태그 이름. 주면 그 ref의 히스토리만 (`all`보다 우선) |
| `q` | | 커밋 검색어 (최대 200자) |
| `in` | `message` | 검색 대상: `message` `author` `content` `path` |

### 검색

| `in` | git 인자 | 찾는 것 |
| --- | --- | --- |
| `message` | `--grep=<q> -i` | 커밋 메시지 |
| `author` | `--author=<q> -i` | 작성자 |
| `content` | `-S<q>` | 이 문자열이 **생기거나 사라진** 커밋 (pickaxe) |
| `path` | `-- <q>` | 이 경로를 건드린 커밋 |

검색어는 항상 인자 하나 안에 갇히고 셸을 거치지 않으므로, `-`로 시작하는 값도
옵션으로 해석되지 않는다.

`ref`는 리비전 자리에 들어가므로 더 좁게 막는다: `-`로 시작하면 거부하고,
`rev-parse --verify <name>^{commit}`로 실제 존재하는지 확인한다. 통과하지 못하면
**무시하고 전체를 보여준다**(오류로 만들지 않는다). 응답의 `ref` 필드로 실제
적용된 값을 알 수 있다.

```json
{
  "commits": [
    {
      "sha": "b6ef3e8...",
      "shortSha": "b6ef3e8",
      "parents": ["95b900c...", "64c0344..."],
      "author": "강성훈",
      "email": "me@example.com",
      "relativeDate": "8 minutes ago",
      "isoDate": "2026-07-25T18:52:03+09:00",
      "subject": "merge hotfix",
      "refs": [{ "type": "head", "name": "main" }],
      "lane": 0,
      "lanesAbove": [0],
      "lanesBelow": [0, 1],
      "parentLanes": [0, 1],
      "isMerge": true
    }
  ],
  "laneCount": 3,
  "hasMore": false,
  "skip": 0,
  "limit": 100,
  "filtered": false,
  "ref": null
}
```

`--topo-order`로 받는다. 기본(시간순)은 시계가 어긋난 커밋에서 그래프가 꼬인다.

`filtered: true`(= 검색 중)면 **그래프를 그리지 않는다.** 모든 커밋의 `lane`이 0,
`lanesAbove`·`lanesBelow`·`parentLanes`가 비고 `laneCount`는 1이다. 검색 결과는
부모가 대부분 빠져 위상이 끊겨 있어서, 레인을 계산하면 커밋마다 새 레인을 잡아
폭이 커밋 수만큼 늘어나고 그려진 선도 사실과 다르다.

### 그래프 레인

ASCII 그림 대신 숫자로 내보내고, 그림은 클라이언트가 SVG로 그린다.

| 필드 | 의미 |
| --- | --- |
| `lane` | 점을 그릴 칸 |
| `lanesAbove` | 이 행 위에서 내려오는 선이 있는 칸들 |
| `lanesBelow` | 이 행 아래로 내려가는 선이 있는 칸들 |
| `parentLanes` | 이 커밋에서 아래로 뻗는 선의 도착 칸 (병합이면 둘 이상) |
| `laneCount` | 이 구간에서 쓰인 칸 수 = 그래프 폭 |

렌더러는 이렇게 읽는다:

- `lanesAbove` ∩ `lanesBelow` → 이 행을 그대로 **통과**하는 선 (수직선)
- `lanesAbove` 중 아래로 안 이어지는 것 → 이 커밋으로 **합쳐지는** 선
- `parentLanes` 중 자기 레인이 아닌 것 → 아래로 **갈라지는** 선

`refs`의 `type`은 `head`(현재 브랜치) · `branch` · `remote` · `tag`.

## POST /api/baseline · DELETE /api/baseline

"내가 마지막으로 확인한 시점"을 잡거나 해제한다.

```json
{ "tree": "32ba7d6e7758839e71cac492b336477e264c1521" }
```

지금 워킹트리를 트리 객체로 굳혀 `refs/grmide/baseline`에 매단다.

- 사용자 index를 건드리지 않기 위해 별도 index 파일(`.git/grmide-index`)로
  `git add -A` → `git write-tree` 한다. 그 파일을 재사용하는 이유는 git의 stat
  캐시다 — 빈 index로 시작하면 저장소 전체를 다시 해시한다.
- ref에 매달아 두므로 `git gc`에도 살아남고 grmide를 다시 켜도 유지된다.
- `refs/grmide/*`는 `--all`에 포함되지 않아 히스토리 그래프를 오염시키지 않는다.

## GET /api/risks

AI가 만든 변경에서 **사람이 놓치기 쉬운 지점**. 린터가 아니라 "여기 한 번 보라"는
표시이므로 판정을 내리지 않고 개수와 예시만 준다.

```json
{
  "files": {
    "src/api.js": [
      { "kind": "error-handling-removed", "label": "사라진 에러 처리", "count": 3,
        "samples": ["try {", "} catch (err) {", "throw new Error('실패')"] },
      { "kind": "debug-added", "label": "남은 디버그 출력", "count": 1,
        "samples": ["console.log(\"fetchUser 호출됨\", id)"] }
    ]
  },
  "total": 5,
  "fileCount": 4
}
```

| `kind` | 무엇을 보는가 |
| --- | --- |
| `test-removed` | 테스트 파일에서 사라진 `it`/`test`/`assert` 줄 |
| `error-handling-removed` | 사라진 `try`/`catch`/`throw`/`.catch(`. 추가된 쪽에 같은 모양이 있으면 옮긴 것으로 보고 그만큼 뺀다 |
| `debug-added` | 새로 들어온 `console.log`/`debugger`/`print(`. 테스트 파일은 제외 |
| `dependency` | `package.json`·lock 파일 변경 |
| `large-deletion` | 30줄 이상 지워지고 추가가 그 1/4 미만 |

위험이 없는 파일은 `files`에 넣지 않는다.

**한 번의 git 호출로 전체를 받는다.** 파일마다 `git diff`를 돌리면 44개 파일에 44번
프로세스를 띄운다. 기준점이 쓰는 임시 index를 재사용해 `add -A` → `diff HEAD --cached -U0`
로 한 번에 받으므로 추적되지 않은 새 파일도 함께 들어온다.

## GET /api/reviewed · PUT /api/reviewed

파일별 "확인함" 표시. `{ "marks": { "work:src/api.js": "modified:3:8" } }`

키는 `staged|work:<경로>`, 값은 변경 규모 지문(`status:추가:삭제`)이다. 그 파일이
다시 바뀌면 지문이 달라져 확인 상태가 자동으로 풀린다.

PUT은 맵을 통째로 갈아 끼운다 — 토글·전체 확인·정리가 모두 맵 전체를 다시 쓰는
동작이고 크기도 파일 수만큼이라 통째로 보내는 편이 단순하다.

**왜 서버인가**: 브라우저 localStorage에 두었더니 grmide가 다른 포트로 뜰 때
(4317이 사용 중일 때) 다른 origin이 되어 진행률이 통째로 사라졌다. 저장소에 붙은
상태이므로 저장소 옆(`<git-dir>/grmide-state.json`)에 둔다.

## 리뷰 코멘트

사람의 판단을 AI에게 되돌리는 경로. 저장 위치는 `<git-dir>/grmide-state.json`이다.

**왜 워킹트리가 아니라 `.git` 안인가**: 워킹트리에 파일을 만들면 grmide 자신의
변경 목록에 떠서 리뷰를 방해하고 커밋 대상이 된다. 저장소마다 따로 남아야 하고,
감시자가 `.git`을 보지 않으므로 저장할 때 화면이 새로고침되지도 않는다.
브라우저 localStorage를 쓰지 않는 이유는 포트가 바뀌면(4317이 사용 중이면 4318로
뜬다) 다른 origin이 되어 내용을 잃기 때문이다.

### GET /api/comments

```json
{
  "comments": [
    {
      "id": "cms0anuc00hfd",
      "path": "web/src/App.vue",
      "line": 214,
      "endLine": null,
      "side": "right",
      "code": "    if (line) await nextTick(() => scrollToLine(line))",
      "text": "이 nextTick 왜 필요해?",
      "sha": null,
      "createdAt": "2026-07-25T11:37:04.080Z"
    }
  ],
  "prompt": "아래 리뷰 코멘트를 반영해줘.\n\n## web/src/App.vue\n…"
}
```

- `side`는 `left`(삭제된 쪽) / `right`(현재 쪽)
- `endLine`은 여러 줄을 끌어 고른 코멘트일 때만 채워진다. 프롬프트에는
  `path:3-6` 형태로 적히고, `code`에는 그 범위의 줄들이 모두 담긴다
- `code`는 **코멘트를 쓸 때 본 그 줄의 내용**이다. 나중에 프롬프트를 만들 때
  파일을 다시 읽지 않아도 되고, 그 사이 파일이 바뀌어도 무엇을 보고 쓴 코멘트인지
  남는다
- `sha`는 커밋 diff에 단 코멘트일 때만 채워진다
- `prompt`는 붙여넣기 가능한 형태로 서버가 만들어 준다 (파일별로 묶고 줄 번호 순,
  확장자에 맞는 코드 펜스)

### POST /api/comments

```json
{ "path": "web/src/App.vue", "line": 214, "endLine": null, "side": "right", "code": "…", "text": "…" }
```

`text`가 비어 있으면 400. 500개를 넘으면 오래된 것부터 버린다.

### PATCH /api/comments

`{ "id": "...", "text": "..." }` — 없는 id면 404.

### DELETE /api/comments

`?id=<id>` 로 하나 삭제, `?all=1` 로 전부 삭제.

## GET /api/files

⌘P(파일 열기)용 목록. 파라미터 없음.

```json
{ "files": ["README.md", "bin/grmide.js", "server/git.js"] }
```

`git ls-files -co --exclude-standard` — 추적 중인 파일 + untracked 파일이고
`.gitignore`는 git이 알아서 지킨다(`node_modules`가 목록을 덮지 않는다).
파일시스템을 직접 훑지 않는다.

서버에서 캐시하고, 워킹트리가 바뀌면(같은 감시자가 SSE를 쏘는 시점) 버린다.

## GET /api/file

읽기 전용 파일 내용.

| 파라미터 | 필수 | 설명 |
| --- | --- | --- |
| `path` | O | 저장소 루트 기준 상대 경로 |
| `sha` | | 커밋 해시. 주면 그 시점의 내용 (`git show <sha>:<path>`) |

```json
{
  "path": "server/log.js",
  "sha": null,
  "language": "javascript",
  "sections": null,
  "binary": false,
  "lines": ["/**", " * `git log` 출력을 파싱하고…"],
  "lineCount": 238,
  "truncated": false
}
```

- 앞 8000바이트에 NUL이 있으면 `binary: true`이고 `lines`는 빈 배열이다
- 20,000줄까지만 보내고 넘으면 `truncated: true`
- 저장소 밖 경로는 403

## GET /api/grep

⌘⇧F(전체 텍스트 검색)용.

| 파라미터 | 기본 | 설명 |
| --- | --- | --- |
| `q` | | 찾을 문자열 (최대 200자) |
| `limit` | 400 | 결과 개수 상한 (1~2000) |

```json
{
  "query": "renderSummary",
  "hits": [
    { "path": "bin/grmide.js", "line": 8, "text": "import { renderSummary } from './summary.js'" }
  ],
  "truncated": false
}
```

`git grep --null -n -I -i -F --untracked` 를 쓴다.

- `--null` → `path\0line\0text`. 경로에 콜론이 있어도 안전하게 나눌 수 있다
- `-I` 바이너리 건너뛰기, `-i` 대소문자 무시, **`-F` 고정 문자열(정규식 아님)**
- 정규식을 받지 않는 이유: 코드에서 찾는 문자열은 대부분 특수문자를 포함하고,
  타이핑 중간 상태(`(`, `[a-`)가 늘 오류가 된다
- 결과가 없으면 git이 exit 1을 내는데, 오류로 보지 않고 빈 결과로 처리한다
- **`--untracked`** — 추적되지 않은 파일도 본다. AI가 방금 만든 파일이 검색에서
  빠지면 이 도구를 쓰는 상황에서 가장 자주 찾을 것을 못 찾는다. `.gitignore`는
  그대로 지켜진다(`node_modules`는 들어오지 않는다)

## GET /api/refs

브랜치 선택기에 쓸 목록. 파라미터 없음.

```json
{
  "refs": [
    {
      "name": "main",
      "fullName": "refs/heads/main",
      "kind": "local",
      "shortSha": "8566076",
      "relativeDate": "9 minutes ago",
      "subject": "노이즈 캔슬링 옵션 추가",
      "current": true
    }
  ]
}
```

- `kind`: `local` · `remote` · `tag`
- `current: true`는 현재 체크아웃된 브랜치
- 최근 커밋 순(`--sort=-committerdate`)
- `refs/remotes/origin/HEAD`는 다른 브랜치를 가리키는 별칭이라 목록에서 빠진다

## GET /api/commit

| 파라미터 | 필수 | 설명 |
| --- | --- | --- |
| `sha` | O | 커밋 해시 |

```json
{
  "sha": "b6ef3e8...", "shortSha": "b6ef3e8",
  "parents": ["95b900c...", "64c0344..."],
  "author": "강성훈", "email": "me@example.com",
  "relativeDate": "8 minutes ago", "isoDate": "2026-07-25T18:52:03+09:00",
  "subject": "merge hotfix",
  "body": "본문 (제목 아래 내용)",
  "refs": [],
  "rooted": false,
  "files": [
    { "path": "hotfix-1.txt", "origPath": null, "status": "added",
      "additions": 1, "deletions": 0 }
  ]
}
```

- `rooted: true`면 최초 커밋이다. 비교 대상이 없어 `--root`로 트리 전체를 낸다.
- `files`의 `status`는 `/api/status`와 같은 이름을 쓴다. rename이면 `origPath`가 찬다.
- 없는 커밋은 404.

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
자동 재접속에 맡기면 grmide를 끈 뒤 페이지가 먹통이 되므로, 직접 재접속을
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
