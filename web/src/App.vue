<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import ChangeList from './components/ChangeList.vue'
import CommitList from './components/CommitList.vue'
import DiffViewer from './components/DiffViewer.vue'
import { useReview } from './composables/useReview.js'
import { useHistory } from './composables/useHistory.js'
import * as api from './api.js'

const repo = ref(null)
const status = ref({ staged: [], unstaged: [], conflicted: [] })
const selected = ref(null)
const diff = ref(null)
const diffLoading = ref(false)
const diffError = ref('')
const fatal = ref('')
const context = ref(3)
const live = ref(false)
const lastSync = ref('')
const connected = ref(true)
const retrying = ref(false)

const repoRoot = computed(() => repo.value?.root ?? null)
const review = useReview(repoRoot)

// --- 탭: 워킹트리 변경 / 커밋 히스토리
const VIEWS = [
  { key: 'changes', label: '변경사항' },
  { key: 'history', label: '히스토리' },
]
const view = ref('changes')
const history = useHistory()
const commitFile = ref(null) // 히스토리 탭에서 고른 파일

// 히스토리 탭을 처음 열 때만 로그와 브랜치 목록을 받는다
watch(view, async (next) => {
  if (next === 'history' && !history.commits.value.length) await history.init()
})

// 커밋을 바꾸면 그 커밋의 첫 파일을 자동으로 보여준다
watch(
  () => history.detail.value,
  (detail) => {
    commitFile.value = detail?.files?.[0] ?? null
  },
)

const commitGroups = computed(() => [
  { key: 'commit', title: '', files: history.detail.value?.files ?? [] },
])

const groups = computed(() => [
  { key: 'conflicted', title: '충돌', files: status.value.conflicted },
  { key: 'staged', title: 'Staged', files: status.value.staged },
  { key: 'unstaged', title: 'Changes', files: status.value.unstaged },
])

const allFiles = computed(() => groups.value.flatMap((g) => g.files))

const progress = computed(() => {
  const total = allFiles.value.length
  const done = allFiles.value.filter((f) => review.isReviewed(f)).length
  return { total, done }
})

async function loadStatus() {
  try {
    status.value = await api.fetchStatus()
    review.prune(allFiles.value)
    lastSync.value = new Date().toLocaleTimeString('ko-KR', { hour12: false })

    // 선택한 파일이 사라졌으면(커밋/되돌림) 첫 파일로 옮긴다.
    if (selected.value) {
      const still = allFiles.value.find(
        (f) => f.path === selected.value.path && f.staged === selected.value.staged,
      )
      if (still) selected.value = still
      else selected.value = allFiles.value[0] ?? null
    } else {
      selected.value = allFiles.value[0] ?? null
    }
  } catch (err) {
    fatal.value = err.message
  }
}

// 두 탭이 같은 DiffViewer를 쓴다. 무엇을 보고 있는지는 이 두 값이 정한다.
const activeFile = computed(() => (view.value === 'history' ? commitFile.value : selected.value))
const activeSha = computed(() => (view.value === 'history' ? history.selectedSha.value : null))

const diffBadge = computed(() => {
  if (view.value !== 'history') return ''
  const sha = history.detail.value?.shortSha
  return sha ? `커밋 ${sha}` : '커밋'
})

async function loadDiff() {
  const file = activeFile.value
  const sha = activeSha.value
  if (!file) {
    diff.value = null
    return
  }
  diffLoading.value = true
  diffError.value = ''
  try {
    const result = await api.fetchDiff(file, { context: context.value, sha })
    // 로딩 중에 다른 파일/커밋으로 옮겼다면 늦게 온 응답은 버린다.
    if (activeFile.value?.path === file.path && activeSha.value === sha) {
      diff.value = result
    }
  } catch (err) {
    diffError.value = err.message
  } finally {
    diffLoading.value = false
  }
}

watch([activeFile, activeSha, context], loadDiff)

async function act(fn, file) {
  try {
    await fn(file.path)
    await loadStatus()
    await loadDiff()
  } catch (err) {
    diffError.value = err.message
  }
}

let stream = null

