/**
 * `git blame --porcelain` 파서.
 *
 * porcelain은 줄마다 `<sha> <원본줄> <최종줄> [<묶음크기>]` 헤더가 오고, 그 sha가
 * 처음 나올 때만 author·summary 같은 상세가 따라온다. 그대로 줄마다 상세를 실어
 * 보내면 20,000줄 파일에서 응답이 수 MB가 되므로, 응답을 둘로 가른다:
 *
 *   lines   { 최종줄번호: sha }
 *   commits { sha: { author, mail, time, summary } }
 *
 * 아직 커밋되지 않은 줄은 sha가 전부 0이다 — 표시는 클라이언트가 정한다.
 */

const HEAD_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/

export function parseBlamePorcelain(text) {
  const lines = {}
  const commits = {}

  const src = text.split('\n')
  let i = 0
  while (i < src.length) {
    const m = src[i].match(HEAD_RE)
    if (!m) {
      i++
      continue
    }
    const sha = m[1]
    const finalLine = Number(m[3])
    i++

    const info = (commits[sha] ??= {})
    // 상세 헤더들. 실제 코드 줄(\t로 시작)까지 읽는다
    while (i < src.length && !src[i].startsWith('\t')) {
      const line = src[i]
      if (line.startsWith('author ')) info.author = line.slice('author '.length)
      else if (line.startsWith('author-mail '))
        info.mail = line.slice('author-mail '.length).replace(/^<|>$/g, '')
      else if (line.startsWith('author-time ')) info.time = Number(line.slice('author-time '.length))
      else if (line.startsWith('summary ')) info.summary = line.slice('summary '.length)
      i++
    }
    i++ // 코드 줄은 쓰지 않는다 — 화면이 이미 들고 있다

    lines[finalLine] = sha
  }

  return { lines, commits }
}
