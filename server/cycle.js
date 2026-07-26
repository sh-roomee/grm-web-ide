/**
 * 사이클 요약 — "기준점 이후 지금까지 무슨 일이 있었나"를 한 장으로.
 *
 * 다음 지시를 쓰려면 사람이 방금 본 것을 다시 훑어야 한다. 파일이 40개면 그
 * 훑기가 리뷰만큼 오래 걸린다.
 *
 * **이 도구는 요약을 지어내지 않는다.** 코드가 무엇을 하는지 말하려면 모델이
 * 필요하고, 그건 터미널의 AI가 이미 한다. 여기서 모으는 것은 AI가 알 수 없는
 * 것들이다 — 사람이 무엇을 확인했고, 무엇이 아직 남았고, 어떤 코멘트가 아직
 * 반영되지 않았는지. git에도 없고 AI의 문맥에도 없는 정보다.
 */

/** 사람이 읽는 경과 시간. */
export function elapsedLabel(fromIso, now) {
  if (!fromIso) return ''
  const start = Date.parse(fromIso)
  if (Number.isNaN(start)) return ''
  const minutes = Math.max(0, Math.round((now - start) / 60000))
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}시간 ${rest}분` : `${hours}시간`
}

const sizeLabel = (file) => {
  const parts = []
  if (file.additions) parts.push(`+${file.additions}`)
  if (file.deletions) parts.push(`−${file.deletions}`)
  return parts.join(' ') || (file.additions === null ? 'bin' : '')
}

/**
 * @param input.files     상태 파일 목록 (staged + unstaged + conflicted를 합친 것)
 * @param input.risks     { [path]: [{ label, count }] }
 * @param input.comments  상태가 붙은 코멘트 목록
 * @param input.baselineAt 기준점을 잡은 시각 (ISO) — 없으면 경과를 적지 않는다
 * @param input.now       기준 시각 (ms)
 */
export function buildCycleSummary({
  files = [],
  risks = {},
  comments = [],
  baselineAt = null,
  now = 0,
} = {}) {
  const elapsed = elapsedLabel(baselineAt, now)
  const additions = files.reduce((sum, f) => sum + (f.additions ?? 0), 0)
  const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0)
  const done = files.filter((f) => f.reviewed).length

  const head = baselineAt
    ? `## 기준점 이후${elapsed ? ` (${elapsed})` : ''}`
    : '## 지금 워킹트리'

  const out = [head, '']

  if (!files.length) {
    out.push('바뀐 파일이 없다.')
    return out.join('\n') + '\n'
  }

  out.push(`파일 ${files.length}개 · +${additions} −${deletions} · 확인 ${done}/${files.length}`)
  out.push('')

  const line = (file) => {
    const bits = [`- ${file.path}`, sizeLabel(file)].filter(Boolean)
    const flags = risks[file.path]
    if (flags?.length) {
      // 사람이 놓치기 쉬운 지점. 요약에서 빠지면 요약을 읽고 넘어가게 된다
      bits.push(`⚠ ${flags.map((r) => `${r.label} ${r.count}`).join(', ')}`)
    }
    return bits.join('  ')
  }

  const pending = files.filter((f) => !f.reviewed)
  const checked = files.filter((f) => f.reviewed)

  if (pending.length) {
    out.push('### 아직 확인 안 한 파일')
    for (const file of pending) out.push(line(file))
    out.push('')
  }
  if (checked.length) {
    out.push('### 확인한 파일')
    for (const file of checked) out.push(line(file))
    out.push('')
  }

  const open = comments.filter((c) => c.status?.state !== 'applied')
  if (open.length) {
    out.push(`### 아직 반영 안 된 코멘트 ${open.length}`)
    for (const comment of open) {
      const where = comment.line
        ? `${comment.path}:${comment.line}${
            comment.endLine && comment.endLine > comment.line ? `-${comment.endLine}` : ''
          }`
        : comment.path
      // 코멘트 원문은 그대로 옮긴다. 줄여서 뜻이 바뀌면 지시가 어긋난다
      out.push(`- ${where}  ${comment.text.replace(/\s*\n\s*/g, ' ')}`)
    }
    out.push('')
  }

  return out.join('\n').trimEnd() + '\n'
}