onMounted(async () => {
  if (!api.token) {
    fatal.value = '토큰이 없습니다. 터미널에서 gitshow가 출력한 주소로 다시 접속하세요.'
    return
  }
  try {
    repo.value = await api.fetchRepo()
  } catch (err) {
    fatal.value = err.message
    return
  }
  await loadStatus()
  await loadDiff()

  // 파일이 바뀌면 서버가 알려준다. 폴링이 아니라 이 스트림이 갱신의 기준이다.
  stream = api.subscribeChanges({
    onChange: async () => {
      live.value = true
      await loadStatus()
      await loadDiff()
      setTimeout(() => (live.value = false), 600)
    },
    onConnection: (state) => {
      connected.value = state.connected
      retrying.value = state.retrying
    },
  })

  window.addEventListener('keydown', onKey)
})

onUnmounted(() => {
  stream?.close()
  window.removeEventListener('keydown', onKey)
})

/** 끊긴 뒤 gitshow를 다시 켰을 때. 스트림과 화면 내용을 함께 되살린다. */
async function reconnect() {
  stream?.reconnect()
  await loadStatus()
  await loadDiff()
}

/**
 * j/k 로 파일 이동, space 로 확인 토글, Tab 으로 탭 전환.
 * 손이 터미널에 있는 사용자를 가정한다.
 */
function onKey(event) {
  if (event.target.matches('input, select, textarea')) return

  if (event.key === 'Tab') {
    event.preventDefault()
    view.value = view.value === 'changes' ? 'history' : 'changes'
    return
  }

  if (event.key !== 'j' && event.key !== 'k' && event.key !== ' ') return
  const step = event.key === 'j' ? 1 : -1

  if (view.value === 'history') {
    // 히스토리에서는 커밋 사이를 오간다. 파일은 마우스로 고르는 편이 빠르다.
    if (event.key === ' ') return
    event.preventDefault()
    const list = history.commits.value
    const idx = list.findIndex((c) => c.sha === history.selectedSha.value)
    const next = list[Math.min(Math.max(idx + step, 0), list.length - 1)]
    if (next) history.selectCommit(next.sha)
    return
  }

  const files = allFiles.value
  if (!files.length) return
  const idx = files.findIndex(
    (f) => f.path === selected.value?.path && f.staged === selected.value?.staged,
  )
  if (event.key === ' ') {
    if (!selected.value) return
    event.preventDefault()
    review.toggle(selected.value)
    return
  }
  selected.value = files[Math.min(Math.max(idx + step, 0), files.length - 1)]
}
</script>

