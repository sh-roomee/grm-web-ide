import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'

import * as gitApi from './git.js'
import { parseUnifiedDiff } from './diff.js'
import { highlightInfo } from './language.js'
import { analyzeRisks, splitDiffFiles } from './risks.js'
import { previewInfo } from './preview.js'
import { attachStatus } from './resolve.js'
import { buildCycleSummary } from './cycle.js'
import {
  normalizeItem,
  itemKey,
  buildContextPrompt,
  MAX_GREP_HITS,
} from './context.js'
import {
  readState,
  saveReviewed,
  addComment,
  updateComment,
  removeComment,
  clearComments,
  buildPrompt,
  saveBaselineAt,
  addContext,
  removeContext,
  clearContext,
} from './state.js'
import { createWatcher } from './watcher.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIST = path.resolve(__dirname, '..', 'web', 'dist')

/**
 * 요청 경로가 저장소 안에 있는지 검증한다.
 *
 * `--no-index` diff와 파일 읽기는 git의 pathspec 보호를 받지 않으므로,
 * 로컬 서버라 해도 저장소 밖 파일이 노출되지 않도록 직접 막는다.
 */
function safeJoin(repo, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    const err = new Error('path 파라미터가 필요합니다')
    err.status = 400
    throw err
  }
  const abs = path.resolve(repo, relPath)
  const rel = path.relative(repo, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('저장소 밖의 경로는 접근할 수 없습니다')
    err.status = 403
    throw err
  }
  return abs
}

/**
 * 커밋 해시로 쓸 수 있는 값인지 확인한다.
 *
 * git은 `--`로 인자와 경로를 나누지만 리비전 자리에는 `HEAD~3`이나 `main..x`
 * 같은 표현이 다 들어간다. 여기서는 클라이언트가 목록에서 받은 해시만 되돌려
 * 보내면 되므로 16진수로 못박는다.
 */
function validSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{4,40}$/i.test(value) ? value : null
}

/** 미리보기로 내보낼 수 있는 최대 크기. 이보다 크면 브라우저에 밀어넣지 않는다. */
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024

/**
 * 미리보기가 읽을 git rev를 정한다.
 *
 * rev를 클라이언트가 직접 보내게 하지 않는 이유: 그러면 임의 리비전을 읽는
 * 엔드포인트가 된다. 대신 diff를 요청할 때와 **같은 파라미터**(sha·staged·compare)를
 * 받아 서버가 이전/이후를 해석한다. 화면에서 보고 있는 것과 어긋날 수 없다.
 *
 * null은 "워킹트리 파일", false는 "그 쪽은 없다"(추가/삭제된 파일)를 뜻한다.
 */
function previewRev({ side, sha, staged, compare, untracked, compareRef }) {
  if (side === 'after') {
    if (sha) return sha
    if (staged) return '' // `git show :path` = index
    return null
  }
  if (untracked && compare === COMPARE.head) return false // 새로 생긴 파일에는 이전이 없다
  if (sha) return `${sha}^`
  // 기준점·확인 시점을 볼 때는 그 트리가 이전 쪽이다. untracked 파일도 그 안에 있을 수
  // 있다 — AI가 만든 파일을 한 번 확인했다면 그 시점의 내용이 트리에 들어 있다.
  if (compare !== COMPARE.head && compareRef) return compareRef
  if (untracked) return false
  return 'HEAD'
}

/**
 * diff의 이전 쪽을 무엇으로 볼지.
 *
 *   head     — HEAD 대비 (기본). git이 원래 보여주는 것
 *   baseline — 사람이 잡아 둔 기준점 대비. 워킹트리 전체가 한 순간에 굳는다
 *   seen     — 이 파일을 확인한 시점 대비. 파일마다 시점이 다르다
 */
const COMPARE = { head: 'head', baseline: 'baseline', seen: 'seen' }

/** 비교 대상의 ref 이름. HEAD 대비면 null. */
function compareRefName(compare) {
  if (compare === COMPARE.baseline) return gitApi.baselineRef()
  if (compare === COMPARE.seen) return gitApi.seenRef()
  return null
}

