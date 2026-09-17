import type { ZodType } from 'zod'

/** 能力家族：env=自我知觉（只读探测），action=产品功能执行 */
export type CapabilityFamily = 'env' | 'action'

/** 风险级：read=免确认；act=调用前必须过既有确认通道 */
export type CapabilityRisk = 'read' | 'act'

/** lane 隔离：初期仅桌面 lane 注册 */
export type CapabilityLane = 'desktop'

/**
 * 子进程探测缝：env 探测类 handler 通过它执行外部命令（参数数组、禁 shell 拼接）。
 * 返回 null 表示命令不存在/启动失败（如非 Windows 平台的 wsl.exe）。
 */
export interface ProbeOutcome {
  code: number | null
  stdout: string
  stderr: string
}

/** 能力 handler 的运行时上下文；由工具执行器从 ToolExecutionContext 裁剪构造。 */
export interface CapabilityContext {
  workDir: string
  userDataDir: string
  sessionId: string
  requestId: string
  signal: AbortSignal
  /** 当前调用 lane；缺省视为 desktop */
  lane?: string
  /** 产品语言（用户选择的 i18n locale，如 zh-CN） */
  locale?: string
  /** 产品名称/版本（env.agent 用；执行器适配层从 electron app 填充） */
  productName?: string
  productVersion?: string
  /** env 探测缝（测试注入 fake runner，不真 spawn） */
  runProbe?: (command: string[], timeoutMs: number) => Promise<ProbeOutcome | null>
  /** 浏览器依赖检测缝（env.browserDetect 用，委托 stagehandService 的缓存实现） */
  detectBrowserDependencies?: (force: boolean) => Promise<unknown>
  /** Phase 2 功能执行系列所需的主进程服务 */
  appDatabase?: unknown
  workDirManager?: unknown
}

/**
 * 能力描述符：每个能力一条，是 find 返回的「调用方式」与 call 校验逻辑的单一事实来源。
 */
export interface CapabilityDescriptor<P = unknown> {
  /** 'env.system' / 'action.session.read' */
  id: string
  family: CapabilityFamily
  /** 一句话用途：find 的匹配与返回主体 */
  summary: string
  /** 匹配关键词（中英，每条 3-8 个词，随描述符评审） */
  keywords: string[]
  /** toolkit.call 的参数校验（唯一真源） */
  paramsSchema: ZodType<P>
  /** 给模型看的参数说明（find.usage 由它生成） */
  paramsDoc: string
  returnsDoc: string
  risk: CapabilityRisk
  /** 缺省 desktop */
  lane?: CapabilityLane
  /** find 结果附注（如「结果缓存 10 分钟」） */
  notes?: string[]
  handler: (params: P, ctx: CapabilityContext) => Promise<unknown>
}

/** find 的紧凑索引条目 */
export interface CapabilityIndexEntry {
  id: string
  summary: string
}
