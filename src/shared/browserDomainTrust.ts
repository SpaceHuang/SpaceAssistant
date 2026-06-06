/** Small public suffix list (PRD §5.2.3 — avoid full PSL) */
const PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'co.jp',
  'com.cn',
  'net.cn'
])

function extractHostname(url: string): string | null {
  try {
    const h = new URL(url).hostname
    if (!h) return null
    return h.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

/** Extract registrable domain for persistent trust (renderer + main process). */
export function extractTrustableDomain(url: string): string | null {
  const host = extractHostname(url)
  if (!host) return null
  if (host === 'localhost') return 'localhost'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return host.split(':')[0]!
  }
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  const lastThree = parts.slice(-3).join('.')
  if (PUBLIC_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.')
  }
  if (PUBLIC_SUFFIXES.has(lastThree.slice(lastThree.indexOf('.') + 1))) {
    return lastThree
  }
  return lastTwo
}