<template>
  <div v-if="fatal" class="fatal">{{ fatal }}</div>

  <div v-else class="layout">
    <header class="top">
      <strong class="repo">{{ repo?.name ?? '…' }}</strong>
      <span class="branch">⎇ {{ repo?.branch ?? '' }}</span>

      <div class="tabs" role="tablist">
        <button
          v-for="tab in VIEWS"
          :key="tab.key"
          class="tab"
          :class="{ on: view === tab.key }"
          role="tab"
          :aria-selected="view === tab.key"
          title="Tab 키로도 전환"
          @click="view = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <span v-if="repo?.head" class="head" :title="repo.head.sha">
        {{ repo.head.shortSha }} · {{ repo.head.subject }}
      </span>
      <span class="spacer" />
      <span v-if="view === 'changes'" class="progress">
        확인 {{ progress.done }}/{{ progress.total }}
      </span>
      <span v-if="!connected" class="offline" title="gitshow가 실행 중인지 확인하세요">
        {{ retrying ? '연결 끊김 · 다시 시도 중' : '연결 끊김 · 아래 내용은 지금 상태가 아닙니다' }}
        <button v-if="!retrying" class="relink" @click="reconnect">다시 연결</button>
      </span>
      <span v-else class="sync" :class="{ live }">{{ live ? '갱신됨' : lastSync }}</span>
    </header>

    <main class="body">
      <aside class="side">
        <!-- 변경사항 탭: 파일 목록 하나 -->
        <ChangeList
          v-if="view === 'changes'"
          :groups="groups"
          :selected="selected"
          :is-reviewed="review.isReviewed"
          @select="selected = $event"
          @toggle-review="review.toggle($event)"
          @review-all="review.markAll($event.files, true)"
          @stage="act(api.stageFile, $event)"
          @unstage="act(api.unstageFile, $event)"
        />

        <!-- 히스토리 탭: 위에 커밋 목록, 아래에 그 커밋의 파일 목록 -->
        <div v-else class="history-side">
          <div class="commits">
            <CommitList
              :commits="history.commits.value"
              :lane-count="history.laneCount.value"
              :selected="history.selectedSha.value"
              :loading="history.loading.value"
              :has-more="history.hasMore.value"
              :filtered="history.filtered.value"
              :refs="history.refs.value"
              :active-ref="history.activeRef.value"
              :query="history.query.value"
              :search-in="history.searchIn.value"
              @select="history.selectCommit($event.sha)"
              @more="history.loadMore()"
              @update:active-ref="history.activeRef.value = $event"
              @update:query="history.query.value = $event"
              @update:search-in="history.searchIn.value = $event"
            />
          </div>

          <div class="commit-detail">
            <div v-if="history.detail.value" class="meta">
              <div class="meta-line">
                <span class="sha" :title="history.detail.value.sha">
                  {{ history.detail.value.shortSha }}
                </span>
                <span class="who">{{ history.detail.value.author }}</span>
                <span class="when">{{ history.detail.value.relativeDate }}</span>
              </div>
              <p class="subject">{{ history.detail.value.subject }}</p>
              <pre v-if="history.detail.value.body" class="body-text">{{
                history.detail.value.body
              }}</pre>
            </div>

            <ChangeList
              class="commit-files"
              :groups="commitGroups"
              :selected="commitFile"
              readonly
              title="바뀐 파일"
              count-label="개"
              @select="commitFile = $event"
            />
          </div>
        </div>
      </aside>

      <section class="main">
        <DiffViewer
          :file="activeFile"
          :diff="diff"
          :loading="diffLoading"
          :error="diffError"
          :badge="diffBadge"
          @update:context="context = $event"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.fatal {
  padding: 24px;
  color: var(--status-deleted);
}

.layout {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 12px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  flex: none;
  min-width: 0;
}
.repo {
  flex: none;
}
.branch {
  flex: none;
  color: var(--accent);
}
.head {
  color: var(--fg-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
.progress {
  flex: none;
  color: var(--fg-dim);
}
.sync {
  flex: none;
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
  min-width: 62px;
  text-align: right;
}
.sync.live {
  color: var(--status-added);
}
.offline {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--status-conflicted);
}
.relink {
  padding: 1px 8px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  color: var(--fg);
}
.relink:hover {
  background: var(--bg-elevated);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.side {
  width: 340px;
  min-width: 220px;
  max-width: 60%;
  flex: none;
  resize: horizontal;
  overflow: hidden;
  border-right: 1px solid var(--border);
}

/* 히스토리 탭에서만 좌측을 위아래로 나눈다 */
.history-side {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.commits {
  flex: 1 1 55%;
  min-height: 120px;
  overflow: hidden;
  resize: vertical;
  border-bottom: 1px solid var(--border);
}
.commit-detail {
  flex: 1 1 45%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}
.meta {
  flex: none;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  max-height: 30%;
  overflow-y: auto;
}
.meta-line {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 11px;
}
.sha {
  font-family: var(--mono);
  color: var(--status-conflicted);
}
.who {
  color: var(--fg-dim);
}
.when {
  color: var(--fg-faint);
}
.subject {
  margin: 4px 0 0;
  font-weight: 600;
}
.body-text {
  margin: 6px 0 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.commit-files {
  flex: 1;
  min-height: 0;
}

/* 탭 */
.tabs {
  flex: none;
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  overflow: hidden;
}
.tab {
  padding: 2px 10px;
  font-size: 11px;
  color: var(--fg-dim);
  border-right: 1px solid var(--border-strong);
}
.tab:last-child {
  border-right: none;
}
.tab:hover {
  background: var(--bg-elevated);
  color: var(--fg);
}
.tab.on {
  background: #35548c;
  color: #fff;
}
.main {
  flex: 1;
  min-width: 0;
}
</style>
