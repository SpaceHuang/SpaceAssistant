export type DiffLine = { type: 'add' | 'remove' | 'context'; text: string }

export type BoundedDiffLineStats =
  | Readonly<{ kind: 'available'; add: number; remove: number }>
  | Readonly<{ kind: 'unavailable'; reason: 'input-too-large' | 'work-budget-exceeded' | 'computation-failed' }>

/** Maximum combined UTF-16 code units inspected for write-result statistics. */
export const MAX_DIFF_STATS_INPUT_CHARS = 2_000_000
/** Maximum line count per input before allocating line arrays. */
export const MAX_DIFF_STATS_LINES = 100_000
/** Maximum LCS cell updates after equal prefix/suffix trimming. */
export const MAX_DIFF_STATS_WORK_CELLS = 1_000_000

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

export function buildUnifiedDiffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: 'context', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'remove', text: a[i]! })
      i++
    } else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < m) {
    out.push({ type: 'remove', text: a[i++]! })
  }
  while (j < n) {
    out.push({ type: 'add', text: b[j++]! })
  }
  return out
}

export function diffLineStats(lines: DiffLine[]): { add: number; remove: number } {
  let add = 0
  let remove = 0
  for (const line of lines) {
    if (line.type === 'add') add++
    else if (line.type === 'remove') remove++
  }
  return { add, remove }
}

export function computeDiffLineStats(oldText: string, newText: string): { add: number; remove: number } {
  return diffLineStats(buildUnifiedDiffLines(oldText, newText))
}

/**
 * Bounded, linear-memory line statistics for write results. Equal edges are removed first;
 * the remaining LCS work is rejected before row allocation when it exceeds the fixed budget.
 * Failure is represented as unavailable so a completed write can keep its success result.
 */
export function computeBoundedDiffLineStats(oldText: string, newText: string): BoundedDiffLineStats {
  try {
    if (oldText.length + newText.length > MAX_DIFF_STATS_INPUT_CHARS) {
      return { kind: 'unavailable', reason: 'input-too-large' }
    }
    const oldLineCount = countLines(oldText)
    const newLineCount = countLines(newText)
    if (oldLineCount > MAX_DIFF_STATS_LINES || newLineCount > MAX_DIFF_STATS_LINES) {
      return { kind: 'unavailable', reason: 'input-too-large' }
    }

    const oldLines = splitLines(oldText)
    const newLines = splitLines(newText)
    let prefix = 0
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
    let oldEnd = oldLines.length
    let newEnd = newLines.length
    while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
      oldEnd--
      newEnd--
    }

    const oldMiddleLength = oldEnd - prefix
    const newMiddleLength = newEnd - prefix
    if (oldMiddleLength * newMiddleLength > MAX_DIFF_STATS_WORK_CELLS) {
      return { kind: 'unavailable', reason: 'work-budget-exceeded' }
    }

    // LCS length is symmetric; keep the rolling rows on the shorter middle sequence.
    const outer = oldMiddleLength >= newMiddleLength ? oldLines : newLines
    const inner = oldMiddleLength >= newMiddleLength ? newLines : oldLines
    const outerStart = prefix
    const innerStart = prefix
    const outerEnd = oldMiddleLength >= newMiddleLength ? oldEnd : newEnd
    const innerEnd = oldMiddleLength >= newMiddleLength ? newEnd : oldEnd
    const innerLength = innerEnd - innerStart
    let previous = new Uint32Array(innerLength + 1)
    let current = new Uint32Array(innerLength + 1)
    for (let i = outerStart; i < outerEnd; i++) {
      current[0] = 0
      for (let j = 1; j <= innerLength; j++) {
        current[j] = outer[i] === inner[innerStart + j - 1]
          ? previous[j - 1]! + 1
          : Math.max(previous[j]!, current[j - 1]!)
      }
      const priorRow = previous
      previous = current
      current = priorRow
    }
    const commonLines = prefix + (oldLines.length - oldEnd) + previous[innerLength]!
    return { kind: 'available', add: newLines.length - commonLines, remove: oldLines.length - commonLines }
  } catch {
    return { kind: 'unavailable', reason: 'computation-failed' }
  }
}

function countLines(text: string): number {
  if (text === '') return 0
  let count = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++
  return count
}
