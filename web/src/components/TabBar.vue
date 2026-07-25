<script setup>
defineProps({
  tabs: { type: Array, required: true },
  activeId: { type: String, default: null },
})

const emit = defineEmits(['activate', 'close', 'close-all'])

const KIND = {
  worktree: { char: 'M', cls: 'k-work', title: '워킹트리 변경' },
  commit: { char: 'C', cls: 'k-commit', title: '커밋 안의 변경' },
  file: { char: 'F', cls: 'k-file', title: '파일 (읽기 전용)' },
}

const fileName = (path) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path) => {
  const at = path.lastIndexOf('/')
  return at === -1 ? '' : path.slice(0, at)
}
</script>

<template>
  <div v-if="tabs.length" class="tab-bar">
    <div class="strip">
      <div
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ on: tab.id === activeId }"
        :title="`${tab.path}${tab.sub ? ` · ${tab.sub}` : ''}`"
        @click="emit('activate', tab.id)"
        @mousedown.middle.prevent="emit('close', tab.id)"
      >
        <span class="kind" :class="KIND[tab.kind].cls" :title="KIND[tab.kind].title">
          {{ KIND[tab.kind].char }}
        </span>
        <span class="name">{{ fileName(tab.path) }}</span>
        <span class="dir">{{ dirName(tab.path) }}</span>
        <button class="close" title="닫기 (가운데 클릭)" @click.stop="emit('close', tab.id)">
          ✕
        </button>
      </div>
    </div>

    <button
      v-if="tabs.length > 1"
      class="close-all"
      title="탭 모두 닫기"
      @click="emit('close-all')"
    >
      모두 닫기
    </button>
  </div>
</template>

<style scoped>
.tab-bar {
  flex: none;
  display: flex;
  align-items: stretch;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  min-width: 0;
}

.strip {
  flex: 1;
  display: flex;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.strip::-webkit-scrollbar {
  height: 0;
}

.tab {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 260px;
  padding: 4px 6px 4px 9px;
  border-right: 1px solid var(--border);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  user-select: none;
}
.tab:hover {
  background: var(--bg-elevated);
}
.tab.on {
  background: var(--bg-panel);
  border-bottom-color: var(--accent);
}

.kind {
  flex: none;
  width: 13px;
  text-align: center;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
}
.k-work {
  color: var(--status-modified);
}
.k-commit {
  color: var(--status-conflicted);
}
.k-file {
  color: var(--fg-faint);
}

.name {
  flex: none;
  font-size: 12px;
  white-space: nowrap;
}
.dir {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
  color: var(--fg-faint);
  font-size: 10.5px;
}

.close {
  flex: none;
  width: 15px;
  color: var(--fg-faint);
  font-size: 10px;
  border-radius: 2px;
  visibility: hidden;
}
.tab:hover .close,
.tab.on .close {
  visibility: visible;
}
.close:hover {
  background: var(--border-strong);
  color: var(--fg);
}

.close-all {
  flex: none;
  padding: 0 9px;
  color: var(--fg-faint);
  font-size: 11px;
  border-left: 1px solid var(--border);
  white-space: nowrap;
}
.close-all:hover {
  color: var(--fg);
  background: var(--bg-elevated);
}
</style>
