<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import ChangeList from './components/ChangeList.vue'
import CommitList from './components/CommitList.vue'
import DiffViewer from './components/DiffViewer.vue'
import SearchEverywhere from './components/SearchEverywhere.vue'
import TabBar from './components/TabBar.vue'
import { useReview } from './composables/useReview.js'
import { useHistory } from './composables/useHistory.js'
import { useTabs } from './composables/useTabs.js'
import * as api from './api.js'

const repo = ref(null)
const status = ref({ staged: [], unstaged: [], conflicted: [] })
const selected = ref(null)
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
const commitFile = ref(null) // 히스토리 화면에서 고른 파일
const diffViewer = ref(null) // ⌘F를 넘겨주기 위한 참조
const tabs = useTabs()

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

// --- 통합 검색 (Shift 두 번 / ⌘P / ⌘⇧F)
const paletteOpen = ref(false)
const paletteTab = ref('all')
const fileList = ref([])

async function openPalette(tab = 'all') {
  paletteTab.value = tab
  paletteOpen.value = true
  if (!fileList.value.length) {
    try {
      fileList.value = (await api.fetchFiles()).files
    } catch (err) {
      diffError.value = err.message
    }
  }
}

/**
 * 파일 내용을 DiffViewer가 이해하는 모양으로 바꾼다.
 * 한 컬럼 모드라 오른쪽만 채운다. 이러면 문법 강조·찾기(⌘F)·줄바꿈이 그대로 따라온다.
 */
function fileAsDiff(doc) {
  if (!doc) return null
  return {
    language: doc.language,
    sections: doc.sections,
    binary: doc.binary,
    truncated: doc.truncated,
    lineCount: doc.lineCount,
    changes: 0,
    hunks: [
      {
        header: '',
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: doc.lines.length,
        changes: 0,
        rows: doc.lines.map((text, i) => ({
          type: 'context',
          left: null,
          right: { num: i + 1, text, words: null },
        })),
      },
    ],
  }
}

/** ⌘P / ⌘⇧F 결과에서 파일을 열면 새 탭이 된다. */
function openFile({ path, line = null }) {
  tabs.open({ kind: 'file', path, line, sub: '읽기 전용' })
}

/** 검색에서 커밋을 고르면 히스토리 화면으로 옮겨 그 커밋을 띄운다. */
async function openCommit(sha) {
  view.value = 'history'
  if (!history.commits.value.length) await history.init()
  await history.selectCommit(sha)
}

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

    // 목록에서 사라진 파일의 탭은 닫는다 (커밋했거나 되돌린 경우)
    tabs.pruneWorktree(
      new Set(allFiles.value.map((f) => `${f.staged ? 'staged' : 'unstaged'}:${f.path}`)),
    )

    // 선택한 파일이 사라졌으면 첫 파일로 옮긴다.
    if (selected.value) {
      const still = allFiles.value.find(
        (f) => f.path === selected.value.path && f.staged === selected.value.staged,
      )
      selected.value = still ?? allFiles.value[0] ?? null
    } else if (!tabs.tabs.value.length) {
      // 처음 열었을 때만 자동으로 첫 파일을 띄운다. 이미 탭이 있으면 건드리지 않는다.
      selected.value = allFiles.value[0] ?? null
    }
  } catch (err) {
    fatal.value = err.message
  }
}

// --- 목록에서 고른 것을 탭으로 연다

/** 좌측 변경 목록에서 파일을 고르면 워킹트리 탭이 열린다. */
watch(selected, (file) => {
  if (!file || view.value !== 'changes') return
  tabs.open({
    kind: 'worktree',
    path: file.path,
    staged: file.staged,
    untracked: file.untracked,
    sub: file.staged ? 'staged' : 'working tree',
  })
})

/** 커밋의 파일을 고르면 커밋 탭이 열린다. */
watch(commitFile, (file) => {
  const sha = history.selectedSha.value
  if (!file || !sha) return
  tabs.open({
    kind: 'commit',
    path: file.path,
    sha,
    sub: `커밋 ${history.detail.value?.shortSha ?? ''}`.trim(),
  })
})

/**
 * 지금 보고 있는 탭의 내용을 받는다.
 *
 * 이미 받아 둔 것이 있고 낡지 않았으면 다시 받지 않는다 — 탭을 오가는 것이
 * 매번 요청이 되면 탭의 의미가 없다.
 */
async function loadActive() {
  const tab = tabs.active.value
  if (!tab) return
  if (tab.data && !tab.stale) return

  diffLoading.value = true
  tab.error = ''
  const id = tab.id
  try {
    const data =
      tab.kind === 'file'
        ? fileAsDiff(await api.fetchFile(tab.path))
        : await api.fetchDiff(
            { path: tab.path, staged: tab.staged, untracked: tab.untracked },
            { context: context.value, sha: tab.kind === 'commit' ? tab.sha : null },
          )
    // 늦게 온 응답은 그 탭에만 담는다 (그 사이 다른 탭으로 옮겼을 수 있다)
    const target = tabs.tabs.value.find((t) => t.id === id)
    if (target) {
      target.data = data
      target.stale = false
    }
  } catch (err) {
    const target = tabs.tabs.value.find((t) => t.id === id)
    if (target) target.error = err.message
  } finally {
    diffLoading.value = false
  }

  // ⌘⇧F 결과로 열었으면 그 줄로 간다
  if (tab.line) {
    await nextTick()
    diffViewer.value?.scrollToLine(tab.line)
    tab.line = null
  }
}

