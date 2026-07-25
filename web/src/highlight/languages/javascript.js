import { createScanner } from '../scanner.js'

const KEYWORDS =
  'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|' +
  'new|delete|typeof|instanceof|in|of|this|class|extends|super|import|export|from|' +
  'as|default|async|await|yield|try|catch|finally|throw|void|null|undefined|true|' +
  'false|static|get|set|debugger|with|enum|interface|type|implements|readonly|' +
  'public|private|protected'

const scan = createScanner([
  // 주석이 가장 먼저다. 주석 안의 따옴표에 속으면 줄 전체가 문자열이 된다.
  { re: /\/\/.*/, cls: 'comment' },
  { re: /\/\*[\s\S]*?(?:\*\/|$)/, cls: 'comment' },

  // 닫히지 않은 문자열도 문자열로 본다 (여러 줄에 걸친 경우)
  { re: /'(?:\\.|[^'\\])*'?/, cls: 'string' },
  { re: /"(?:\\.|[^"\\])*"?/, cls: 'string' },
  { re: /`(?:\\.|[^`\\])*`?/, cls: 'string' },

  { re: /0[xX][0-9a-fA-F_]+n?/, cls: 'number' },
  { re: /\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?\b/, cls: 'number' },

  { re: new RegExp(`\\b(?:${KEYWORDS})\\b`), cls: 'keyword' },

  // 호출/선언 위치의 이름
  { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/, cls: 'function' },
  // 객체 리터럴의 키 (`name: 'ModalDeviceSetting'`)
  { re: /\b[A-Za-z_$][\w$]*(?=\s*:)/, cls: 'property' },

  { re: /[A-Za-z_$][\w$]*/, cls: null },
  { re: /[{}()[\];,.]/, cls: 'punct' },
  { re: /[+\-*/%=<>!&|?:^~]+/, cls: 'operator' },
])

export default {
  id: 'javascript',
  tokenize: (line, start, end) => scan(line, start, end),
}
