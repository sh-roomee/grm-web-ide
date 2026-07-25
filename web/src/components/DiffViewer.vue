<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import { buildSpans, tokenizeLine, findRanges } from '../highlight/index.js'

const props = defineProps({
  file: { type: Object, default: null },
  diff: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  // 워킹트리가 아니라 커밋을 보고 있을 때 그 사실을 알려준다
  badge: { type: String, default: '' },
  // 파일 하나를 그냥 읽는 모드(⌘P로 열었을 때). diff가 아니라 한 컬럼이다.
  single: { type: Boolean, default: false },
  // 기준점 대비로 볼 수 있는 상태인지 (기준점이 있고 워킹트리 diff일 때만)
  canCompareBase: { type: Boolean, default: false },
  compareBase: { type: Boolean, default: false },
  // 줄별 리뷰 코멘트: (path, side, line) => 코멘트 배열 | null
  commentsFor: { type: Function, default: () => null },
})

const emit = defineEmits(['update:context', 'update:compareBase', 'comment', 'delete-comment'])

/**
 * 텍스트 선택을 한쪽 컬럼에 붙잡아 둔다.
 *
 * DOM 순서가 `[좌번호, 좌코드, 우번호, 우코드]`라서, 선택이 행을 넘어가는 순간
 * 반대쪽 셀을 지나간다. 그러면 화면에서도 양쪽이 칠해지고 복사해도 좌우가
 * 뒤섞인 텍스트가 나온다.
 *
 * 해결: 드래그를 시작한 쪽을 기억하고 반대쪽 셀에 `user-select: none`을 준다.
 * 브라우저가 선택을 확장할 때 그 셀들을 건너뛰므로, 한쪽 컬럼만 깔끔하게 잡힌다.
 */
const selectSide = ref(null) // 'left' | 'right' | null

function onCodeMouseDown(side) {
  selectSide.value = side
}

// --- 리뷰 코멘트: 줄 번호를 끌어 여러 줄을 고를 수 있다
const composing = ref(null) // { side, from, to, code, text }
const dragging = ref(null) // { side, from, to } — 끄는 중

function gutterDown(side, cell, event) {
  if (!cell?.num) return
  event.preventDefault() // 줄 번호를 끄는 동안 텍스트가 선택되지 않게
  dragging.value = { side, from: cell.num, to: cell.num }
}

function gutterEnter(side, cell) {
  if (!dragging.value || dragging.value.side !== side || !cell?.num) return
  dragging.value.to = cell.num
}

function gutterUp() {
  const drag = dragging.value
  dragging.value = null
  if (!drag) return
  const from = Math.min(drag.from, drag.to)
  const to = Math.max(drag.from, drag.to)
  composing.value = { side: drag.side, from, to, code: rangeCode(drag.side, from, to), text: '' }
  nextTick(() => document.querySelector('.comment-input')?.focus())
}

/** 고른 범위의 코드를 모아 온다. 코멘트와 함께 저장해 프롬프트에 넣는다. */
function rangeCode(side, from, to) {
  const lines = []
  for (const item of items.value) {
    if (item.kind !== 'row') continue
    const cell = item.row[side]
    if (cell?.num >= from && cell?.num <= to) lines.push(cell.text)
  }
  return lines.join('\n')
}

/** 지금 고르는 중이거나 코멘트를 쓰는 중인 범위에 이 줄이 들어가나. */
function inPicked(side, num) {
  if (!num) return false
  for (const range of [dragging.value, composing.value]) {
    if (!range || range.side !== side) continue
    const from = Math.min(range.from, range.to)
    const to = Math.max(range.from, range.to)
    if (num >= from && num <= to) return true
  }
  return false
}

function submitComment() {
  const draft = composing.value
  if (!draft?.text.trim()) return
  emit('comment', {
    line: draft.from,
    endLine: draft.to > draft.from ? draft.to : null,
    side: draft.side,
    code: draft.code,
    text: draft.text.trim(),
  })
  composing.value = null
}

