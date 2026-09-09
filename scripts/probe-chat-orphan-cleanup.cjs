const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const file = process.argv[3]
if (process.argv[2] === 'writer') {
  const token = process.argv[4]
  const child = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000)`, token], { detached: true, stdio: 'ignore' })
  child.unref()
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, token }))
  process.exit(0)
}
if (process.argv[2] === 'reader') {
  const identity = JSON.parse(fs.readFileSync(file, 'utf8'))
  const command = process.platform === 'win32'
    ? spawnSync('wmic', ['process', 'where', `ProcessId=${identity.pid}`, 'get', 'CommandLine'], { encoding: 'utf8' }).stdout
    : spawnSync('ps', ['-p', String(identity.pid), '-o', 'command='], { encoding: 'utf8' }).stdout
  if (!command.includes(identity.token)) throw new Error(`owner validation failed: ${command}`)
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(identity.pid), '/T', '/F'])
  else process.kill(process.platform === 'darwin' ? -identity.pid : identity.pid, 'SIGTERM')
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    try { process.kill(identity.pid, 0) } catch { process.stdout.write(JSON.stringify({ verified: true, pid: identity.pid })); process.exit(0) }
  }
  throw new Error('orphan process still alive after cleanup deadline')
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-orphan-cleanup-'))
const identityFile = path.join(dir, 'identity.json')
const token = `sa-owner-${process.pid}-${Date.now()}`
try {
  const writer = spawnSync(process.execPath, [__filename, 'writer', identityFile, token], { encoding: 'utf8' })
  if (writer.status !== 0) throw new Error(writer.stderr || 'writer failed')
  const reader = spawnSync(process.execPath, [__filename, 'reader', identityFile], { encoding: 'utf8' })
  if (reader.status !== 0) throw new Error(reader.stderr || reader.stdout || 'reader failed')
  console.log(`[chat-orphan-cleanup] ${JSON.stringify({ writerPid: writer.pid, readerPid: reader.pid, ...JSON.parse(reader.stdout) })}`)
} finally {
  try { fs.unlinkSync(identityFile) } catch {}
  fs.rmSync(dir, { recursive: true, force: true })
}
