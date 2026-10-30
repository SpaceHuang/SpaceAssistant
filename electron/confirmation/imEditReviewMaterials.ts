import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import type { ApprovalReviewMaterials } from '../../src/shared/confirmation/types'
import type { WritePathFact } from './extractors/writePathFacts'

export const REVIEW_MATERIAL_MAX_BYTES = 20_000

type EditReviewFields = Extract<ApprovalReviewMaterials, { kind: 'outside-file-write' }>

async function readWriteTargetForReview(fact: WritePathFact | undefined): Promise<string | undefined> {
  const expected = fact?.identity
  if (!fact || fact.targetKind !== 'file' || !expected || expected.size > REVIEW_MATERIAL_MAX_BYTES) return undefined
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(fact.normalizedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
    const before = await handle.stat()
    const matches = (stat: typeof before) => stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino &&
      stat.mode === expected.mode && stat.size === expected.size && stat.mtimeMs === expected.mtimeMs && stat.nlink === expected.nlink
    if (!matches(before)) return undefined
    const buffer = Buffer.alloc(REVIEW_MATERIAL_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat()
    if (bytesRead !== expected.size || !matches(after)) return undefined
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function previewEditScope(targetContent: string, oldText: string, replacementText: string, replaceAll: boolean) {
  const fileEol = targetContent.includes('\r\n') ? '\r\n' : '\n'
  const source = targetContent.replace(/\r\n/g, '\n')
  const needle = oldText.replace(/\r\n/g, '\n')
  const replacement = replacementText.replace(/\r\n/g, '\n')
  const matchRanges: Array<{ startLine: number; endLine: number }> = []
  let matchRangesTruncated = false
  if (needle) {
    let cursor = 0
    let lineCursor = 0
    let currentLine = 1
    while (cursor <= source.length) {
      const index = source.indexOf(needle, cursor)
      if (index < 0) break
      if (matchRanges.length >= 128) { matchRangesTruncated = true; break }
      const beforeMatch = source.slice(lineCursor, index)
      currentLine += (beforeMatch.match(/\n/g) ?? []).length
      const startLine = currentLine
      const matchedText = source.slice(index, index + needle.length)
      const endLine = startLine + (matchedText.match(/\n/g) ?? []).length
      matchRanges.push({ startLine, endLine })
      cursor = index + needle.length
      lineCursor = cursor
      currentLine = endLine
    }
  }
  const matchCount = matchRanges.length + (matchRangesTruncated ? 1 : 0)
  const executionOutcome = matchCount === 0 ? 'no-match' as const
    : matchCount > 1 && !replaceAll ? 'rejects-ambiguous-matches' as const
      : replaceAll ? 'applies-all' as const : 'applies-first' as const
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  const needleBytes = Buffer.byteLength(needle, 'utf8')
  const replacementBytes = Buffer.byteLength(replacement, 'utf8')
  const projectedBytes = executionOutcome === 'applies-all'
    ? sourceBytes - (matchCount * needleBytes) + (matchCount * replacementBytes)
    : executionOutcome === 'applies-first' ? sourceBytes - needleBytes + replacementBytes : sourceBytes
  const sourceNewlines = (source.match(/\n/g) ?? []).length
  const needleNewlines = (needle.match(/\n/g) ?? []).length
  const replacementNewlines = (replacement.match(/\n/g) ?? []).length
  const outputNewlines = executionOutcome === 'applies-all'
    ? sourceNewlines - (matchCount * needleNewlines) + (matchCount * replacementNewlines)
    : executionOutcome === 'applies-first' ? sourceNewlines - needleNewlines + replacementNewlines : sourceNewlines
  const proposedContentAvailable = !matchRangesTruncated &&
    projectedBytes + (fileEol === '\r\n' ? outputNewlines : 0) <= REVIEW_MATERIAL_MAX_BYTES
  let proposed = source
  if (proposedContentAvailable && executionOutcome === 'applies-all') proposed = source.split(needle).join(replacement)
  else if (proposedContentAvailable && executionOutcome === 'applies-first') {
    const index = source.indexOf(needle)
    proposed = source.slice(0, index) + replacement + source.slice(index + needle.length)
  }
  if (proposedContentAvailable && fileEol === '\r\n') proposed = proposed.replace(/\n/g, '\r\n')
  return { matchCount, matchRanges, matchRangesTruncated, executionOutcome,
    ...(proposedContentAvailable ? { proposedContent: proposed } : {}), proposedContentAvailable }
}

/** Read bounded target identity and project the exact edit options plus the executor-equivalent result. */
export async function createOutsideEditReviewFields(input: {
  targetFact?: WritePathFact
  target: string
  oldText: string
  replacementText: string
  replaceAll: boolean
  tolerateEscapeLayer: boolean
}): Promise<Omit<EditReviewFields, 'kind' | 'operation' | 'target'>> {
  const targetContent = await readWriteTargetForReview(input.targetFact)
  const oldTextWithinBounds = Buffer.byteLength(input.oldText, 'utf8') <= REVIEW_MATERIAL_MAX_BYTES
  const replacementWithinBounds = Buffer.byteLength(input.replacementText, 'utf8') <= REVIEW_MATERIAL_MAX_BYTES
  const withinBounds = oldTextWithinBounds && replacementWithinBounds &&
    Buffer.byteLength(input.oldText, 'utf8') + Buffer.byteLength(input.replacementText, 'utf8') <= REVIEW_MATERIAL_MAX_BYTES &&
    targetContent !== undefined && Buffer.byteLength(targetContent, 'utf8') <= REVIEW_MATERIAL_MAX_BYTES && input.oldText.length > 0
  const preview = withinBounds ? previewEditScope(targetContent!, input.oldText, input.replacementText, input.replaceAll) : undefined
  const complete = Boolean(withinBounds && preview?.proposedContentAvailable && !preview.matchRangesTruncated &&
    !(input.tolerateEscapeLayer && preview.matchCount === 0))
  return {
    ...(oldTextWithinBounds ? { oldText: input.oldText } : {}),
    ...(replacementWithinBounds ? { replacementText: input.replacementText } : {}),
    ...(targetContent !== undefined ? { targetContent } : {}),
    replaceAll: input.replaceAll,
    tolerateEscapeLayer: input.tolerateEscapeLayer,
    ...(preview ? { matchCount: preview.matchCount, matchRanges: preview.matchRanges, matchRangesTruncated: preview.matchRangesTruncated,
      executionOutcome: preview.executionOutcome, ...(preview.proposedContentAvailable ? { proposedContent: preview.proposedContent } : {}) } : {}),
    complete
  }
}
