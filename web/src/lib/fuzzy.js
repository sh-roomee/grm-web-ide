/**
 * 경로 퍼지 매칭.
 *
 * 입력한 글자가 순서대로 들어 있으면 통과한다. `dvue` → `src/components/Display.vue`
 * 같은 입력을 받으려는 것이다.
 *
 * 점수 규칙 — 원하는 파일이 첫 줄에 오는 것이 이 기능의 전부다:
 *  - 연속으로 맞을수록 크게 가산 (`disp` > `d..i..s..p`)
 *  - 파일명(마지막 구간)에 맞으면 가산 — 사람은 보통 파일명을 친다
 *  - 경계(`/`, `.`, `-`, `_`, 대문자) 바로 뒤에 맞으면 가산
 *  - 경로가 짧을수록 살짝 우대
 */
export function fuzzyScore(path, needle) {
  if (!needle) return { points: 0, marks: [], parts: [{ text: path, on: false }] }

  const hay = path.toLowerCase()
  const baseStart = hay.lastIndexOf('/') + 1

  let at = 0
  let points = 0
  let streak = 0
  const marks = []

  for (const ch of needle) {
    const found = hay.indexOf(ch, at)
    if (found === -1) return null

    marks.push(found)
    streak = found === at ? streak + 1 : 0
    points += 1 + streak * 3
    if (found >= baseStart) points += 4
    if (found === baseStart || isBoundary(path, found)) points += 2
    at = found + 1
  }

  points -= path.length * 0.02
  return { points, marks, parts: splitMarks(path, marks) }
}

const BOUNDARY = new Set(['/', '.', '-', '_'])

function isBoundary(path, index) {
  if (index === 0) return true
  const prev = path[index - 1]
  if (BOUNDARY.has(prev)) return true
  // camelCase 경계: 소문자 뒤의 대문자
  return prev === prev.toLowerCase() && path[index] !== path[index].toLowerCase()
}

/** 맞은 글자만 굵게 보여주기 위해 조각으로 쪼갠다. */
export function splitMarks(text, marks) {
  if (!marks?.length) return [{ text, on: false }]
  const out = []
  let at = 0
  for (const mark of marks) {
    if (mark > at) out.push({ text: text.slice(at, mark), on: false })
    // 붙어 있는 표시는 한 조각으로 합친다
    const last = out[out.length - 1]
    if (last?.on && mark === at) last.text += text[mark]
    else out.push({ text: text[mark], on: true })
    at = mark + 1
  }
  if (at < text.length) out.push({ text: text.slice(at), on: false })
  return out
}
