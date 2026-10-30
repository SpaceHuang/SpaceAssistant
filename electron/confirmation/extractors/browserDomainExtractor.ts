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
 * - act：目标域名/页面身份不在 toolInput 中，由执行链路经 `env.browserAct` 注入；
 *   高危结论经 `env.browserAct.dangerous` 注入（映射 suspicious 档，§5.1 裁决）。
 *   act 的域名缓存键走 domain+action 档（与 navigate 信任档分离）。执行链路在
 *   高危或会话信任关闭时不注入 currentHost（这些情形不消费域名信任），但仍绑定页面身份以便复核。
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
        sideEffect: 'navigate',
        querySensitivity: 'public',
        completeness: host ? 'complete' : 'partial',
        ...(host ? { host } : {})
      })
    } else {
      signals.push({ kind: 'browser-action', action: 'navigate', sideEffect: 'navigate', querySensitivity: 'unknown', completeness: host ? 'complete' : 'partial' })
    }
    const summary = host ? `访问 ${host}（动作：${action}）` : `动作：${action}`
    return { signals, summary }
  }

  if (action === 'act') {
    const host = env.browserAct?.currentHost
    const dangerous = env.browserAct?.dangerous === true
    const instruction = typeof toolInput.instruction === 'string' ? toolInput.instruction : typeof toolInput.text === 'string' ? toolInput.text : ''
    const instructionLower = instruction.toLowerCase()
    const sideEffect: Extract<FactSignal, { kind: 'browser-action' }>['sideEffect'] =
      /pay|payment|purchase|checkout|支付|付款|购买|结账/i.test(instruction) ? 'payment' :
        /authori[sz]e|grant access|permission|授权|授予权限/i.test(instruction) ? 'authorization' :
          /upload|attach|上传|附件/i.test(instruction) ? 'upload' :
            /delete|remove|删除|移除/i.test(instruction) ? 'delete' :
              /submit|send|提交|发送/i.test(instruction) ? 'submit' :
                /search|query|find|lookup|搜索|查询/i.test(instruction) ? 'read' : 'unknown'
    const querySensitivity = /private|personal|account|balance|medical|customer|sensitive|私人|个人|账号|账户|余额|病历|客户|敏感/i.test(instruction)
      ? 'private' as const
      : sideEffect === 'read' ? 'public' as const : 'unknown' as const
    signals.push({
      kind: 'browser-action',
      action: 'act',
      sideEffect,
      querySensitivity,
      completeness: instruction ? 'complete' : 'partial',
      ...(host ? { host } : {}),
      ...(env.browserAct?.pageIdentity ? { pageIdentity: env.browserAct.pageIdentity } : {}),
      ...(dangerous ? { dangerous } : {})
    })
    return { signals, summary: dangerous ? '页面操作（高危）' : '页面操作' }
  }

  signals.push({ kind: 'browser-action', action: action || 'unknown' })
  return { signals, summary: `动作：${action || 'unknown'}` }
}
