/**
 * edit_file 匹配失败（occ === 0）的结构化诊断。
 *
 * 依据 docs/develop/edit-file-match-failure-diagnosis-and-improvement-plan.md §5.1 / §5.2：
 * - 块窗口两阶段：1a 以 old_string 行数为窗口做线性粗筛出 top-K 短名单，1b 仅对短名单精算
 *   LCS 占比与字符级 opcodes —— LCS 调用次数 ≤ MAX_LCS_WINDOWS，不随窗口数乘性膨胀。
 * - 诊断与匹配器共用同一 EOL 归一口径（仅 \r\n → \n）；行号与偏移一律在归一视图上度量。
 * - suggestedOldString 是候选块的真实内容（整块 [X,Y] 行），下发前必经 §5.2.1 脱敏预检
 *   （与投影层同一个 sanitizeAgentText、同一 homeRules 状态）与 §5.2.2 长度上限，
 *   会被出口脱敏改写或超长的候选一律抑制下发。
 * - 反斜杠差异用「连续反斜杠个数」整数表达，不回传转义文本，消除层数歧义。
 */

import { sanitizeAgentText } from '../../src/shared/agentSafeText'
import {
  MAX_CANDIDATES,
  MAX_DIAGNOSIS_BLOCK_LINES,
  MAX_LCS_INPUT_CHARS,
  MAX_LCS_WINDOWS,
  MAX_SUGGESTED_OLD_STRING_CHARS,
  MIN_SIM_GAP
} from '../../src/shared/toolResultLimits'

export type EditMissingDiagnosisKind =
  | 'escape-layer-mismatch'
  | 'invisible-char-mismatch'
  | 'content-mismatch'
  | 'no-similar-line'
  | 'ambiguous-candidate'
  | 'block-too-large'

export interface EditDiagnosisDiff {
  /** 差异在提交文本（归一视图）上的起始偏移 */
  index: number
  /** escape 段：提交侧连续反斜杠个数 */
  submittedBackslashRun?: number
  /** escape 段：文件侧连续反斜杠个数 */
  fileBackslashRun?: number
  /** 非 escape 段的提交侧片段预览（≤ DIFF_PREVIEW_CHARS 字符） */
  submittedPreview?: string
  /** 非 escape 段的文件侧片段预览（≤ DIFF_PREVIEW_CHARS 字符） */
  filePreview?: string
}

export interface EditMissingDiagnosis {
  kind: EditMissingDiagnosisKind
  /** 归一视图下文件总行数 */
  totalLines: number
  /** old_string 行数（L ≥ 1） */
  oldLineCount: number
  /** 最相似块行号范围（1-based，含端点；多行时 [X, Y]） */
  candidateLineRange?: [number, number]
  /** top1 候选相似度（0～1） */
  similarity?: number
  /** top1 与 top2 的相似度差（ambiguous-candidate 时一并给出） */
  similarityGap?: number
  /** 唯一 top1 时的字符级差异（非 equal 段，最多 MAX_DIFFS 处） */
  diffs?: EditDiagnosisDiff[]
  /** 可用性预检通过后下发的候选块真实内容（归一视图，LF 行尾） */
  suggestedOldString?: string
  suggestedOldStringLength?: number
  usableAsOldString: boolean
  suppressionReason?: 'sanitize-would-rewrite' | 'too-long'
  hint: string
}

/** 单处差异预览与条数上限（§5.1 步骤 3：非 equal 段最多取 5 处） */
const MAX_DIFFS = 5
const DIFF_PREVIEW_CHARS = 60
const NO_SIMILAR_PREVIEW_CHARS = 80

/** LCS 全表 DP 的规模守卫（n*m 超过该值不做精算，避免主进程卡顿）；4096² ≈ 16.8M 在界内 */
const MAX_LCS_OPS = 20_000_000

/** 与 builtinExecutors.countOccurrencesWithEolTolerance 同口径（§5.1 步骤 0：不另立口径） */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** 按 \n 切行；文本以 \n 结尾时不产生尾空行（行号口径与编辑器一致） */
function splitLines(text: string): string[] {
  if (text === '') return ['']
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function charHistogram(text: string): Map<string, number> {
  const hist = new Map<string, number>()
  for (const ch of text) hist.set(ch, (hist.get(ch) ?? 0) + 1)
  return hist
}

/** 行级廉价相似度：字符直方图 Dice 系数为主、长度差为辅（线性代价，用于粗筛） */
function lineSimilarity(a: string, ha: Map<string, number>, b: string, hb: Map<string, number>): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  if (a === b) return 1
  let inter = 0
  for (const [ch, n] of ha) {
    const m = hb.get(ch)
    if (m) inter += Math.min(n, m)
  }
  const dice = (2 * inter) / (a.length + b.length)
  const lenSim = 1 - Math.abs(a.length - b.length) / maxLen
  return dice * 0.7 + lenSim * 0.3
}

