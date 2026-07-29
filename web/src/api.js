/**
 * 서버 통신 계층.
 *
 * 토큰은 grmide가 열어준 URL의 ?t= 로 전달된다. 주소창에 토큰이 남아 있으면
 * 복사/공유 사고가 나므로 즉시 sessionStorage로 옮기고 URL에서 지운다.
 */

const TOKEN_KEY = 'grmide:token'

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
      'x-grmide-token': token,
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

/** AI 변경에서 사람이 놓치기 쉬운 지점 */
export const fetchRisks = () => request('/api/risks')

/**
 * 미리보기 이미지 주소.
 *
 * `<img src>`는 헤더를 붙일 수 없어 토큰을 쿼리로 보낸다. 어느 쪽(이전/이후)을
 * 읽을지는 diff를 요청할 때와 같은 파라미터를 그대로 넘겨 서버가 정한다 —
 * 화면에서 보고 있는 것과 어긋날 수 없다.
 */
export function blobUrl(file, side, { sha = null, compare = 'head' } = {}) {
  const params = new URLSearchParams({ path: file.path, side })
  if (sha) params.set('sha', sha)
  else if (compare !== 'head') {
    params.set('compare', compare)
    // 확인 시점·기준점 트리에는 untracked 파일도 들어 있다. 그쪽을 읽어야 한다.
    if (file.untracked) params.set('untracked', '1')
  } else {
    if (file.staged) params.set('staged', '1')
    if (file.untracked) params.set('untracked', '1')
  }
  if (token) params.set('t', token)
  return `/api/blob?${params}`
}

/**
 * 미리보기용 파일 내용을 글자로 받는다 (마크다운 렌더링).
 *
 * 이미지와 같은 `/api/blob`을 쓴다 — 어느 버전을 볼지(staged·커밋·기준점·확인 시점) 정하는
 * 규칙이 한 곳에만 있어야 화면과 어긋나지 않는다. diff 행을 이어붙이지 않는 이유는
 * "변경 부분"만 받아 온 상태에서는 문서 절반이 비기 때문이다.
 */
export async function fetchBlobText(file, side, opts = {}) {
  const res = await fetch(blobUrl(file, side, opts), { headers: { 'x-grmide-token': token } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `내용을 받지 못했습니다 (${res.status})`)
  }
  return res.text()
}

/**
 * @param file {path, staged?, untracked?}
 * @param opts.sha 커밋 해시. 주면 워킹트리가 아니라 그 커밋 안의 변경을 본다.
 */
export function fetchDiff(file, { context = 3, sha = null, compare = 'head', against = null } = {}) {
  const params = new URLSearchParams({ path: file.path, context: String(context) })
  if (against) params.set('against', against)
  else if (sha) params.set('sha', sha)
  else if (compare !== 'head') params.set('compare', compare)
  else {
    if (file.staged) params.set('staged', '1')
    if (file.untracked) params.set('untracked', '1')
  }
  return request(`/api/diff?${params}`)
}

/** 브랜치 비교 (base...HEAD). base를 안 주면 서버가 기본 브랜치를 찾는다. */
export const fetchCompare = (base = null) =>
  request(`/api/compare${base ? `?base=${encodeURIComponent(base)}` : ''}`)

// 기준점 — "여기까지 봤다"
export const setBaseline = () => request('/api/baseline', { method: 'POST', body: '{}' })
export const clearBaseline = () => request('/api/baseline', { method: 'DELETE' })

// "확인함" 표시 — 서버에 둔다 (포트가 바뀌면 localStorage는 잃는다)
export const fetchReviewed = () => request('/api/reviewed')
export const saveReviewed = (marks) =>
  request('/api/reviewed', { method: 'PUT', body: JSON.stringify({ marks }) })

