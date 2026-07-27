import { createScanner } from '../scanner.js'

/**
 * Java.
 *
 * 자바 코드를 읽을 때 눈이 먼저 찾는 것은 **타입과 애너테이션**이다. 한 줄이
 * `@Override public ResponseEntity<RoomDto> getRoom(@PathVariable Long id)` 처럼
 * 수식어로 시작하는 일이 많아서, 키워드만 칠하면 어디가 타입이고 어디가 이름인지
 * 구분이 안 된다. 그래서 두 가지를 규칙으로 넣었다.
 *
 *  - `@Annotation` — 메타 표시라 코드 본문과 다른 색으로 뗀다
 *  - `UpperCamelCase` 식별자 — 타입으로 본다. 자바에서는 관례가 강해 거의 맞는다
 */

const KEYWORDS =
  'abstract|assert|break|case|catch|class|continue|default|do|else|enum|extends|' +
  'final|finally|for|goto|if|implements|import|instanceof|interface|native|new|' +
  'package|private|protected|public|return|static|strictfp|super|switch|' +
  'synchronized|this|throw|throws|transient|try|volatile|while|yield|' +
  // 문맥 키워드 (Java 9+ 모듈, 14+ record, 17+ sealed)
  'record|sealed|permits|non-sealed|var|module|requires|exports|opens|provides|uses|to|with'

// 기본형과 리터럴은 타입/키워드와 색을 나눠 두면 시그니처가 훨씬 빨리 읽힌다.
const PRIMITIVES = 'boolean|byte|char|double|float|int|long|short|void'
const LITERALS = 'true|false|null'

const scan = createScanner([
  // 주석이 가장 먼저다. 주석 안의 따옴표에 속으면 줄 전체가 문자열이 된다.
  { re: /\/\/.*/, cls: 'comment' },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: 'comment' },

  // 텍스트 블록(Java 15+). 줄 단위 스캐너라 여는 따옴표가 있는 줄만 알아본다.
  { re: /"""[\s\S]*?(?:"""|$)/, cls: 'string' },
  { re: /"(?:\\.|[^"\\])*"?/, cls: 'string' },
  // char 리터럴. 닫히지 않은 것도 문자열로 둔다 — 아포스트로피가 든 주석은 위에서 걸렀다.
  { re: /'(?:\\.|[^'\\])*'?/, cls: 'string' },

  { re: /0[xX][0-9a-fA-F_]+[lL]?/, cls: 'number' },
  { re: /0[bB][01_]+[lL]?/, cls: 'number' },
  { re: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[lLfFdD]?\b/, cls: 'number' },

  // 애너테이션은 코드가 아니라 표시다. 한 덩어리로 뗀다 (`@Override`, `@Valid`)
  { re: /@\s*[A-Za-z_$][\w$.]*/, cls: 'entity' },

  { re: new RegExp(`\\b(?:${LITERALS})\\b`), cls: 'keyword' },
  { re: new RegExp(`\\b(?:${PRIMITIVES})\\b`), cls: 'type' },
  { re: new RegExp(`\\b(?:${KEYWORDS})\\b`), cls: 'keyword' },

  // 호출·선언 위치의 이름
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/, cls: 'function' },
  // 대문자로 시작하면 타입으로 본다 (`RoomService`, `List`, `UUID`)
  { re: /\b[A-Z][\w$]*/, cls: 'type' },

  { re: /[A-Za-z_$][\w$]*/, cls: null },
  { re: /[{}()[\];,.]/, cls: 'punct' },
  { re: /[+\-*/%=<>!&|?:^~]+/, cls: 'operator' },
])

/**
 * javadoc 중간 줄. `*` 로 시작하는 줄은 자바에서 사실상 주석 이어짐이다.
 *
 * 강조는 줄 단위 무상태라 `/**` 로 시작한 블록의 **중간 줄**을 모르는 것이 원래
 * 한계다. 다른 언어에서는 가끔 티가 나는 정도지만, 자바는 파일마다 클래스 위에
 * javadoc 이 붙어서 첫 화면부터 어색해진다.
 *
 * 자바에서만 쓰는 어림짐작인 이유: JS 라면 `*next() {}`(제너레이터)일 수 있지만
 * 자바에는 그런 문법이 없다. 곱셈이 줄 첫머리에 오려면 왼쪽 피연산자가 같은 줄에
 * 있어야 하므로 `^\s*\*` 는 사실상 javadoc 뿐이다.
 */
const DOC_CONTINUATION = /^(\s*)\*/

export default {
  id: 'java',
  tokenize: (line, start, end) => {
    const slice = line.slice(start, end)
    const doc = DOC_CONTINUATION.exec(slice)
    if (doc) return [{ start: start + doc[1].length, end, cls: 'comment' }]
    return scan(line, start, end)
  },
}
