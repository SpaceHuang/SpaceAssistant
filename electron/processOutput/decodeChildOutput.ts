import { TextDecoder } from 'util'
import type { DecodedStreamMeta, OutputEncodingContract } from '../../src/shared/outputEncoding'
import { expectedLabelForContract, labelForOemCodepage, resolveOemCodepage } from './contracts'
import {
  countReplacements,
  decodeWithLabel,
  detectEncoding,
  FALLBACK_ENCODING_LABEL,
  isAsciiText,
  type DetectEncodingOptions
} from './detectEncoding'

export interface DecodeChildOutputOptions {
  contract: OutputEncodingContract
  platform?: NodeJS.Platform
  oemCodepage?: number
}

export interface DecodedChildOutput {
  text: string
  meta: DecodedStreamMeta
  replacements: number
}

/**
 * 一次性解码（短输出、测试、探测类调用）。
 * 与流式解码器共用同一条判定链（§8.3 硬约束）。
 */
export function decodeChildOutput(buf: Buffer, options: DecodeChildOutputOptions): DecodedChildOutput {
  const contractKind = options.contract.kind
  if (buf.length === 0) {
    const label = expectedLabelForContract(options.contract) ?? 'utf-8'
    return {
      text: '',
      meta: { encoding: label, source: 'contract', confidence: 'high', bomBytes: 0, contractKind },
      replacements: 0
    }
  }
  const { meta } = detectEncoding(buf, options)
  const text = decodeWithLabel(meta.encoding, buf.subarray(meta.bomBytes))
  return { text, meta, replacements: countReplacements(text) }
}

export interface CreateChildStreamDecoderOptions extends DecodeChildOutputOptions {
  /** 未判定缓冲上限，默认 8 KiB；0 表示「首块即判定」（§8.2 / D3） */
  windowBytes?: number
}

export interface ChildStreamDecoder {
  write(chunk: Buffer): string
  end(): string
  readonly meta: DecodedStreamMeta
  /** 累计消费的原始字节数（G8 口径） */
  readonly rawBytes: number
  /** 仍在前导缓冲中的字节数 */
  readonly bufferedBytes: number
  readonly locked: boolean
  readonly weakEvidence: boolean
}

const DEFAULT_WINDOW_BYTES = 8 * 1024

interface Candidate {
  label: string
  decoder: TextDecoder
  output: string
  dead: boolean
  muted: boolean
}

function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]
  for (let index = 1; index < values.length && prefix.length > 0; index += 1) {
    const other = values[index]
    let length = 0
    const limit = Math.min(prefix.length, other.length)
    while (length < limit && prefix[length] === other[length]) length += 1
    prefix = prefix.slice(0, length)
  }
  return prefix
}

function buildCandidateLabels(contract: OutputEncodingContract, oemLabel: string | undefined): string[] {
  const base = contract.kind === 'utf16le'
    ? ['utf-16le', 'utf-8']
    : contract.kind === 'oem'
      ? [oemLabel, 'utf-8']
      : ['utf-8', oemLabel]
  const unique: string[] = []
  for (const label of [...base, 'utf-16le']) {
    if (typeof label !== 'string' || label.length === 0) continue
    if (label === FALLBACK_ENCODING_LABEL) continue
    if (unique.includes(label)) continue
    unique.push(label)
  }
  return unique.slice(0, 3)
}

/**
 * 流式解码器（§8.2 交付与锁定分离）。
 *
 * - 交付规则：所有在场候选对缓冲前缀解出的文本一致时立即交付该前缀（纯 ASCII 必然满足）；
 * - 锁定规则：强证据（BOM / UTF-16 零字节模式）、候选收敛到唯一、达到 windowBytes、或流结束；
 * - 锁定后只用该 TextDecoder 的 `{stream:true}` 增量解码，永不改判、不重解历史。
 */
