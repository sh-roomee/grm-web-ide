import { computed, ref } from 'vue'

import * as api from '../api.js'

/**
 * 리뷰 코멘트.
 *
 * 지금까지 리뷰 흐름은 이렇게 끊겼다: 브라우저에서 diff를 보고 → 머릿속에 기억 →
 * 터미널로 가서 경로와 줄 번호를 다시 타이핑. 그 옮겨 적는 일을 없애는 것이 이
 * 기능의 전부다.
 *
 * 저장은 서버(`.git/grmide-state.json`)가 한다. 새로고침이나 grmide 재시작에
 * 사라지면 리뷰 도중 쓴 메모가 날아간다.
 */
export function useComments() {
  const comments = ref([])
  const prompt = ref('')
  const error = ref('')

  /** 파일+줄로 빠르게 찾기 위한 색인. diff를 그릴 때 줄마다 조회한다. */
  const byLine = computed(() => {
    const map = new Map()
    for (const comment of comments.value) {
      const key = `${comment.path}:${comment.side}:${comment.line}`
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(comment)
    }
    return map
  })

  const forLine = (path, side, line) => byLine.value.get(`${path}:${side}:${line}`) ?? null

  const countFor = (path) => comments.value.filter((c) => c.path === path).length

  /**
   * 반영 판정은 서버가 붙여 준다 (`status.state`).
   *  - open    아직 그 코드가 그대로다
   *  - applied 그 코드가 바뀌었다 = AI가 손댔다
   *  - frozen  커밋에 단 코멘트라 판정하지 않는다
   */
  const openOnes = computed(() => comments.value.filter((c) => c.status?.state !== 'applied'))
  const appliedOnes = computed(() => comments.value.filter((c) => c.status?.state === 'applied'))

  async function load() {
    try {
      const res = await api.fetchComments()
      comments.value = res.comments
      prompt.value = res.prompt
    } catch (err) {
      error.value = err.message
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

  const add = wrap(api.addComment)
  const edit = wrap(api.editComment)
  const remove = wrap(api.deleteComment)
  const removeMany = wrap(api.deleteComments)
  const clear = wrap(api.clearComments)

  /**
   * 프롬프트를 클립보드에 담는다.
   *
   * 파일로 떨어뜨리지 않고 클립보드를 쓰는 이유: 어떤 AI 도구를 쓰든 붙여넣기는
   * 되고, 저장소에 파일을 만들면 그것이 다시 변경 목록에 떠서 리뷰를 방해한다.
   */
  /**
   * 프롬프트를 클립보드에 담는다. 담을 문장을 넘기면 그것을, 아니면 전체를 담는다.
   *
   * **클릭 핸들러 안에서 아무것도 기다리지 않는다.** 브라우저는 `await` 하나만
   * 지나도 사용자 제스처가 끝난 것으로 보고 클립보드 권한을 회수한다. 골라 보내기를
   * 만들면서 "선택한 것만 프롬프트를 받아 오고 나서 복사"로 짰다가, 복사가 조용히
   * 실패했다. 그래서 문장은 미리 받아 두고 여기서는 담기만 한다.
   */
  async function copyPrompt(text = null) {
    const payload = text ?? prompt.value
    if (!payload) return false
    try {
      await navigator.clipboard.writeText(payload)
      return true
    } catch {
      // 클립보드 권한이 없을 때의 대체 경로
      const area = document.createElement('textarea')
      area.value = payload
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }

  return {
    comments,
    prompt,
    error,
    openOnes,
    appliedOnes,
    forLine,
    countFor,
    load,
    add,
    edit,
    remove,
    removeMany,
    clear,
    copyPrompt,
  }
}
