<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

import MdBlocks from './MdBlocks.vue'
import { parseMarkdown, tableOfContents } from '../markdown/parse.js'
import { classifyImage, classifyLink } from '../markdown/links.js'
import { blobUrl } from '../api.js'

/**
 * 마크다운 미리보기.
 *
 * 문서를 읽으려고 IDE를 켜는 일도 없애야 한다. diff로 보면 `## 제목`과 `| a | b |`가
 * 글자로 남아 표가 표로 안 보인다 — 문서를 검토할 때 정작 필요한 것이 그 모양이다.
 *
 * 폭을 제한한다(72em). 넓은 화면에서 한 줄이 200자가 되면 눈이 다음 줄을 못 찾는다.
 * 코드 영역의 밀도 원칙은 여기에 적용하지 않는다 — 이쪽은 diff가 아니라 산문이고,
 * 산문은 여백이 있어야 읽힌다.
 */
const props = defineProps({
  text: { type: String, default: '' },
  /** 문서의 저장소 기준 경로. 상대 링크·그림 경로를 푸는 기준이다 */
  path: { type: String, default: '' },
  /** 어느 쪽 버전을 보는지. 그림도 같은 버전에서 가져온다 */
  target: { type: Object, default: () => ({}) },
  /** 다른 문서에서 `X.md#설계-결정` 으로 들어왔을 때 그 제목 id */
  hash: { type: String, default: '' },
})

const emit = defineEmits(['open-file'])

const blocks = computed(() => parseMarkdown(props.text))
const toc = computed(() => tableOfContents(blocks.value))

/**
 * 목차.
 *
 * 785줄짜리 문서를 그려 놓고 원하는 절로 갈 길이 없으면 그린 값이 반감한다. 다만
 * 이 도구는 터미널 옆 좁은 폭에서 뜨므로 목차가 항상 자리를 차지하면 안 된다 —
 * 토글로 두고 선택을 기억한다. 제목이 세 개 아래면 아예 내놓지 않는다.
 */
const TOC_KEY = 'grmide.md.toc'
const tocOpen = ref(localStorage.getItem(TOC_KEY) === '1')
const hasToc = computed(() => toc.value.length >= 3)

function toggleToc() {
  tocOpen.value = !tocOpen.value
  try {
    localStorage.setItem(TOC_KEY, tocOpen.value ? '1' : '0')
  } catch {
    // 시크릿 창 등. 이번 세션만 적용되면 충분하다.
  }
}

defineExpose({ toggleToc, hasToc, tocOpen })

const scroller = ref(null)
const activeId = ref('')

/**
 * 제목으로 옮긴다.
 *
 * **`scrollIntoView`를 쓰지 않는다.** 그걸 쓰면 브라우저가 조건을 맞추려고 바깥
 * 컨테이너까지 함께 민다 — 실제로 `.main`이 38px 밀려 탭 바가 화면 밖으로 나갔다.
 * 측정으로 확인했고, `style.css`가 `overflow: hidden`으로 막아 둔 것과 같은 사고다.
 * 목표 위치를 직접 계산해 `scrollTop`만 건드리면 그 영역만 움직인다.
 *
 * `behavior: 'smooth'` 도 쓸 자리가 아니다 — 중첩 스크롤에서 아무 일도 하지 않는
 * 경우가 있다(아래 같은 이름의 설계 결정 참고).
 */
async function jumpTo(id) {
  if (!id) return
  await nextTick()
  const root = scroller.value
  const el = root?.querySelector(`[id="${cssEscape(id)}"]`)
  if (!el) return
  const offset = el.getBoundingClientRect().top - root.getBoundingClientRect().top
  // 제목이 맨 위에 딱 붙으면 잘린 것처럼 보인다. 한 줄 만큼 띄운다.
  root.scrollTop = Math.max(0, root.scrollTop + offset - 12)
  activeId.value = id
}

