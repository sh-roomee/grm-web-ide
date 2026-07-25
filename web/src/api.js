/**
 * 서버 통신 계층.
 *
 * 토큰은 gitshow가 열어준 URL의 ?t= 로 전달된다. 주소창에 토큰이 남아 있으면
 * 복사/공유 사고가 나므로 즉시 sessionStorage로 옮기고 URL에서 지운다.
 */

const TOKEN_KEY = 'gitshow:token'

function readToken() {
  const url = new URL(window.location.href)
  const fromUrl = url.searchParams.get('t')
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl)
    url.searchParams.delete('t')
    window.history.replaceState({}, '', url.pathname + url.search + url.hash)
    return fromUrl
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? ''
}

export const token = readToken()

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-gitshow-token': token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `요청 실패 (${res.status})`)
  }
  return res.json()
}

export const fetchRepo = () => request('/api/repo')
export const fetchStatus = () => request('/api/status')

export function fetchDiff(file, { context = 3 } = {}) {
  const params = new URLSearchParams({ path: file.path, context: String(context) })
  if (file.staged) params.set('staged', '1')
  if (file.untracked) params.set('untracked', '1')
  return request(`/api/diff?${params}`)
}

export const stageFile = (path) =>
  request('/api/stage', { method: 'POST', body: JSON.stringify({ path }) })

export const unstageFile = (path) =>
  request('/api/unstage', { method: 'POST', body: JSON.stringify({ path }) })

const MAX_RECONNECT_ATTEMPTS = 5

/**
 * 워킹트리 변경 알림 스트림. EventSource는 헤더를 못 붙여 토큰을 쿼리로 넘긴다.
 *
 * 재접속을 EventSource의 자동 재접속에 맡기지 않고 직접 돌린다. gitshow를 끈
 * 뒤(포트가 닫힌 뒤) 브라우저가 재접속을 반복하면서 페이지가 먹통이 되는 것을
 * 실제로 겪었다. 그래서 error가 나면 즉시 닫고, 우리가 정한 간격으로 몇 번만
 * 다시 시도하고 포기한다. 그 뒤에는 사용자가 직접 `reconnect()`를 호출한다.
 *
 * `onConnection`으로 접속 상태를 알린다. gitshow를 끈 뒤에도 화면에는 옛 내용이
 * 남아 있어서, 끊긴 사실을 알려주지 않으면 지금 상태로 착각한다.
 */
export function subscribeChanges({ onChange, onConnection }) {
  let source = null
  let timer = null
  let attempts = 0
  let closed = false

  function cleanup() {
    if (timer) clearTimeout(timer)
    timer = null
    source?.close()
    source = null
  }

  function connect() {
    cleanup()
    if (closed) return
    source = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
    source.addEventListener('changed', onChange)
    source.addEventListener('open', () => {
      attempts = 0
      onConnection?.({ connected: true, retrying: false })
    })
    source.addEventListener('error', () => {
      cleanup()
      if (closed) return
      attempts += 1
      const retrying = attempts <= MAX_RECONNECT_ATTEMPTS
      onConnection?.({ connected: false, retrying })
      // 1초 → 2 → 4 → 8 → 16초. 그 뒤에는 사용자가 누를 때까지 멈춘다.
      if (retrying) timer = setTimeout(connect, 1000 * 2 ** (attempts - 1))
    })
  }

  connect()

  return {
    close: () => {
      closed = true
      cleanup()
    },
    reconnect: () => {
      closed = false
      attempts = 0
      connect()
    },
  }
}
