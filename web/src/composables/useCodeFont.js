import { computed, ref } from 'vue'

/** 11px 아래는 SF Mono가 뭉개지고, 17px 위는 한 화면에 남는 줄이 너무 적다 */
const MIN = 11
const MAX = 17
const DEFAULT = 12.5
const STEP = 0.5
const KEY = 'grmide.codeFontSize'

/**
 * 코드 글자 크기.
 *
 * 밀도는 이 도구의 전제라 기본값(12.5px)은 그대로 둔다. 다만 고정이면 눈에 맞지
 * 않는 사람에게는 읽을 방법이 없다. --code-font-size 하나만 움직이고 줄 높이와
 * 번호칸 폭은 style.css에서 거기에 비례하게 두었다 — 배율만 바뀌고 짜임새는 같다.
 *
 * 0.5px 단위로 움직인다. 12.5 → 13 → 13.5. 1px씩 가면 작은 크기에서 한 걸음이
 * 너무 크게 튄다.
 */
export function useCodeFont() {
  const size = ref(load())
  apply(size.value)

  const canGrow = computed(() => size.value < MAX)
  const canShrink = computed(() => size.value > MIN)
  const isDefault = computed(() => size.value === DEFAULT)

  function load() {
    const raw = Number.parseFloat(localStorage.getItem(KEY) ?? '')
    // 저장된 값이 없거나 손으로 망가뜨렸으면 기본값으로 돌아간다
    if (!Number.isFinite(raw)) return DEFAULT
    return clamp(raw)
  }

  function clamp(v) {
    return Math.min(MAX, Math.max(MIN, v))
  }

  function apply(v) {
    document.documentElement.style.setProperty('--code-font-size', `${v}px`)
  }

  function set(v) {
    const next = clamp(v)
    if (next === size.value) return
    size.value = next
    apply(next)
    try {
      localStorage.setItem(KEY, String(next))
    } catch {
      // 시크릿 창 등에서 저장이 막힐 수 있다. 이번 세션만 적용되면 충분하다.
    }
  }

  const grow = () => set(size.value + STEP)
  const shrink = () => set(size.value - STEP)
  const reset = () => set(DEFAULT)

  return { size, canGrow, canShrink, isDefault, grow, shrink, reset }
}
