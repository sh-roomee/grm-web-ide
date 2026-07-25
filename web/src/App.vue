<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import ChangeList from './components/ChangeList.vue'
import DiffViewer from './components/DiffViewer.vue'
import { useReview } from './composables/useReview.js'
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

async function loadDiff() {
  const file = selected.value
  if (!file) {
    diff.value = null
    return
  }
  diffLoading.value = true
  diffError.value = ''
  try {
    const result = await api.fetchDiff(file, { context: context.value })
    // 로딩 중에 다른 파일로 옮겼다면 늦게 온 응답은 버린다.
    if (selected.value?.path === file.path && selected.value?.staged === file.staged) {
      diff.value = result
    }
  } catch (err) {
    diffError.value = err.message
  } finally {
    diffLoading.value = false
  }
}

watch(selected, loadDiff)
watch(context, loadDiff)

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

/** j/k 로 파일 이동, space 로 확인 토글. 손이 터미널에 있는 사용자를 가정한다. */
function onKey(event) {
  if (event.target.matches('input, select, textarea')) return
  const files = allFiles.value
  if (!files.length) return
  const idx = files.findIndex(
    (f) => f.path === selected.value?.path && f.staged === selected.value?.staged,
  )
  if (event.key === 'j') selected.value = files[Math.min(idx + 1, files.length - 1)]
  else if (event.key === 'k') selected.value = files[Math.max(idx - 1, 0)]
  else if (event.key === ' ' && selected.value) {
    event.preventDefault()
    review.toggle(selected.value)
  }
}
</script>

<template>
  <div v-if="fatal" class="fatal">{{ fatal }}</div>

  <div v-else class="layout">
    <header class="top">
      <strong class="repo">{{ repo?.name ?? '…' }}</strong>
      <span class="branch">⎇ {{ repo?.branch ?? '' }}</span>
      <span v-if="repo?.head" class="head" :title="repo.head.sha">
        {{ repo.head.shortSha }} · {{ repo.head.subject }}
      </span>
      <span class="spacer" />
      <span class="progress">확인 {{ progress.done }}/{{ progress.total }}</span>
      <span v-if="!connected" class="offline" title="gitshow가 실행 중인지 확인하세요">
        {{ retrying ? '연결 끊김 · 다시 시도 중' : '연결 끊김 · 아래 내용은 지금 상태가 아닙니다' }}
        <button v-if="!retrying" class="relink" @click="reconnect">다시 연결</button>
      </span>
      <span v-else class="sync" :class="{ live }">{{ live ? '갱신됨' : lastSync }}</span>
    </header>

    <main class="body">
      <aside class="side">
        <ChangeList
          :groups="groups"
          :selected="selected"
          :is-reviewed="review.isReviewed"
          @select="selected = $event"
          @toggle-review="review.toggle($event)"
          @review-all="review.markAll($event.files, true)"
          @stage="act(api.stageFile, $event)"
          @unstage="act(api.unstageFile, $event)"
        />
      </aside>

      <section class="main">
        <DiffViewer
          :file="selected"
          :diff="diff"
          :loading="diffLoading"
          :error="diffError"
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
  max-width: 50%;
  flex: none;
  resize: horizontal;
  overflow: hidden;
}
.main {
  flex: 1;
  min-width: 0;
}
</style>
