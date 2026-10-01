import { elideConstantHeaderFields, type RequestHeaderPayload } from '../../src/shared/requestContext'

const fingerprintsByWindow = new Map<string, { system: string; tools: string }>()
const MAX_WINDOWS = 500

/** Request-header projection state shared by Hosted and legacy lanes for one context window. */
export function projectRequestHeaderForWindow(windowId: string, header: RequestHeaderPayload): RequestHeaderPayload {
  const previous = fingerprintsByWindow.get(windowId) ?? null
  const { elided, fingerprints } = elideConstantHeaderFields(header, previous)
  fingerprintsByWindow.delete(windowId)
  fingerprintsByWindow.set(windowId, fingerprints)
  if (fingerprintsByWindow.size > MAX_WINDOWS) {
    const oldest = fingerprintsByWindow.keys().next().value
    if (oldest !== undefined) fingerprintsByWindow.delete(oldest)
  }
  return elided
}