export type Opcode = { tag: 'equal' | 'replace' | 'delete' | 'insert'; i1: number; i2: number; j1: number; j2: number }

/**
 * 最小 LCS + opcode 回溯（纯函数、无 I/O）。仅在 §5.1 步骤 1b 对短名单窗口调用，
 * 输入规模由 MAX_LCS_INPUT_CHARS / MAX_LCS_OPS 守卫。
 */
export function lcsOpcodes(a: string, b: string): Opcode[] {
  const n = a.length
  const m = b.length
  if (n === 0 || m === 0) {
    return n === 0 && m === 0 ? [] : [{ tag: n === 0 ? 'insert' : 'delete', i1: 0, i2: n, j1: 0, j2: m }]
  }
  if (n * m > MAX_LCS_OPS) return [{ tag: 'replace', i1: 0, i2: n, j1: 0, j2: m }]
  const width = m + 1
  const dp = new Uint16Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    const row = i * width
    const next = row + width
    const ca = a.charCodeAt(i)
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = ca === b.charCodeAt(j)
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1])
    }
  }
  const raw: Opcode[] = []
  let i = 0
  let j = 0
  const push = (tag: Opcode['tag'], i1: number, i2: number, j1: number, j2: number) => {
    if (i2 > i1 || j2 > j1) raw.push({ tag, i1, i2, j1, j2 })
  }
  while (i < n && j < m) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) {
      const i0 = i
      const j0 = j
      while (i < n && j < m && a.charCodeAt(i) === b.charCodeAt(j)) {
        i++
        j++
      }
      push('equal', i0, i, j0, j)
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      const i0 = i
      while (i < n && j < m && a.charCodeAt(i) !== b.charCodeAt(j) && dp[(i + 1) * width + j] >= dp[i * width + j + 1]) i++
      push('delete', i0, i, j, j)
    } else {
      const j0 = j
      while (i < n && j < m && a.charCodeAt(i) !== b.charCodeAt(j) && dp[(i + 1) * width + j] < dp[i * width + j + 1]) j++
      push('insert', i, i, j0, j)
    }
  }
  push('delete', i, n, j, j)
  push('insert', i, i, j, m)
  // 相邻 delete + insert 合并为 replace（difflib 语义），equal 段保持独立
  const ops: Opcode[] = []
  for (const op of raw) {
    const prev = ops[ops.length - 1]
    if (
      prev &&
      (op.tag === 'delete' || op.tag === 'insert') &&
      prev.tag === (op.tag === 'delete' ? 'insert' : 'delete') &&
      prev.i2 === op.i1 &&
      prev.j2 === op.j1
    ) {
      ops[ops.length - 1] = { tag: 'replace', i1: prev.i1, i2: op.i2, j1: prev.j1, j2: op.j2 }
    } else {
      ops.push(op)
    }
  }
  return ops
}

/** 连续反斜杠串的总长度（纯反斜杠段即 run 长度；混合段传达「差几个反斜杠」仍有意义） */
function backslashRunLength(s: string): number {
  let c = 0
  for (const ch of s) if (ch === '\\') c++
  return c
}

/** 把每段连续反斜杠压成单个 '\' 后比较，用于识别「仅层数不同」的段 */
function collapseBackslashRuns(s: string): string {
  return s.replace(/\\+/g, '\\')
}

const INVISIBLE_CHAR_RE = /[\r\t\0\v\f\u00a0\u200b-\u200f\u2028\u2029\ufeff]/

/**
 * 单个差异段是否「仅为反斜杠连续个数不同」：
 * - 两侧均为纯反斜杠串（一侧可为空）：run 长度差；
 * - 或两侧按 run 压缩后逐字符相等且都含反斜杠。
 */
function isBackslashRunDiff(sSeg: string, fSeg: string): boolean {
  const onlySlashes = (t: string) => /^\\*$/.test(t)
  if (onlySlashes(sSeg) && onlySlashes(fSeg)) return true
  if (collapseBackslashRuns(sSeg) === collapseBackslashRuns(fSeg) && sSeg.includes('\\') && fSeg.includes('\\')) return true
  return false
}

