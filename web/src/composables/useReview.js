import { ref } from 'vue'

import * as api from '../api.js'

/**
 * 파일별 "확인했음" 상태.
 *
 * AI가 만든 변경은 파일 수가 많아서 어디까지 봤는지가 곧 진행률이다.
 * 단순히 경로만 기록하면 그 파일이 다시 바뀌었을 때도 확인 상태로 남으므로,
 * 변경 규모(status/추가/삭제 줄 수)를 지문으로 함께 저장하고 지문이 달라지면
 * 확인 상태를 자동으로 해제한다.
 *
 * 저장은 서버(`<git-dir>/grmide-state.json`)가 한다. 브라우저 localStorage에
 * 두었더니 grmide가 다른 포트로 뜰 때(4317이 사용 중일 때) 다른 origin이 되어
 * 진행률이 통째로 사라졌다. 저장소에 붙은 상태이므로 저장소 옆에 두는 것이 맞다.
 */

const SAVE_DEBOUNCE_MS = 200

export function useReview(repoRoot) {
  const marks = ref({})
  const error = ref('')
  let saveTimer = null

  const fingerprint = (file) => `${file.status}:${file.additions ?? '-'}:${file.deletions ?? '-'}`
  const keyOf = (file) => `${file.staged ? 'staged' : 'work'}:${file.path}`

  /** 서버에 밀어 넣는다. 토글·전체 확인이 연달아 눌릴 수 있어 잠깐 모은다. */
  function persist() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(async () => {
      try {
        await api.saveReviewed(marks.value)
      } catch (err) {
        error.value = err.message
      }
    }, SAVE_DEBOUNCE_MS)
  }

  /**
   * 예전에 브라우저에 저장해 둔 표시를 한 번 옮겨 온다.
   * 서버가 비어 있을 때만 — 서버 쪽에 이미 있으면 그것이 최신이다.
   */
  function importLegacy() {
    const key = repoRoot.value ? `grmide:reviewed:${repoRoot.value}` : null
    if (!key) return false
    try {
      const local = JSON.parse(localStorage.getItem(key) ?? '{}')
      localStorage.removeItem(key)
      if (!Object.keys(local).length) return false
      marks.value = local
      return true
    } catch {
      return false
    }
  }

  async function load() {
    try {
      const res = await api.fetchReviewed()
      marks.value = res.marks ?? {}
      if (!Object.keys(marks.value).length && importLegacy()) persist()
    } catch (err) {
      error.value = err.message
    }
  }

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

  return { marks, error, load, isReviewed, toggle, markAll, prune }
}
