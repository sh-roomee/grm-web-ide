import { createScanner } from '../scanner.js'

// Dockerfile — 지시어는 줄 앞에서만 (FROM x AS y의 AS는 칠하지 않는다)
const scan = createScanner([
  { re: /^\s*#.*/, cls: 'comment' },
  {
    re: /^(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i,
    cls: 'keyword',
  },
  { re: /"(?:\\.|[^"\\])*"?|'[^']*'?/, cls: 'string' },
  { re: /\$\{[^}]*\}|\$\w+/, cls: 'variable' },
  { re: /\b\d+\b/, cls: 'number' },
])

export default { id: 'docker', tokenize: (line, start, end) => scan(line, start, end) }
