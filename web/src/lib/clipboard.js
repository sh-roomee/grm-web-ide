/**
 * 클립보드에 담는다.
 *
 * **호출하기 전에 아무것도 기다리지 말 것.** 브라우저는 `await` 하나만 지나도
 * 사용자 제스처가 끝난 것으로 보고 클립보드 권한을 회수한다. 담을 문장은 클릭
 * 전에 미리 만들어 두고, 핸들러에서는 이 함수만 부른다.
 *
 * 권한이 없을 때를 대비해 옛 `execCommand` 경로를 남긴다 — 담기지 않으면 이
 * 도구의 존재 이유(사람이 옮겨 적지 않게)가 사라진다.
 */
export async function copyToClipboard(text) {
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}