watch(() => tabs.activeId.value, loadActive)

// 컨텍스트(보기 범위)를 바꾸면 diff 탭을 다시 받아야 한다
watch(context, () => {
  for (const tab of tabs.tabs.value) {
    if (tab.kind !== 'file') tab.stale = true
  }
  loadActive()
})

async function act(fn, file) {
  try {
    await fn(file.path)
    tabs.markStale()
    await loadStatus()
    await loadActive()
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
  await loadActive()

  // 파일이 바뀌면 서버가 알려준다. 폴링이 아니라 이 스트림이 갱신의 기준이다.
  stream = api.subscribeChanges({
    onChange: async () => {
      live.value = true
      tabs.markStale()
      await loadStatus()
      await loadActive()
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
  tabs.markStale()
  await loadStatus()
  await loadActive()
}

/**
 * j/k 로 파일 이동, space 로 확인 토글, Tab 으로 탭 전환.
 * 손이 터미널에 있는 사용자를 가정한다.
 */
const SHIFT_DOUBLE_TAP_MS = 400
let lastShiftAt = 0

function onKey(event) {
  const meta = event.metaKey || event.ctrlKey

  // Esc는 어디에 포커스가 있든 열린 것을 닫는다
  if (event.key === 'Escape' && paletteOpen.value) {
    paletteOpen.value = false
    return
  }

  // Shift 두 번 → 통합 검색 (IntelliJ Search Everywhere)
  if (event.key === 'Shift' && !meta && !event.altKey) {
    const now = event.timeStamp
    if (now - lastShiftAt < SHIFT_DOUBLE_TAP_MS) {
      lastShiftAt = 0
      openPalette('all')
      return
    }
    lastShiftAt = now
    return
  }
  if (event.key !== 'Shift') lastShiftAt = 0 // 사이에 다른 키가 끼면 무효

  // ⌘/Ctrl 조합은 입력창 안에서도 받는다. 브라우저 기본 동작을 대신한다.
  if (meta && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (event.shiftKey) openPalette('text')
    else diffViewer.value?.openFind()
    return
  }
  if (meta && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openPalette('file')
    return
  }

  // ⌥←/→ 로 탭 이동. ⌘⇧[ ] 는 브라우저가 이미 쓴다.
  if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault()
    tabs.step(event.key === 'ArrowRight' ? 1 : -1)
    return
  }
  // ⌥W 로 현재 탭 닫기 (⌘W는 브라우저 창을 닫는다)
  if (event.altKey && event.key.toLowerCase() === 'w' && tabs.activeId.value) {
    event.preventDefault()
    tabs.close(tabs.activeId.value)
    return
  }

  // 입력창에서는 j/k 같은 단일 키를 가로채지 않는다.
  // target이 Element가 아닌 경우(합성 이벤트)도 있어 형을 확인한다.
  const target = event.target
  if (target instanceof Element && target.matches('input, select, textarea')) return

  // 읽기 전용으로 열어 둔 파일은 Esc로 닫는다. diff 탭은 Esc로 닫지 않는다 —
  // 목록에서 고른 것이므로 사용자가 닫으려는 의도로 보기 어렵다.
  if (event.key === 'Escape' && tabs.active.value?.kind === 'file') {
    tabs.close(tabs.activeId.value)
    return
  }

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
        <TabBar
          :tabs="tabs.tabs.value"
          :active-id="tabs.activeId.value"
          @activate="tabs.activate($event)"
          @close="tabs.close($event)"
          @close-all="tabs.closeAll()"
        />

        <DiffViewer
          v-if="tabs.active.value"
          :key="tabs.active.value.id"
          ref="diffViewer"
          :single="tabs.active.value.kind === 'file'"
          :file="tabs.active.value"
          :diff="tabs.active.value.data"
          :loading="diffLoading && !tabs.active.value.data"
          :error="tabs.active.value.error || diffError"
          :badge="tabs.active.value.sub"
          @update:context="context = $event"
        />

        <div v-else class="empty-main">
          <p>왼쪽에서 파일을 고르거나 <kbd>⌘P</kbd> 로 파일을 열어보세요.</p>
          <p class="dim"><kbd>Shift</kbd> <kbd>Shift</kbd> 로 파일·커밋·텍스트를 한 번에 찾습니다.</p>
        </div>
      </section>
    </main>

    <SearchEverywhere
      :open="paletteOpen"
      :tab="paletteTab"
      :files="fileList"
      @update:tab="paletteTab = $event"
      @close="paletteOpen = false"
      @open-file="openFile($event)"
      @open-commit="openCommit($event)"
    />
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.empty-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--fg-dim);
}
.empty-main .dim {
  color: var(--fg-faint);
  font-size: 12px;
}
.empty-main p {
  margin: 0;
}
kbd {
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 3px;
  background: var(--bg-elevated);
  font-family: var(--mono);
  font-size: 11px;
}
</style>
