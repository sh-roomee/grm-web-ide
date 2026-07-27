<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import { buildSpans, tokenizeLine, findRanges } from '../highlight/index.js'
import { flattenInline } from '../inline.js'
import { blobUrl } from '../api.js'
import ImagePreview from './ImagePreview.vue'

const props = defineProps({
  file: { type: Object, default: null },
  diff: { type: Object, default: null },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
  // 워킹트리가 아니라 커밋을 보고 있을 때 그 사실을 알려준다
  badge: { type: String, default: '' },
  // 심볼릭 링크면 가리키는 곳. diff 가 비어 있어 이것만이 내용이다
  link: { type: String, default: '' },
  // 파일 하나를 그냥 읽는 모드(⌘P로 열었을 때). diff가 아니라 한 컬럼이다.
  single: { type: Boolean, default: false },
  // 기준점 대비로 볼 수 있는 상태인지 (기준점이 있고 워킹트리 diff일 때만)
  canCompareBase: { type: Boolean, default: false },
  compareBase: { type: Boolean, default: false },
  // 줄별 리뷰 코멘트: (path, side, line) => 코멘트 배열 | null
  commentsFor: { type: Function, default: () => null },
  // 지금 파일의 위험 신호 [{ kind, label, count, samples }]
  risks: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'update:context',
  'update:compareBase',
  'comment',
  'delete-comment',
  'add-context',
])

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

/**
 * 고른 줄 범위를 컨텍스트 바구니에 담는다.
 *
 * 줄을 끌어 고른 다음에 할 수 있는 일이 "코멘트 쓰기"뿐이었다. 그런데 그 동작의
 * 절반은 "여기 좀 봐"라서, 같은 자리에서 담을 수 있어야 한다.
 */