export function createChildStreamDecoder(options: CreateChildStreamDecoderOptions): ChildStreamDecoder {
  const platform = options.platform ?? process.platform
  const windowBytes = options.windowBytes ?? DEFAULT_WINDOW_BYTES
  const oemCodepage = resolveOemCodepage(options.contract, options.oemCodepage, platform)
  const oemLabel = labelForOemCodepage(oemCodepage)
  const contractLabel = expectedLabelForContract(options.contract)
  const contractKind = options.contract.kind
  const detectOptions: DetectEncodingOptions = { contract: options.contract, platform, oemCodepage }

  const candidates: Candidate[] = buildCandidateLabels(options.contract, oemLabel).map((label) => ({
    label,
    decoder: new TextDecoder(label, { fatal: true }),
    output: '',
    dead: false,
    muted: false
  }))

  let history = Buffer.alloc(0)
  let delivered = ''
  let rawBytes = 0
  let lockedDecoder: TextDecoder | undefined
  let lockedMeta: DecodedStreamMeta | undefined
  let lockedWeakEvidence = false

  const provisionalMeta = (): DecodedStreamMeta => ({
    encoding: 'unknown',
    source: 'contract',
    confidence: 'low',
    bomBytes: 0,
    contractKind,
    provisional: true
  })

  const emit = (fullText: string): string => {
    if (fullText.length <= delivered.length) return ''
    if (!fullText.startsWith(delivered)) return ''
    const delta = fullText.slice(delivered.length)
    delivered = fullText
    return delta
  }

  const metaForLabel = (label: string): DecodedStreamMeta => {
    const conflict = contractLabel !== undefined && contractLabel !== label ? ('contract-mismatch' as const) : undefined
    const shared = { bomBytes: 0, contractKind, codepage: oemCodepage } as const
    if (label === contractLabel) {
      return { ...shared, encoding: label, source: 'contract', confidence: 'high', contractConflict: undefined }
    }
    if (label === 'utf-8') return { ...shared, encoding: label, source: 'strict-utf8', confidence: 'high', contractConflict: conflict }
    if (oemLabel !== undefined && label === oemLabel) {
      return { ...shared, encoding: label, source: 'oem-codepage', confidence: 'high', contractConflict: conflict }
    }
    return { ...shared, encoding: label, source: 'utf16-structure', confidence: 'medium', contractConflict: conflict }
  }

  const lock = (meta: DecodedStreamMeta, weakEvidence: boolean): string => {
    const decoder = new TextDecoder(meta.encoding)
    const fullText = decoder.decode(history.subarray(meta.bomBytes), { stream: true })
    if (!fullText.startsWith(delivered)) {
      // §8.6 守卫：已交付前缀必须与锁定编码一致；否则退回可逆兜底并标记可疑。
      const fallbackDecoder = new TextDecoder(FALLBACK_ENCODING_LABEL)
      const fallbackText = fallbackDecoder.decode(history, { stream: true })
      lockedDecoder = fallbackDecoder
      lockedMeta = {
        encoding: FALLBACK_ENCODING_LABEL,
        source: 'fallback-latin1',
        confidence: 'low',
        bomBytes: 0,
        contractKind,
        codepage: oemCodepage
      }
      lockedWeakEvidence = true
      return emit(fallbackText)
    }
    lockedDecoder = decoder
    lockedMeta = meta
    lockedWeakEvidence = weakEvidence
    return emit(fullText)
  }

  const feed = (chunk: Buffer): void => {
    for (const candidate of candidates) {
      if (candidate.dead) continue
      try {
        candidate.output += candidate.decoder.decode(chunk, { stream: true })
      } catch {
        candidate.dead = true
      }
    }
    // 纯 ASCII 前缀下 UTF-16 解释不成立：先「静音」而不是淘汰（后续字节可能重新成立）。
    const asciiPrefix = isAsciiText(history)
    for (const candidate of candidates) {
      if (candidate.label.startsWith('utf-16')) candidate.muted = asciiPrefix
    }
  }

  const inPlay = (): Candidate[] => candidates.filter((candidate) => !candidate.dead && !candidate.muted)

  const write = (chunk: Buffer): string => {
    if (chunk.length === 0) return ''
    rawBytes += chunk.length
    if (lockedDecoder) {
      const delta = lockedDecoder.decode(chunk, { stream: true })
      delivered += delta
      return delta
    }
    history = history.length === 0 ? Buffer.from(chunk) : Buffer.concat([history, chunk])
    feed(chunk)

    const strong = detectEncoding(history, detectOptions)
    if (strong.meta.source === 'bom' || strong.meta.source === 'utf16-pattern') {
      return lock(strong.meta, strong.weakEvidence)
    }

    const live = inPlay().filter((candidate) => !candidate.dead)
    if (live.length === 0) {
      return lock(metaForLabel(FALLBACK_ENCODING_LABEL), true)
    }
    if (live.length === 1) {
      return lock(metaForLabel(live[0].label), false)
    }
    if (windowBytes === 0 || history.length >= windowBytes) {
      const decision = detectEncoding(history, detectOptions)
      return lock(decision.meta, decision.weakEvidence)
    }
    return emit(longestCommonPrefix(inPlay().map((candidate) => candidate.output)))
  }

  /** 冲刷已锁定解码器的尾部（flush）；未锁定则返回空串。 */
  const flushTail = (): string => {
    const decoder = lockedDecoder
    if (!decoder) return ''
    const tail = decoder.decode()
    delivered += tail
    return tail
  }

  const end = (): string => {
    if (!lockedDecoder) {
      if (history.length === 0) {
        const label = contractLabel ?? 'utf-8'
        lockedMeta = { encoding: label, source: contractLabel ? 'contract' : 'strict-utf8', confidence: 'high', bomBytes: 0, contractKind, codepage: oemCodepage }
        lockedDecoder = new TextDecoder(label)
        return ''
      }
      const decision = detectEncoding(history, detectOptions)
      const out = lock(decision.meta, decision.weakEvidence)
      return out + flushTail()
    }
    return flushTail()
  }

  return {
    write,
    end,
    get meta(): DecodedStreamMeta {
      return lockedMeta ?? provisionalMeta()
    },
    get rawBytes(): number {
      return rawBytes
    },
    get bufferedBytes(): number {
      return lockedDecoder ? 0 : history.length
    },
    get locked(): boolean {
      return lockedDecoder !== undefined
    },
    get weakEvidence(): boolean {
      return lockedWeakEvidence
    }
  }
}
