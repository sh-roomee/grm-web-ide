<script setup>
import { computed, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  comments: { type: Array, default: () => [] },
  // 고른 코멘트 id. 프롬프트를 미리 만들어 두려고 부모가 들고 있다
  picked: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'open-file', 'delete', 'delete-many', 'copy', 'update:picked'])

/**
 * 보낼 것 고르기.
 *
 * 열 때마다 "아직"인 것을 골라 둔다. 반영된 것까지 매번 다시 보내면 AI가 이미 한
 * 일을 또 하게 된다. 사람이 마음을 바꾸면 체크로 뒤집을 수 있다.
 */
const picked = computed(() => new Set(props.picked))

watch(
  () => [props.open, props.comments.length],
  ([isOpen]) => {
    if (!isOpen) return
    emit(
      'update:picked',
      props.comments.filter((c) => c.status?.state !== 'applied').map((c) => c.id),
    )
  },
  { immediate: true },
)

function toggle(id) {
  const next = new Set(props.picked)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  // 화면에 보이는 순서대로 넘긴다 — 프롬프트에 담기는 순서와 같아진다
  emit('update:picked', props.comments.filter((c) => next.has(c.id)).map((c) => c.id))
}

const pickedIds = computed(() => props.picked)

const applied = computed(() => props.comments.filter((c) => c.status?.state === 'applied'))

/** 파일별로 묶고 줄 번호 순으로. 프롬프트에 담기는 순서와 같게 보여준다. */
const groups = computed(() => {
  const map = new Map()
  for (const comment of props.comments) {
    if (!map.has(comment.path)) map.set(comment.path, [])
    map.get(comment.path).push(comment)
  }
  return [...map.entries()].map(([path, list]) => ({
    path,
    list: [...list].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
  }))
})

const STATUS = {
  open: { label: '아직', cls: 's-open', hint: '코멘트를 쓸 때 본 코드가 아직 그대로다' },
  applied: {
    label: '반영됨',
    cls: 's-applied',
    hint: '그 코드가 바뀌었다 — AI가 손댄 것으로 보인다',
  },
  frozen: { label: '커밋', cls: 's-frozen', hint: '커밋에 단 코멘트라 판정하지 않는다' },
  unknown: { label: '?', cls: 's-unknown', hint: '코드 조각이 없어 판정할 수 없다' },
}

const statusOf = (comment) => STATUS[comment.status?.state] ?? STATUS.unknown

