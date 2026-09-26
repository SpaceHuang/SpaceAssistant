import { isSensitivePath } from '../shell/shellSensitivePaths'
import type { ShellConfig, ToolsConfig } from '../../src/shared/domainTypes'
import { DEFAULT_TOOLS_CONFIG } from '../../src/shared/domainTypes'
import type { WritePathFact } from '../confirmation/extractors/writePathFacts'
import type { PathZone } from '../../src/shared/confirmation/types'

export type AutoApprovalRejectReason = 'invalid_path' | 'sensitive_path' | 'outside_workdir' | 'unsafe_target' | 'oversize' | 'edit_too_large'

export type WriteFileAutoApprovalInput = {
  absPath: string
  relPath: string
  workDir: string
  userDataDir?: string
  customSensitivePrefixes?: string[]
  contentBytes?: number
  editCharSpan?: number
  autoApproveMaxBytes: number
  autoApproveMaxEditChars: number
  targetZone?: PathZone
}

export type WriteFileAutoApprovalResult =
  | { approve: true }
  | { approve: false; reason: string; reasonCode: AutoApprovalRejectReason }

export function evaluateWriteFileAutoApproval(input: WriteFileAutoApprovalInput): WriteFileAutoApprovalResult {
  if (
    (input.targetZone === undefined
      ? isSensitivePath(input.absPath, input.userDataDir, input.customSensitivePrefixes) || isSensitivePath(input.relPath, input.userDataDir, input.customSensitivePrefixes)
      : input.targetZone === 'sensitive-file')
  ) {
    return {
      approve: false,
      reason: '目标路径命中敏感目录',
      reasonCode: 'sensitive_path'
    }
  }

  if (input.targetZone !== undefined && input.targetZone !== 'workdir-normal') {
    return {
      approve: false,
      reason: '写入目标位于工作目录之外',
      reasonCode: 'outside_workdir'
    }
  }

  if (typeof input.contentBytes === 'number' && input.contentBytes > input.autoApproveMaxBytes) {
    return {
      approve: false,
      reason: `写入体量超过自动放行阈值（${formatBytes(input.contentBytes)} > ${formatBytes(input.autoApproveMaxBytes)}）`,
      reasonCode: 'oversize'
    }
  }

  if (typeof input.editCharSpan === 'number' && input.editCharSpan > input.autoApproveMaxEditChars) {
    return {
      approve: false,
      reason: `单次替换文本过大（${input.editCharSpan} > ${input.autoApproveMaxEditChars} 字符）`,
      reasonCode: 'edit_too_large'
    }
  }

  return { approve: true }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export async function evaluateFileToolAutoApproval(args: {
  workDir: string
  userDataDir: string
  toolsConfig: ToolsConfig
  shellConfig?: ShellConfig | null
  toolName: 'write_file' | 'edit_file'
  input: Record<string, unknown>
  writePathFact?: WritePathFact
}): Promise<WriteFileAutoApprovalResult> {
  const rel = typeof args.input.path === 'string' ? args.input.path : ''
  if (!rel) {
    return { approve: false, reason: '缺少有效的文件路径', reasonCode: 'invalid_path' }
  }
  const fact = args.writePathFact
  if (!fact || fact.rawPath !== rel) return { approve: false, reason: '缺少与当前输入绑定的写入目标事实', reasonCode: 'unsafe_target' }
  if (fact.zone === 'sensitive-file') return { approve: false, reason: '目标路径命中敏感目录', reasonCode: 'sensitive_path' }
  if (fact.zone !== 'workdir-normal') return { approve: false, reason: '写入目标位于工作目录之外', reasonCode: 'outside_workdir' }
  if (fact.targetKind !== 'file' && fact.targetKind !== 'missing') return { approve: false, reason: '写入目标不是普通文件或新文件路径', reasonCode: 'unsafe_target' }
  const abs = fact.normalizedPath
  const maxBytes = args.toolsConfig.autoApproveMaxBytes ?? DEFAULT_TOOLS_CONFIG.autoApproveMaxBytes!
  const maxEdit = args.toolsConfig.autoApproveMaxEditChars ?? DEFAULT_TOOLS_CONFIG.autoApproveMaxEditChars!
  let contentBytes: number | undefined
  let editCharSpan: number | undefined
  if (args.toolName === 'write_file') {
    const content = typeof args.input.content === 'string' ? args.input.content : ''
    contentBytes = Buffer.byteLength(content, 'utf8')
  } else {
    const oldS = typeof args.input.old_string === 'string' ? args.input.old_string : ''
    const newS = typeof args.input.new_string === 'string' ? args.input.new_string : ''
    editCharSpan = oldS.length + newS.length
  }
  return evaluateWriteFileAutoApproval({
    absPath: abs,
    relPath: rel,
    workDir: args.workDir,
    userDataDir: args.userDataDir,
    customSensitivePrefixes: args.shellConfig?.customSensitivePrefixes,
    contentBytes,
    editCharSpan,
    autoApproveMaxBytes: maxBytes,
    autoApproveMaxEditChars: maxEdit,
    targetZone: fact.zone
  })
}
