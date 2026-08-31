import type { ToolActionDescriptor } from './confirmation/types'

/**
 * 内置工具确认/风险元数据。
 *
 * 独立于 BUILTIN_TOOL_DEFINITIONS 维护：
 * 1) 避免元数据字段泄漏到 Anthropic / OpenAI 兼容网关的 tools 载荷；
 * 2) 避免其他模块（如 domainTypes）因引用元数据而把完整 LLM tools 载荷带进渲染 bundle（M5）。
 *
 * riskLevel 在 P0 与既有 builtinToolRiskLevel 完全一致（对外行为不变）；browser→medium、
 * wechat 出站→low 是计划 §4 的演进目标，留待允许行为变化的阶段统一。
 */
export const BUILTIN_TOOL_METADATA: Record<string, ToolActionDescriptor> = {
  read_file: { toolName: 'read_file', actionClass: 'read', riskLevel: 'low', extractors: [] },
  grep: { toolName: 'grep', actionClass: 'read', riskLevel: 'low', extractors: [] },
  list_directory: { toolName: 'list_directory', actionClass: 'read', riskLevel: 'low', extractors: [] },
  browser_detect: { toolName: 'browser_detect', actionClass: 'read', riskLevel: 'low', extractors: [] },
  read_feishu_attachment: {
    toolName: 'read_feishu_attachment',
    actionClass: 'read',
    riskLevel: 'low',
    extractors: []
  },
  list_work_dirs: { toolName: 'list_work_dirs', actionClass: 'read', riskLevel: 'low', extractors: [] },
  switch_work_dir: { toolName: 'switch_work_dir', actionClass: 'read', riskLevel: 'low', extractors: [] },
  switch_session: { toolName: 'switch_session', actionClass: 'read', riskLevel: 'low', extractors: [] },
  edit_file: {
    toolName: 'edit_file',
    actionClass: 'write',
    riskLevel: 'medium',
    extractors: ['path-classifier']
  },
  write_file: {
    toolName: 'write_file',
    actionClass: 'write',
    riskLevel: 'medium',
    extractors: ['path-classifier']
  },
  run_shell: {
    toolName: 'run_shell',
    actionClass: 'execute',
    riskLevel: 'high',
    extractors: ['command-sequence', 'path-classifier', 'network-egress']
  },
  run_script: {
    toolName: 'run_script',
    actionClass: 'execute',
    riskLevel: 'high',
    extractors: ['script-analysis', 'path-classifier']
  },
  run_lark_cli: {
    toolName: 'run_lark_cli',
    actionClass: 'execute',
    riskLevel: 'high',
    extractors: ['lark-subcommand']
  },
  browser: {
    toolName: 'browser',
    actionClass: 'outbound',
    riskLevel: 'low',
    extractors: ['browser-domain']
  },
  wechat_reply: {
    toolName: 'wechat_reply',
    actionClass: 'outbound',
    riskLevel: 'medium',
    extractors: ['outbound-target']
  },
  wechat_send: {
    toolName: 'wechat_send',
    actionClass: 'outbound',
    riskLevel: 'medium',
    extractors: ['outbound-target']
  }
}

/** 查找内置工具的确认/风险元数据；未注册时返回 undefined（信息不足走默认策略）。 */
export function getBuiltinToolMetadata(name: string): ToolActionDescriptor | undefined {
  return BUILTIN_TOOL_METADATA[name]
}
