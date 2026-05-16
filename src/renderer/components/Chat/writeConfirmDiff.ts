export type DiffLine = { type: 'add' | 'remove' | 'context'; text: string }

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
