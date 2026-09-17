import type {
  ApprovalCluePack,
  ApprovalInvocation,
  ApprovalInvocationResult,
  ApprovalVerdict
} from '../../src/shared/confirmation/types'
import type { BrowserConfig, ShellConfig, ToolsConfig } from '../../src/shared/domainTypes'
import type { AppDatabase } from '../database'
import { createSession } from '../database'
import { runToolChatSession } from '../toolChatLoop'
import { ensureToolResultPairing } from '../../src/shared/toolResultPairing'
import { buildFinalSystemPrompt } from '../llmSystemPrompt'
import type { AppLocale } from '../../src/shared/locale'
import { signalChatCancel } from '../chatCancelRegistry'
import { getBundledSecurityApprovalSkill } from '../skills/bundled/securityApprovalSkill'

/**
 * 审批执行链（P2-2，复用管家模式但**绝不取管家准入票**，评审 N8）：
 * createSession({ ownership:'internal', visibility:'hidden' }) → runToolChatSession({ lane:'automation' })
 * + 递归豁免标记（I5）+ 有界 Profile（侦查轮数 ≤3、超时默认 30s）+ 封闭只读工具集（只能收窄）。
 * 输入形态：facts + 结构化线索包（方案 §12-1），不给全量会话。
 * 输出：ApprovalVerdict 两态；超时 / 失败 / 不可解析一律 fail-closed deny（I4）。
 */

/** 侦查轮数上界（Profile 硬上界）。 */
export const APPROVAL_MAX_ROUNDS = 3

/** 审批 Profile 默认模型（快模型；装配方可用 deps.model 覆盖）。 */
export const DEFAULT_APPROVAL_MODEL = 'claude-haiku-4-5-20251001'

/** 封闭只读工具集（Profile 工具集只能收窄，不能加宽——「免再审批」的安全前提）。 */
export const APPROVAL_READONLY_TOOLS: readonly string[] = [
  'read_file',
  'list_directory',
  'grep',
  'list_work_dirs',
  'history.read',
  'skills.read'
]

export interface ApprovalAgentDeps {
  db: AppDatabase
  workDir: string
  userDataDir: string
  getToolsConfig: () => ToolsConfig
  getShellConfig?: () => ShellConfig | null
  getBrowserConfig?: () => BrowserConfig
  getWorkDir: () => string
  /** 会话工作目录解析（主进程装配注入，与桌面链路同一来源）。 */
  resolveWorkDirForSession?: (sessionId: string) => string
  /** 审批 Profile 模型（快模型）；缺省 DEFAULT_APPROVAL_MODEL。 */
  model?: string
  /** 界面语言（系统提示渲染用）；缺省由装配方决定，测试可省。 */
  locale?: AppLocale
  getApiKey: () => Promise<string | null>
}

function renderCluePack(clue: ApprovalCluePack): string {
  const lines = [
    '## 待裁决调用',
    `- 工具：${clue.toolName}`,
    `- 动作类别：${clue.actionClass}`,
    `- 风险等级：${clue.riskLevel}`,
    `- 摘要：${clue.summary}`,
    `- 信号：${clue.signals.length ? clue.signals.join(', ') : '（无）'}`
  ]
  if (clue.targetPath) lines.push(`- 目标路径：${clue.targetPath}`)
  if (clue.command) lines.push(`- 命令：${clue.command}`)
  if (clue.url) lines.push(`- URL：${clue.url}`)
  if (clue.involvedFiles?.length) lines.push(`- 涉及文件：${clue.involvedFiles.join(', ')}`)
  lines.push('', '请依据裁决标准给出两态 JSON 结论。')
  return lines.join('\n')
}

function extractText(res: { ok: true; content: unknown[] }): string {
  let s = ''
  for (const b of res.content) {
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: string }).text
      if (typeof t === 'string') s += t
    }
  }
  return s.trim()
}

/** 从文本中提取平衡的 JSON 对象候选（考虑字符串转义），供逐个解析验证。 */
function extractBalancedJsonObjects(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return out
}