/** id에 따옴표나 대괄호가 들어가도 선택자가 깨지지 않게 한다 */
function cssEscape(id) {
  return String(id).replace(/["\\]/g, '\\$&')
}

// 다른 문서에서 앵커를 달고 들어왔을 때. 내용이 늦게 오므로 둘 다 지켜본다.
watch([() => props.hash, () => props.text], () => jumpTo(props.hash), { immediate: true })

/**
 * 지금 읽고 있는 절을 목차에서 표시한다.
 *
 * IntersectionObserver 대신 스크롤 위치로 센다. 제목이 화면에 여러 개 보일 때
 * "무엇이 지금 절인가"는 교차 여부가 아니라 "위에서 가장 가까운 제목"이라서다.
 */
let ticking = false
function onScroll() {
  if (ticking || !tocOpen.value) return
  ticking = true
  requestAnimationFrame(() => {
    ticking = false
    const root = scroller.value
    if (!root) return
    const top = root.getBoundingClientRect().top
    let current = ''
    for (const item of toc.value) {
      const el = root.querySelector(`[id="${cssEscape(item.id)}"]`)
      if (!el) continue
      // 화면 위쪽 1/4 을 지난 제목까지를 "읽고 있는 절"로 본다
      if (el.getBoundingClientRect().top - top <= root.clientHeight * 0.25) current = item.id
      else break
    }
    if (current) activeId.value = current
  })
}

onMounted(() => scroller.value?.addEventListener('scroll', onScroll, { passive: true }))
onUnmounted(() => scroller.value?.removeEventListener('scroll', onScroll))

/** 트리 전체에서 쓰는 도우미 묶음. 재귀 컴포넌트로 그대로 내려간다. */
const ctx = {
  linkOf: (href) => classifyLink(props.path, href),
  jumpTo,

  openLink(href) {
    const link = classifyLink(props.path, href)
    // 앵커까지 함께 넘긴다. 문서들이 서로 절 단위로 참조하기 때문이다.
    if (link?.kind === 'file') emit('open-file', { path: link.path, hash: link.hash })
  },

  /** 저장소 안의 그림만 주소를 만든다. 바깥 주소면 null (그리지 않는다) */
  imageUrl(src) {
    const img = classifyImage(props.path, src)
    if (img?.kind !== 'file') return null
    const t = props.target ?? {}
    return blobUrl({ path: img.path, staged: t.staged, untracked: t.untracked }, 'after', {
      sha: t.sha ?? null,
      base: Boolean(t.base),
    })
  },
}
</script>

<template>
  <div class="md-wrap">
    <div ref="scroller" class="md-scroll">
      <article class="md">
        <MdBlocks :blocks="blocks" :ctx="ctx" />
        <p v-if="!blocks.length" class="md-empty">빈 문서입니다.</p>
      </article>
    </div>

    <!-- 목차는 본문 오른쪽에 붙는다. 본문 폭(72em)을 건드리지 않으려고 밖에 둔다 -->
    <nav v-if="hasToc && tocOpen" class="toc" aria-label="목차">
      <ol>
        <li v-for="item in toc" :key="item.id" :class="[`lv-${item.level}`, { on: item.id === activeId }]">
          <button type="button" :title="item.text" @click="jumpTo(item.id)">{{ item.text }}</button>
        </li>
      </ol>
    </nav>
  </div>
</template>

<style scoped>
.md-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
  background: var(--bg-code);
  /* 목차가 자기 폭이 아니라 "이 영역이 얼마나 좁은지"로 숨을 수 있게 한다.
     창 크기가 아니라 패널 폭이 기준이다 — 좌측 목록을 접었는지에 따라 달라진다. */
  container-type: inline-size;
}

.md-scroll {
  flex: 1;
  min-width: 0;
  overflow: auto;
}

/**
 * 목차. 스크롤은 본문만 하고 목차는 제자리에 남는다.
 *
 * 좁은 폭(터미널 옆)에서는 목차가 본문을 잡아먹으므로 폭을 고정하지 않고 clamp로
 * 준다. 400px 아래로 좁아지면 아예 감춘다 — 그 폭에서는 본문이 먼저다.
 */
.toc {
  flex: none;
  width: clamp(150px, 22%, 230px);
  padding: 22px 14px 40px 8px;
  border-left: 0.5px solid var(--border);
  overflow-y: auto;
  font-size: 11.5px;
  line-height: 1.5;
}
.toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}
.toc li + li {
  margin-top: 1px;
}
.toc button {
  /* 두 줄까지 보여 준다. 한 줄로 자르면 절 이름이 다 비슷해 구분이 안 된다 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  width: 100%;
  padding: 3px 8px;
  border-radius: var(--r-sm);
  color: var(--fg-dim);
  text-align: left;
  overflow: hidden;
}
.toc button:hover {
  background: rgba(118, 118, 128, 0.2);
  color: var(--fg);
}
.toc .lv-3 button {
  padding-left: 18px;
}
.toc .lv-4 button {
  padding-left: 28px;
}
/* 지금 읽고 있는 절 */
.toc li.on button {
  background: var(--accent-soft);
  color: var(--fg);
  font-weight: 550;
}

@container (max-width: 400px) {
  .toc {
    display: none;
  }
}

/**
 * 자식 컴포넌트(MdBlocks·MdInline)가 그린 요소라 :deep()으로 닿는다. 산문 서식을
 * 여기 한 곳에 모아 두면 컴포넌트는 구조만 갖는다.
 */
.md {
  max-width: 72em;
  margin: 0 auto;
  padding: 28px 32px 64px;
  color: var(--fg-code);
  font-family: var(--ui);
  font-size: 14px;
  line-height: 1.72;
  overflow-wrap: anywhere;
}

.md-empty {
  color: var(--fg-faint);
}

/* --- 제목. 위 여백을 넉넉히 두어 절의 시작이 눈에 걸리게 한다 --- */
.md :deep(h1),
.md :deep(h2),
.md :deep(h3),
.md :deep(h4),
.md :deep(h5),
.md :deep(h6) {
  margin: 1.9em 0 0.7em;
  line-height: 1.35;
  font-weight: 650;
  color: var(--fg);
}
.md :deep(> h1:first-child),
.md :deep(> h2:first-child) {
  margin-top: 0;
}
.md :deep(h1) {
  font-size: 1.85em;
  letter-spacing: -0.02em;
}
.md :deep(h2) {
  font-size: 1.42em;
  letter-spacing: -0.015em;
  padding-bottom: 0.3em;
  border-bottom: 0.5px solid var(--border);
}
.md :deep(h3) {
  font-size: 1.16em;
}
.md :deep(h4) {
  font-size: 1em;
}
.md :deep(h5),
.md :deep(h6) {
  font-size: 0.94em;
  color: var(--fg-dim);
}

.md :deep(p) {
  margin: 0 0 1.05em;
}

.md :deep(hr) {
  margin: 2.2em 0;
  border: none;
  border-top: 0.5px solid var(--border);
}

/* --- 목록 --- */
.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 1.05em;
  padding-left: 1.6em;
}
.md :deep(li) {
  margin: 0.3em 0;
}
/* 중첩 목록과 항목 안의 문단은 여백을 줄인다. 안 그러면 계단처럼 벌어진다 */
.md :deep(li > ul),
.md :deep(li > ol) {
  margin: 0.3em 0 0.4em;
}
.md :deep(li > p) {
  margin: 0 0 0.5em;
}
.md :deep(li > p:last-child) {
  margin-bottom: 0;
}
.md :deep(ul) {
  list-style: none;
}
/* 불릿을 직접 그린다. 기본 disc는 이 글자 크기에서 너무 무겁다 */
.md :deep(ul > li) {
  position: relative;
}
.md :deep(ul > li)::before {
  content: '';
  position: absolute;
  left: -1.05em;
  top: 0.72em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--fg-faint);
}
/* 체크 항목은 불릿 대신 네모칸을 쓴다 */
.md :deep(ul > li.task)::before {
  display: none;
}
.md :deep(.md-check) {
  position: absolute;
  left: -1.5em;
  top: 0.28em;
  width: 1.05em;
  height: 1.05em;
  border-radius: 3px;
  box-shadow: inset 0 0 0 1px var(--border-strong);
  color: var(--bg-code);
  font-size: 0.82em;
  line-height: 1.15em;
  text-align: center;
}
.md :deep(li.done > .md-check) {
  background: var(--status-added);
  box-shadow: none;
  font-weight: 700;
}
/* 끝낸 항목은 한 단계 물러나게 한다. 남은 일이 먼저 눈에 들어와야 한다 */
.md :deep(li.done) {
  color: var(--fg-dim);
}
.md :deep(ol) {
  list-style: decimal;
}
.md :deep(ol > li)::marker {
  color: var(--fg-faint);
  font-variant-numeric: tabular-nums;
}

