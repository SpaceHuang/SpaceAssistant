import { existsSync } from 'fs'
import path from 'path'
import {
  StdioClientTransport,
  type StdioServerParameters
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { detectSensitiveParamValue } from '../../src/shared/mcpTypes'
import { sanitizeForLog } from '../logSanitize'

/**
 * stdio 传输安全封装：
 * - 复用 SDK StdioClientTransport（shell:false、支持自定义 env、stderr pipe）。
 * - 命令解析阶段显性拒绝 `.cmd`/`.bat`（含 PATH 解析命中垫片，评审 B1），给出可读引导。
 * - 环境从受控最小继承集构建（Windows 大小写去重），叠加解密后的用户环境变量。
 * - stderr 脱敏后交回调（进诊断），不落日志明文。
 */

export const STDIO_WINDOWS_SHIM_GUIDANCE =
  'Windows 下该命令为脚本垫片（.cmd/.bat），不可直接启动；请改用 `node <入口.js>`、`python <server.py>`、`docker run …` 或可执行文件路径'

export class StdioCommandValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StdioCommandValidationError'
  }
}

export type StdioCommandValidationOptions = {
  platform?: NodeJS.Platform
  baseEnv?: Record<string, string>
  /** 测试缝：PATH 解析候选（默认按 baseEnv PATH + PATHEXT 查找）。 */
  pathLookup?: (command: string) => string | null
}

export function resolveCommandCandidate(
  command: string,
  platform: NodeJS.Platform,
  baseEnv: Record<string, string>
): string | null {
  if (command.includes('/') || command.includes('\\')) {
    return existsSync(command) ? command : null
  }
  const pathValue = baseEnv.PATH ?? ''
  const dirs = platform === 'win32' ? pathValue.split(';').filter(Boolean) : pathValue.split(':').filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, command)
    if (existsSync(candidate)) return candidate
    if (platform === 'win32') {
      const pathext = (baseEnv.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      for (const ext of pathext) {
        const withExt = candidate + ext.toLowerCase()
        if (existsSync(withExt)) return withExt
      }
    }
  }
  return null
}

export function validateStdioCommand(
  input: { command: string; args: string[] },
  options?: StdioCommandValidationOptions
): { ok: true } | { ok: false; error: string } {
  const command = input.command.trim()
  if (!command) {
    return { ok: false, error: 'stdio 命令不能为空' }
  }
  for (const arg of input.args) {
    if (detectSensitiveParamValue(arg).matched) {
      return {
        ok: false,
        error: '命令参数中包含疑似 token/凭据，请改用加密环境变量注入'
      }
    }
  }

  const platform = options?.platform ?? process.platform
  if (platform === 'win32') {
    const lower = command.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { ok: false, error: `${STDIO_WINDOWS_SHIM_GUIDANCE}（${path.basename(command)}）` }
    }
    const baseEnv = options?.baseEnv ?? (process.env as Record<string, string>)
    const candidate = options?.pathLookup
      ? options.pathLookup(command)
      : resolveCommandCandidate(command, platform, baseEnv)
    if (candidate) {
      const candLower = candidate.toLowerCase()
      if (candLower.endsWith('.cmd') || candLower.endsWith('.bat')) {
        return {
          ok: false,
          error: `${STDIO_WINDOWS_SHIM_GUIDANCE}（PATH 解析命中 ${path.basename(candidate)}）`
        }
      }
    }
  }
  return { ok: true }
}

const WINDOWS_REQUIRED_ENV_KEYS = ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'SYSTEMDRIVE', 'WINDIR']

/**
 * 构建受控最小环境：Windows 下按大小写去重继承必需变量，其余宿主环境变量默认不透传；
 * 用户解密后的环境变量叠加在顶层。
 */
export function buildStdioEnvironment(
  userEnv: Record<string, string>,
  options?: { platform?: NodeJS.Platform; baseEnv?: Record<string, string> }
): Record<string, string> {
  const platform = options?.platform ?? process.platform
  const baseEnv = options?.baseEnv ?? (process.env as Record<string, string>)
  const out: Record<string, string> = {}

  if (platform === 'win32') {
    const normalized = new Map<string, string>()
    for (const [key, value] of Object.entries(baseEnv)) {
      const lower = key.toLowerCase()
      if (value === undefined || normalized.has(lower)) continue
      const required = WINDOWS_REQUIRED_ENV_KEYS.some((rk) => rk.toLowerCase() === lower)
      if (required) normalized.set(lower, value)
    }
    for (const requiredKey of WINDOWS_REQUIRED_ENV_KEYS) {
      const value = normalized.get(requiredKey.toLowerCase())
      if (value !== undefined) out[requiredKey] = value
    }
  } else if (baseEnv.PATH !== undefined) {
    out.PATH = baseEnv.PATH
  }

  for (const [key, value] of Object.entries(userEnv)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

export type StdioTransportOptions = {
  platform?: NodeJS.Platform
  baseEnv?: Record<string, string>
  /** stderr 逐行脱敏回调（用于写入诊断）。 */
  onStderr?: (sanitizedLine: string) => void
  maxBufferSize?: number
}

export function createStdioTransport(
  params: { command: string; args: string[]; cwd?: string; env?: Record<string, string> },
  options?: StdioTransportOptions
): StdioClientTransport {
  const validation = validateStdioCommand(
    { command: params.command, args: params.args },
    { platform: options?.platform, baseEnv: options?.baseEnv }
  )
  if (!validation.ok) {
    throw new StdioCommandValidationError(validation.error)
  }

  const env = buildStdioEnvironment(params.env ?? {}, {
    platform: options?.platform,
    baseEnv: options?.baseEnv
  })

  const serverParams: StdioServerParameters = {
    command: params.command.trim(),
    args: params.args,
    cwd: params.cwd,
    env,
    stderr: options?.onStderr ? 'pipe' : 'inherit',
    ...(options?.maxBufferSize ? { maxBufferSize: options.maxBufferSize } : {})
  }

  const transport = new StdioClientTransport(serverParams)
  if (options?.onStderr) {
    const stream = transport.stderr
    if (stream) {
      let buffer = ''
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const sanitized = sanitizeForLog(line)
          options.onStderr!(typeof sanitized === 'string' ? sanitized : String(sanitized))
        }
      })
    }
  }
  return transport
}
