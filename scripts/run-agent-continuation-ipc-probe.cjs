const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildAgentContinuationProbeArgs } = require('./agentContinuationProbeArgs.cjs')

const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'spaceassistant-agent-continuation-electron-'))
try {
  const electronBinary = require('electron')
  const result = spawnSync(electronBinary, buildAgentContinuationProbeArgs(
    profilePath,
    path.join(__dirname, 'probe-agent-continuation-ipc.cjs')
  ), { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', timeout: 60_000 })
  if (result.error?.code === 'ETIMEDOUT') throw new Error('isolated Electron continuation IPC probe timed out after 60 seconds')
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  fs.rmSync(profilePath, { recursive: true, force: true })
}
