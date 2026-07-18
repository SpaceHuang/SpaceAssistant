export type ExplicitPathIntent = 'output' | 'referenced-input' | 'unknown'

export type ExplicitPathEvidence = {
  evidenceId: string
  rawPath: string
  start: number
  end: number
  intent: ExplicitPathIntent
  trailingSeparator: boolean
}

function inferIntent(message: string, start: number): ExplicitPathIntent {
  const context = message.slice(Math.max(0, start - 20), start)
  if (/(?:读取|查看|检查|参考)/.test(context)) return 'referenced-input'
  if (/(?:保存为|保存到|写入|输出|生成|创建)/.test(context)) return 'output'
  return 'unknown'
}

/** Extract conservative quoted path evidence without treating arbitrary prose as a destination. */
export function extractExplicitPathEvidence(message: string, input: { requestId: string }): ExplicitPathEvidence[] {
  const matches = message.matchAll(/`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)'/g)
  const evidence: ExplicitPathEvidence[] = []
  for (const match of matches) {
    const rawPath = match[1] ?? match[2] ?? match[3] ?? ''
    if (!rawPath || match.index === undefined) continue
    const start = match.index
    const end = start + match[0].length
    evidence.push({
      evidenceId: `${input.requestId}:${start}:${end}`,
      rawPath,
      start,
      end,
      intent: inferIntent(message, start),
      trailingSeparator: /[\\/]$/.test(rawPath)
    })
  }
  const keywordMatches = message.matchAll(/(?:保存为|保存到|文件|目录|写入|输出|生成)\s+([A-Za-z0-9][A-Za-z0-9._-]*)/g)
  for (const match of keywordMatches) {
    const rawPath = match[1]!
    if (match.index === undefined) continue
    const start = match.index + match[0].lastIndexOf(rawPath)
    const end = start + rawPath.length
    if (evidence.some((item) => item.start === start && item.end === end)) continue
    evidence.push({
      evidenceId: `${input.requestId}:${start}:${end}`,
      rawPath,
      start,
      end,
      intent: 'output',
      trailingSeparator: false
    })
  }
  evidence.sort((left, right) => left.start - right.start)
  return evidence
}