/** 从模型输出中解析两态裁决 JSON（无中间态：解析不出即为 unparsable → deny 由调用方兜底）。 */
export function parseApprovalVerdict(text: string): ApprovalVerdict | null {
  for (const raw of extractBalancedJsonObjects(text)) {
    try {
      const parsed = JSON.parse(raw) as { kind?: unknown; reason?: { summary?: unknown } }
      if (
        (parsed.kind === 'approve' || parsed.kind === 'deny') &&
        typeof parsed.reason?.summary === 'string' &&
        parsed.reason.summary
      ) {
        return { kind: parsed.kind, reason: { summary: parsed.reason.summary } }
      }
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 执行一次审批调用。失败一律返回 ok:false 且 cause 可区分（timeout/unavailable/unparsable/config-error），
 * 绝不向上抛错；绝不取 butlerAdmission 票（外层管家回合持票等待结论，内层取票即并发=1 下自死锁）。
 */
export async function runApprovalAgent(deps: ApprovalAgentDeps, inv: ApprovalInvocation): Promise<ApprovalInvocationResult> {
  const db = deps.db
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const skill = getBundledSecurityApprovalSkill()
    const session = createSession(db, {
      name: `安全审批 · ${inv.clue.summary.slice(0, 24)}`,
      ownership: 'internal',
      visibility: 'hidden'
    })
    const sessionId = session.id

    // 封闭只读工具集：在调用方配置基础上显式收窄（allowedTools 白名单），不给任何写 / 执行工具
    const baseToolsConfig = deps.getToolsConfig()
    const toolsConfig: ToolsConfig = {
      ...baseToolsConfig,
      allowedTools: [...APPROVAL_READONLY_TOOLS]
    }

    // 输入形态：facts + 线索包（单条 user 消息），不给全量会话
    const messages = [{ role: 'user' as const, content: renderCluePack(inv.clue) }]
    const { messages: pairedMessages } = ensureToolResultPairing(messages)

    const system = buildFinalSystemPrompt({
      system: skill.content,
      memoryContent: null,
      memoryEnabled: false,
      locale: deps.locale ?? 'zh-CN'
    })

    const runPromise = runToolChatSession({
      requestId: inv.requestId,
      sessionId,
      lane: 'automation',
      internalConfirmExemption: 'approval-agent',
      maxToolLoopRounds: APPROVAL_MAX_ROUNDS,
      model: deps.model ?? DEFAULT_APPROVAL_MODEL,
      baseUrl: undefined,
      messages: pairedMessages,
      system,
      options: { maxTokens: 2048 },
      toolsConfig,
      browserConfig: deps.getBrowserConfig?.(),
      shellConfig: deps.getShellConfig?.() ?? null,
      workDir: deps.resolveWorkDirForSession ? deps.resolveWorkDirForSession(sessionId) : deps.workDir,
      userDataDir: deps.userDataDir,
      getApiKey: deps.getApiKey,
      appDb: db,
      ...(deps.locale ? { locale: deps.locale } : {}),
      emitFactEvent: () => undefined,
      emitSessionEvent: () => undefined
    })

    // 超时上界（Profile 有界性）：inv.timeoutMs 到期按 timeout 处理，不依赖内层自觉；
    // 超时同时取消内层调用，避免孤儿 run 继续消耗
    const timeoutPromise = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeoutHandle = setTimeout(() => {
        signalChatCancel(inv.requestId)
        resolve({ kind: 'timeout' })
      }, inv.timeoutMs)
    })
    const raced = await Promise.race([
      runPromise.then((r) => ({ kind: 'run' as const, r })),
      timeoutPromise
    ])
    if (raced.kind === 'timeout') {
      return { ok: false, cause: 'timeout' }
    }
    if (!raced.r.ok) {
      return { ok: false, cause: 'unavailable' }
    }
    const verdict = parseApprovalVerdict(extractText(raced.r))
    if (!verdict) {
      return { ok: false, cause: 'unparsable' }
    }
    return {
      ok: true,
      verdict,
      ...(raced.r.usage ? { usage: raced.r.usage as unknown as Record<string, unknown> } : {})
    }
  } catch {
    // 内层任何异常（模型不可用 / 会话创建失败等）一律 fail-closed，不向上抛
    return { ok: false, cause: 'unavailable' }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
