import { createHash } from 'node:crypto'
import type { ScriptAuditFinding, ScriptAuditInput, ScriptAuditRef } from './types'

/** Storage bounds for the audit projection; analysis facts remain complete and untruncated. */
export const SCRIPT_AUDIT_MAX_FINDINGS = 16
export const SCRIPT_AUDIT_MAX_SNIPPET_CHARS = 2_000

export interface ProjectedScriptSnippet {
  skeleton: string
  truncated: boolean
}

const NUMBER_LITERAL = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?j?)/
const STRING_PREFIX = /^[rRuUbBfF]{1,3}(?=['"])/

function consumeString(source: string, quoteStart: number, prefixStart: number): { end: number; skeleton: string } | null {
  // f-string replacement fields contain Python expressions with their own strings and
  // nested f-strings. Until this projector can parse those lexical boundaries, fail closed
  // instead of treating a quote inside an expression as the outer string terminator.
  if (source.slice(prefixStart, quoteStart).toLowerCase().includes('f')) return null
  const quote = source[quoteStart]!
  const delimiter = source.slice(quoteStart, quoteStart + 3) === quote.repeat(3) ? quote.repeat(3) : quote
  let cursor = quoteStart + delimiter.length
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += Math.min(2, source.length - cursor)
      continue
    }
    if (source.slice(cursor, cursor + delimiter.length) === delimiter) {
      const end = cursor + delimiter.length
      const prefix = source.slice(prefixStart, quoteStart)
      return { end, skeleton: `${prefix}${delimiter}…${delimiter}` }
    }
    cursor += 1
  }
  return null
}

function projectLine(line: string): string | null {
  let cursor = 0
  let output = ''
  while (cursor < line.length) {
    if (line[cursor] === '#') {
      output += '# …'
      break
    }

    const prefix = STRING_PREFIX.exec(line.slice(cursor))
    const prefixLength = prefix?.[0].length ?? 0
    const quoteStart = cursor + prefixLength
    if (line[quoteStart] === '"' || line[quoteStart] === "'") {
      const string = consumeString(line, quoteStart, cursor)
      if (!string) return null
      output += string.skeleton
      cursor = string.end
      continue
    }

    const number = NUMBER_LITERAL.exec(line.slice(cursor))
    if (number?.[0]) {
      output += '…'
      cursor += number[0].length
      continue
    }

    output += line[cursor]
    cursor += 1
  }
  return output
}

/**
 * facts stage → audit storage projection: mask Python string/number literals and comments,
 * preserving code structure only. Unterminated strings fail closed to `[unavailable]`.
 */
export function projectScriptSnippet(snippet: string, maxChars = SCRIPT_AUDIT_MAX_SNIPPET_CHARS): ProjectedScriptSnippet {
  const normalized = snippet.replace(/\r\n?/g, '\n')
  const projectedLines = normalized.split('\n').map(projectLine)
  if (projectedLines.some((line) => line === null)) return { skeleton: '[unavailable]', truncated: false }
  const fullSkeleton = projectedLines.join('\n')
  return fullSkeleton.length > maxChars
    ? { skeleton: fullSkeleton.slice(0, maxChars), truncated: true }
    : { skeleton: fullSkeleton, truncated: false }
}

/**
 * policy-independent audit projection. Hash the normalized raw snippet before projection/truncation;
 * the `(pattern, range)` pair remains the location key and does not participate in the digest.
 */
export function createScriptAuditRef(
  sessionId: string,
  input: ScriptAuditInput
): ScriptAuditRef | null {
  if (!/^[a-f0-9]{64}$/i.test(input.contentDigest) || !input.turnId || !Number.isSafeInteger(input.totalCount) || input.totalCount < 0) {
    return null
  }
  const selected = input.findings.slice(0, SCRIPT_AUDIT_MAX_FINDINGS)
  let truncated = input.totalCount > selected.length || input.findings.length > selected.length
  const findings = selected.map((finding) => {
    const rawSnippet = finding.snippet.replace(/\r\n?/g, '\n')
    const projection = projectScriptSnippet(rawSnippet)
    truncated ||= projection.truncated
    return {
      pattern: finding.pattern,
      class: finding.class,
      range: { ...finding.range },
      skeleton: projection.skeleton,
      snippetSha256: createHash('sha256').update(rawSnippet, 'utf8').digest('hex')
    }
  })
  return {
    sessionId,
    turnId: input.turnId,
    contentDigest: input.contentDigest.toLowerCase(),
    totalCount: input.totalCount,
    truncated,
    findings
  }
}
