<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  refs: { type: Array, default: () => [] },
  selected: { type: String, default: null }, // null = 전체 브랜치
})

const emit = defineEmits(['select'])

const open = ref(false)
const filter = ref('')
const input = ref(null)

const KIND_LABEL = { local: '로컬 브랜치', remote: '원격 브랜치', tag: '태그' }

const groups = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const matched = needle
    ? props.refs.filter((r) => r.name.toLowerCase().includes(needle))
    : props.refs
  return ['local', 'remote', 'tag']
    .map((kind) => ({ kind, label: KIND_LABEL[kind], items: matched.filter((r) => r.kind === kind) }))
    .filter((g) => g.items.length)
})

const matchCount = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

const label = computed(() => props.selected ?? '전체 브랜치')

watch(open, async (isOpen) => {
  if (!isOpen) {
    filter.value = ''
    return
  }
  // 열면 바로 타이핑할 수 있게 한다. 브랜치가 많을 때 이게 곧 검색이다.
  await nextTick()
  input.value?.focus()
})

function choose(name) {
  emit('select', name)
  open.value = false
}

/** 목록에 하나만 남았으면 Enter로 고른다. */
function onEnter() {
  if (matchCount.value === 1) {
    const only = groups.value[0].items[0]
    choose(only.name)
  }
}
</script>

<template>
  <div class="picker">
    <button
      class="trigger"
      :class="{ on: selected }"
      :title="selected ? `${selected} 브랜치만 보고 있다` : '모든 브랜치를 보고 있다'"
      @click="open = !open"
    >
      ⎇ {{ label }}
      <span class="caret">▾</span>
    </button>

    <!-- 바깥을 누르면 닫힌다 -->
    <div v-if="open" class="backdrop" @click="open = false" />

    <div v-if="open" class="panel">
      <input
        ref="input"
        v-model="filter"
        class="filter"
        type="text"
        placeholder="브랜치 검색"
        @keydown.enter="onEnter"
        @keydown.esc="open = false"
      />

      <div class="list">
        <button class="item all" :class="{ on: !selected }" @click="choose(null)">
          전체 브랜치
        </button>

        <template v-for="group in groups" :key="group.kind">
          <div class="group">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.fullName"
            class="item"
            :class="{ on: item.name === selected }"
            @click="choose(item.name)"
          >
            <span class="name">
              {{ item.name }}
              <span v-if="item.current" class="here" title="현재 브랜치">HEAD</span>
            </span>
            <span class="meta">{{ item.shortSha }} · {{ item.relativeDate }}</span>
          </button>
        </template>

        <p v-if="!matchCount" class="none">일치하는 브랜치가 없습니다.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
  flex: none;
}

.trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--fg-dim);
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  max-width: 160px;
}
.trigger:hover {
  color: var(--fg);
}
.trigger.on {
  color: var(--accent);
  border-color: var(--accent);
}
.caret {
  opacity: 0.6;
}

.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}

.panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 21;
  width: 280px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  overflow: hidden;
}

.filter {
  width: 100%;
  padding: 6px 9px;
  background: var(--bg);
  color: var(--fg);
  border: none;
  border-bottom: 1px solid var(--border);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.list {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}

.group {
  padding: 6px 9px 2px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-faint);
}

.item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 3px 9px;
  text-align: left;
}
.item:hover {
  background: #3a3d42;
}
.item.on {
  color: var(--accent);
}
.item.all {
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  margin-bottom: 2px;
}

.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.here {
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 2px;
  background: #2f5c34;
  color: #b7e0a8;
  font-size: 9.5px;
}
.meta {
  flex: none;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--fg-faint);
}

.none {
  padding: 10px;
  color: var(--fg-faint);
  font-size: 12px;
}
</style>