function truncatePreview(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

interface WindowCandidate {
  windowIndex: number
  score: number
  precise: boolean
  blockText: string
}

export function diagnoseMissingOldString(fileText: string, oldS: string): EditMissingDiagnosis {
  const fileNorm = normalizeEol(fileText)
  const oldNorm = normalizeEol(oldS)
  const fileLines = splitLines(fileNorm)
  const oldLines = splitLines(oldNorm)
  const totalLines = fileLines.length
  const oldLineCount = oldLines.length
  const base = { totalLines, oldLineCount }

  // 步骤 1：old_string 行数超限 → 不做块级诊断，不下发建议
  if (oldLineCount > MAX_DIAGNOSIS_BLOCK_LINES) {
    return {
      ...base,
      kind: 'block-too-large',
      usableAsOldString: false,
      hint: `未找到待替换的字符串。old_string 覆盖 ${oldLineCount} 行，超出诊断支持的块大小（文件共 ${totalLines} 行）。请缩小 old_string 范围或用 read_file 读取目标区间后重试 edit_file，不要改用脚本写文件。`
    }
  }

  // 步骤 1a：粗筛 —— 逐行直方图预计算一次，窗口分数为逐行相似度均值（线性代价）
  const oldHists = oldLines.map(charHistogram)
  const fileHists = fileLines.map(charHistogram)
  const windowCount = totalLines - oldLineCount + 1
  const coarse: Array<{ windowIndex: number; score: number }> = []
  if (windowCount > 0) {
    for (let w = 0; w < windowCount; w++) {
      let sum = 0
      for (let k = 0; k < oldLineCount; k++) {
        sum += lineSimilarity(oldLines[k], oldHists[k], fileLines[w + k], fileHists[w + k])
      }
      coarse.push({ windowIndex: w, score: sum / oldLineCount })
    }
    coarse.sort((a, b) => b.score - a.score)
  }

  // 步骤 1b：仅对短名单窗口精算 LCS（LCS 只对短名单计算，控成本）
  const shortlist = coarse.slice(0, MAX_LCS_WINDOWS)
  const candidates: WindowCandidate[] = shortlist.map((c) => {
    const blockText = fileLines.slice(c.windowIndex, c.windowIndex + oldLineCount).join('\n')
    const oversized = oldNorm.length > MAX_LCS_INPUT_CHARS || blockText.length > MAX_LCS_INPUT_CHARS
    let score = c.score
    let precise = false
    if (!oversized && oldNorm.length * blockText.length <= MAX_LCS_OPS) {
      const ops = lcsOpcodes(oldNorm, blockText)
      let lcs = 0
      for (const op of ops) if (op.tag === 'equal') lcs += op.i2 - op.i1
      const ratio = lcs / Math.max(oldNorm.length, blockText.length, 1)
      score = Math.max(score, ratio)
      precise = true
    }
    return { windowIndex: c.windowIndex, score, precise, blockText }
  })

  const lineRangeOf = (c: WindowCandidate): [number, number] => [c.windowIndex + 1, c.windowIndex + oldLineCount]

  // 步骤 2：候选筛选（阈值 0.5；歧义不下发建议）
  if (candidates.length === 0 || candidates[0].score < 0.5) {
    return {
      ...base,
      kind: 'no-similar-line',
      usableAsOldString: false,
      hint: `未找到待替换的字符串。文件共 ${totalLines} 行，未找到与 old_string 相似的块（提交首行：${truncatePreview(oldLines[0] ?? '', NO_SIMILAR_PREVIEW_CHARS)}）。请确认目标内容后重试 edit_file，不要改用脚本写文件。`
    }
  }
  const above = candidates.filter((c) => c.score >= 0.5)
  const top1 = above[0]
  const top2 = above[1]
  const gap = top1.score - (top2?.score ?? 0)
  if (above.length > MAX_CANDIDATES || (top2 && gap < MIN_SIM_GAP)) {
    return {
      ...base,
      kind: 'ambiguous-candidate',
      candidateLineRange: lineRangeOf(top1),
      similarity: top1.score,
      similarityGap: gap,
      usableAsOldString: false,
      hint: `未找到待替换的字符串。存在多个相似块（最佳：第 ${lineRangeOf(top1)[0]}–${lineRangeOf(top1)[1]} 行，相似度 ${top1.score.toFixed(3)}，与次优差距 ${gap.toFixed(3)}）。请提供更精确的上下文后重试 edit_file，不要改用脚本写文件。`
    }
  }

  // top1 明确但块超长（无法精算也无法下发）→ block-too-large
  if (!top1.precise) {
    return {
      ...base,
      kind: 'block-too-large',
      candidateLineRange: lineRangeOf(top1),
      similarity: top1.score,
      usableAsOldString: false,
      hint: `未找到待替换的字符串。最相似块（第 ${lineRangeOf(top1)[0]}–${lineRangeOf(top1)[1]} 行，相似度 ${top1.score.toFixed(3)}）超过诊断长度上限，无法下发建议。请用 read_file 读取该行区间后以正确内容重试 edit_file，不要改用脚本写文件。`
    }
  }

  // 步骤 3：对（候选块, old_string）做字符级对齐并分类
  const candidateBlock = top1.blockText
  const ops = lcsOpcodes(oldNorm, candidateBlock)
  const nonEqual = ops.filter((op) => op.tag !== 'equal')
  // 分类基于全量非 equal 段（不受 MAX_DIFFS 截断影响），diffs 条目按上限截断
  const segPair = nonEqual.map((op) => ({ s: oldNorm.slice(op.i1, op.i2), f: candidateBlock.slice(op.j1, op.j2) }))
  const allEscape = nonEqual.length > 0 && nonEqual.every((op) => isBackslashRunDiff(oldNorm.slice(op.i1, op.i2), candidateBlock.slice(op.j1, op.j2)))
  const hasInvisible = segPair.some(({ s, f }) => INVISIBLE_CHAR_RE.test(s) || INVISIBLE_CHAR_RE.test(f))
  const kind: EditMissingDiagnosisKind = allEscape
    ? 'escape-layer-mismatch'
    : hasInvisible
      ? 'invisible-char-mismatch'
      : 'content-mismatch'
  const diffs: EditDiagnosisDiff[] = []
  // escape 段的计数语义：该差异点两侧的连续反斜杠 run 长度（含 equal 上下文中的相邻 '\'），
  // 与计划 §5.1 返回结构示例一致（提交 1 个、文件 2 个），而不是插入段自身的字符数。
  const countExtend = (text: string, from: number, step: -1 | 1): number => {
    let c = 0
    let p = from
    while (p >= 0 && p < text.length && text[p] === '\\') {
      c++
      p += step
    }
    return c
  }
  const segRun = (t: string) => (t.match(/\\/g) ?? []).length
  for (const op of nonEqual) {
    if (diffs.length >= MAX_DIFFS) break
    const sSeg = oldNorm.slice(op.i1, op.i2)
    const fSeg = candidateBlock.slice(op.j1, op.j2)
    if (isBackslashRunDiff(sSeg, fSeg)) {
      const submittedRun = countExtend(oldNorm, op.i1 - 1, -1) + segRun(sSeg) + countExtend(oldNorm, op.i2, 1)
      const fileRun = countExtend(candidateBlock, op.j1 - 1, -1) + segRun(fSeg) + countExtend(candidateBlock, op.j2, 1)
      diffs.push({ index: op.i1, submittedBackslashRun: submittedRun, fileBackslashRun: fileRun })
    } else {
      diffs.push({ index: op.i1, submittedPreview: truncatePreview(sSeg, DIFF_PREVIEW_CHARS), filePreview: truncatePreview(fSeg, DIFF_PREVIEW_CHARS) })
    }
  }
  const [startLine, endLine] = lineRangeOf(top1)
  const similarity = top1.score

  // 步骤 4/5：hint 生成 + 可用性预检（§5.2.1 同一函数、同一 homeRules 状态）+ 长度上限（§5.2.2）
  const { text: sanitized } = sanitizeAgentText(candidateBlock)
  const wouldRewrite = sanitized !== candidateBlock
  const tooLong = candidateBlock.length > MAX_SUGGESTED_OLD_STRING_CHARS
  const escapeSummary = describeEscapeDiff(diffs)
  const location = `第 ${startLine}${startLine === endLine ? '' : `–${endLine}`} 行（相似度 ${similarity.toFixed(3)}）`

  if (wouldRewrite || tooLong) {
    const reason = wouldRewrite ? '敏感内容' : '长度'
    const diffClause = escapeSummary ? `；其差异为${escapeSummary}` : ''
    return {
      ...base,
      kind,
      candidateLineRange: [startLine, endLine],
      similarity,
      diffs,
      usableAsOldString: false,
      suppressionReason: wouldRewrite ? 'sanitize-would-rewrite' : 'too-long',
      hint: `未找到待替换的字符串。最相近块为${location}${diffClause}。该片段因${reason}未随诊断下发，请用 read_file 读取该行区间后以正确内容重试 edit_file，不要改用脚本写文件。`
    }
  }

  return {
    ...base,
    kind,
    candidateLineRange: [startLine, endLine],
    similarity,
    diffs,
    suggestedOldString: candidateBlock,
    suggestedOldStringLength: candidateBlock.length,
    usableAsOldString: true,
    hint: `未找到待替换的字符串。已定位最相似块（${location}${escapeSummary ? `，${escapeSummary}` : ''}）。请使用 diagnosis.suggestedOldString 作为 old_string 重新调用 edit_file，不要改用脚本写文件。`
  }
}

function describeEscapeDiff(diffs: EditDiagnosisDiff[]): string {
  const escapeDiffs = diffs.filter((d) => d.submittedBackslashRun !== undefined)
  if (escapeDiffs.length === 0) return ''
  const first = escapeDiffs[0]
  const fileRun = first.fileBackslashRun ?? 0
  const submittedRun = first.submittedBackslashRun ?? 0
  const direction = fileRun > submittedRun ? '多' : '少'
  if (escapeDiffs.length === 1) {
    return `反斜杠连续个数（文件 ${fileRun} 个、提交 ${submittedRun} 个，文件比提交${direction} ${Math.abs(fileRun - submittedRun)} 个）`
  }
  return `反斜杠连续个数（共 ${escapeDiffs.length} 处，首处为文件 ${fileRun} 个、提交 ${submittedRun} 个）`
}

// ---- P1-C：转义归一后唯一命中回退（默认关闭，入参 tolerate_escape_layer 显式开启；§5.3）----

/** 变体后单个反斜杠 run 的长度上限（§5.3：±1 个反斜杠，上限如 3 层） */
export const MAX_ESCAPE_RUN = 4

/** 变体集总数上限：超过即放弃回退（不做任意模糊搜索） */
export const MAX_ESCAPE_VARIANTS = 64

function replaceRange(s: string, start: number, end: number, replacement: string): string {
  return s.slice(0, start) + replacement + s.slice(end)
}

/**
 * 有限变体集：对每个连续反斜杠 run 生成 ±1 个反斜杠的变体（每次只动一个位点），
 * 以及 字面 `\n`（两字符）↔ 真实换行 的变体。不做正则、不做编辑距离搜索。
 * 超过 MAX_ESCAPE_VARIANTS 时返回空数组（放弃回退，退回诊断路径）。
 */
export function buildEscapeLayerVariants(oldNorm: string): Array<{ text: string; kind: 'escape-layer' | 'literal-newline'; backslashRunDelta: number }> {
  const totalBackslashes = backslashRunLength(oldNorm)
  const variants: Array<{ text: string; kind: 'escape-layer' | 'literal-newline'; backslashRunDelta: number }> = []
  const seen = new Set<string>([oldNorm])
  const push = (text: string, kind: 'escape-layer' | 'literal-newline') => {
    if (text === oldNorm || seen.has(text) || variants.length >= MAX_ESCAPE_VARIANTS) return
    seen.add(text)
    variants.push({ text, kind, backslashRunDelta: backslashRunLength(text) - totalBackslashes })
  }
  for (const m of oldNorm.matchAll(/\\+/g)) {
    const runLen = m[0].length
    const start = m.index
    if (runLen >= 2) push(replaceRange(oldNorm, start, start + runLen, '\\'.repeat(runLen - 1)), 'escape-layer')
    if (runLen + 1 <= MAX_ESCAPE_RUN) push(replaceRange(oldNorm, start, start + runLen, '\\'.repeat(runLen + 1)), 'escape-layer')
  }
  for (const m of oldNorm.matchAll(/\\n/g)) {
    push(replaceRange(oldNorm, m.index, m.index + 2, '\n'), 'literal-newline')
  }
  for (const m of oldNorm.matchAll(/\n/g)) {
    push(replaceRange(oldNorm, m.index, m.index + 1, '\\n'), 'literal-newline')
  }
  return variants
}
