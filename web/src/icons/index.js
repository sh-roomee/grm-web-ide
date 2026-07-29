/**
 * 파일 아이콘 레지스트리 — IntelliJ·VSCode의 아이콘 테마가 하던 일.
 *
 * 목록·트리·탭에서 파일을 훑을 때 사람은 이름을 읽기 전에 색과 모양으로
 * 거른다. 그래서 종류마다 다른 아이콘이 붙어 있으면 스캔 속도가 다르다.
 *
 * 그림 파일을 받지 않는다. 아이콘은 1–3글자 약어 + 색(tone)이고, tone은
 * style.css의 `--icon-*` 변수와 짝이 되는 이름이다. 그리는 쪽은
 * `components/FileIcon.vue` 한 곳이다.
 *
 * 종류를 추가하려면 아래 표에 한 줄 넣거나, 플러그인처럼 밖에서
 * `registerName` / `registerExt`를 부르면 된다.
 */

/** 정확한 파일명(소문자) → 아이콘. 확장자보다 먼저 본다. */
const NAMES = new Map()

/** 확장자(소문자, 점 없이) → 아이콘 */
const EXTS = new Map()

export function registerName(name, icon) {
  NAMES.set(name, icon)
}

export function registerExt(ext, icon) {
  EXTS.set(ext, icon)
}

const icon = (label, tone) => ({ label, tone })

// --- 파일명으로 정해지는 것들
for (const [names, def] of [
  [['package.json'], icon('npm', 'red')],
  [['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'], icon('LK', 'gray')],
  [['.gitignore', '.gitattributes', '.gitmodules'], icon('git', 'orange')],
  [['dockerfile', 'docker-compose.yml', 'docker-compose.yaml'], icon('DK', 'blue')],
  [['makefile'], icon('MK', 'gray')],
  [['license', 'license.md', 'license.txt', 'copying'], icon('§', 'gray')],
]) {
  for (const name of names) registerName(name, def)
}

// --- 확장자로 정해지는 것들
for (const [exts, def] of [
  [['js', 'mjs', 'cjs'], icon('JS', 'yellow')],
  [['jsx'], icon('JSX', 'yellow')],
  [['ts', 'mts', 'cts'], icon('TS', 'blue')],
  [['tsx'], icon('TSX', 'blue')],
  [['vue'], icon('V', 'green')],
  [['svelte'], icon('S', 'orange')],
  [['html', 'htm'], icon('<>', 'orange')],
  [['xml'], icon('<>', 'gray')],
  [['css'], icon('CSS', 'indigo')],
  [['scss', 'sass'], icon('S', 'pink')],
  [['less'], icon('L', 'indigo')],
  [['json', 'jsonc', 'json5'], icon('{}', 'yellow')],
  [['md', 'markdown'], icon('MD', 'blue')],
  [['yml', 'yaml'], icon('Y', 'purple')],
  [['toml', 'ini', 'cfg', 'conf'], icon('CFG', 'gray')],
  [['sh', 'bash', 'zsh', 'fish'], icon('$', 'green')],
  [['py'], icon('PY', 'mint')],
  [['rb'], icon('RB', 'red')],
  [['go'], icon('GO', 'teal')],
  [['rs'], icon('RS', 'orange')],
  [['java'], icon('J', 'orange')],
  [['kt', 'kts'], icon('K', 'purple')],
  [['c'], icon('C', 'blue')],
  [['h'], icon('H', 'purple')],
  [['cpp', 'cc', 'cxx'], icon('C+', 'blue')],
  [['hpp', 'hh'], icon('H+', 'purple')],
  [['cs'], icon('C#', 'green')],
  [['swift'], icon('SW', 'orange')],
  [['php'], icon('PHP', 'indigo')],
  [['sql'], icon('SQL', 'teal')],
  [['graphql', 'gql'], icon('GQL', 'pink')],
  [['svg'], icon('SVG', 'orange')],
  [['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'heic'], icon('IMG', 'purple')],
  [['mp4', 'mov', 'webm', 'm4v'], icon('VID', 'pink')],
  [['mp3', 'wav', 'm4a', 'flac'], icon('AUD', 'pink')],
  [['pdf'], icon('PDF', 'red')],
  [['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar'], icon('ZIP', 'brown')],
  [['ttf', 'otf', 'woff', 'woff2', 'eot'], icon('Aa', 'gray')],
  [['csv', 'tsv'], icon('CSV', 'green')],
  [['txt', 'log'], icon('TXT', 'gray')],
  [['lock'], icon('LK', 'gray')],
]) {
  for (const ext of exts) registerExt(ext, def)
}

const FALLBACK = icon('·', 'gray')

/**
 * 경로 → 아이콘.
 *
 * 파일명 → 테스트 파일 → 확장자 순서로 본다. 테스트 파일(*.test.* / *.spec.*)은
 * 언어 약어를 그대로 두고 색만 초록으로 바꾼다 — IDE들이 테스트를 초록으로
 * 표시하는 관례를 따른다.
 */
export function iconFor(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()

  const byName = NAMES.get(name)
  if (byName) return byName

  if (name.startsWith('.env')) return icon('ENV', 'yellow')

  const at = name.lastIndexOf('.')
  const ext = at > 0 ? name.slice(at + 1) : '' // at > 0: `.gitignore`류의 앞 점은 확장자가 아니다
  const base = EXTS.get(ext)

  if (/\.(test|spec)\.[^.]+$/.test(name)) return icon(base?.label ?? 'T', 'green')
  if (base) return base

  // 모르는 확장자는 약어만 만들어 회색으로 — 아예 빈 것보다 스캔에 낫다
  if (ext) return icon(ext.slice(0, 3).toUpperCase(), 'gray')
  return FALLBACK
}
