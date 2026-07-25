#!/usr/bin/env node
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import process from 'node:process'

import { createServer } from '../server/index.js'
import { resolveRepoRoot } from '../server/git.js'

const DEFAULT_PORT = 4317
const PORT_TRIES = 20
const HOST = '127.0.0.1' // 로컬 전용. 저장소 내용을 노출하므로 외부 바인딩은 지원하지 않는다.

const HELP = `gitshow - 현재 디렉토리의 git 변경사항을 브라우저에서 본다

사용법:
  gitshow [경로] [옵션]

옵션:
  -p, --port <번호>   시작 포트 (기본 ${DEFAULT_PORT}, 사용 중이면 다음 포트로)
      --no-open       브라우저를 자동으로 열지 않는다
  -h, --help          이 도움말
`

function parseArgs(argv) {
  const opts = { dir: process.cwd(), port: DEFAULT_PORT, open: true }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') opts.help = true
    else if (arg === '--no-open') opts.open = false
    else if (arg === '-p' || arg === '--port') opts.port = Number.parseInt(argv[++i], 10)
    else if (arg.startsWith('-')) {
      console.error(`알 수 없는 옵션: ${arg}`)
      process.exit(1)
    } else opts.dir = arg
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    console.error('포트 번호가 올바르지 않습니다')
    process.exit(1)
  }
  return opts
}

/** 포트가 이미 쓰이고 있으면 다음 번호로 넘어간다. */
function listen(app, port, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST)
    server.once('listening', () => resolve(server))
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
        listen(app, port + 1, attemptsLeft - 1).then(resolve, reject)
      } else reject(err)
    })
  })
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]]
  execFile(cmd[0], cmd[1], (err) => {
    if (err) console.log(`브라우저를 직접 열어주세요: ${url}`)
  })
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(HELP)
    return
  }

  const repo = await resolveRepoRoot(opts.dir)
  if (!repo) {
    console.error(`git 저장소가 아닙니다: ${opts.dir}`)
    process.exit(1)
  }

  const dev = process.env.GITSHOW_DEV === '1'
  const token = process.env.GITSHOW_TOKEN || crypto.randomBytes(16).toString('hex')
  const { app, close } = createServer({ repo, token, dev })
  const server = await listen(app, opts.port, PORT_TRIES)
  const { port } = server.address()

  const url = `http://${HOST}:${port}/?t=${token}`
  console.log(`gitshow  ${repo}`)
  console.log(`         ${url}`)
  if (dev) console.log(`         (dev) 프론트는 vite dev server에서 확인: http://localhost:5173/?t=${token}`)
  if (opts.open && !dev) openBrowser(url)

  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) process.exit(0) // 두 번째 Ctrl-C는 즉시 종료
    shuttingDown = true
    await close()
    server.closeAllConnections?.() // keep-alive 연결까지 끊는다
    server.close(() => process.exit(0))
    // 그래도 남는 연결이 있으면 기다리지 않고 나간다
    setTimeout(() => process.exit(0), 1000).unref()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
