export type ImOutboundContentClass = 'ordinary' | 'sensitive' | 'bulk-local-export' | 'permission-change' | 'private-query' | 'upload' | 'unknown'

export type ImOutboundEvidenceKind =
  | 'credential-like-pattern'
  | 'local-path-reference'
  | 'bulk-export-language'
  | 'permission-change-language'

export interface ImOutboundContentFacts {
  readonly factId: string
  readonly contentDigest: string
  readonly classifierVersion: 'host-im-outbound-v1'
  readonly inspectionCoverage: 'complete' | 'partial' | 'unavailable'
  readonly evidenceKinds: readonly ImOutboundEvidenceKind[]
}

const CLASSIFIER_VERSION = 'host-im-outbound-v1' as const
const CREDENTIAL_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]|(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,})/i
const LOCAL_PATH_PATTERN = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/i
const BULK_EXPORT_PATTERN = /\b(?:all|bulk|entire|every)\s+(?:customer|user|message|record|file)s?\b|批量|全部客户|所有用户|所有记录|通讯录导出/i
const PERMISSION_CHANGE_PATTERN = /\b(?:permission|privilege|access control)\s+(?:change|grant|revoke)|权限变更|授权变更/i

/** Classify only observable content patterns. This helper has no policy or execution dependency. */
export function classifyImOutboundContent(body: string): ImOutboundContentClass {
  if (!body.trim() || body.length > 20_000) return 'unknown'
  if (CREDENTIAL_PATTERN.test(body) || LOCAL_PATH_PATTERN.test(body)) return 'sensitive'
  if (BULK_EXPORT_PATTERN.test(body)) return 'bulk-local-export'
  if (PERMISSION_CHANGE_PATTERN.test(body)) return 'permission-change'
  return 'ordinary'
}

function evidenceFor(body: string): ImOutboundEvidenceKind[] {
  const evidence: ImOutboundEvidenceKind[] = []
  if (CREDENTIAL_PATTERN.test(body)) evidence.push('credential-like-pattern')
  if (LOCAL_PATH_PATTERN.test(body)) evidence.push('local-path-reference')
  if (BULK_EXPORT_PATTERN.test(body)) evidence.push('bulk-export-language')
  if (PERMISSION_CHANGE_PATTERN.test(body)) evidence.push('permission-change-language')
  return evidence
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('IM_OUTBOUND_FACTS_CRYPTO_UNAVAILABLE')
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Produce a versioned, content-free fact snapshot. It reports evidence and inspection coverage only. */
export async function createImOutboundFacts(body: string): Promise<ImOutboundContentFacts> {
  const contentDigest = await sha256(body)
  const inspectionCoverage = body.length > 20_000 ? 'unavailable' : body.trim() ? 'complete' : 'partial'
  const evidenceKinds = inspectionCoverage === 'complete' ? evidenceFor(body) : []
  const factDigest = await sha256(`${CLASSIFIER_VERSION}\0${contentDigest}`)
  return Object.freeze({
    factId: `fact-${factDigest.slice(0, 24)}`,
    contentDigest,
    classifierVersion: CLASSIFIER_VERSION,
    inspectionCoverage,
    evidenceKinds: Object.freeze(evidenceKinds)
  })
}
