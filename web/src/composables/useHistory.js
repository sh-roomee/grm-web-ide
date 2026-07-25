import { ref, watch } from 'vue'

import * as api from '../api.js'

const PAGE_SIZE = 100

/**
 * 커밋 히스토리 상태.
 *
 * 워킹트리 상태(App.vue)와 분리해 둔다. 히스토리는 SSE로 갱신할 필요가 거의
 * 없고(커밋은 사용자가 만들 때만 늘어난다) 페이지 단위로 이어 받으므로
 * 갱신 규칙이 다르다.
 */
const SEARCH_DEBOUNCE_MS = 250

export function useHistory() {
  const commits = ref([])
  const laneCount = ref(1)
  const hasMore = ref(false)
  const filtered = ref(false)
  const loading = ref(false)
  const error = ref('')

  // 브랜치/태그 선택과 검색
  const refs = ref([])
  const activeRef = ref(null) // null = 전체 브랜치
  const query = ref('')
  const searchIn = ref('message')

  const selectedSha = ref(null)
  const detail = ref(null) // { ...커밋 메타, files: [] }
  const detailLoading = ref(false)

  const searchParams = () => ({
    ref: activeRef.value,
    q: query.value.trim(),
    in: searchIn.value,
  })

  async function loadRefs() {
    try {
      const res = await api.fetchRefs()
      refs.value = res.refs
    } catch (err) {
      error.value = err.message
    }
  }

  async function loadLog() {
    loading.value = true
    error.value = ''
    try {
      const res = await api.fetchLog({ limit: PAGE_SIZE, ...searchParams() })
      commits.value = res.commits
      laneCount.value = res.laneCount
      hasMore.value = res.hasMore
      filtered.value = res.filtered
      // 선택한 커밋이 목록에서 사라졌으면 맨 위로
      if (!commits.value.some((c) => c.sha === selectedSha.value)) {
        await selectCommit(commits.value[0]?.sha ?? null)
      }
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (loading.value || !hasMore.value) return
    loading.value = true
    try {
      const res = await api.fetchLog({
        limit: PAGE_SIZE,
        skip: commits.value.length,
        ...searchParams(),
      })
      // 레인은 받아온 구간 안에서만 계산되므로, 이어 붙이면 경계에서 선이
      // 어긋날 수 있다. 그래서 전체를 다시 계산하지 않고 그대로 이어 둔다 —
      // 경계 한 줄의 선 모양이 살짝 어긋나는 정도이고, 다시 받는 비용이 크다.
      commits.value = [...commits.value, ...res.commits]
      laneCount.value = Math.max(laneCount.value, res.laneCount)
      hasMore.value = res.hasMore
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function selectCommit(sha) {
    selectedSha.value = sha
    if (!sha) {
      detail.value = null
      return
    }
    detailLoading.value = true
    try {
      detail.value = await api.fetchCommit(sha)
    } catch (err) {
      error.value = err.message
      detail.value = null
    } finally {
      detailLoading.value = false
    }
  }

  watch(activeRef, loadLog)

  // 검색 대상만 바꿨는데 검색어가 없으면 결과가 같다. 요청하지 않는다.
  watch(searchIn, () => {
    if (query.value.trim()) loadLog()
  })

  // 검색어는 타이핑마다 요청하지 않는다
  let debounce = null
  watch(query, () => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(loadLog, SEARCH_DEBOUNCE_MS)
  })

  async function init() {
    await Promise.all([loadRefs(), loadLog()])
  }

  return {
    commits,
    laneCount,
    hasMore,
    filtered,
    loading,
    error,
    refs,
    activeRef,
    query,
    searchIn,
    selectedSha,
    detail,
    detailLoading,
    init,
    loadRefs,
    loadLog,
    loadMore,
    selectCommit,
  }
}
