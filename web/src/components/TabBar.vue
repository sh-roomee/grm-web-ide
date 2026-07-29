<script setup>
import FileIcon from './FileIcon.vue'

defineProps({
  tabs: { type: Array, required: true },
  activeId: { type: String, default: null },
})

const emit = defineEmits(['activate', 'pin', 'close', 'close-all'])

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
        :class="{ on: tab.id === activeId, preview: tab.preview }"
        :title="`${tab.path}${tab.sub ? ` · ${tab.sub}` : ''}${
          tab.preview ? ' · 미리 보기 (두 번 누르면 붙잡는다)' : ''
        }`"
        @click="emit('activate', tab.id)"
        @dblclick="emit('pin', tab.id)"
        @mousedown.middle.prevent="emit('close', tab.id)"
      >
        <!-- 파일 탭의 'F'는 정보가 없었다. 파일 종류 아이콘이 그 자리를 대신한다.
             워킹트리 M·커밋 C는 "무엇을 보고 있나"라는 뜻이 있어 남긴다 -->
        <FileIcon v-if="tab.kind === 'file'" :path="tab.path" :title="KIND.file.title" />
        <span v-else class="kind" :class="KIND[tab.kind].cls" :title="KIND[tab.kind].title">
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
/* 열어 둔 문서 — Safari 탭처럼 알약으로 띄운다 */
.tab-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  background: var(--bg);
  border-bottom: 0.5px solid var(--border);
  min-width: 0;
}

.strip {
  flex: 1;
  display: flex;
  gap: 5px;
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
  gap: 6px;
  max-width: 250px;
  padding: 3px 7px 3px 10px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.16);
  cursor: pointer;
  user-select: none;
  transition: background var(--fast) var(--ease);
}
.tab:hover {
  background: rgba(118, 118, 128, 0.3);
}
.tab.on {
  background: var(--bg-elevated);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
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
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
}
/**
 * 미리 보기 탭은 기울여 쓴다.
 *
 * 다음에 무엇을 고르면 이 자리가 없어지는지가 보여야 한다. 색이나 투명도로 구분하면
 * "안 읽은 것"이나 "낡은 것"처럼 읽히는데, 기울임은 IDE에서 이미 이 뜻으로 쓰인다.
 */
.tab.preview .name {
  font-style: italic;
  font-weight: 400;
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
  width: 16px;
  height: 16px;
  color: var(--fg-faint);
  font-size: 9px;
  border-radius: 50%;
  visibility: hidden;
}
.tab:hover .close,
.tab.on .close {
  visibility: visible;
}
.close:hover {
  background: rgba(118, 118, 128, 0.5);
  color: var(--fg);
}

.close-all {
  flex: none;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  color: var(--fg-dim);
  font-size: 11.5px;
  white-space: nowrap;
}
.close-all:hover {
  color: var(--fg);
  background: rgba(118, 118, 128, 0.24);
}
</style>
