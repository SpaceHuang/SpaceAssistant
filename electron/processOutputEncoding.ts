import { TextDecoder } from 'util'

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
