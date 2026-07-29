import { createScanner } from '../scanner.js'

// 문자열 규칙이 주석보다 먼저다 — '...' 안의 #가 주석이 되지 않게.
// 스캐너는 각 위치에서 앞선 규칙부터 시도하므로, 따옴표를 만나면 통째로 삼킨다.
const scan = createScanner([
  { re: /^#!.*/, cls: 'entity' }, // shebang
  { re: /"(?:\\.|[^"\\])*"?/, cls: 'string' },
  { re: /'[^']*'?/, cls: 'string' },
  { re: /\$\{[^}]*\}|\$[\w@#?*!$-]+/, cls: 'variable' },
  { re: /#.*/, cls: 'comment' },
  {
    re: /\b(?:if|then|elif|else|fi|for|in|do|done|while|until|case|esac|function|select|return|exit|local|export|readonly|source|alias|set|unset|shift|break|continue|trap|eval|exec)\b/,
    cls: 'keyword',
  },
  { re: /\b\d+\b/, cls: 'number' },
  { re: /[|&;<>()=]/, cls: 'operator' },
])

export default { id: 'shell', tokenize: (line, start, end) => scan(line, start, end) }
