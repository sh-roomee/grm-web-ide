import { ref, watch } from 'vue'

/**
 * 파일별 "확인했음" 상태를 localStorage에 보관한다.
 *
 * AI가 만든 변경은 파일 수가 많아서 어디까지 봤는지가 곧 진행률이다.
 * 단순히 경로만 기록하면 그 파일이 다시 바뀌었을 때도 확인 상태로 남으므로,
 * 변경 규모(status/추가/삭제 줄 수)를 지문으로 함께 저장하고 지문이 달라지면
 * 확인 상태를 자동으로 해제한다.
 */
export function useReview(repoRoot) {
  const marks = ref({})

  const storageKey = () => (repoRoot.value ? `gitshow:reviewed:${repoRoot.value}` : null)

  watch(
    repoRoot,
    (root) => {
      if (!root) return
      try {
        marks.value = JSON.parse(localStorage.getItem(storageKey()) ?? '{}')
      } catch {
        marks.value = {}
      }
    },
    { immediate: true },
  )

  function persist() {
    const key = storageKey()
    if (key) localStorage.setItem(key, JSON.stringify(marks.value))
  }

  const fingerprint = (file) =>
    `${file.status}:${file.additions ?? '-'}:${file.deletions ?? '-'}`

  const keyOf = (file) => `${file.staged ? 'staged' : 'work'}:${file.path}`

  function isReviewed(file) {
    return marks.value[keyOf(file)] === fingerprint(file)
  }

  function toggle(file) {
    const key = keyOf(file)
    if (marks.value[key] === fingerprint(file)) delete marks.value[key]
    else marks.value[key] = fingerprint(file)
    persist()
  }

  function markAll(files, reviewed) {
    for (const file of files) {
      if (reviewed) marks.value[keyOf(file)] = fingerprint(file)
      else delete marks.value[keyOf(file)]
    }
    persist()
  }

  /** 목록에서 사라진 파일(커밋/되돌림)의 기록을 정리한다. */
  function prune(files) {
    const live = new Set(files.map(keyOf))
    let changed = false
    for (const key of Object.keys(marks.value)) {
      if (!live.has(key)) {
        delete marks.value[key]
        changed = true
      }
    }
    if (changed) persist()
  }

  return { isReviewed, toggle, markAll, prune }
}
