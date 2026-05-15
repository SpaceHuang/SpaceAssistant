import { toolIdToOpenAiCompatibleApiToolName } from './toolApiFunctionName'

export function sanitizeAnthropicToolsPayloadForStrictGateways(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t
    const o = t as Record<string, unknown>
    const rawName = typeof o.name === 'string' ? o.name : ''
    return { ...o, name: toolIdToOpenAiCompatibleApiToolName(rawName) }
  })
}
