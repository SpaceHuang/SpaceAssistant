import type { EnvFacts, FactSignal } from '../../../src/shared/confirmation/types'

function extractHostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname || null
  } catch {
    return null
  }
}

/**
 * 浏览器域名提取器（§5.1）：动作 + 目标域名 → 事实信号。
 * 只产出事实（域名/动作/高危结论），不放行/拒绝判定；域名信任命中由缓存查询承担。
 *
 * - navigate 且 mode=open：产 `browser-action`(navigate-open) + 通用 `network-egress`
 *   （域名缓存键 domain-any-action 档由此派生）；非 open 模式不产 navigate-open 信号（现状免确认）。
 * - act：目标域名不在 toolInput 中，由执行链路经 `env.browserAct.currentHost` 注入；
 *   高危结论经 `env.browserAct.dangerous` 注入（映射 suspicious 档，§5.1 裁决）。
 *   act 的域名缓存键走 domain+action 档（与 navigate 信任档分离）。执行链路在
 *   高危或会话信任关闭时不注入 currentHost（现状语义：这些情形不消费域名信任）。
 */
export function extractBrowserSignals(toolInput: Record<string, unknown>, env: EnvFacts): {
  signals: FactSignal[]
  summary: string
} {
  const action = typeof toolInput.action === 'string' ? toolInput.action : ''
  const url = typeof toolInput.url === 'string' ? toolInput.url : ''
  const signals: FactSignal[] = []

  if (action === 'navigate') {
    const mode = typeof toolInput.mode === 'string' ? toolInput.mode : 'open'
    const host = url ? extractHostFromUrl(url) : null
    if (host) {
      signals.push({ kind: 'network-egress', domains: [host] })
      signals.push({ kind: 'outbound-target', channel: 'browser', recipient: host })
    }
    if (mode === 'open') {
      signals.push({
        kind: 'browser-action',
        action: 'navigate-open',
        ...(host ? { host } : {})
      })
    } else {
      signals.push({ kind: 'browser-action', action: 'navigate' })
    }
    const summary = host ? `访问 ${host}（动作：${action}）` : `动作：${action}`
    return { signals, summary }
  }

  if (action === 'act') {
    const host = env.browserAct?.currentHost
    const dangerous = env.browserAct?.dangerous === true
    signals.push({
      kind: 'browser-action',
      action: 'act',
      ...(host ? { host } : {}),
      ...(dangerous ? { dangerous } : {})
    })
    return { signals, summary: dangerous ? '页面操作（高危）' : '页面操作' }
  }

  signals.push({ kind: 'browser-action', action: action || 'unknown' })
  return { signals, summary: `动作：${action || 'unknown'}` }
}
