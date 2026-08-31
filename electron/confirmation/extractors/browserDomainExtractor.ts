import type { EnvFacts, FactSignal } from '../../../src/shared/confirmation/types'

function extractHostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * 浏览器域名提取器（§5.1）：动作 + 目标 URL → 通用 `network-egress` 信号。
 * 只产出事实（域名/动作），不放行/拒绝判定；域名信任命中由缓存查询承担。
 */
export function extractBrowserSignals(toolInput: Record<string, unknown>, _env: EnvFacts): {
  signals: FactSignal[]
  summary: string
} {
  const action = typeof toolInput.action === 'string' ? toolInput.action : ''
  const url = typeof toolInput.url === 'string' ? toolInput.url : ''
  const host = url ? extractHostFromUrl(url) : null
  const signals: FactSignal[] = []
  if (host) {
    signals.push({ kind: 'network-egress', domains: [host] })
    signals.push({ kind: 'outbound-target', channel: 'browser', recipient: host })
  }
  const summary = host ? `访问 ${host}（动作：${action}）` : `动作：${action}`
  return { signals, summary }
}