/* --- 인용 --- */
.md :deep(blockquote) {
  margin: 0 0 1.05em;
  padding: 0.1em 0 0.1em 1.1em;
  border-left: 2px solid var(--border-strong);
  color: var(--fg-dim);
}
.md :deep(blockquote > :last-child) {
  margin-bottom: 0;
}

/* --- 코드 --- */
.md :deep(.md-code) {
  padding: 0.12em 0.38em;
  border-radius: 4px;
  background: rgba(118, 118, 128, 0.24);
  font-family: var(--mono);
  font-size: 0.87em;
  /* 인라인 코드가 줄바꿈으로 두 조각이 되면 배경도 갈라져 읽기 어렵다 */
  white-space: nowrap;
}

/**
 * 코드 블록은 diff와 같은 밀도·같은 표면을 쓴다. ⌘+/⌘-도 그대로 따라온다 —
 * 문서 안의 코드만 안 커지면 도구가 두 규칙을 갖게 된다.
 */
.md :deep(.md-fence) {
  margin: 0 0 1.3em;
  padding: 11px 14px;
  border-radius: var(--r-md);
  background: rgba(0, 0, 0, 0.24);
  box-shadow: inset 0 0 0 0.5px var(--border);
  overflow-x: auto;
  font-family: var(--mono);
  font-size: var(--code-font-size);
  line-height: var(--row-height);
  white-space: pre;
  tab-size: 2;
}
.md :deep(.md-fence code) {
  font: inherit;
}