/** 코멘트 입력창은 고른 범위의 마지막 줄 아래에 붙인다. */
const isComposingAt = (side, num) =>
  Boolean(num) && composing.value?.side === side && composing.value?.to === num

/** 이 행에 달린 코멘트. 범위 코멘트는 마지막 줄 아래에 보여준다. */
function rowComments(row) {
  const out = []
  for (const side of ['left', 'right']) {
    const cell = row[side]
    if (!cell?.num) continue
    const list = props.commentsFor(side, cell.num)
    if (list) for (const comment of list) out.push({ side, comment })
  }
  return out
}

const rangeLabel = (comment) =>
  comment.endLine && comment.endLine > comment.line
    ? `${comment.line}–${comment.endLine}행`
    : `${comment.line}행`

const wrap = ref(false)
const scroller = ref(null)
const cursor = ref(0) // 현재 몇 번째 변경 블록을 보고 있는지

// --- 파일 안에서 찾기 (Cmd+F)
const findOpen = ref(false)
const findTerm = ref('')
const findCursor = ref(0) // 현재 몇 번째 매치
const findInput = ref(null)

async function openFind() {
  findOpen.value = true
  await nextTick()
  findInput.value?.select()
}

function closeFind() {
  findOpen.value = false
  findTerm.value = ''
}

