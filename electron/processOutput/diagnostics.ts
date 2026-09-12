import type {
  DecodedStreamMeta,
  OutputEncodingContract,
  StreamDecodeDiagnostics
} from '../../src/shared/outputEncoding'
import { sanitizeArtifactRef } from '../../src/shared/processResultProjection'
import { countNulChars, countReplacements, isDecodeSuspect } from './detectEncoding'

export interface LossStageInput {
  contract: OutputEncodingContract
  meta: DecodedStreamMeta
  text: string
}

/**
 * 单条流的诊断投影（§10.4）。
 * `replacements` 统计解码产生的 U+FFFD；可疑判定统一走 isDecodeSuspect。
 */
export function buildStreamDiagnostics(
  meta: DecodedStreamMeta,
  text: string,
  weakEvidence: boolean
): StreamDecodeDiagnostics {
  const replacements = countReplacements(text)
  return {
    encoding: meta.encoding,
    source: meta.source,
    confidence: meta.confidence,
    replacements,
    suspect: isDecodeSuspect(meta, { replacements, weakEvidence, nulChars: countNulChars(text) })
  }
}

/**
 * 区分「宿主内已丢」与「解码器丢」（§8.5 / §10.4）。
 *
 * 仅在以下三条同时成立时判定为 `host`：
 * 1. 契约是我们自己钉死的 UTF-8（例如 run_script 的 PYTHONUTF8=1）；
 * 2. 契约没有被推翻（没有 contractConflict）——说明原始字节本身就是合法 UTF-8；
 * 3. 文本里仍然出现 U+FFFD。
 * 此时替换字符不可能是我们解码造成的，只能是上游写管道之前就已经损坏。
 */
export function resolveLossStage(input: LossStageInput): 'host' | undefined {
  if (input.contract.kind !== 'utf8') return undefined
  if (input.meta.contractConflict) return undefined
  if (!input.text.includes('\uFFFD')) return undefined
  return 'host'
}

export interface OutputDiagLineInput {
  stream: 'stdout' | 'stderr'
  diagnostics: StreamDecodeDiagnostics
  contract: OutputEncodingContract
  contractConflict?: 'contract-mismatch'
  /** artifact 引用：传入持久化绝对路径也会被降级为 artifactId（同投影层规则）。 */
  rawArtifactPath?: string
}

/** 机器可读的纯 ASCII 诊断行（放在文本投影之后，便于稳定断言）。 */
export function formatOutputDiagLine(input: OutputDiagLineInput): string {
  const contractText = input.contract.kind === 'oem' ? `oem:${input.contract.codepage}` : input.contract.kind
  return [
    '[output-diag]',
    `stream=${input.stream}`,
    `encoding=${input.diagnostics.encoding}`,
    `source=${input.diagnostics.source}`,
    `confidence=${input.diagnostics.confidence}`,
    `replacements=${input.diagnostics.replacements}`,
    `contract=${contractText}`,
    `conflict=${input.contractConflict ?? 'none'}`,
    `suspect=${input.diagnostics.suspect}`,
    `rawArtifact=${sanitizeArtifactRef(input.rawArtifactPath)}`
  ].join(' ')
}

export function resolveOutputTrust(...diagnostics: readonly StreamDecodeDiagnostics[]): 'ok' | 'suspect' {
  return diagnostics.some((item) => item.suspect) ? 'suspect' : 'ok'
}
