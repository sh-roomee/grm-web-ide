import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 파일이 어떤 언어인지, .vue처럼 한 파일에 여러 언어가 섞여 있으면
 * 줄 번호별로 어떤 언어인지를 알려준다.
 *
 * 강조 자체는 클라이언트 플러그인이 하고, 서버는 "무엇으로 칠할지"만 정한다.
 * 이 판단에 파일 전체 내용이 필요해서(SFC 블록 경계) 서버에 둔다.
 */

const EXT_LANGUAGE = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.vue': 'vue',
  '.html': 'markup',
  '.htm': 'markup',
  '.xml': 'markup',
  '.svg': 'markup',
  '.css': 'css',
  '.scss': 'css',
  '.sass': 'css',
  '.less': 'css',
  '.json': 'json',
  '.jsonc': 'json',
  '.java': 'java',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.toml': 'properties',
  '.ini': 'properties',
  '.cfg': 'properties',
  '.conf': 'properties',
  '.properties': 'properties',
  '.env': 'properties',
}

/**
 * 확장자가 없는 파일들 — 이름 자체가 형식이다.
 * `.prettierrc`류는 내용이 JSON이고, Jenkinsfile은 Groovy(java로 근사)다.
 */
const NAME_LANGUAGE = {
  '.gitignore': 'ignore',
  '.gitattributes': 'ignore',
  '.npmignore': 'ignore',
  '.dockerignore': 'ignore',
  '.prettierignore': 'ignore',
  '.eslintignore': 'ignore',
  '.prettierrc': 'json',
  '.babelrc': 'json',
  '.eslintrc': 'json',
  '.npmrc': 'properties',
  '.editorconfig': 'properties',
  jenkinsfile: 'groovy',
  dockerfile: 'docker',
  makefile: 'shell', // 레시피 줄이 셸이다 — 근사
}

export function detectLanguage(filePath) {
  const name = path.basename(filePath).toLowerCase()
  if (NAME_LANGUAGE[name]) return NAME_LANGUAGE[name]
  if (name.startsWith('.env')) return 'properties' // .env.production 류
  return EXT_LANGUAGE[path.extname(filePath).toLowerCase()] ?? 'plain'
}

const BLOCK_LANGUAGE = {
  template: 'markup',
  script: 'javascript',
  style: 'css',
  i18n: 'json',
  docs: 'plain',
}

/**
 * Vue SFC의 최상위 블록 경계를 찾아 `[{ start, end, lang }]`로 만든다.
 * 줄 번호는 1부터, end는 포함이다.
 *
 * SFC 최상위 블록은 관례상 1열에서 시작하므로 열 위치로 판별한다. 이러면
 * 템플릿 안에 들어 있는 `<style>` 같은 문자열에 속지 않는다.
 */
export function sfcSections(content) {
  const lines = content.split('\n')
  const sections = []
  let open = null

  lines.forEach((line, index) => {
    const lineNo = index + 1
    if (open) {
      if (new RegExp(`^</${open.name}\\s*>`).test(line)) {
        sections.push({ start: open.start, end: lineNo, lang: open.lang })
        open = null
      }
      return
    }
    const m = /^<([a-zA-Z][\w-]*)(\s[^>]*)?>?\s*$/.exec(line)
    if (!m) return
    const name = m[1].toLowerCase()
    const lang = blockLanguage(name, m[2] ?? '')
    if (!lang) return
    open = { name, start: lineNo, lang }
  })

  // 닫는 태그 없이 파일이 끝난 경우(작성 중인 파일)도 구간으로 인정한다
  if (open) sections.push({ start: open.start, end: lines.length, lang: open.lang })
  return sections
}

/** `<script lang="ts">`, `<style lang="scss">` 처럼 lang 속성이 있으면 그쪽을 따른다. */
function blockLanguage(name, attrs) {
  const base = BLOCK_LANGUAGE[name]
  if (!base) return null
  const lang = /\blang\s*=\s*["']([\w-]+)["']/.exec(attrs)?.[1]?.toLowerCase()
  if (!lang) return base
  return EXT_LANGUAGE[`.${lang}`] ?? base
}

/**
 * diff 응답에 실을 강조 정보를 만든다.
 *
 * 구획 판단에는 워킹트리의 현재 내용을 쓴다. 좌우 줄 번호가 어긋나는 만큼
 * 경계 부근에서 틀릴 수 있지만, 블록 경계 몇 줄 차이라 실사용에 문제가 없고
 * 양쪽 버전을 따로 읽는 비용을 아낄 수 있다.
 */
export async function highlightInfo(repo, relPath) {
  const language = detectLanguage(relPath)
  if (language !== 'vue') return { language, sections: null }

  try {
    const content = await fs.readFile(path.resolve(repo, relPath), 'utf8')
    return { language, sections: sfcSections(content) }
  } catch {
    // 삭제된 파일 등 워킹트리에 없는 경우: 구획 없이 보낸다.
    // 클라이언트는 vue를 markup으로 취급한다.
    return { language, sections: null }
  }
}
