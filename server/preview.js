/**
 * 어떤 파일을 그림으로 보여줄 수 있는지 판단한다.
 *
 * 확장자만 본다. 내용을 스니핑하면 "이 바이트열이 정말 png인가"를 판정하는 일이
 * 되고, 그걸 틀리면 브라우저에 잘못된 Content-Type을 내보내게 된다. git이 아는
 * 파일만 다루는 도구라 확장자 신뢰의 위험도 낮다.
 *
 * 판단 결과는 그대로 응답의 Content-Type이 되므로, 표에 없는 확장자는 미리보기를
 * 하지 않는다 — 임의 파일을 임의 타입으로 브라우저에 흘리지 않기 위해서다.
 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // svg는 텍스트라 diff도 되지만, 눈으로 봐야 판단이 되는 파일이라 함께 다룬다.
  // <img>로만 그린다 — 문서에 직접 심으면 svg 안의 스크립트가 실행된다.
  '.svg': 'image/svg+xml',
}

/** 확장자를 소문자로 뽑는다. 확장자가 없으면 빈 문자열. */
function extname(relPath) {
  const name = String(relPath ?? '')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const dot = name.lastIndexOf('.')
  if (dot <= slash + 1) return '' // 확장자 없음, 또는 `.gitignore` 같은 점파일
  return name.slice(dot).toLowerCase()
}

/**
 * 미리보기 정보. 미리볼 수 없으면 null.
 * @returns {{ kind: 'image', mime: string } | null}
 */
export function previewInfo(relPath) {
  const mime = IMAGE_MIME[extname(relPath)]
  return mime ? { kind: 'image', mime } : null
}

/** 사람이 읽는 크기. 리뷰에서 "이 이미지가 갑자기 커졌나"를 보려고 쓴다. */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}
