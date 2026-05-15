/**
 * OpenAI 兼容网关要求工具 function.name 匹配 ^[a-zA-Z0-9_-]+$。
 */

const NON_OPENAI_COMPAT_CHAR = /[^a-zA-Z0-9_-]/g

export function toolIdToOpenAiCompatibleApiToolName(toolId: string): string {
  const s = toolId.replace(NON_OPENAI_COMPAT_CHAR, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return s.length > 0 ? s : 'tool'
}