const where = (comment) => {
  if (!comment.line) return comment.path
  const end = comment.endLine && comment.endLine > comment.line ? `–${comment.endLine}` : ''
  return `${comment.line}${end}행`
}

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path) => {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

/** "3분 전 바뀜" — 줄이 아니라 파일 단위 정보라 그렇게 부른다. */
function sinceLabel(mtime) {
  if (!mtime) return ''
  const seconds = Math.max(0, (Date.now() - mtime) / 1000)
  if (seconds < 90) return '방금'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.round(hours / 24)}일 전`
}
</script>

<template>
  <div v-if="open" class="backdrop" @click="emit('close')">
    <section class="sheet" @click.stop>
      <header class="head">
        <h2>리뷰 스레드</h2>
        <span class="counts">
          아직 {{ comments.length - applied.length }} · 반영됨 {{ applied.length }}
        </span>
        <span class="spacer" />
        <button class="ghost" title="닫기 (Esc)" @click="emit('close')">✕</button>
      </header>

      <p v-if="!comments.length" class="empty">
        아직 코멘트가 없습니다. diff에서 줄 번호를 누르거나 끌어서 답니다.
      </p>

      <div v-else class="list">
        <section v-for="group in groups" :key="group.path" class="group">
          <button class="file" :title="group.path" @click="emit('open-file', { path: group.path })">
            <span class="name">{{ fileName(group.path) }}</span>
            <span class="dir">{{ dirName(group.path) }}</span>
          </button>

          <article
            v-for="comment in group.list"
            :key="comment.id"
            class="item"
            :class="{ picked: picked.has(comment.id), done: comment.status?.state === 'applied' }"
          >
            <button
              class="check"
              :class="{ on: picked.has(comment.id) }"
              :title="picked.has(comment.id) ? '보낼 것에서 빼기' : '보낼 것에 넣기'"
              @click="toggle(comment.id)"
            >
              {{ picked.has(comment.id) ? '✓' : '' }}
            </button>

            <div class="body">
              <div class="meta">
                <button
                  class="where"
                  title="그 줄로 가기"
                  @click="emit('open-file', { path: comment.path, line: comment.line })"
                >
                  {{ where(comment) }}
                </button>
                <span v-if="comment.side === 'left'" class="tag">삭제된 쪽</span>
                <span class="status" :class="statusOf(comment).cls" :title="statusOf(comment).hint">
                  {{ statusOf(comment).label }}
                </span>
                <span v-if="comment.status?.state === 'applied'" class="since">
                  파일 {{ sinceLabel(comment.status.fileMtime) }} 바뀜
                </span>
                <span class="spacer" />
                <button class="ghost" title="코멘트 삭제" @click="emit('delete', comment.id)">
                  ✕
                </button>
              </div>

              <p class="text">{{ comment.text }}</p>
              <pre v-if="comment.code.trim()" class="code">{{ comment.code }}</pre>
            </div>
          </article>
        </section>
      </div>

      <footer v-if="comments.length" class="foot">
        <button
          v-if="applied.length"
          class="ghost-btn"
          title="반영된 것으로 보이는 코멘트를 지운다"
          @click="emit('delete-many', applied.map((c) => c.id))"
        >
          반영된 {{ applied.length }}개 정리
        </button>
        <span class="spacer" />
        <button
          class="send"
          :disabled="!pickedIds.length"
          title="고른 코멘트만 프롬프트로 만들어 클립보드에 담는다"
          @click="emit('copy')"
        >
          선택 {{ pickedIds.length }}개 · 프롬프트 복사
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 60px 20px 40px;
}

.sheet {
  width: min(760px, 100%);
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-sheet);
  backdrop-filter: saturate(180%) blur(30px);
  -webkit-backdrop-filter: saturate(180%) blur(30px);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-sheet);
  overflow: hidden;
  animation: rise 220ms var(--ease);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(12px) scale(0.99);
  }
}

.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 14px 16px 10px;
  flex: none;
}
h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.counts {
  color: var(--fg-faint);
  font-size: 12px;
}
.spacer {
  flex: 1;
}

.empty {
  padding: 18px 16px 26px;
  color: var(--fg-faint);
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 12px;
}

.group + .group {
  margin-top: 14px;
}

.file {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  padding: 6px 6px 6px 4px;
  text-align: left;
}
.file:hover .name {
  color: var(--accent);
}
.name {
  font-size: 12.5px;
  font-weight: 590;
}
.dir {
  color: var(--fg-faint);
  font-size: 10.5px;
  font-family: var(--mono);
}

/* 코멘트 하나 = iOS 목록의 한 행 */
.item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-panel);
  border-radius: var(--r-md);
}
.item + .item {
  margin-top: 6px;
}
.item.done {
  opacity: 0.62;
}
.item.picked {
  box-shadow: inset 2px 0 0 var(--accent);
}

.check {
  flex: none;
  width: 19px;
  height: 19px;
  margin-top: 1px;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--fg-faint);
  color: transparent;
  font-size: 11px;
  line-height: 19px;
  text-align: center;
}
.check.on {
  background: var(--accent);
  box-shadow: none;
  color: #fff;
}

.body {
  flex: 1;
  min-width: 0;
}

.meta {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 3px;
}
.where {
  padding: 0;
  color: var(--fg-dim);
  font-family: var(--mono);
  font-size: 11px;
}
.where:hover {
  color: var(--accent);
  text-decoration: underline;
}
.tag {
  color: var(--fg-faint);
  font-size: 10.5px;
}

.status {
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 10.5px;
  font-weight: 590;
  line-height: 16px;
  white-space: nowrap;
}
.s-open {
  background: rgba(255, 159, 10, 0.18);
  color: var(--status-conflicted);
}
.s-applied {
  background: rgba(48, 209, 88, 0.2);
  color: var(--status-added);
}
.s-frozen {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
}
.s-unknown {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-faint);
}
.since {
  color: var(--fg-faint);
  font-size: 10.5px;
}

.text {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.code {
  margin: 6px 0 0;
  padding: 7px 10px;
  background: var(--bg-code);
  border-radius: var(--r-sm);
  color: var(--fg-dim);
  font-family: var(--mono);
  font-size: 11px;
  /* 코멘트가 인용한 짧은 조각이라 --row-height(코드 배율에 연동)를 쓰지 않는다.
     본문 11px은 그대로인데 줄 높이만 따라 늘어나면 성기게 벌어진다. */
  line-height: 1.65;
  white-space: pre;
  overflow-x: auto;
  max-height: 88px;
}

.ghost {
  color: var(--fg-faint);
  font-size: 11px;
  padding: 2px 5px;
  border-radius: var(--r-sm);
}
.ghost:hover {
  background: rgba(118, 118, 128, 0.28);
  color: var(--fg);
}

.foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-top: 0.5px solid var(--border);
  flex: none;
}

.ghost-btn {
  padding: 4px 12px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-dim);
  font-size: 12px;
}
.ghost-btn:hover {
  color: var(--fg);
  background: rgba(118, 118, 128, 0.36);
}

/* 이 시트에서 유일하게 채워진 버튼. 여기 나가는 것이 이 화면의 목적이다 */
.send {
  padding: 5px 15px;
  border-radius: var(--r-pill);
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 590;
}
.send:hover {
  background: #3d9bff;
}
.send:disabled {
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg-faint);
  cursor: default;
}
</style>
