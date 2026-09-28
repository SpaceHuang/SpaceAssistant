import path from 'node:path'

/**
 * 会话工作目录的唯一事实源：装配期解析一次，随调用携带，只读。
 *
 * 消费纪律（调用内冻结、调用间跟随）：一次工具调用的四个消费点
 * （env 自述 / 文件工具 / shell cwd / 安全审批）读同一 revision；
 * 绑定变更只有下一次工具调用可见（refresh 时 revision + 1）。
 */
export interface WorkspaceSnapshot {
  /** 绑定的 profile id；source='active-fallback' 时为全局 active profile id */
  profileId: string
  /** 规范化后的根路径：path.resolve → 去尾分隔符（realpath 尽力提升由 Runtime 装配期完成） */
  rootPath: string
  /** 平台化比较键：win32 走小写 + 正斜杠，posix 原样（口径对齐 electron/writeSafety/pathIdentity.ts） */
  key: string
  /** 基准来源，必须可解释（诊断与审计要引用它） */
  source: 'session-binding' | 'active-fallback'
  sensitive: boolean
  /** 每次绑定变更 +1；「同一 revision 内四个消费点结论必须一致」由它表达 */
  revision: number
}

/**
 * 平台化路径比较键：win32 小写 + 正斜杠；posix 保持原样。
 * 与 electron/writeSafety/pathIdentity 的 win32 口径一致（词法归一，不做 realpath）。
 */
export function workspacePathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const resolver = platform === 'win32' ? path.win32.resolve : path.posix.resolve
  const normalized = stripTrailingSep(resolver(p))
  if (platform === 'win32') {
    return normalized.replace(/\\/g, '/').toLowerCase()
  }
  return normalized
}

/** 规范化工作目录根：resolve → 去尾分隔符（盘符根形态在 resolve 前拦截，防 cwd 漂移） */
export function normalizeWorkspaceRoot(p: string): string {
  // C1：'E:' / 'E:\' / 'E:/' 这类盘符根不能交给 path.resolve——'E:' 会解析为
  // 「该盘的进程当前目录」而漂移。直接规范为 'E:\'。
  const driveRoot = /^[A-Za-z]:[\\/]*$/.exec(p.trim())
  if (driveRoot) {
    return p.trim().slice(0, 2).toUpperCase() + '\\'
  }
  return stripTrailingSep(path.resolve(p))
}

function stripTrailingSep(resolved: string): string {
  // C1（评审 2026-09-28）：Windows 盘符根（E:\ 或 E:/）的尾分隔符是形态的一部分——
  // 剥成 'E:' 后作为 path.resolve 基座会漂移到「该盘的进程当前目录」。盘符根原样规范为带尾分隔符形态。
  if (/^[A-Za-z]:[\\/]?$/.test(resolved)) {
    return resolved.slice(0, 2) + '\\'
  }
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    return resolved.replace(/[\\/]+$/, '') || resolved
  }
  return resolved
}

export type WorkspaceConsumerName = 'env' | 'file' | 'shell' | 'safety'

/**
 * 开发态断言 + 单测共用：四个消费点在同一 revision 内必须得到同一基准。
 * 比较按 workspacePathKey，不做字面字符串比较。
 */
export function assertWorkspaceBasisConsistent(input: {
  snapshot: WorkspaceSnapshot
  consumers: Array<{ name: WorkspaceConsumerName; workDir: string }>
}): { ok: true } | { ok: false; mismatches: Array<{ name: string; workDir: string }> } {
  const expected = input.snapshot.key
  const mismatches = input.consumers
    .filter((c) => workspacePathKey(c.workDir) !== expected)
    .map((c) => ({ name: c.name, workDir: c.workDir }))
  if (mismatches.length > 0) {
    return { ok: false, mismatches }
  }
  return { ok: true }
}
