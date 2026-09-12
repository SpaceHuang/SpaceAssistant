/**
 * Shell 子进程输出编解码的共享契约类型（需求 §7 / §8）。
 *
 * 主进程与渲染进程共用：主进程按契约解码并把诊断投影写进工具结果，
 * 渲染进程只消费（绝不做二次解码）。
 */

/** 输出编码契约的判别式。 */
export type OutputEncodingKind = 'auto' | 'utf8' | 'oem' | 'utf16le'

/**
 * 输出编码契约：描述「期望子进程按什么编码写出」。
 * - `auto`：无先验，完全交给 §8.1 判定链；
 * - `utf8`：宿主已钉死 UTF-8（如 PYTHONUTF8=1 / pwsh 7）；
 * - `oem`：宿主控制台使用 OEM 代码页（Windows PowerShell 5.1）；
 * - `utf16le`：已知原生输出 UTF-16LE。
 */
export type OutputEncodingContract =
  | { readonly kind: 'auto' }
  | { readonly kind: 'utf8' }
  | { readonly kind: 'oem'; readonly codepage: number }
  | { readonly kind: 'utf16le' }

/** 判定来源，用于诊断与长期度量（§10.4）。 */
export type OutputEncodingSource =
  | 'bom'
  | 'utf16-pattern'
  | 'utf16-structure'
  | 'strict-utf8'
  | 'contract'
  | 'oem-codepage'
  | 'fallback-latin1'

/** 判定置信度；`exact` 仅用于 BOM 这类无歧义证据。 */
export type DecodeConfidence = 'exact' | 'high' | 'medium' | 'low'

/** 单条流一次解码的元信息（H1：判定只发生一次，之后锁定）。 */
export interface DecodedStreamMeta {
  /** WHATWG TextDecoder 标签（如 `utf-8` / `gbk` / `utf-16le`）。 */
  readonly encoding: string
  readonly source: OutputEncodingSource
  readonly confidence: DecodeConfidence
  /** 判定命中 BOM 时需跳过的前导字节数。 */
  readonly bomBytes: number
  readonly contractKind: OutputEncodingKind
  /** 判定命中 OEM 代码页时实际生效的代码页。 */
  readonly codepage?: number
  /** 契约与实测不一致（契约被推翻）时记录。 */
  readonly contractConflict?: 'contract-mismatch'
  /** 判定尚未锁定（流式解码器仍在观察前导窗口）时为 true。 */
  readonly provisional?: boolean
}

/** 单条流的解码诊断投影（§10.4）。 */
export interface StreamDecodeDiagnostics {
  encoding: string
  source: OutputEncodingSource
  confidence: DecodeConfidence
  /** 解码产生的 U+FFFD 数量。 */
  replacements: number
  suspect: boolean
}

/** 原始字节留档信息（§10.6）。 */
export interface RawArtifactInfo {
  path: string
  bytes: number
  sha256: string
  reason: string
}