/** 알 수 없는 값은 조용히 기본값으로 떨어뜨린다. 화면이 비는 것보다 낫다. */
function readCompare(query) {
  const raw = String(query.compare ?? '')
  if (COMPARE[raw]) return COMPARE[raw]
  // 옛 파라미터. 기준점 대비를 base=1 로 보내던 때가 있었다.
  if (query.base === '1' || query.base === 'true') return COMPARE.baseline
  return COMPARE.head
}

// 커밋 검색 대상. 이 목록에 없는 값은 message로 떨어진다.
const SEARCH_MODES = new Set(['message', 'author', 'content', 'path'])

function clamp(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function createServer({ repo, token, gitDir, dev = false }) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))
  app.disable('x-powered-by')

  const clients = new Set()

  // --- 인증: 로컬 바인딩이지만 같은 머신의 다른 프로세스/사이트가 붙는 것을 막는다.
  app.use('/api', (req, res, next) => {
    const provided = req.get('x-grmide-token') || req.query.t
    if (provided !== token) return res.status(401).json({ error: '토큰이 유효하지 않습니다' })
    next()
  })

  const wrap = (handler) => (req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      const status = err.status ?? 500
      if (status >= 500) console.error('[grmide]', err)
      res.status(status).json({ error: err.message })
    })
  }

  app.get(
    '/api/repo',
    wrap(async (_req, res) => {
      const [branch, head] = await Promise.all([gitApi.currentBranch(repo), gitApi.headCommit(repo)])
      res.json({ root: repo, name: path.basename(repo), branch, head })
    }),
  )

  app.get(
    '/api/status',
    wrap(async (_req, res) => {
      const [status, baseline, snapshots] = await Promise.all([
        gitApi.status(repo),
        gitApi.getBaseline(repo),
        // 확인 시점이 기록된 경로. 화면은 이걸로 "확인 이후" 비교를 걸 수 있는지 안다
        gitApi.seenPaths(repo).catch(() => new Set()),
      ])

      // 기준점이 없으면 비교 비용을 아예 치르지 않는다
      let fresh = null
      if (baseline) {
        try {
          fresh = await gitApi.changedSinceBaseline(repo, gitDir, baseline)
        } catch (err) {
          console.error('[grmide] 기준점 비교 실패:', err.message)
        }
      }

      // 기준점 이후 바뀐 파일에 표시를 남긴다
      let freshCount = 0
      if (fresh) {
        const counted = new Set()
        for (const list of [status.conflicted, status.staged, status.unstaged]) {
          for (const file of list) {
            file.fresh = fresh.has(file.path)
            if (file.fresh && !counted.has(file.path)) {
              counted.add(file.path)
              freshCount += 1
            }
          }
        }
      }

      // 확인 시점 스냅샷이 있는 파일. 없으면 "확인 이후" 비교가 파일 전체를 새로 추가된
      // 것처럼 보여주므로 화면이 그 선택지를 내놓지 않아야 한다.
      for (const list of [status.conflicted, status.staged, status.unstaged]) {
        for (const file of list) file.seen = snapshots.has(file.path)
      }

      res.json({ ...status, baseline: baseline ? { tree: baseline, freshCount } : null })
    }),
  )

  app.post(
    '/api/baseline',
    wrap(async (_req, res) => {
      const tree = await gitApi.setBaseline(repo, gitDir)
      // 사이클 요약이 "기준점 이후 몇 분"을 말하려면 시각이 필요하다
      await saveBaselineAt(gitDir, new Date().toISOString())
      res.json({ tree })
    }),
  )

  app.delete(
    '/api/baseline',
    wrap(async (_req, res) => {
      await gitApi.clearBaseline(repo)
      await saveBaselineAt(gitDir, null)
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/diff',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)
      const staged = req.query.staged === '1' || req.query.staged === 'true'
      const untracked = req.query.untracked === '1' || req.query.untracked === 'true'
      const context = Number.parseInt(req.query.context ?? '3', 10)
      const sha = validSha(req.query.sha)
      const wanted = readCompare(req.query)

      /**
       * 요청한 비교 대상으로 diff를 뜬다. 뜰 수 없으면 HEAD 대비로 떨어뜨리고
       * **무엇으로 떴는지 함께 돌려준다** — 화면이 고른 것과 실제가 어긋날 수 있어서다.
       *
       * '확인 이후'는 그 파일을 한 번이라도 확인했을 때만 뜻이 있다. 클라이언트가
       * 이미 걸러 주지만, 상태가 낡은 사이에 요청이 오면 파일 전체가 새로 추가된
       * 것처럼 보인다. 그건 사실이 아니라 답할 수 없는 질문이므로 여기서도 막는다.
       */
      async function diffFor() {
        if (sha) return { raw: await gitApi.commitFileDiff(repo, sha, relPath, { context }), compare: COMPARE.head }
        if (wanted === COMPARE.baseline) {
          return { raw: await gitApi.baselineFileDiff(repo, gitDir, relPath, { context }), compare: wanted }
        }
        if (wanted === COMPARE.seen) {
          const raw = await gitApi.seenFileDiff(repo, gitDir, relPath, { context })
          if (raw !== null) return { raw, compare: wanted }
        }
        return {
          raw: await gitApi.fileDiff(repo, relPath, { staged, untracked, context }),
          compare: COMPARE.head,
        }
      }

      const [diffResult, highlight] = await Promise.all([diffFor(), highlightInfo(repo, relPath)])
      const { raw } = diffResult
      const compare = diffResult.compare
      const parsed = parseUnifiedDiff(raw)

      // 그림으로 볼 수 있는 파일이면 양쪽 크기를 함께 준다. "이 이미지가 갑자기
      // 커졌나"는 diff 텍스트로는 절대 보이지 않는 정보다.
      const info = previewInfo(relPath)
      let preview = null
      // 크기는 이미지에만 뜻이 있다. 마크다운에 바이트 수를 보여줘도 판단에 쓰이지
      // 않으므로 blobSize 두 번을 아낀다.
      if (info && info.kind !== 'image') {
        preview = { ...info, before: null, after: null }
      } else if (info) {
        const compareRef = compareRefName(compare)
        const revs = {
          before: previewRev({ side: 'before', sha, staged, compare, untracked, compareRef }),
          after: previewRev({ side: 'after', sha, staged, compare, untracked, compareRef }),
        }
        const [before, after] = await Promise.all([
          revs.before === false ? null : gitApi.blobSize(repo, relPath, { rev: revs.before }),
          revs.after === false ? null : gitApi.blobSize(repo, relPath, { rev: revs.after }),
        ])
        preview = { ...info, before, after }
      }

      res.json({
        path: relPath,
        staged,
        untracked,
        sha: sha ?? null,
        compare,
        preview,
        ...highlight,
        ...parsed,
      })
    }),
  )

  app.get(
    '/api/log',
    wrap(async (req, res) => {
      const limit = clamp(Number.parseInt(req.query.limit ?? '100', 10), 1, 500, 100)
      const skip = clamp(Number.parseInt(req.query.skip ?? '0', 10), 0, 1e6, 0)
      const all = req.query.all !== '0' && req.query.all !== 'false'

      // 없는 ref거나 옵션처럼 생긴 값이면 무시하고 전체를 보여준다
      const ref = req.query.ref ? await gitApi.resolveRef(repo, req.query.ref) : null

      const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : ''
      const searchIn = SEARCH_MODES.has(req.query.in) ? req.query.in : 'message'

      res.json(await gitApi.commitLog(repo, { limit, skip, all, ref, query, searchIn }))
    }),
  )

  // 파일 목록은 자주 열리고(⌘P) 잘 안 바뀐다. 워킹트리가 바뀌면 버린다.
  let fileCache = null

  app.get(
    '/api/files',
    wrap(async (_req, res) => {
      if (!fileCache) fileCache = await gitApi.listFiles(repo)
      res.json({ files: fileCache })
    }),
  )

  app.get(
    '/api/file',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)
      const sha = validSha(req.query.sha)
      const [content, highlight] = await Promise.all([
        gitApi.fileContent(repo, relPath, { sha }),
        highlightInfo(repo, relPath),
      ])

      // 이미지를 ⌘P로 열면 "바이너리 파일입니다"가 아니라 그림을 본다
      const info = previewInfo(relPath)
      const preview = info
        ? { ...info, before: null, after: await gitApi.blobSize(repo, relPath, { rev: sha }) }
        : null

      res.json({ path: relPath, sha: sha ?? null, preview, ...highlight, ...content })
    }),
  )

  /**
   * 미리보기 원본 바이트 (이미지).
   *
   * `<img src>`로 불리므로 헤더를 붙일 수 없다 — 토큰은 쿼리(`?t=`)로 받는다.
   * Content-Type은 확장자 표에서 온 값만 쓰고 `nosniff`를 붙인다. svg는 문서에
   * 심지 않고 `<img>`로만 그리므로 안의 스크립트가 실행되지 않는다.
   */
  app.get(
    '/api/blob',
    wrap(async (req, res) => {
      const relPath = req.query.path
      safeJoin(repo, relPath)

      const info = previewInfo(relPath)
      if (!info) {
        return res.status(415).json({ error: '미리볼 수 없는 형식입니다' })
      }

      const side = req.query.side === 'before' ? 'before' : 'after'
      const sha = validSha(req.query.sha)
      const staged = req.query.staged === '1' || req.query.staged === 'true'
      const untracked = req.query.untracked === '1' || req.query.untracked === 'true'
      const compare = readCompare(req.query)
      const rev = previewRev({
        side,
        sha,
        staged,
        compare,
        untracked,
        compareRef: compareRefName(compare),
      })
      if (rev === false) return res.status(404).json({ error: '그 쪽에는 파일이 없습니다' })

      const blob = await gitApi.readBlob(repo, relPath, { rev, maxBytes: MAX_PREVIEW_BYTES })
      if (!blob) return res.status(404).json({ error: '내용을 찾을 수 없습니다' })
      if (blob.tooLarge) {
        return res.status(413).json({ error: '너무 커서 미리보기를 하지 않습니다', size: blob.size })
      }

      res.set('Content-Type', info.mime)
      res.set('X-Content-Type-Options', 'nosniff')
      res.set('Content-Disposition', 'inline')
      // 워킹트리는 계속 바뀌고, git 객체는 내용이 곧 이름이라 바뀌지 않는다
      res.set('Cache-Control', rev === null || rev === '' ? 'no-store' : 'max-age=31536000, immutable')
      res.send(blob.buffer)
    }),
  )

  /**
   * AI가 만든 변경에서 사람이 놓치기 쉬운 지점.
   *
   * 린터가 아니라 "여기 한 번 보라"는 표시다. 판정을 내리지 않고 개수와 예시만 준다.
   */
  app.get(
    '/api/risks',
    wrap(async (_req, res) => {
      const raw = await gitApi.worktreeDiff(repo, gitDir)
      res.json(analyzeRisks(splitDiffFiles(raw)))
    }),
  )

  /**
   * "확인함" 표시. 브라우저 localStorage에 두면 grmide가 다른 포트로 뜰 때
   * (4317이 사용 중일 때) 다른 origin이 되어 진행률이 초기화된다.
   */
  app.get(
    '/api/reviewed',
    wrap(async (_req, res) => {
      const state = await readState(gitDir)
      res.json({ marks: state.reviewed })
    }),
  )

  app.put(
    '/api/reviewed',
    wrap(async (req, res) => {
      /**
       * 확인 표시를 저장하면서 **그때의 내용**도 함께 굳힌다.
       *
       * 클라이언트는 표시 전체를 보내므로(부분 갱신이 아니다) 서버가 앞뒤를 비교해
       * "새로 확인된 것"을 찾는다. 표시를 풀 때는 스냅샷을 지우지 않는다 — 그 기록은
       * "마지막으로 확인했을 때 내용이 이랬다"는 사실이고, 표시를 껐다고 없던 일이
       * 되지는 않는다.
       *
       * 지문이 바뀌어 확인이 자동으로 풀린 경우(파일이 또 바뀐 경우)에도 키는 그대로
       * 남아 있어 여기서는 "새로 확인된 것"으로 보이지 않는다. 그게 맞다 — 사람이 다시
       * 누르기 전까지 기준은 예전 내용이어야 "확인 이후 무엇이 바뀌었나"가 나온다.
       */
      const before = (await readState(gitDir)).reviewed ?? {}
      const marks = await saveReviewed(gitDir, req.body?.marks)

      const added = Object.keys(marks).filter((key) => marks[key] !== before[key])
      // 키는 `work:<path>` / `staged:<path>` 다. 경로에 `:` 가 있을 수 있어 한 번만 자른다.
      const paths = added.map((key) => key.slice(key.indexOf(':') + 1)).filter(Boolean)
      if (paths.length) {
        try {
          await gitApi.markSeen(repo, gitDir, paths)
        } catch (err) {
          // 스냅샷을 못 남겨도 확인 표시 자체는 살린다. 진행률이 더 중요하다.
          console.error('[grmide] 확인 시점 기록 실패:', err.message)
        }
      }

      res.json({ marks })
    }),
  )

  /**
   * 코멘트가 달린 파일들을 경로당 한 번만 읽는다.
   *
   * 반영 판정에 필요한 것은 "지금 그 코드가 파일에 있나"뿐이라, 파일 하나를
   * 여러 코멘트가 함께 쓴다.
   */
  async function readCommentedFiles(comments) {
    const paths = [...new Set(comments.filter((c) => !c.sha).map((c) => c.path))]
    const files = new Map()
    await Promise.all(
      paths.map(async (relPath) => {
        try {
          const abs = safeJoin(repo, relPath)
          const [text, stat] = await Promise.all([
            fs.promises.readFile(abs, 'utf8'),
            fs.promises.stat(abs),
          ])
          files.set(relPath, { text, mtime: stat.mtimeMs })
        } catch {
          files.set(relPath, { text: null, mtime: null })
        }
      }),
    )
    return files
  }

  // --- 리뷰 코멘트: 사람의 판단을 AI에게 되돌리는 경로
  app.get(
    '/api/comments',
    wrap(async (req, res) => {
      const state = await readState(gitDir)
      const files = await readCommentedFiles(state.comments)
      const comments = attachStatus(state.comments, files)

      // ids를 주면 그것만으로 프롬프트를 만든다 — 보낼 것을 골라 보내는 화면용
      const wanted =
        typeof req.query.ids === 'string' && req.query.ids
          ? new Set(req.query.ids.split(',').filter(Boolean))
          : null
      const chosen = wanted ? state.comments.filter((c) => wanted.has(c.id)) : state.comments

      res.json({ comments, prompt: buildPrompt(chosen) })
    }),
  )

  app.post(
    '/api/comments',
    wrap(async (req, res) => {
      const { path: relPath, line, endLine, side, code, text, sha } = req.body ?? {}
      safeJoin(repo, relPath)
      if (typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('코멘트 내용이 비어 있습니다'), { status: 400 })
      }
      const comment = await addComment(gitDir, {
        path: relPath,
        line,
        endLine,
        side,
        code,
        text: text.trim(),
        sha: validSha(sha),
      })
      res.json({ comment })
    }),
  )

  app.patch(
    '/api/comments',
    wrap(async (req, res) => {
      const { id, text } = req.body ?? {}
      if (!id || typeof text !== 'string' || !text.trim()) {
        throw Object.assign(new Error('id와 내용이 필요합니다'), { status: 400 })
      }
      const updated = await updateComment(gitDir, id, text.trim())
      if (!updated) throw Object.assign(new Error('코멘트를 찾을 수 없습니다'), { status: 404 })
      res.json({ comment: updated })
    }),
  )

  app.delete(
    '/api/comments',
    wrap(async (req, res) => {
      if (req.query.all === '1') {
        await clearComments(gitDir)
        return res.json({ ok: true })
      }
      // 반영된 것 정리 — 한 번에 여러 개를 지운다
      if (typeof req.query.ids === 'string' && req.query.ids) {
        const ids = req.query.ids.split(',').filter(Boolean)
        let count = 0
        for (const id of ids) if (await removeComment(gitDir, id)) count += 1
        return res.json({ ok: true, removed: count })
      }
      const removed = await removeComment(gitDir, req.query.id)
      if (!removed) throw Object.assign(new Error('코멘트를 찾을 수 없습니다'), { status: 404 })
      res.json({ ok: true })
    }),
  )

  /**
   * 사이클 요약 — 다음 지시를 쓸 때 사람이 다시 훑지 않아도 되게.
   *
   * 요약을 지어내지 않는다. 코드가 무엇을 하는지는 터미널의 AI가 이미 안다.
   * 여기서 모으는 것은 AI가 알 수 없는 것들이다 — 사람이 무엇을 확인했는지,
   * 무엇이 남았는지, 어떤 코멘트가 아직 반영되지 않았는지.
   */
  app.get(
    '/api/summary',
    wrap(async (_req, res) => {
      const [status, state, rawDiff] = await Promise.all([
        gitApi.status(repo),
        readState(gitDir),
        gitApi.worktreeDiff(repo, gitDir),
      ])
      const riskResult = analyzeRisks(splitDiffFiles(rawDiff))

      // 확인 표시는 클라이언트와 같은 규칙으로 읽는다 (지문이 다르면 풀린 것이다)
      const markKey = (file) => `${file.staged ? 'staged' : 'work'}:${file.path}`
      const fingerprint = (file) =>
        `${file.status}:${file.additions ?? '-'}:${file.deletions ?? '-'}`

      const files = [...status.conflicted, ...status.staged, ...status.unstaged].map((file) => ({
        ...file,
        reviewed: state.reviewed[markKey(file)] === fingerprint(file),
      }))

      const commentFiles = await readCommentedFiles(state.comments)
      const comments = attachStatus(state.comments, commentFiles)

      res.json({
        summary: buildCycleSummary({
          files,
          risks: riskResult.files ?? {},
          comments,
          baselineAt: state.baselineAt ?? null,
          now: Date.now(),
        }),
      })
    }),
  )

  /**
   * 컨텍스트 바구니 — "이것도 같이 봐"를 모아 두는 곳.
   *
   * 내용은 **넘길 때** 읽는다. 담을 때 얼려 두면 AI가 고친 뒤에는 프롬프트가
   * 사실과 달라진다. 바구니는 "무엇을 볼지"만 들고 있다.
   */
  async function contextSources(items) {
    const sources = new Map()
    await Promise.all(
      items.map(async (item) => {
        const key = itemKey(item)
        if (item.kind === 'grep') {
          const result = await gitApi.grep(repo, item.query, { limit: MAX_GREP_HITS * 4 })
          sources.set(key, { hits: result.hits, total: result.hits.length })
          return
        }
        try {
          const abs = safeJoin(repo, item.path)
          const text = await fs.promises.readFile(abs, 'utf8')
          const all = text.split('\n')
          if (all.length && all[all.length - 1] === '') all.pop()
          const lines =
            item.kind === 'range'
              ? all
                  .slice(item.line - 1, item.endLine)
                  // 구간은 줄 번호를 붙여 준다 — AI가 어디를 말하는지 알아야 한다
                  .map((line, i) => `${item.line + i}: ${line}`)
              : all
          sources.set(key, { lines })
        } catch {
          sources.set(key, { missing: true })
        }
      }),
    )
    return sources
  }

  app.get(
    '/api/context',
    wrap(async (_req, res) => {
      const state = await readState(gitDir)
      const sources = await contextSources(state.context)
      res.json({ items: state.context, prompt: buildContextPrompt(state.context, sources) })
    }),
  )

  app.post(
    '/api/context',
    wrap(async (req, res) => {
      const item = normalizeItem(req.body)
      if (!item) throw Object.assign(new Error('담을 수 없는 항목입니다'), { status: 400 })
      if (item.path) safeJoin(repo, item.path)
      const result = await addContext(gitDir, item, itemKey(item))
      res.json(result)
    }),
  )

  app.delete(
    '/api/context',
    wrap(async (req, res) => {
      if (req.query.all === '1') {
        await clearContext(gitDir)
        return res.json({ ok: true })
      }
      const removed = await removeContext(gitDir, req.query.id)
      if (!removed) throw Object.assign(new Error('항목을 찾을 수 없습니다'), { status: 404 })
      res.json({ ok: true })
    }),
  )

  app.get(
    '/api/grep',
    wrap(async (req, res) => {
      const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : ''
      const limit = clamp(Number.parseInt(req.query.limit ?? '400', 10), 1, 2000, 400)
      res.json({ query, ...(await gitApi.grep(repo, query, { limit })) })
    }),
  )

  app.get(
    '/api/refs',
    wrap(async (_req, res) => {
      res.json({ refs: await gitApi.refList(repo) })
    }),
  )

  app.get(
    '/api/commit',
    wrap(async (req, res) => {
      const sha = validSha(req.query.sha)
      if (!sha) {
        throw Object.assign(new Error('sha 파라미터가 필요합니다'), { status: 400 })
      }
      res.json(await gitApi.commitDetail(repo, sha))
    }),
  )

  app.post(
    '/api/stage',
    wrap(async (req, res) => {
      safeJoin(repo, req.body?.path)
      await gitApi.stageFile(repo, req.body.path)
      res.json({ ok: true })
    }),
  )

  app.post(
    '/api/unstage',
    wrap(async (req, res) => {
      safeJoin(repo, req.body?.path)
      await gitApi.unstageFile(repo, req.body.path)
      res.json({ ok: true })
    }),
  )

  // --- 원격: fetch와 fast-forward pull만. 실패(네트워크·fast-forward 불가)는
  // 서버 잘못이 아니라 저장소 상태라서 4xx로 내린다 — 500이면 콘솔에 스택이 쌓인다.
  app.post(
    '/api/fetch',
    wrap(async (_req, res) => {
      try {
        res.json(await gitApi.fetchRemote(repo))
      } catch (err) {
        err.status ??= 409
        throw err
      }
    }),
  )

  app.post(
    '/api/pull',
    wrap(async (_req, res) => {
      try {
        res.json(await gitApi.pullFastForward(repo))
      } catch (err) {
        err.status ??= 409
        throw err
      }
    }),
  )

  // --- 실시간 갱신: AI가 파일을 쓰는 동안 브라우저가 스스로 따라온다.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    // 재접속 간격. 너무 짧으면(1초) grmide를 끈 뒤에도 브라우저가 계속
    // 재접속을 시도하면서 페이지가 먹통이 된다.
    res.write('retry: 3000\n\n')
    clients.add(res)

    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000)
    req.on('close', () => {
      clearInterval(keepAlive)
      clients.delete(res)
    })
  })

  function broadcast(event, data = {}) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) client.write(payload)
  }

  const watcher = createWatcher(repo, () => {
    fileCache = null
    broadcast('changed')
  })

  // --- 정적 파일: dev 모드에서는 vite dev server가 프론트를 서빙한다.
  if (!dev) {
    if (!fs.existsSync(WEB_DIST)) {
      console.warn(`[grmide] 빌드 결과물이 없습니다: ${WEB_DIST}\n            npm run build 를 먼저 실행하세요.`)
    }
    app.use(express.static(WEB_DIST, { index: false }))
    app.get('*', (_req, res) => {
      const indexHtml = path.join(WEB_DIST, 'index.html')
      if (!fs.existsSync(indexHtml)) {
        return res.status(503).send('빌드 결과물이 없습니다. npm run build 를 실행하세요.')
      }
      res.sendFile(indexHtml)
    })
  }

  /**
   * SSE 연결을 먼저 끊어야 한다. 열린 채로 두면 `server.close()`가 그 연결이
   * 끝나기를 기다리므로, 브라우저 탭이 열려 있는 동안 Ctrl-C로 종료되지 않는다.
   */
  async function close() {
    for (const client of clients) client.end()
    clients.clear()
    await watcher.close()
  }

  return { app, close }
}
