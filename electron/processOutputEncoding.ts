import { TextDecoder } from 'util'
import { augmentShellPathEnv, pickSafeNodeOptions } from './shell/shellSpawnEnv'

export type StreamTextDecoder = {
  write(chunk: Buffer): string
  end(): string
}

export function createStreamTextDecoder(encoding: 'utf-8' | 'gbk' = 'utf-8'): StreamTextDecoder {
  const decoder = new TextDecoder(encoding)
  return {
    write(chunk: Buffer): string {
      return decoder.decode(chunk, { stream: true })
    },
    end(): string {
      return decoder.decode()
    }
  }
}

/**
 * 流式子进程输出解码：Windows 上按 decodeProcessOutput 规则在 UTF-8 / GBK 间选择。
 * write/end 返回自上次调用以来的新增文本（便于累加至完整输出）。
 */
export function createProcessOutputStreamDecoder(platform: NodeJS.Platform = process.platform): StreamTextDecoder {
  const chunks: Buffer[] = []
  let lastText = ''
  const flush = (): string => {
    const text = decodeProcessOutput(Buffer.concat(chunks), platform)
    const delta = text.slice(lastText.length)
    lastText = text
    return delta
  }
  return {
    write(chunk: Buffer): string {
      chunks.push(chunk)
      return flush()
    },
    end(): string {
      if (chunks.length === 0) return ''
      return flush()
    }
  }
}

/**
 * Windows 上经 cmd.exe 启动的子进程：cmd 自身报错（如「不是内部或外部命令」）为 GBK，
 * 而 Node CLI 管道输出多为 UTF-8。UTF-8 误读 GBK 会产生 U+FFFD，据此回退 GBK 解码。
 */
export function decodeProcessOutput(buf: Buffer, platform: NodeJS.Platform = process.platform): string {
  if (buf.length === 0) return ''
  const utf8 = new TextDecoder('utf-8').decode(buf)
  if (platform !== 'win32') return utf8
  const gbk = new TextDecoder('gbk').decode(buf)
  const hasCjk = (s: string) => /[\u4e00-\u9fff]/.test(s)
  if (hasCjk(gbk) && !hasCjk(utf8)) return gbk
  if (utf8.includes('\uFFFD') && hasCjk(gbk)) return gbk
  return utf8
}

/** 运行 shell 命令时的子进程环境：剔除 API Key 等敏感变量。 */
export function buildShellEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const denyKey = (k: string) =>
    /API_KEY/i.test(k) ||
    k.startsWith('ANTHROPIC_') ||
    k.startsWith('OPENAI_') ||
    k.startsWith('ELECTRON_') ||
    k === 'NODE_OPTIONS'

  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || denyKey(k)) continue
    if (k === 'NODE_OPTIONS') continue
    if (process.platform === 'win32' && (k === 'Path' || k === 'PATH' || k === 'path')) continue
    env[k] = v
  }
  const pathValue = augmentShellPathEnv(base)
  if (process.platform === 'win32') {
    env.Path = pathValue
    env.PATH = pathValue
    env.SystemRoot = base.SystemRoot ?? ''
    env.USERPROFILE = base.USERPROFILE ?? ''
    env.LOCALAPPDATA = base.LOCALAPPDATA ?? ''
    env.ComSpec = base.ComSpec ?? 'cmd.exe'
  } else {
    env.PATH = pathValue
    env.HOME = base.HOME ?? ''
    env.LANG = base.LANG ?? 'C.UTF-8'
    env.LC_ALL = base.LC_ALL ?? env.LANG
  }
  const nodeOptions = pickSafeNodeOptions(base)
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions
  return env
}

/** 运行 Python 脚本时的子进程环境：Windows 控制台默认 CP936，强制 stdout/stderr 使用 UTF-8。 */
export function buildPythonScriptEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    PATH: base.PATH ?? '',
    PYTHONIOENCODING: 'utf-8',
    ...(process.platform === 'win32'
      ? {
          USERPROFILE: base.USERPROFILE ?? '',
          PYTHONUTF8: '1'
        }
      : {
          HOME: base.HOME ?? ''
        })
  }
}
