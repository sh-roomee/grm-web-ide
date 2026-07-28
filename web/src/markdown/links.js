/**
 * 마크다운 안의 주소와 코드 펜스 언어를 이 도구의 세계로 옮긴다.
 *
 * 문서는 서로를 참조한다 — `docs/ROADMAP.md`가 `ARCHITECTURE.md#설계-결정`을 가리키는
 * 식이다. 미리보기에서 그 링크가 죽으면 문서를 읽다가 다시 ⌘P로 돌아가야 하고, 그게
 * 이 도구가 없애려던 번거로움이다.
 */

/** 펜스 언어 이름 → 강조 플러그인 id. 없는 이름은 plain으로 떨어진다. */
const FENCE_LANGUAGE = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  typescript: 'javascript',
  vue: 'vue',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  jsonc: 'json',
  java: 'java',
}

export function fenceLanguage(info) {
  return FENCE_LANGUAGE[String(info ?? '').toLowerCase()] ?? 'plain'
}

/**
 * 문서 안의 상대 경로를 저장소 기준 경로로 바꾼다.
 *
 * `docs/ROADMAP.md` 에서 `ARCHITECTURE.md` 는 `docs/ARCHITECTURE.md` 이고,
 * `../README.md` 는 `README.md` 다. `..` 가 저장소 밖으로 나가면 null — 서버가
 * 어차피 막지만 링크로 만들지 않는 편이 정직하다.
 */
export function resolveRelative(fromPath, href) {
  const target = String(href ?? '')
  if (!target || target.startsWith('#')) return null

  const base = String(fromPath ?? '')
    .split('/')
    .slice(0, -1)
  const parts = target.startsWith('/') ? [] : base
  const out = parts.slice()

  for (const seg of target.replace(/^\//, '').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null // 저장소 밖
      out.pop()
      continue
    }
    out.push(seg)
  }

  return out.length ? out.join('/') : null
}

/** 저장소 밖을 가리키는 주소인가. */
function isExternal(href) {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(href ?? '')) || String(href ?? '').startsWith('//')
}

/**
 * 링크를 어떻게 다룰지 정한다.
 *
 *   {kind:'anchor'}                 문서 안 이동. 지금은 그리기만 하고 이동은 안 한다
 *   {kind:'external', href}         새 브라우저 탭
 *   {kind:'file', path, hash}       이 도구에서 문서 탭으로 연다
 */
export function classifyLink(fromPath, href) {
  const raw = String(href ?? '')
  if (!raw) return null
  if (raw.startsWith('#')) return { kind: 'anchor', href: raw }
  if (isExternal(raw)) return { kind: 'external', href: raw }

  const [pathPart, hash] = splitHash(raw)
  const path = resolveRelative(fromPath, pathPart)
  if (!path) return null
  return { kind: 'file', path, hash: hash || null }
}

function splitHash(raw) {
  const at = raw.indexOf('#')
  return at < 0 ? [raw, ''] : [raw.slice(0, at), raw.slice(at + 1)]
}

/**
 * 이미지 주소를 결정한다.
 *
 * **저장소 안의 그림만 그린다.** 바깥 주소(`https://...`)는 불러오지 않고 링크로
 * 남긴다 — 문서를 열었다는 사실이 그 서버에 새어 나가고, 이 도구는 "git이 보는
 * 세계"에 머물기로 했다. 자리를 비우지는 않는다: alt와 주소를 보여 준다.
 */
export function classifyImage(fromPath, src) {
  const raw = String(src ?? '')
  if (!raw) return null
  if (isExternal(raw)) return { kind: 'external', href: raw }
  const path = resolveRelative(fromPath, splitHash(raw)[0])
  return path ? { kind: 'file', path } : null
}