/** n번째 매치로 이동한다. */
function gotoHit(index) {
  if (!hitCount.value) return
  const next = (index + hitCount.value) % hitCount.value
  findCursor.value = next
  const el = scroller.value?.querySelector(`[data-hit="${next}"]`)
  el?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

const stepHit = (delta) => gotoHit(findCursor.value + delta)

// 검색어를 바꾸면 첫 매치로 간다
watch(findTerm, () => {
  findCursor.value = 0
  if (hitCount.value) nextTick(() => gotoHit(0))
})

/** 특정 줄로 이동한다 (⌘⇧F 결과에서 열었을 때). */
function scrollToLine(lineNo) {
  const el = scroller.value?.querySelector(`[data-line="${lineNo}"]`)
  el?.scrollIntoView({ block: 'center' })
  el?.classList.add('flash')
  setTimeout(() => el?.classList.remove('flash'), 1200)
}

defineExpose({ openFind, scrollToLine })

/** 한 쪽(좌/우)의 문법 토큰. 파일이 바뀔 때만 다시 계산된다. */
function sideTokens(side) {
  if (!side) return null
  return tokenizeLine(props.diff.language, side.text, {
    lineNo: side.num,
    sections: props.diff.sections,
  })
}

/**
 * 훅 헤더와 행을 하나의 평면 리스트로 만든다.
 * 연속된 변경 행 묶음의 첫 행에 blockIndex를 달아 두면 다음/이전 변경 이동을
 * DOM 조회 한 번으로 처리할 수 있다.
 *
 * 문법 토큰까지만 여기서 만든다. 찾기 강조는 아래 `items`에서 얹는다 — 같이
 * 계산하면 검색어를 한 글자 칠 때마다 파일 전체를 다시 토크나이즈한다.
 */
const baseItems = computed(() => {
  const out = []
  if (!props.diff) return out
  let blockIndex = -1
  let inBlock = false
  for (const hunk of props.diff.hunks) {
    out.push({ kind: 'hunk', hunk, key: `h${hunk.oldStart}-${hunk.newStart}` })
    inBlock = false
    hunk.rows.forEach((row, i) => {
      const isChange = row.type !== 'context'
      let mark = null
      if (isChange && !inBlock) {
        mark = ++blockIndex
        inBlock = true
      } else if (!isChange) {
        inBlock = false
      }
      out.push({
        kind: 'row',
        row,
        leftTokens: sideTokens(row.left),
        rightTokens: sideTokens(row.right),
        blockIndex: mark,
        key: `r${hunk.newStart}-${i}`,
      })
    })
  }
  return out
})

/** 토큰 위에 변경 구간과 찾기 결과를 얹어 최종 span을 만든다. */
const items = computed(() => {
  const query = findTerm.value
  let hitIndex = -1

  return baseItems.value.map((item) => {
    if (item.kind !== 'row') return item

    const build = (side, tokens) => {
      if (!side) return null
      const hits = query ? findRanges(side.text, query) : null
      const first = hits ? ++hitIndex : null // 이 셀의 첫 매치 번호
      if (hits && hits.length > 1) hitIndex += hits.length - 1
      return { spans: buildSpans(side.text, side.words, tokens, hits), hits, first }
    }

    const left = build(item.row.left, item.leftTokens)
    const right = build(item.row.right, item.rightTokens)
    return { ...item, left, right }
  })
})

/** 찾기 결과 총 개수. 좌우 양쪽을 센다. */
const hitCount = computed(() => {
  if (!findTerm.value) return 0
  let total = 0
  for (const item of items.value) {
    if (item.kind !== 'row') continue
    total += item.left?.hits?.length ?? 0
    total += item.right?.hits?.length ?? 0
  }
  return total
})

/**
 * 변경 위치를 알려주는 스크롤 마커.
 *
 * 파일 전체 보기에서는 변경된 곳이 긴 내용 사이에 흩어져 있어서, 어디를 봐야
 * 하는지가 보이지 않으면 "전체를 보여준다"는 것만으로는 쓸모가 없다. 오른쪽
 * 가장자리에 변경 블록 위치를 눈금으로 찍고, 누르면 그 자리로 간다.
 *
 * 위치는 행 인덱스 비율로 잡는다. 모든 행 높이가 같아서 스크롤 비율과 거의
 * 일치하고, 실제 이동은 scrollIntoView가 정확히 처리한다.
 */
const markers = computed(() => {
  const total = items.value.length
  if (!total) return []
  const out = []
  items.value.forEach((item, index) => {
    if (item.kind !== 'row' || item.blockIndex === null) return
    out.push({
      blockIndex: item.blockIndex,
      type: item.row.type,
      ratio: index / total,
    })
  })
  return out
})

const blockCount = computed(() => markers.value.length)

watch(
  () => props.file,
  () => {
    cursor.value = 0
    if (scroller.value) scroller.value.scrollTop = 0
  },
)

function scrollToBlock(index) {
  cursor.value = index
  const el = scroller.value?.querySelector(`[data-block="${index}"]`)
  // behavior: 'smooth'를 쓰면 안 된다. 중첩 스크롤 컨테이너에서 아무 일도
  // 일어나지 않는 경우가 있다(측정으로 확인). 변경 사이 점프는 즉시 이동이 낫다.
  el?.scrollIntoView({ block: 'center' })
}

function goto(delta) {
  if (blockCount.value === 0) return
  scrollToBlock((cursor.value + delta + blockCount.value) % blockCount.value)
}

// git -U 에 안전하게 넘길 수 있는 크기. 어떤 파일이든 전체가 한 훅으로 온다.
const FULL_CONTEXT = 100000
const VIEW_MODES = [
  { context: 3, label: '변경 부분', hint: '변경 주변 3줄만' },
  { context: 8, label: '± 8줄', hint: '변경 주변 8줄' },
  { context: FULL_CONTEXT, label: '파일 전체', hint: '파일 전체를 보면서 변경된 곳 확인' },
]

// 보기 방식은 파일을 옮겨도 유지되어야 한다. 파일마다 다시 고르는 건 번거롭다.
const STORE_KEY = 'grmide:viewContext'
const context = ref(Number(localStorage.getItem(STORE_KEY)) || 3)

function setContext(value) {
  context.value = value
  localStorage.setItem(STORE_KEY, String(value))
}

watch(context, (value) => emit('update:context', value), { immediate: true })
</script>

<template>
  <div class="viewer">
    <header class="bar">
      <template v-if="file">
        <span class="path" :title="file.path">{{ file.path }}</span>
        <span class="badge">{{ badge || (file.staged ? 'staged' : 'working tree') }}</span>

        <div v-if="!single" class="nav">
          <button title="이전 변경 (↑)" @click="goto(-1)">↑</button>
          <button title="다음 변경 (↓)" @click="goto(1)">↓</button>
          <span class="pos">{{ blockCount ? cursor + 1 : 0 }} / {{ blockCount }}</span>
        </div>

        <!-- 비교 대상: HEAD 대비 / 기준점 대비 -->
        <div v-if="canCompareBase" class="modes" role="group" aria-label="비교 대상">
          <button
            class="mode"
            :class="{ on: !compareBase }"
            title="커밋된 상태(HEAD)와 비교"
            @click="emit('update:compareBase', false)"
          >
            HEAD 대비
          </button>
          <button
            class="mode"
            :class="{ on: compareBase }"
            title="마지막으로 확인한 시점과 비교 — 새로 바뀐 것만 보인다"
            @click="emit('update:compareBase', true)"
          >
            기준점 대비
          </button>
        </div>

        <div v-if="!single" class="modes" role="group" aria-label="보기 범위">
          <button
            v-for="mode in VIEW_MODES"
            :key="mode.context"
            class="mode"
            :class="{ on: context === mode.context }"
            :title="mode.hint"
            @click="setContext(mode.context)"
          >
            {{ mode.label }}
          </button>
        </div>

        <button class="ctl" :class="{ on: wrap }" title="긴 줄 접기" @click="wrap = !wrap">
          줄바꿈
        </button>

        <span class="spacer" />

        <!-- 파일 안에서 찾기 (Cmd+F) -->
        <div v-if="findOpen" class="find">
          <input
            ref="findInput"
            v-model="findTerm"
            class="find-input"
            type="text"
            placeholder="이 파일에서 찾기"
            @keydown.enter.exact.prevent="stepHit(1)"
            @keydown.enter.shift.prevent="stepHit(-1)"
            @keydown.esc.prevent="closeFind()"
          />
          <span class="find-pos">
            {{ findTerm ? `${hitCount ? findCursor + 1 : 0} / ${hitCount}` : '' }}
          </span>
          <button title="이전 (Shift+Enter)" @click="stepHit(-1)">↑</button>
          <button title="다음 (Enter)" @click="stepHit(1)">↓</button>
          <button title="닫기 (Esc)" @click="closeFind()">✕</button>
        </div>
        <button v-else class="ctl" title="이 파일에서 찾기 (⌘F)" @click="openFind()">찾기</button>

        <span class="summary">
          {{ single ? `${diff?.lineCount ?? 0}줄` : `${diff?.changes ?? 0} differences` }}
        </span>
        <slot name="actions" />
      </template>
      <span v-else class="path dim">왼쪽에서 파일을 선택하세요</span>
    </header>

    <div class="stage">
      <!-- 변경 위치 눈금. 파일 전체 보기에서 어디를 봐야 하는지 알려준다. -->
      <div v-if="markers.length && !single" class="markers" role="group" aria-label="변경 위치">
        <button
          v-for="marker in markers"
          :key="marker.blockIndex"
          class="marker"
          :class="[`m-${marker.type}`, { on: marker.blockIndex === cursor }]"
          :style="{ top: `${marker.ratio * 100}%` }"
          :title="`${marker.blockIndex + 1}번째 변경으로 이동`"
          @click="scrollToBlock(marker.blockIndex)"
        />
      </div>

      <div
        ref="scroller"
        class="scroll"
        :class="[{ wrap }, selectSide && `sel-${selectSide}`]"
        @mouseup="gutterUp()"
        @mouseleave="dragging = null"
      >
        <p v-if="error" class="notice err">{{ error }}</p>
        <p v-else-if="loading" class="notice">불러오는 중…</p>
        <p v-else-if="!file" class="notice"></p>
        <p v-else-if="diff?.binary" class="notice">
          바이너리 파일입니다. 내용을 비교할 수 없습니다.
        </p>
        <p v-else-if="!diff?.hunks.length" class="notice">표시할 변경사항이 없습니다.</p>

        <template v-else>
          <template v-for="item in items" :key="item.key">
            <div v-if="item.kind === 'hunk' && single" />
            <div v-else-if="item.kind === 'hunk'" class="hunk">
              @@ -{{ item.hunk.oldStart }},{{ item.hunk.oldLines }} +{{ item.hunk.newStart }},{{
                item.hunk.newLines
              }} @@
              <span v-if="item.hunk.header" class="hunk-ctx">{{ item.hunk.header }}</span>
            </div>

            <div
              v-else
              class="line"
              :class="[`t-${item.row.type}`, { single }]"
              :data-block="item.blockIndex ?? undefined"
              :data-line="single ? item.row.right?.num : undefined"
            >
              <template v-if="!single">
                <span
                  class="gutter"
                  :class="{ clickable: item.row.left?.num, picked: inPicked('left', item.row.left?.num) }"
                  title="코멘트 — 클릭하거나 여러 줄을 끌어서 고른다"
                  @mousedown="gutterDown('left', item.row.left, $event)"
                  @mouseenter="gutterEnter('left', item.row.left)"
                  >{{ item.row.left?.num ?? '' }}</span
                >
                <span
                  class="code side-left"
                  :class="{ empty: !item.row.left, picked: inPicked('left', item.row.left?.num) }"
                  :data-hit="item.left?.first ?? undefined"
                  @mousedown="onCodeMouseDown('left')"
                  ><span
                    v-for="(span, i) in item.left?.spans"
                    :key="i"
                    :class="[
                      span.cls && `tk-${span.cls}`,
                      { word: span.changed, hit: span.hit },
                    ]"
                    >{{ span.text }}</span
                  ></span
                >
              </template>

              <span
                class="gutter"
                :class="{ clickable: item.row.right?.num, picked: inPicked('right', item.row.right?.num) }"
                title="코멘트 — 클릭하거나 여러 줄을 끌어서 고른다"
                @mousedown="gutterDown('right', item.row.right, $event)"
                @mouseenter="gutterEnter('right', item.row.right)"
                >{{ item.row.right?.num ?? '' }}</span
              >
              <span
                class="code side-right"
                :class="{ empty: !item.row.right, picked: inPicked('right', item.row.right?.num) }"
                :data-hit="item.right?.first ?? undefined"
                @mousedown="onCodeMouseDown('right')"
                ><span
                  v-for="(span, i) in item.right?.spans"
                  :key="i"
                  :class="[
                    span.cls && `tk-${span.cls}`,
                    { word: span.changed, hit: span.hit },
                  ]"
                  >{{ span.text }}</span
                ></span
              >
            </div>

            <!-- 이 줄에 달린 코멘트 -->
            <template v-if="item.kind === 'row'">
              <div
                v-for="entry in rowComments(item.row)"
                :key="entry.comment.id"
                class="comment"
              >
                <span class="comment-where">
                  {{ rangeLabel(entry.comment) }}{{ entry.side === 'left' ? ' · 삭제된 쪽' : '' }}
                </span>
                <span class="comment-text">{{ entry.comment.text }}</span>
                <button
                  class="comment-del"
                  title="코멘트 삭제"
                  @click="emit('delete-comment', entry.comment.id)"
                >
                  ✕
                </button>
              </div>

              <!-- 코멘트 입력 -->
              <div
                v-if="
                  isComposingAt('left', item.row.left?.num) ||
                  isComposingAt('right', item.row.right?.num)
                "
                class="comment compose"
              >
                <textarea
                  class="comment-input"
                  :placeholder="`${composing.from === composing.to ? `${composing.from}행` : `${composing.from}–${composing.to}행`}에 코멘트 — ⌘Enter 저장, Esc 취소`"
                  v-model="composing.text"
                  rows="2"
                  @keydown.enter.meta.prevent="submitComment()"
                  @keydown.enter.ctrl.prevent="submitComment()"
                  @keydown.esc.prevent="composing = null"
                />
                <button class="comment-save" @click="submitComment()">저장</button>
                <button class="comment-cancel" @click="composing = null">취소</button>
              </div>
            </template>
          </template>

          <p v-if="diff.truncated" class="notice">
            변경량이 너무 커서 일부만 표시했습니다. 터미널에서 <code>git diff</code>로
            확인하세요.
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  flex: none;
  min-width: 0;
}
.path {
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45%;
}
.path.dim {
  color: var(--fg-faint);
  font-family: inherit;
}
.badge {
  flex: none;
  padding: 1px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 3px;
  color: var(--fg-dim);
  font-size: 11px;
}
.spacer {
  flex: 1;
}
.summary {
  flex: none;
  color: var(--fg-dim);
}

