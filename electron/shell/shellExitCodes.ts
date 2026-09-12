const EXIT_HINTS: Record<number, string> = {
  1: '一般性错误',
  2: '误用 shell 命令',
  126: '命令不可执行（权限或格式问题）',
  127: '命令未找到',
  130: '被 SIGINT 中断（Ctrl+C）',
  137: '被 SIGKILL 强制终止',
  143: '被 SIGTERM 终止'
}

export type ExitCodeFamily = 'success' | 'posix' | 'windows-host' | 'unknown-windows-host'

export interface ExitCodeDescription {
  /** 人类可读提示（既有 exitCodeHint 字段沿用该值） */
  hint: string
  family: ExitCodeFamily
  /** 语义名，如 STATUS_CONTROL_C_EXIT */
  semantics?: string
  /** Node 上报的无符号值 */
  unsigned: number
  /** Windows 语义下的有符号值 */
  signed?: number
  /** 可执行建议：模型能直接照做的动作 */
  advice?: readonly string[]
}

const WINDOWS_HOST_CODES: Record<number, { semantics: string; hint: string; advice: readonly string[] }> = {
  0xffff0000: {
    semantics: 'WINDOWS_HOST_INIT_FAILED',
    hint: 'Windows 宿主进程初始化失败（0xFFFF0000）',
    advice: [
      '改用 run_script（Python subprocess）执行同一命令',
      '检查宿主机的安全/加密组件（如 0x8009001D 指向加密服务提供程序 DLL 加载失败）后重试',
      '读取本次执行的原始字节 artifact，确认宿主自身写出的原始报错'
    ]
  },
  0xfffd0000: {
    semantics: 'WINDOWS_ENCODED_COMMAND_INVALID',
    hint: '-EncodedCommand 参数非法（不是合法 Base64）',
    advice: ['这是应用内部命令构造问题，请上报 bug 而不是改写命令']
  },
  // 需求 §10.2 与 §2.4 对「非法 -EncodedCommand」给出的十六进制/十进制不一致
  // （0xFFFD0000 = 4294770688，而 4294836224 = 0xFFFE0000），两个数值都登记，避免漏判。
  0xfffe0000: {
    semantics: 'WINDOWS_ENCODED_COMMAND_INVALID',
    hint: '-EncodedCommand 参数非法（不是合法 Base64）',
    advice: ['这是应用内部命令构造问题，请上报 bug 而不是改写命令']
  },
  0xc000013a: {
    semantics: 'STATUS_CONTROL_C_EXIT',
    hint: '进程被 Ctrl+C 中断（STATUS_CONTROL_C_EXIT）',
    advice: ['属正常中断，无需重试']
  },
  0xc0000142: {
    semantics: 'STATUS_DLL_INIT_FAILED',
    hint: '宿主依赖 DLL 初始化失败（STATUS_DLL_INIT_FAILED）',
    advice: ['疑似安全软件拦截或系统组件缺失，重试一次后再改用 run_script']
  },
  0xc0000005: {
    semantics: 'STATUS_ACCESS_VIOLATION',
    hint: '宿主进程访问冲突（STATUS_ACCESS_VIOLATION）',
    advice: ['宿主崩溃，附加原始字节 artifact 后上报']
  },
  0xc00000fd: {
    semantics: 'STATUS_STACK_OVERFLOW',
    hint: '宿主进程栈溢出（STATUS_STACK_OVERFLOW）',
    advice: ['检查命令是否递归或脚本过大']
  }
}

function toSigned32(code: number): number {
  return code > 0x7fffffff ? code - 0x100000000 : code
}

/** 结构化退出码解释（§10.2）：未收录的 Windows 宿主码只标 family，不编造语义。 */
export function describeExitCodeDetails(code: number | null | undefined): ExitCodeDescription | undefined {
  if (code === null || code === undefined) return undefined
  if (code === 0) return { hint: '', family: 'success', unsigned: 0 }
  const posix = EXIT_HINTS[code]
  if (posix !== undefined) return { hint: posix, family: 'posix', unsigned: code }
  const windows = WINDOWS_HOST_CODES[code]
  if (windows) {
    return {
      hint: windows.hint,
      family: 'windows-host',
      semantics: windows.semantics,
      unsigned: code,
      signed: toSigned32(code),
      advice: windows.advice
    }
  }
  if (code > 0x7fffffff) {
    const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`
    return {
      hint: `Windows 宿主异常终止（退出码 ${hex} / ${toSigned32(code)}）`,
      family: 'unknown-windows-host',
      unsigned: code,
      signed: toSigned32(code)
    }
  }
  return { hint: `进程异常退出（退出码 ${code}）`, family: 'posix', unsigned: code }
}

/** 兼容既有调用方：只返回提示文本。 */
export function describeExitCode(code: number | null | undefined): string | undefined {
  const details = describeExitCodeDetails(code)
  if (!details) return undefined
  return details.hint.length > 0 ? details.hint : undefined
}

export interface HresultDescription {
  code: string
  name: string
  meaning: string
  advice: readonly string[]
}

/**
 * 文本层的 HRESULT 解释（§10.2）：事故里唯一的诊断信息 `8009001d` 被乱码吞掉过一次。
 */
export function describeHresult(text: string): HresultDescription | undefined {
  if (/0x8009001d\b|(^|[^0-9a-f])8009001d([^0-9a-f]|$)/i.test(text)) {
    return {
      code: '0x8009001D',
      name: 'NTE_PROVIDER_DLL_FAIL',
      meaning: '加密服务提供程序 DLL 加载或初始化失败',
      advice: ['疑似宿主机安全/加密组件拦截，重试一次；仍失败则改用 run_script']
    }
  }
  return undefined
}