// 리뷰 코멘트 — 사람의 판단을 AI에게 되돌리는 경로
/** ids를 주면 그 코멘트들만으로 프롬프트를 만들어 온다 (골라 보내기). */
export const fetchComments = (ids = null) =>
  request(ids?.length ? `/api/comments?ids=${ids.map(encodeURIComponent).join(',')}` : '/api/comments')

export const addComment = (comment) =>
  request('/api/comments', { method: 'POST', body: JSON.stringify(comment) })

export const editComment = (id, text) =>
  request('/api/comments', { method: 'PATCH', body: JSON.stringify({ id, text }) })

export const deleteComment = (id) =>
  request(`/api/comments?id=${encodeURIComponent(id)}`, { method: 'DELETE' })

/** 여러 개를 한 번에 — "반영된 것 정리"용 */
export const deleteComments = (ids) =>
  request(`/api/comments?ids=${ids.map(encodeURIComponent).join(',')}`, { method: 'DELETE' })

export const clearComments = () => request('/api/comments?all=1', { method: 'DELETE' })

/** 사이클 요약 — 기준점 이후 무엇이 있었나 */
export const fetchSummary = () => request('/api/summary')

// --- 컨텍스트 바구니: "이것도 같이 봐"를 모아 두는 곳
export const fetchContext = () => request('/api/context')

export const addContext = (item) =>
  request('/api/context', { method: 'POST', body: JSON.stringify(item) })

export const deleteContext = (id) =>
  request(`/api/context?id=${encodeURIComponent(id)}`, { method: 'DELETE' })

export const clearContext = () => request('/api/context?all=1', { method: 'DELETE' })

export function fetchLog({ limit = 100, skip = 0, ref = null, q = '', in: searchIn = 'message' } = {}) {
  const params = new URLSearchParams({ limit: String(limit), skip: String(skip) })
  if (ref) params.set('ref', ref)
  if (q) {
    params.set('q', q)
    params.set('in', searchIn)
  }
  return request(`/api/log?${params}`)
}

export const fetchRefs = () => request('/api/refs')

// ⌘P / ⌘⇧F 용
export const fetchFiles = () => request('/api/files')
export const fetchGrep = (q, { limit = 400 } = {}) =>
  request(`/api/grep?q=${encodeURIComponent(q)}&limit=${limit}`)

/** 파일 하나를 읽는다(읽기 전용). sha를 주면 그 시점의 내용. */
export function fetchFile(path, { sha = null } = {}) {
  const params = new URLSearchParams({ path })
  if (sha) params.set('sha', sha)
  return request(`/api/file?${params}`)
}

export const fetchCommit = (sha) => request(`/api/commit?sha=${encodeURIComponent(sha)}`)

export const stageFile = (path) =>
  request('/api/stage', { method: 'POST', body: JSON.stringify({ path }) })

export const unstageFile = (path) =>
  request('/api/unstage', { method: 'POST', body: JSON.stringify({ path }) })

// 원격 — 최소한만: fetch와 fast-forward pull. push·rebase는 넣지 않는다
export const gitFetch = () => request('/api/fetch', { method: 'POST' })
export const gitPull = () => request('/api/pull', { method: 'POST' })

const MAX_RECONNECT_ATTEMPTS = 5

/**
 * 워킹트리 변경 알림 스트림. EventSource는 헤더를 못 붙여 토큰을 쿼리로 넘긴다.
 *
 * 재접속을 EventSource의 자동 재접속에 맡기지 않고 직접 돌린다. grmide를 끈
 * 뒤(포트가 닫힌 뒤) 브라우저가 재접속을 반복하면서 페이지가 먹통이 되는 것을
 * 실제로 겪었다. 그래서 error가 나면 즉시 닫고, 우리가 정한 간격으로 몇 번만
 * 다시 시도하고 포기한다. 그 뒤에는 사용자가 직접 `reconnect()`를 호출한다.
 *
 * `onConnection`으로 접속 상태를 알린다. grmide를 끈 뒤에도 화면에는 옛 내용이
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
