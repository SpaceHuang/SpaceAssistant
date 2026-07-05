/** 与 `claudeStreamHandlers` 中 Claude IPC 共用：模型、baseUrl、requestId 校验 */

export { getStrictToolResultPairing } from '../src/shared/toolResultPairingStrict'

export function assertValidRequestId(requestId: string): string {
  const trimmed = requestId.trim()
  if (!trimmed) throw new Error('Invalid requestId')
  if (trimmed.length > 200) throw new Error('Invalid requestId')
  return trimmed
}

export function assertValidModel(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) throw new Error('Invalid model')
  if (trimmed.length > 200) throw new Error('Invalid model')
  return trimmed
}

export function assertValidOptionalAnthropicBaseUrl(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new Error('Invalid baseUrl')
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (trimmed.length > 2048) throw new Error('baseUrl too long')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Invalid baseUrl')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https')
  }
  return trimmed
}
