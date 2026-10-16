import type { FactSignal } from './types'

type ImAttachmentAssessmentSignal = Extract<FactSignal, { kind: 'wechat-media-content-assessment' }>
export type ImAttachmentEvidenceKind = ImAttachmentAssessmentSignal['evidenceKinds'][number]
export type ImAttachmentFacts = Omit<ImAttachmentAssessmentSignal, 'kind'>

export interface CreateImAttachmentFactsInput {
  fileName: string
  relativePath: string
  content: string
  contentDigest: string
  inspectionCoverage: ImAttachmentFacts['inspectionCoverage']
}

const EXTRACTOR_VERSION = 'host-im-attachment-v1' as const
const CREDENTIAL_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|password)\s*[:=]|(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,})/i
const PERSONAL_DATA_PATTERN = /\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\d ()-]{8,}\d)\b|(?:客户|用户|联系人).{0,16}(?:邮箱|电话|地址|身份证|记录|信息)/i
const SENSITIVE_PATH_PATTERN = /(^|[/\\.])(?:\.env|credentials?|secrets?|private|exports?)([/\\._-]|$)|\.(?:pem|key|p12|pfx)$/i

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('IM_ATTACHMENT_FACTS_CRYPTO_UNAVAILABLE')
  const bytes = new TextEncoder().encode(value)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Report attachment observations only; the original bytes, name, and path are never returned. */
export async function createImAttachmentFacts(input: CreateImAttachmentFactsInput): Promise<ImAttachmentFacts> {
  if (!/^[a-f0-9]{64}$/i.test(input.contentDigest)) throw new Error('IM_ATTACHMENT_FACTS_DIGEST_INVALID')
  const evidenceKinds: ImAttachmentEvidenceKind[] = []
  if (input.inspectionCoverage === 'complete') {
    if (SENSITIVE_PATH_PATTERN.test(`${input.fileName} ${input.relativePath}`)) evidenceKinds.push('sensitive-path-name')
    if (CREDENTIAL_PATTERN.test(input.content)) evidenceKinds.push('credential-like-pattern')
    if (PERSONAL_DATA_PATTERN.test(input.content)) evidenceKinds.push('personal-data-pattern')
  }
  const factId = `fact-${(await sha256(JSON.stringify([EXTRACTOR_VERSION, input.contentDigest.toLowerCase(),
    input.inspectionCoverage, evidenceKinds]))).slice(0, 24)}`
  return Object.freeze({
    factId,
    contentDigest: input.contentDigest.toLowerCase(),
    extractorVersion: EXTRACTOR_VERSION,
    inspectionCoverage: input.inspectionCoverage,
    evidenceKinds: Object.freeze(evidenceKinds)
  })
}
