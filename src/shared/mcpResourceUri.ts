const SENSITIVE_QUERY = /token|secret|password|passwd|cookie|auth|key|credential|sig|signature/i
import { maskSensitiveText } from './mcpSensitiveText'

export function sanitizeMcpResourceUri(input: string): string {
  const value = input.slice(0, 2048)
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_QUERY.test(key)) url.searchParams.delete(key)
    url.hash = ''
    return maskSensitiveText(url.toString().slice(0, 2048))
  } catch {
    return maskSensitiveText(value.replace(/(password|token|secret|key)=[^\s&#]+/gi, '$1=<redacted>').slice(0, 2048))
  }
}