/* --- 표 --- */
.md :deep(.md-table-wrap) {
  margin: 0 0 1.3em;
  overflow-x: auto;
}
.md :deep(table) {
  border-collapse: collapse;
  font-size: 0.94em;
}
.md :deep(th),
.md :deep(td) {
  padding: 7px 12px;
  border: 0.5px solid var(--border);
  text-align: left;
  vertical-align: top;
}
.md :deep(th) {
  background: rgba(118, 118, 128, 0.16);
  color: var(--fg);
  font-weight: 600;
  white-space: nowrap;
}

/* --- 링크·그림 --- */
.md :deep(.md-link) {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 0.5px solid rgba(10, 132, 255, 0.4);
}
.md :deep(.md-link:hover) {
  border-bottom-color: var(--accent);
}
/* 바깥으로 나가는 링크임을 표시한다 */
.md :deep(.md-link.out)::after {
  content: '↗';
  margin-left: 0.15em;
  font-size: 0.82em;
  color: var(--fg-faint);
}
.md :deep(.md-anchor) {
  color: var(--fg);
}
.md :deep(.md-img) {
  display: block;
  max-width: 100%;
  margin: 0.4em 0;
  border-radius: var(--r-sm);
  box-shadow: inset 0 0 0 0.5px var(--border);
}
/* 저장소 밖의 그림은 불러오지 않는다. 자리를 비우지 않고 무엇이었는지 말해 준다 */
.md :deep(.md-img-out) {
  display: inline-block;
  padding: 0.15em 0.5em;
  border-radius: 4px;
  background: rgba(118, 118, 128, 0.18);
  color: var(--fg-dim);
  font-size: 0.9em;
}

.md :deep(del) {
  color: var(--fg-faint);
}
.md :deep(strong) {
  font-weight: 650;
  color: var(--fg);
}
</style>