function stashRange() {
  const draft = composing.value
  if (!draft || !props.file) return
  emit('add-context', {
    kind: 'range',
    path: props.file.path,
    line: draft.from,
    endLine: draft.to,
  })
  composing.value = null
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

/**
 * 한 줄 보기에서 이 줄 아래에 붙일 코멘트.
 *
 * 문맥 줄은 오른쪽 번호만 보이지만, 나란히 보기에서 왼쪽 번호에 달아 둔 코멘트가
 * 있을 수 있다. 보기 방식을 바꿨다고 코멘트가 사라져 보이면 안 되므로 같은
 * 자리에 함께 보여준다.
 */
function lineComments(item) {
  const out = []
  if (item.type === 'context' && item.oldNum) {
    const left = props.commentsFor('left', item.oldNum)
    if (left) for (const comment of left) out.push({ side: 'left', comment })
  }
  const list = item.cell?.num ? props.commentsFor(item.side, item.cell.num) : null
  if (list) for (const comment of list) out.push({ side: item.side, comment })
  return out
}

/** 이 항목(행 또는 줄) 아래에 붙일 코멘트와 입력창 조건. */
const commentsAt = (item) => (item.kind === 'line' ? lineComments(item) : rowComments(item.row))
const composingAt = (item) =>
  item.kind === 'line'
    ? isComposingAt(item.side, item.cell?.num)
    : isComposingAt('left', item.row.left?.num) || isComposingAt('right', item.row.right?.num)

const rangeLabel = (comment) =>
  comment.endLine && comment.endLine > comment.line
    ? `${comment.line}–${comment.endLine}행`
    : `${comment.line}행`

/**
 * 이미지 미리보기.
 *
 * png 같은 바이너리는 diff가 아예 없으니 그림밖에 보여줄 것이 없다. svg는 텍스트라
 * diff도 되는데, 그래도 기본은 그림이다 — svg를 열어 보는 이유는 대개 "어떻게
 * 생겼나"이기 때문이다. 텍스트 diff는 토글로 남긴다.
 */
const showPreview = ref(true)

const previewOn = computed(() => {
  if (!props.diff?.preview) return false
  return props.diff.binary || showPreview.value
})

/** 미리보기 주소는 지금 보고 있는 diff와 같은 파라미터로 만든다. */
const previewUrls = computed(() => {
  const diff = props.diff
  if (!diff?.preview) return { before: '', after: '' }
  const target = { path: diff.path ?? props.file?.path, staged: diff.staged, untracked: diff.untracked }
  const opts = { sha: diff.sha ?? null, base: Boolean(diff.base) }
  return {
    before: blobUrl(target, 'before', opts),
    after: blobUrl(target, 'after', opts),
  }
})

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

/**
 * 특정 줄로 이동한다 (⌘⇧F 결과에서 열었을 때).
 *
 * 파일을 막 열었을 때는 행이 아직 그려지지 않았을 수 있다. 한 프레임 뒤에 한 번
 * 더 시도한다 — 첫 시도에서 조용히 실패하면 "파일만 열리고 안 움직인다"가 된다.
 */
function scrollToLine(lineNo, retry = true) {
  const el = scroller.value?.querySelector(`[data-line="${lineNo}"]`)
  if (!el) {
    if (retry) requestAnimationFrame(() => scrollToLine(lineNo, false))
    return
  }
  el.scrollIntoView({ block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1200)
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

/**
 * 토큰 위에 변경 구간과 찾기 결과를 얹어 최종 span을 만든다.
 *
 * 찾기 번호(`data-hit`)는 **화면에 그려지는 순서**를 따라야 한다. 한 줄 보기에서
 * 문맥 행은 오른쪽 셀만 그리므로, 왼쪽 셀의 매치까지 세면 번호가 어긋나 Enter를
 * 눌러도 아무 데로도 가지 않는다.
 */
const items = computed(() => {
  const query = findTerm.value
  const inline = inlineOn.value
  let hitIndex = -1

  return baseItems.value.map((item) => {
    if (item.kind !== 'row') return item

    const build = (side, tokens, counted = true) => {
      if (!side) return null
      const hits = query && counted ? findRanges(side.text, query) : null
      const first = hits ? ++hitIndex : null // 이 셀의 첫 매치 번호
      if (hits && hits.length > 1) hitIndex += hits.length - 1
      return { spans: buildSpans(side.text, side.words, tokens, hits), hits, first }
    }

    // 한 줄 보기의 문맥 행은 왼쪽을 그리지 않는다 (양쪽 내용이 같다)
    const leftShown = !(inline && item.row.type === 'context')
    const left = build(item.row.left, item.leftTokens, leftShown)
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
  const list = renderItems.value
  const total = list.length
  if (!total) return []
  const out = []
  list.forEach((item, index) => {
    if (item.blockIndex === null || item.blockIndex === undefined) return
    if (item.kind !== 'row' && item.kind !== 'line') return
    out.push({
      blockIndex: item.blockIndex,
      type: item.kind === 'line' ? item.type : item.row.type,
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

/**
 * 나란히(split) / 한 줄로(inline).
 *
 * 이 도구의 전제가 "터미널 옆에 브라우저"라서 폭이 700~800px인 경우가 많다.
 * 그 폭에서 side-by-side는 양쪽이 다 잘려 읽을 수 없다. 그래서 좁으면 한 줄로
 * 보여주고, 고른 값은 기억한다.
 *
 * 처음 열 때만 폭으로 정한다 — 사용자가 한 번 고르면 그 뜻을 존중한다.
 */
const LAYOUT_KEY = 'grmide:diffLayout'
const NARROW_PX = 1100

const storedLayout = localStorage.getItem(LAYOUT_KEY)
/** 파일 하나를 읽는 모드는 이미 한 컬럼이라 이 토글이 없다. */
const inlineOn = computed(() => layout.value === 'inline' && !props.single)
const layout = ref(
  storedLayout === 'inline' || storedLayout === 'split'
    ? storedLayout
    : window.innerWidth < NARROW_PX
      ? 'inline'
      : 'split',
)

function setLayout(value) {
  layout.value = value
  localStorage.setItem(LAYOUT_KEY, value)
}

/** 화면에 그리는 목록. 마커·찾기 번호도 이걸 기준으로 센다. */
const renderItems = computed(() => (inlineOn.value ? inlineItems.value : items.value))

/** 한 줄 보기 목록. 펼치는 규칙은 `inline.js`에 있고 테스트로 고정해 두었다. */
const inlineItems = computed(() => (inlineOn.value ? flattenInline(items.value) : []))

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

        <div v-if="!single && !previewOn" class="nav">
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

        <button
          class="ctl"
          title="이 파일을 컨텍스트에 담는다 — AI에게 '이것도 같이 봐'로 넘어간다"
          @click="emit('add-context', { kind: 'file', path: file.path })"
        >
          담기
        </button>

        <!--
          보기 방식은 둘 중 하나라 토글 하나로 둔다. 세그먼트로 두 칸을 쓰면
          이 기능이 필요한 좁은 폭에서 바가 먼저 넘친다.
        -->
        <button
          v-if="!single && !previewOn"
          class="ctl"
          :class="{ on: layout === 'inline' }"
          title="한 줄로 보기 — 터미널 옆에 좁게 띄웠을 때. 끄면 좌우로 나란히"
          @click="setLayout(layout === 'inline' ? 'split' : 'inline')"
        >
          한 줄로
        </button>

        <div v-if="!single && !previewOn" class="modes" role="group" aria-label="보기 범위">
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

        <!-- 그림으로도, 텍스트로도 볼 수 있는 파일(svg)에만 뜬다 -->
        <button
          v-if="diff?.preview && !diff.binary"
          class="ctl"
          :class="{ on: showPreview }"
          title="그림으로 보기 / 텍스트 diff로 보기"
          @click="showPreview = !showPreview"
        >
          미리보기
        </button>

        <button
          v-if="!previewOn"
          class="ctl"
          :class="{ on: wrap }"
          title="긴 줄 접기"
          @click="wrap = !wrap"
        >
          줄바꿈
        </button>

        <span class="spacer" />

        <!-- 파일 안에서 찾기 (Cmd+F) -->
        <div v-if="findOpen && !previewOn" class="find">
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
        <button v-else-if="!previewOn" class="ctl" title="이 파일에서 찾기 (⌘F)" @click="openFind()">
          찾기
        </button>

        <span v-if="!previewOn" class="summary">
          {{ single ? `${diff?.lineCount ?? 0}줄` : `${diff?.changes ?? 0} differences` }}
        </span>
        <slot name="actions" />
      </template>
      <span v-else class="path dim">왼쪽에서 파일을 선택하세요</span>
    </header>

    <!-- 사람이 놓치기 쉬운 지점. 판정이 아니라 "여기 한 번 보라"는 표시다. -->
    <div v-if="risks.length" class="risk-strip">
      <span class="risk-icon">⚠</span>
      <span v-for="risk in risks" :key="risk.kind" class="risk-item" :title="risk.samples.join('\n')">
        {{ risk.label }}
        <strong>{{ risk.count }}</strong>
      </span>
    </div>

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
        :class="[
          { wrap, previewing: previewOn },
          inlineOn ? 'inline' : 'split',
          selectSide && `sel-${selectSide}`,
        ]"
        @mouseup="gutterUp()"
        @mouseleave="dragging = null"
      >
        <p v-if="error" class="notice err">{{ error }}</p>
        <p v-else-if="loading" class="notice">불러오는 중…</p>
        <p v-else-if="!file" class="notice"></p>
        <ImagePreview
          v-else-if="previewOn"
          :preview="diff.preview"
          :before-url="previewUrls.before"
          :after-url="previewUrls.after"
          :single="single"
        />
        <p v-else-if="diff?.binary" class="notice">
          바이너리 파일입니다. 내용을 비교할 수 없습니다.
        </p>
        <!-- 링크는 diff 가 비어 있다. 무엇인지는 말해 준다 -->
        <p v-else-if="link" class="notice">심볼릭 링크입니다 → <code>{{ link }}</code></p>
        <p v-else-if="!diff?.hunks.length" class="notice">표시할 변경사항이 없습니다.</p>

        <template v-else>
          <template v-for="item in renderItems" :key="item.key">
            <div v-if="item.kind === 'hunk' && single" />
            <div v-else-if="item.kind === 'hunk'" class="hunk">
              @@ -{{ item.hunk.oldStart }},{{ item.hunk.oldLines }} +{{ item.hunk.newStart }},{{
                item.hunk.newLines
              }} @@
              <span v-if="item.hunk.header" class="hunk-ctx">{{ item.hunk.header }}</span>
            </div>

            <!--
              한 줄 보기. 번호 컬럼은 하나다 — 부호가 가리키는 쪽의 번호를 쓴다
              (`−`는 HEAD 쪽 번호, `+`와 문맥은 지금 파일의 번호). 좁은 폭을
              벌기 위한 선택이고, 코멘트도 그 한 쪽에 달린다.
            -->
            <div
              v-else-if="item.kind === 'line'"
              class="iline"
              :class="`t-${item.type}`"
              :data-block="item.blockIndex ?? undefined"
            >
              <span
                class="gutter"
                :class="{
                  clickable: item.cell?.num,
                  picked: inPicked(item.side, item.cell?.num),
                }"
                title="코멘트 — 클릭하거나 여러 줄을 끌어서 고른다"
                @mousedown="gutterDown(item.side, item.cell, $event)"
                @mouseenter="gutterEnter(item.side, item.cell)"
                >{{ item.cell?.num ?? '' }}</span
              >
              <span class="sign">{{ item.sign }}</span>
              <span
                class="code"
                :class="{ picked: inPicked(item.side, item.cell?.num) }"
                :data-hit="item.hit ?? undefined"
                ><span
                  v-for="(span, i) in item.spans"
                  :key="i"
                  :class="[span.cls && `tk-${span.cls}`, { word: span.changed, hit: span.hit }]"
                  >{{ span.text }}</span
                ></span
              >
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

            <!-- 이 줄에 달린 코멘트 (두 보기 방식이 같은 마크업을 쓴다) -->
            <template v-if="item.kind === 'row' || item.kind === 'line'">
              <div v-for="entry in commentsAt(item)" :key="entry.comment.id" class="comment">
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
              <div v-if="composingAt(item)" class="comment compose">
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
                <button
                  class="comment-cancel"
                  title="이 구간을 컨텍스트에 담는다 (코멘트는 남기지 않는다)"
                  @click="stashRange()"
                >
                  구간 담기
                </button>
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
  container-type: inline-size;
}

/**
 * 좁아지면 바에서 덜 중요한 것부터 접는다.
 *
 * 파일 경로와 `찾기`는 남기고 개수 표시(`N differences`)를 먼저 버린다 — 개수는
 * 알아서 좋은 정보지만, 경로를 잃거나 찾기 버튼이 화면 밖으로 밀리면 못 쓴다.
 */
@container (max-width: 700px) {
  .summary {
    display: none;
  }
}
@container (max-width: 560px) {
  .badge {
    display: none;
  }
}

/* 파일 도구 바. 내비게이션 바와 같은 재료를 쓰되 흐림은 걸지 않는다 */
.bar {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 14px;
  border-bottom: 0.5px solid var(--border);
  flex: none;
  min-width: 0;
}
.path {
  font-family: var(--mono);
  font-size: 12px;
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
  padding: 1px 8px;
  border-radius: var(--r-pill);
  background: rgba(118, 118, 128, 0.2);
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
  width: 20px;
  height: 20px;
  color: var(--fg-dim);
  border-radius: 50%;
}
.nav button:hover {
  background: rgba(118, 118, 128, 0.24);
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
/* 보기 범위·비교 대상 — 상단 화면 전환과 같은 세그먼티드 컨트롤 */
.modes {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  background: rgba(118, 118, 128, 0.2);
  border-radius: 7px;
}
.mode {
  padding: 2px 9px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg-dim);
  border-radius: 5px;
}
.mode:hover {
  color: var(--fg);
}
.mode.on {
  background: var(--bg-elevated);
  color: var(--fg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}

/* 위험 신호 띠 */
.risk-strip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 6px 14px;
  background: rgba(255, 159, 10, 0.1);
  border-bottom: 0.5px solid var(--border);
  font-size: 12px;
  color: var(--status-conflicted);
  overflow-x: auto;
}
.risk-icon {
  flex: none;
}
.risk-item {
  flex: none;
  cursor: help;
  white-space: nowrap;
}
.risk-item strong {
  color: #fff;
  font-variant-numeric: tabular-nums;
}

/* 마커 눈금이 스크롤 영역 위에 얹히도록 */
/**
 * 코드가 놓이는 면. 캔버스보다 한 단 올려서 "크롬 / 내용"이 갈리게 한다.
 * iOS에서 목록·카드가 캔버스 위에 뜨는 것과 같은 층 구조다.
 */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--bg-panel);
  border-top: 0.5px solid var(--border);
}

/* 겹치지 않게 나란히 둔다. 코드 위에 얹으면 글자를 가린다. */
.markers {
  position: relative;
  flex: none;
  order: 2;
  width: 12px;
  background: var(--diff-gutter);
  border-left: 0.5px solid var(--border);
}
.marker {
  position: absolute;
  right: 2px;
  width: 8px;
  height: 3px;
  border-radius: var(--r-pill);
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
}
/* 미리보기는 스크롤 대신 패널을 채운다. 이미지 아래에 빈 공간이 남으면 안 된다 */
.scroll.previewing {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.scroll.previewing > * {
  min-height: 0;
}
/**
 * 코드를 읽는 표면. 캔버스보다 한 단계 밝고 글자는 흰색에서 한 단계 내려온다.
 * 왜 그래야 하는지는 style.css의 --bg-code 주석에 있다.
 */
.scroll:not(.previewing) {
  font-family: var(--mono);
  font-size: var(--code-font-size);
  line-height: var(--row-height);
  background: var(--bg-code);
  color: var(--fg-code);
}

.notice {
  padding: 18px;
  color: var(--fg-faint);
  font-family: var(--ui);
  font-size: 13px;
}
.notice.err {
  color: var(--status-deleted);
}

.hunk {
  display: flex;
  gap: 10px;
  padding: 3px 12px;
  background: rgba(118, 118, 128, 0.12);
  color: var(--fg-faint);
  border-top: 0.5px solid var(--border);
  border-bottom: 0.5px solid var(--border);
  font-size: 0.88em;
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

/**
 * 껍데기 폭은 em으로 잡는다. .line은 --code-font-size를 물려받으므로 글자를 키우면
 * 번호칸도 같이 커진다 — px로 박아 두면 17px에서 네 자리 줄번호가 잘린다.
 * 4.2em은 12.5px에서 52.5px, 지금까지의 폭이다.
 */
.line {
  display: grid;
  grid-template-columns: 4.2em minmax(0, 1fr) 4.2em minmax(0, 1fr);
}
/* 파일 하나를 읽는 모드는 한 컬럼이다 */
.line.single {
  grid-template-columns: 4.2em minmax(0, 1fr);
}

/**
 * 한 줄 보기. 번호 하나 + 부호 하나 + 코드.
 *
 * 나란히 보기는 번호·코드가 두 벌이라 폭 100px 이상을 껍데기에 쓴다. 여기서는
 * 60px이면 되고, 남는 폭이 그대로 코드가 된다 — 좁게 띄웠을 때의 요점이다.
 */
.iline {
  display: grid;
  grid-template-columns: 3.7em 1.15em minmax(0, 1fr);
}
.sign {
  text-align: center;
  user-select: none;
  color: var(--fg-faint);
  font-size: 0.88em;
}

.iline.t-del .code,
.iline.t-del .sign,
.iline.t-del .gutter {
  background: var(--diff-del-bg);
}
.iline.t-add .code,
.iline.t-add .sign,
.iline.t-add .gutter {
  background: var(--diff-add-bg);
}
.iline.t-del .sign {
  color: var(--diff-del-line);
}
.iline.t-add .sign {
  color: var(--diff-add-line);
}
.iline.t-del .word {
  background: var(--diff-del-word);
  box-shadow: inset 0 -1.5px 0 var(--diff-del-line);
}
.iline.t-add .word {
  background: var(--diff-add-word);
  box-shadow: inset 0 -1.5px 0 var(--diff-add-line);
}

.gutter {
  padding: 0 8px 0 4px;
  text-align: right;
  color: var(--fg-faint);
  background: var(--diff-gutter);
  border-right: 0.5px solid var(--border);
  user-select: none;
  font-variant-numeric: tabular-nums;
  font-size: 0.84em;
}
.gutter.clickable {
  cursor: pointer;
}
.gutter.clickable:hover {
  background: rgba(118, 118, 128, 0.36);
  color: var(--accent);
}
/* 코멘트로 고른 줄 범위 */
.gutter.picked {
  background: var(--accent);
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
.scroll.split.sel-left .code.side-right,
.scroll.split.sel-right .code.side-left {
  user-select: none;
}


/* --- 리뷰 코멘트 --- */
.comment {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  /* 왼쪽 여백은 번호칸(4.2em) 너머에서 시작해 코드와 줄을 맞춘다. 글자 크기를
     바꾸면 번호칸이 움직이므로 여기도 같은 식으로 따라가야 한다. */
  padding: 7px 14px 7px calc(var(--code-font-size) * 4.2 + 4px);
  background: rgba(48, 209, 88, 0.09);
  border-left: 2px solid var(--status-added);
  font-family: var(--ui);
  font-size: 12.5px;
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
  background: var(--accent-soft);
  border-left-color: var(--accent);
  align-items: flex-end;
}
.comment-input {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  background: var(--bg-panel);
  color: var(--fg);
  border: none;
  box-shadow: 0 0 0 1px var(--border-strong);
  border-radius: 8px;
  font: inherit;
  font-size: 12px;
  resize: vertical;
  outline: none;
}
.comment-save,
.comment-cancel {
  flex: none;
  padding: 4px 13px;
  border-radius: var(--r-pill);
  font-size: 12px;
  font-weight: 500;
}
.comment-save {
  background: var(--accent);
  color: #fff;
  font-weight: 590;
}
.comment-save:hover {
  background: #3d9bff;
}
.comment-cancel {
  color: var(--fg);
  background: rgba(118, 118, 128, 0.24);
}
.comment-cancel:hover {
  background: rgba(118, 118, 128, 0.36);
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
  background: rgba(0, 0, 0, 0.22);
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
  background: rgba(255, 214, 10, 0.28);
  box-shadow: inset 0 0 0 1px rgba(255, 214, 10, 0.85);
  border-radius: 3px;
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
    background: rgba(255, 214, 10, 0.24);
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
  width: 180px;
  padding: 3px 10px;
  background: rgba(118, 118, 128, 0.24);
  color: var(--fg);
  border: none;
  border-radius: var(--r-pill);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.find-input:focus {
  background: var(--bg-elevated);
  box-shadow: 0 0 0 2px var(--accent-soft);
}
.find-pos {
  min-width: 46px;
  text-align: center;
  color: var(--fg-faint);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.find button {
  width: 20px;
  height: 20px;
  color: var(--fg-dim);
  border-radius: 50%;
}
.find button:hover {
  background: rgba(118, 118, 128, 0.24);
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