.nav {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
.nav button {
  padding: 0 5px;
  color: var(--fg-dim);
  border-radius: 3px;
}
.nav button:hover {
  background: var(--bg-elevated);
  color: var(--fg);
}
.pos {
  color: var(--fg-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.ctl {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fg-dim);
  font-size: 11px;
}
.ctl.on {
  color: var(--accent);
}
/* 보기 범위 선택 */
.modes {
  flex: none;
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  overflow: hidden;
}
.mode {
  padding: 2px 9px;
  font-size: 11px;
  color: var(--fg-dim);
  border-right: 1px solid var(--border-strong);
}
.mode:last-child {
  border-right: none;
}
.mode:hover {
  background: var(--bg-elevated);
  color: var(--fg);
}
.mode.on {
  background: #35548c;
  color: #fff;
}

/* 마커 눈금이 스크롤 영역 위에 얹히도록 */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
}

/* 겹치지 않게 나란히 둔다. 코드 위에 얹으면 글자를 가린다. */
.markers {
  position: relative;
  flex: none;
  order: 2;
  width: 12px;
  background: var(--diff-gutter);
  border-left: 1px solid var(--border);
}
.marker {
  position: absolute;
  right: 2px;
  width: 8px;
  height: 3px;
  border-radius: 1px;
  transform: translateY(-1px);
}
.marker:hover {
  width: 10px;
  right: 1px;
}
.marker.on {
  outline: 1px solid var(--fg);
}
.m-add {
  background: var(--status-added);
}
.m-del {
  background: var(--status-deleted);
}
.m-mod {
  background: var(--status-modified);
}

.scroll {
  flex: 1;
  min-width: 0;
  order: 1;
  overflow: auto;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: var(--row-height);
}

.notice {
  padding: 16px;
  color: var(--fg-faint);
  font-family: inherit;
}
.notice.err {
  color: var(--status-deleted);
}

.hunk {
  display: flex;
  gap: 10px;
  padding: 2px 12px;
  background: var(--diff-gutter);
  color: var(--fg-faint);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 1;
}
.hunk-ctx {
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 52px minmax(0, 1fr);
}
/* 파일 하나를 읽는 모드는 한 컬럼이다 */
.line.single {
  grid-template-columns: 52px minmax(0, 1fr);
}

.gutter {
  padding: 0 8px 0 4px;
  text-align: right;
  color: var(--fg-faint);
  background: var(--diff-gutter);
  border-right: 1px solid var(--border);
  user-select: none;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.gutter.clickable {
  cursor: pointer;
}
.gutter.clickable:hover {
  background: #3a3d42;
  color: var(--accent);
}
/* 코멘트로 고른 줄 범위 */
.gutter.picked {
  background: #35548c;
  color: #fff;
}
.code.picked {
  box-shadow: inset 0 0 0 9999px rgba(84, 138, 247, 0.12);
}

/**
 * 드래그를 시작한 쪽만 선택되게 한다.
 *
 * 반대쪽 셀에 user-select: none을 주면 브라우저가 선택을 확장할 때 그 셀들을
 * 건너뛴다. 이러면 화면에서도 한쪽만 칠해지고, 복사해도 좌우가 섞이지 않는다.
 */
.scroll.sel-left .code.side-right,
.scroll.sel-right .code.side-left {
  user-select: none;
}

/* --- 리뷰 코멘트 --- */
.comment {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 5px 12px 5px 56px;
  background: #2b2f26;
  border-left: 3px solid var(--status-added);
  font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.comment-where {
  flex: none;
  color: var(--fg-faint);
  font-size: 10.5px;
}
.comment-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.comment-del {
  flex: none;
  color: var(--fg-faint);
  font-size: 11px;
}
.comment-del:hover {
  color: var(--status-deleted);
}

.comment.compose {
  background: #26303a;
  border-left-color: var(--accent);
  align-items: flex-end;
}
.comment-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
  outline: none;
}
.comment-save,
.comment-cancel {
  flex: none;
  padding: 3px 10px;
  border-radius: 3px;
  font-size: 11px;
}
.comment-save {
  background: #35548c;
  color: #fff;
}
.comment-save:hover {
  background: #3f63a5;
}
.comment-cancel {
  color: var(--fg-dim);
  border: 1px solid var(--border-strong);
}

.code {
  padding: 0 8px;
  white-space: pre;
  overflow-x: hidden;
  tab-size: 2;
}
.scroll.wrap .code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.code.empty {
  background: #26282c;
}

.t-add .code:last-child,
.t-add .gutter:nth-child(3) {
  background: var(--diff-add-bg);
}
.t-del .code:nth-child(2),
.t-del .gutter:first-child {
  background: var(--diff-del-bg);
}
.t-mod .code {
  background: var(--diff-mod-bg);
}
.t-mod .code:nth-child(2) .word {
  background: var(--diff-del-word);
  box-shadow: inset 0 -1.5px 0 var(--diff-del-line);
}
.t-mod .code:last-child .word {
  background: var(--diff-add-word);
  box-shadow: inset 0 -1.5px 0 var(--diff-add-line);
}

/* 찾기 결과. diff 배경색 위에 얹히므로 테두리로 존재를 알린다. */
.hit {
  background: #6b5a1e;
  box-shadow: inset 0 0 0 1px #d4a72c;
  border-radius: 2px;
}
.line[data-hit] {
  scroll-margin-top: 40px;
}

/* ⌘⇧F 결과로 뛰어온 줄을 잠깐 알려준다 */
.line.flash .code {
  animation: flash 1.2s ease-out;
}
@keyframes flash {
  0%,
  40% {
    background: #4a4420;
  }
  100% {
    background: transparent;
  }
}

/* --- 찾기 바 --- */
.find {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}
.find-input {
  width: 170px;
  padding: 2px 7px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--accent);
  border-radius: 3px;
  font: inherit;
  font-size: 11.5px;
  outline: none;
}
.find-pos {
  min-width: 46px;
  text-align: center;
  color: var(--fg-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.find button {
  padding: 0 5px;
  color: var(--fg-dim);
  border-radius: 3px;
}
.find button:hover {
  background: var(--bg-elevated);
  color: var(--fg);
}

/* --- 문법 강조 --- */
.tk-keyword {
  color: var(--tok-keyword);
}
.tk-string {
  color: var(--tok-string);
}
.tk-number {
  color: var(--tok-number);
}
.tk-comment {
  color: var(--tok-comment);
  font-style: italic;
}
.tk-function {
  color: var(--tok-function);
}
.tk-tag {
  color: var(--tok-tag);
}
.tk-attr {
  color: var(--tok-attr);
}
.tk-property {
  color: var(--tok-property);
}
.tk-directive {
  color: var(--tok-directive);
}
.tk-selector {
  color: var(--tok-selector);
}
.tk-variable {
  color: var(--tok-variable);
}
.tk-entity {
  color: var(--tok-entity);
}
.tk-interp {
  color: var(--tok-interp);
}
.tk-operator {
  color: var(--tok-operator);
}
.tk-punct {
  color: var(--tok-punct);
}

.line[data-block] {
  scroll-margin-top: 32px;
}
</style>
