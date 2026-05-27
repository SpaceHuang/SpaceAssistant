import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import path from 'path'
import { logFeishuCliEvent } from './feishuCliLogger'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

export type NpmCommandResult = {
  success: boolean
  stdout: string
  stderr: string
  timedOut?: boolean
}

function spawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existing = env[pathKey] ?? env.PATH ?? ''
  const extra: string[] = []
  if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.ProgramFiles) extra.push(path.join(process.env.ProgramFiles, 'nodejs'))
  if (process.env['ProgramFiles(x86)']) extra.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs'))
  if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'))
  env[pathKey] = [...extra, existing].filter(Boolean).join(path.delimiter)
  return env
}

/** Windows 上不能直接 spawn .cmd/.bat（会 EINVAL）；经 cmd.exe 调用 npm/npx。 */
function spawnPackageManager(
  command: 'npm' | 'npx',
  args: string[],
  options?: { cwd?: string }
): ChildProcess {
  const env = spawnEnv()
  const spawnOpts: SpawnOptions = {
    shell: false,
    windowsHide: true,
    env,
    cwd: options?.cwd
  }

  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    return spawn(comspec, ['/d', '/s', '/c', command, ...args], spawnOpts)
  }

  return spawn(command, args, spawnOpts)
}

function runSpawnedCommand(
  proc: ChildProcess,
  timeoutMs: number,
  timeoutMessage: string
): Promise<NpmCommandResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: NpmCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGTERM')
      setTimeout(() => proc.kill('SIGKILL'), 500)
      finish({ success: false, stdout, stderr: `${stderr}\n${timeoutMessage}`.trim(), timedOut: true })
    }, timeoutMs)

    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    proc.on('close', (code) => {
      finish({ success: code === 0, stdout, stderr })
    })

    proc.on('error', (e) => {
      finish({
        success: false,
        stdout,
        stderr: `${stderr}\n${e.message}`.trim()
      })
    })
  })
}

export function runNpmCommand(
  args: string[],
  options?: { timeoutMs?: number; cwd?: string }
): Promise<NpmCommandResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  let proc: ChildProcess
  try {
    proc = spawnPackageManager('npm', args, { cwd: options?.cwd })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logFeishuCliEvent('info', 'feishu.npm.command', {
      command: 'npm',
      argsRedacted: args.join(' '),
      success: false,
      durationMs: Date.now() - startedAt
    })
    return Promise.resolve({ success: false, stdout: '', stderr: msg })
  }

  return runSpawnedCommand(proc, timeoutMs, '安装超时').then((r) => {
    logFeishuCliEvent('info', 'feishu.npm.command', {
      command: 'npm',
      argsRedacted: args.join(' '),
      success: r.success,
      timedOut: r.timedOut,
      durationMs: Date.now() - startedAt
    })
    return r
  })
}

export function runNpxCommand(args: string[], options?: { timeoutMs?: number }): Promise<NpmCommandResult> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()

  let proc: ChildProcess
  try {
    proc = spawnPackageManager('npx', args)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logFeishuCliEvent('info', 'feishu.npm.command', {
      command: 'npx',
      argsRedacted: args.join(' '),
      success: false,
      durationMs: Date.now() - startedAt
    })
    return Promise.resolve({ success: false, stdout: '', stderr: msg })
  }

  return runSpawnedCommand(proc, timeoutMs, '命令超时').then((r) => {
    logFeishuCliEvent('info', 'feishu.npm.command', {
      command: 'npx',
      argsRedacted: args.join(' '),
      success: r.success,
      timedOut: r.timedOut,
      durationMs: Date.now() - startedAt
    })
    return r
  })
}
