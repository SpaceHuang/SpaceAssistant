import type { ToolExecutionContext, ToolExecutorResult } from '../tools/types'
import { defineDirectTool } from '../tools/plannedToolRegistry'
import type { RegisteredTool } from '../tools/plannedToolRegistry'
import { capabilityRegistry } from './registry'
import type { CapabilityRegistry } from './registry'
import type { CapabilityContext } from './types'
import { matchCapabilities } from './match'
import { callCapability } from './callCapability'
import { APP_PRODUCT_NAME } from '../../src/shared/appMeta'

/**
 * toolkit.find / toolkit.call：模型面仅有的两个网关工具（需求 §3.1）。
 * 能力集合内的增删不改变这两个 schema，对上下文零增量。
 * 实现采用仓库既有模式：独立 executor 函数（可单测）+ defineDirectTool 包装（注册用）。
 */

function parseRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/** 由运行时上下文构造能力 handler 所需的 CapabilityContext。 */
export function buildCapabilityContext(ctx: ToolExecutionContext): CapabilityContext {
  return {
    workDir: ctx.workDir,
    userDataDir: ctx.userDataDir,
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
    signal: ctx.signal,
    locale: ctx.requestLocale,
    lane: ctx.lane,
    confirmedByUser: ctx.toolUserConfirmed === true,
    productName: APP_PRODUCT_NAME,
    // 懒取 electron app（单测环境无 electron 模块；主进程运行时恒可用）
    get productVersion() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron') as typeof import('electron')
        return app.getVersion()
      } catch {
        return ''
      }
    },
    detectBrowserDependencies: (force) => {
      // 与原 browser_detect 工具同口径：委托 stagehandService（自带缓存），沿用会话检测上下文
      const { stagehandService } = require('../browser/stagehandService') as typeof import('../browser/stagehandService')
      if (ctx.getBrowserDetectContext) {
        stagehandService.configureDetectContext(ctx.getBrowserDetectContext())
      }
      return stagehandService.detectDependencies(force)
    },
    appDatabase: ctx.appDatabase,
    workDirManager: ctx.workDirManager
  }
}

export type ToolkitFindExecutor = (input: Record<string, unknown>) => Promise<ToolExecutorResult>

export function createToolkitFindExecutor(registry: CapabilityRegistry = capabilityRegistry): ToolkitFindExecutor {
  return async (input) => {
    const query = typeof input.query === 'string' ? input.query : ''
    if (!query.trim()) {
      return { success: false, error: 'query 不能为空：描述用途，或直接给出能力 id' }
    }
    const family = input.family === 'env' || input.family === 'action' ? input.family : undefined
    const outcome = matchCapabilities(registry.list(), query, family)
    const hint = '调用方式：toolkit.call { "id": "<能力id>", "params": <参数> }'
    if (outcome.matches.length > 0) {
      const matchedIds = new Set(outcome.matches.map((m) => m.id))
      const matches = registry
        .list()
        .filter((d) => matchedIds.has(d.id))
        .map((d) => ({
          id: d.id,
          summary: d.summary,
          usage: `toolkit.call 入参：${d.paramsDoc}`,
          returns: d.returnsDoc,
          risk: d.risk,
          ...(d.notes?.length ? { notes: d.notes } : {})
        }))
      return { success: true, data: { ok: true, matches, hint } }
    }
    return {
      success: true,
      data: {
        ok: true,
        matches: [],
        index: outcome.index.map((d) => ({ id: d.id, summary: d.summary })),
        hint: '未命中。可换关键词再用 toolkit.find 重查；或直接按 id 调用：toolkit.call { id, params }'
      }
    }
  }
}

export type ToolkitCallExecutor = (
  input: Record<string, unknown>,
  runtimeContext?: ToolExecutionContext
) => Promise<ToolExecutorResult>

export function createToolkitCallExecutor(registry: CapabilityRegistry = capabilityRegistry): ToolkitCallExecutor {
  return async (input, runtimeContext) => {
    const id = typeof input.id === 'string' ? input.id : ''
    if (!id.trim()) {
      return { success: false, error: 'id 不能为空：请先 toolkit.find 查询能力 id' }
    }
    if (!runtimeContext) {
      return { success: false, error: 'toolkit.call 缺少运行时上下文' }
    }
    const result = await callCapability(registry, id, input.params, buildCapabilityContext(runtimeContext))
    // 业务失败也以 success:false 回报（UI 行显示失败）；data 保留结构化结论供模型自纠
    // （serializeAgentToolResult 对失败结果仍序列化 data，评审建议 11）
    return result.ok
      ? { success: true, data: result }
      : { success: false, error: result.error.message, data: result }
  }
}

export function createToolkitFindTool(registry: CapabilityRegistry = capabilityRegistry): RegisteredTool {
  const executor = createToolkitFindExecutor(registry)
  return defineDirectTool<Record<string, unknown>, ToolExecutorResult>({
    name: 'toolkit.find',
    parseInput: parseRecord,
    execute: (input) => executor(input)
  })
}

export function createToolkitCallTool(registry: CapabilityRegistry = capabilityRegistry): RegisteredTool {
  const executor = createToolkitCallExecutor(registry)
  return defineDirectTool<Record<string, unknown>, ToolExecutorResult>({
    name: 'toolkit.call',
    parseInput: parseRecord,
    execute: (input, context) => executor(input, context.runtimeContext as ToolExecutionContext)
  })
}

export const toolkitFindExecutor = createToolkitFindExecutor()
export const toolkitCallExecutor = createToolkitCallExecutor()
export const toolkitFindTool = createToolkitFindTool()
export const toolkitCallTool = createToolkitCallTool()
