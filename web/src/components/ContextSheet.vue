<script setup>
import { computed } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'open-file', 'remove', 'clear', 'copy'])

const KIND = {
  file: { label: '파일', cls: 'k-file' },
  range: { label: '구간', cls: 'k-range' },
  grep: { label: '검색', cls: 'k-grep' },
}

const label = (item) => {
  if (item.kind === 'grep') return `"${item.query}"`
  if (item.kind === 'range') {
    return item.endLine > item.line
      ? `${item.path}:${item.line}-${item.endLine}`
      : `${item.path}:${item.line}`
  }
  return item.path
}

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path) => {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}

const counts = computed(() => {
  const out = { file: 0, range: 0, grep: 0 }
  for (const item of props.items) out[item.kind] = (out[item.kind] ?? 0) + 1
  return out
})
</script>

<template>
  <div v-if="open" class="backdrop" @click="emit('close')">
    <section class="sheet" @click.stop>
      <header class="head">
        <h2>컨텍스트</h2>
        <span class="counts">
          파일 {{ counts.file }} · 구간 {{ counts.range }} · 검색 {{ counts.grep }}
        </span>
        <span class="spacer" />
        <button class="ghost" title="닫기 (Esc)" @click="emit('close')">✕</button>
      </header>

      <p v-if="!items.length" class="empty">
        담긴 것이 없습니다. diff 위 <code>담기</code>, 줄을 끌어 고른 뒤
        <code>구간 담기</code>, 검색 결과에서 <code>⌥Enter</code>로 담습니다.
      </p>

      <div v-else class="list">
        <article v-for="item in items" :key="item.id" class="item">
          <span class="kind" :class="KIND[item.kind].cls">{{ KIND[item.kind].label }}</span>

          <button
            v-if="item.kind === 'grep'"
            class="what grep"
            title="이 검색어는 넘길 때 다시 검색한다"
            disabled
          >
            {{ label(item) }}
          </button>
          <button
            v-else
            class="what"
            :title="`${item.path} 열기`"
            @click="emit('open-file', { path: item.path, line: item.line ?? null })"
          >
            <span class="name">{{ fileName(item.path) }}</span>
            <span class="dir">{{ dirName(item.path) }}</span>
            <span v-if="item.kind === 'range'" class="range">
              {{ item.endLine > item.line ? `${item.line}–${item.endLine}행` : `${item.line}행` }}
            </span>
          </button>

          <span class="spacer" />
          <button class="ghost" title="빼기" @click="emit('remove', item.id)">✕</button>
        </article>
      </div>

      <footer v-if="items.length" class="foot">
        <button class="ghost-btn" title="바구니 비우기" @click="emit('clear')">비우기</button>
        <span class="note">내용은 넘길 때 읽는다 — 지금 파일 그대로 담긴다</span>
        <span class="spacer" />
        <button class="send" title="담긴 것을 프롬프트로 만들어 클립보드에 담는다" @click="emit('copy')">
          {{ items.length }}개 · 프롬프트 복사
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
  width: min(680px, 100%);
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
  padding: 16px 16px 26px;
  color: var(--fg-dim);
  font-size: 12.5px;
  line-height: 1.7;
}
.empty code {
  padding: 1px 6px;
  border-radius: var(--r-sm);
  background: rgba(118, 118, 128, 0.24);
  font-family: var(--mono);
  font-size: 11px;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 12px 12px;
}

.item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-radius: var(--r-md);
}
.item + .item {
  margin-top: 5px;
}

.kind {
  flex: none;
  padding: 0 8px;
  border-radius: var(--r-pill);
  font-size: 10.5px;
  font-weight: 590;
  line-height: 16px;
}
.k-file {
  background: var(--accent-soft);
  color: var(--accent);
}
.k-range {
  background: rgba(191, 90, 242, 0.2);
  color: var(--status-untracked);
}
.k-grep {
  background: rgba(255, 159, 10, 0.18);
  color: var(--status-conflicted);
}

.what {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 0;
  text-align: left;
}
.what:hover .name {
  color: var(--accent);
}
.what.grep {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--fg);
  cursor: default;
}
.name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
}
.dir {
  color: var(--fg-faint);
  font-size: 10.5px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.range {
  color: var(--fg-dim);
  font-size: 11px;
  font-family: var(--mono);
  white-space: nowrap;
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
.note {
  color: var(--fg-faint);
  font-size: 11px;
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

/* 이 시트에서 유일하게 채워진 버튼 */
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
</style>
