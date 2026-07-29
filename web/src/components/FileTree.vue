<script setup>
import { computed, ref } from 'vue'

import FileIcon from './FileIcon.vue'

/**
 * 디렉토리 트리 — 검색이 "아는 파일로 가는 길"이라면 트리는 "모르는 파일을
 * 발견하는 길"이다. 코드를 읽다 보면 어쩔 수 없이 다른 파일을 따라가게 되고,
 * 그때마다 이름을 떠올려 검색하게 할 수는 없다.
 *
 * 목록은 부모가 준다(git ls-files 기반). 파일시스템을 직접 훑지 않으므로
 * .gitignore가 지켜지고 이 트리도 "git이 보는 세계"에 머문다.
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  files: { type: Array, default: () => [] }, // 경로 문자열 배열
  activePath: { type: String, default: null },
})

const emit = defineEmits(['update:open', 'select', 'pin', 'menu'])

/** 파일 행 우클릭 → 부모가 컨텍스트 메뉴를 연다. 디렉토리는 대상이 아니다. */
function onRowMenu(event, row) {
  if (row.dir) return
  event.preventDefault()
  emit('menu', { path: row.path, event })
}

// 펼친 디렉토리들. 세션 안에서만 기억한다 — 다음에 켤 때는 접힌 상태가
// "지금 저장소가 어떻게 생겼나"를 다시 보여 주는 시작점이다.
const expanded = ref(new Set())

function toggleDir(path) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

const cmp = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b)

const scroller = ref(null)

/**
 * 행에 포커스가 있을 때의 키보드 — IDE 트리의 관례를 따른다.
 *
 * ↑↓  이웃 행으로 (기본 동작은 스크롤이라 가로챈다)
 * →   접힌 디렉토리는 펼치고, 펼쳐진 디렉토리는 첫 자식으로
 * ←   펼쳐진 디렉토리는 접고, 그 외(접힌 것·파일)는 부모로
 * Enter/Space는 버튼 기본 동작(click)이라 따로 다루지 않는다.
 */
function onRowKey(event, row, index) {
  const key = event.key

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault()
    focusRow(index + (key === 'ArrowDown' ? 1 : -1))
    return
  }
  if (key === 'ArrowRight') {
    event.preventDefault()
    if (!row.dir) return
    if (row.opened) focusRow(index + 1)
    else toggleDir(row.path)
    return
  }
  if (key === 'ArrowLeft') {
    event.preventDefault()
    if (row.dir && row.opened) {
      toggleDir(row.path)
      return
    }
    const parent = row.path.slice(0, row.path.lastIndexOf('/'))
    if (!parent) return
    focusRow(rows.value.findIndex((r) => r.path === parent))
  }
}

function focusRow(index) {
  const list = scroller.value?.querySelectorAll('.t-row')
  if (!list?.length || index < 0) return
  const el = list[Math.min(index, list.length - 1)]
  el.focus()
  el.scrollIntoView({ block: 'nearest' })
}

/**
 * 경로 목록 → 화면에 보이는 행. 접힌 디렉토리의 안쪽은 아예 만들지 않는다.
 * 디렉토리 먼저, 그다음 파일 — IDE 트리의 관례다.
 */
const rows = computed(() => {
  const root = { dirs: new Map(), files: [] }
  for (const path of props.files) {
    const parts = path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i])
      if (!child) {
        child = { dirs: new Map(), files: [] }
        node.dirs.set(parts[i], child)
      }
      node = child
    }
    node.files.push(parts[parts.length - 1])
  }

  const out = []
  const walk = (node, prefix, depth) => {
    for (const name of [...node.dirs.keys()].sort(cmp)) {
      const path = prefix ? `${prefix}/${name}` : name
      const opened = expanded.value.has(path)
      out.push({ path, name, depth, dir: true, opened })
      if (opened) walk(node.dirs.get(name), path, depth + 1)
    }
    for (const name of [...node.files].sort(cmp)) {
      out.push({ path: prefix ? `${prefix}/${name}` : name, name, depth, dir: false })
    }
  }
  walk(root, '', 0)
  return out
})
</script>

<template>
  <div class="file-tree" :class="{ open }">
    <button class="tree-header" @click="emit('update:open', !open)">
      <span class="chev" :class="{ down: open }">›</span>
      <span class="t-title">파일</span>
      <span v-if="files.length" class="t-count">{{ files.length }}</span>
    </button>

    <div v-if="open" ref="scroller" class="tree-scroll">
      <button
        v-for="(row, index) in rows"
        :key="row.path"
        class="t-row"
        :class="{ active: !row.dir && row.path === activePath }"
        :style="{ paddingLeft: `${14 + row.depth * 14}px` }"
        :title="row.dir ? row.path : '한 번 누르면 미리 보기, 두 번 누르면 탭으로 붙잡는다'"
        @click="row.dir ? toggleDir(row.path) : emit('select', row.path)"
        @dblclick="row.dir || emit('pin', row.path)"
        @contextmenu="onRowMenu($event, row)"
        @keydown="onRowKey($event, row, index)"
      >
        <span v-if="row.dir" class="chev" :class="{ down: row.opened }">›</span>
        <span v-else class="chev-pad" />
        <FileIcon :folder="row.dir" :path="row.path" />
        <span class="t-name" :class="{ dir: row.dir }">{{ row.name }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 접으면 헤더 한 줄. 펼쳤을 때의 높이는 부모(App)의 분할선이 정한다 */
.file-tree {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-bottom: 0.5px solid var(--border);
}
.file-tree.open {
  overflow: hidden;
  border-bottom: none; /* 분할선이 경계선을 대신한다 */
}

/* 변경사항 헤더(ChangeList .list-header)와 같은 급의 제목 — 같은 층위의 섹션이다 */
.tree-header {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  padding: 12px 16px 8px;
  text-align: left;
  flex: none;
}
.t-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.tree-header:hover .t-title {
  color: var(--fg-dim);
}
.t-count {
  color: var(--fg-faint);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.chev {
  flex: none;
  width: 10px;
  text-align: center;
  color: var(--fg-faint);
  transition: transform var(--fast) var(--ease);
  align-self: center;
}
.chev.down {
  transform: rotate(90deg);
}
.chev-pad {
  flex: none;
  width: 10px;
}

.tree-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 8px;
}

/* 훑는 화면이라 변경 목록보다 촘촘하다 — IDE 트리의 밀도 */
.t-row {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding-top: 2.5px;
  padding-bottom: 2.5px;
  padding-right: 8px;
  text-align: left;
  min-width: 0;
  border-radius: var(--r-sm);
}
.t-row:hover {
  background: var(--bg-elevated);
}
/* 키보드로 옮겨 다닐 때의 자리 표시. 브라우저 기본 링은 행 밖으로 튀어나온다 */
.t-row:focus-visible {
  outline: 1.5px solid var(--accent);
  outline-offset: -1.5px;
}
.t-row.active {
  background: var(--accent-soft);
}
.t-row.active .t-name {
  color: #fff;
  font-weight: 590;
}

.t-name {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-name.dir {
  color: var(--fg-dim);
}
</style>
