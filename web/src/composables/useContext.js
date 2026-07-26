import { computed, ref } from 'vue'

import * as api from '../api.js'

/**
 * 컨텍스트 바구니.
 *
 * 코멘트가 **판단**을 넘기는 길이라면 이쪽은 **읽을 곳**을 넘기는 길이다. 지금까지는
 * "이 파일도 같이 봐"를 하려고 사람이 터미널에 경로를 손으로 쳤다.
 *
 * 프롬프트는 서버가 만들어 목록과 함께 내려준다. 복사할 때 만들면 늦다 — `await`
 * 하나만 지나도 브라우저가 클릭 제스처를 끝난 것으로 보고 클립보드 권한을 회수한다.
 */
export function useContext() {
  const items = ref([])
  const prompt = ref('')
  const error = ref('')
  const lastAdded = ref('') // 방금 담은 것의 이름 (화면에 잠깐 알린다)

  const count = computed(() => items.value.length)

  async function load() {
    try {
      const res = await api.fetchContext()
      items.value = res.items
      prompt.value = res.prompt
    } catch (err) {
      error.value = err.message
    }
  }

  /** 담고 나서 목록을 다시 받는다. 프롬프트도 함께 새로 온다. */
  async function add(item, label = '') {
    try {
      const res = await api.addContext(item)
      // 이미 있는 것을 또 누르면 아무 일도 안 일어난 것처럼 보인다. 그렇게 말해 준다.
      lastAdded.value = res.added ? label || '담았다' : '이미 담김'
      setTimeout(() => (lastAdded.value = ''), 1600)
      await load()
      return res.added
    } catch (err) {
      error.value = err.message
      return false
    }
  }

  const wrap = (fn) => async (...args) => {
    try {
      await fn(...args)
      await load()
    } catch (err) {
      error.value = err.message
    }
  }

  const remove = wrap(api.deleteContext)
  const clear = wrap(api.clearContext)

  /** 클릭 핸들러 안에서 아무것도 기다리지 않는다 (클립보드 권한). */
  async function copyPrompt() {
    if (!prompt.value) return false
    try {
      await navigator.clipboard.writeText(prompt.value)
      return true
    } catch {
      const area = document.createElement('textarea')
      area.value = prompt.value
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }

  return { items, prompt, error, count, lastAdded, load, add, remove, clear, copyPrompt }
}
