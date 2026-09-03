import { describe, expect, it } from 'vitest'
import type { EnvFacts } from '../../../src/shared/confirmation/types'
import { extractCommandSignals, isPersistableTrustCommand } from './commandSequenceExtractor'
import { classifyPath } from './pathClassifier'
import { extractScriptSignals } from './scriptAnalysisExtractor'
import { extractBrowserSignals } from './browserDomainExtractor'
import { extractOutboundTarget, extractLarkSubcommand } from './outboundExtractors'
import { runExtractors } from './runExtractors'

const env: EnvFacts = {
  os: 'win32',
  workDir: 'C:\\work',
  sensitivePaths: ['C:\\work\\secrets', '/root/.ssh']
}

function signalKinds(signals: { kind: string }[]): string[] {
  return signals.map((s) => s.kind)
}

describe('commandSequenceExtractor', () => {
  it('把命令拆为子命令并输出规范化签名', () => {
    const r = extractCommandSignals('cat a.txt && grep x /tmp', env)
    expect(signalKinds(r.signals)).toContain('command-sequence')
    const seq = r.signals.find((s) => s.kind === 'command-sequence')!
    if (seq.kind === 'command-sequence') {
      expect(seq.commands.map((c) => c.verb)).toEqual(['cat', 'grep'])
      expect(seq.commands[0]!.signature).toBe('cat a.txt')
      expect(seq.commands[1]!.signature).toBe('grep x /tmp')
    }
  })

  it('`FOO=1 cmd` 与 `cd x && cmd` 不命中同一 exact 签名（变体绕过防护）', () => {
    const a = extractCommandSignals('FOO=1 cmd', env)
    const b = extractCommandSignals('cd x && cmd', env)
    const sig = (r: ReturnType<typeof extractCommandSignals>) =>
      r.signals
        .filter((s): s is Extract<typeof s, { kind: 'command-sequence' }> => s.kind === 'command-sequence')
        .flatMap((s) => s.commands.map((c) => c.signature))
    expect(sig(a)).not.toBe(sig(b))
  })

  it('引号/空白变体归一化后命中同一签名（缓存可对账）', () => {
    const a = extractCommandSignals('ping "baidu.com"', env)
    const b = extractCommandSignals('  ping   baidu.com ', env)
    const sig = (r: ReturnType<typeof extractCommandSignals>) =>
      r.signals
        .filter((s): s is Extract<typeof s, { kind: 'command-sequence' }> => s.kind === 'command-sequence')
        .flatMap((s) => s.commands.map((c) => c.signature))
    expect(sig(a)).toEqual(sig(b))
  })

  it('含元语法/复合命令不可持久化信任', () => {
    expect(isPersistableTrustCommand('ping baidu.com')).toBe(true)
    expect(isPersistableTrustCommand('cd x && cmd')).toBe(false)
    expect(isPersistableTrustCommand('FOO=1 cmd')).toBe(false) // 变量前缀变体不作为 cm
  })
})

describe('pathClassifier', () => {
  it('工作目录内路径归为 workdir-normal', () => {
    expect(classifyPath('a.txt', env)).toBe('workdir-normal')
  })
  it('相对路径超出工作目录归为 outside-workdir', () => {
    expect(classifyPath('..\\..\\secret.txt', env)).toBe('outside-workdir')
  })
  it('敏感路径归为 sensitive-file', () => {
    expect(classifyPath('secrets\\key.pem', env)).toBe('sensitive-file')
  })
  it('系统目录归为 system-dir', () => {
    expect(classifyPath('C:\\Windows\\System32\\x.dll', env)).toBe('system-dir')
  })
})

describe('scriptAnalysisExtractor', () => {
  it('clean 脚本产 script-analysis=clean', () => {
    const r = extractScriptSignals('x = 1', env)
    const sa = r.signals.find((s) => s.kind === 'script-analysis')
    expect(sa && sa.kind === 'script-analysis' && sa.signal).toBe('clean')
  })

  it('网络脚本额外产 script-network 信号', () => {
    const r = extractScriptSignals("import requests\nrequests.get('http://x')", env)
    expect(signalKinds(r.signals)).toContain('script-network')
  })

  it('危险脚本产 script-analysis=dangerous', () => {
    const r = extractScriptSignals("import ctypes\nctypes.CDLL('libc.so')", env)
    const sa = r.signals.find((s) => s.kind === 'script-analysis')
    expect(sa && sa.kind === 'script-analysis' && sa.signal).toBe('dangerous')
  })

  it('allow 但无法通过远程正白名单认证的脚本产 script-uncertified', () => {
    const r = extractScriptSignals("print('hi')()", env)
    expect(signalKinds(r.signals)).toContain('script-uncertified')
  })
})

describe('runExtractors', () => {
  it('run_shell 编排产出 command-sequence 信号', () => {
    const facts = runExtractors(
      { toolName: 'run_shell', actionClass: 'execute', riskLevel: 'high', extractors: ['command-sequence'] },
      { command: 'ping baidu.com' },
      env
    )
    expect(signalKinds(facts.signals)).toContain('command-sequence')
    expect(facts.actionClass).toBe('execute')
    expect(facts.baseRiskLevel).toBe('high')
  })

  it('write_file 编排产出 path-target 信号', () => {
    const facts = runExtractors(
      { toolName: 'write_file', actionClass: 'write', riskLevel: 'medium', extractors: ['path-classifier'] },
      { path: 'secrets\\key.pem', content: 'x' },
      env
    )
    const pt = facts.signals.find((s) => s.kind === 'path-target')
    expect(pt && pt.kind === 'path-target' && pt.zone).toBe('sensitive-file')
  })
})

describe('browserDomainExtractor', () => {
  it('提取 network-egress / outbound-target 域名信号', () => {
    const r = extractBrowserSignals({ action: 'navigate', url: 'https://example.com/a' }, env)
    const ne = r.signals.find((s) => s.kind === 'network-egress')
    expect(ne && ne.kind === 'network-egress' && ne.domains).toEqual(['example.com'])
    expect(r.signals.some((s) => s.kind === 'outbound-target')).toBe(true)
  })

  it('域名可经 decideTool 产出（browser descriptor）', () => {
    const facts = runExtractors(
      { toolName: 'browser', actionClass: 'outbound', riskLevel: 'medium', extractors: ['browser-domain'] },
      { action: 'navigate', url: 'https://example.com' },
      env
    )
    expect(facts.signals.some((s) => s.kind === 'network-egress')).toBe(true)
  })
})

describe('outbound / lark 提取器', () => {
  it('wechat_send 接收者 → outbound-target 信号', () => {
    const r = extractOutboundTarget({ userId: 'u1', text: 'hi' })
    const t = r.signals.find((s) => s.kind === 'outbound-target')
    expect(t && t.kind === 'outbound-target' && t.recipient).toBe('u1')
  })

  it('lark 子命令 → outbound-target（读/写分类复用 classifyLarkCliImpact）', () => {
    const r = extractLarkSubcommand({ args: ['message', 'send', '--chat-id', 'oc_x', '--text', 'x'] })
    expect(r.signals.some((s) => s.kind === 'outbound-target')).toBe(true)
    expect(r.summary).toContain('写')
  })

  it('runExtractors 支持 run_lark_cli 的 lark-subcommand', () => {
    const facts = runExtractors(
      { toolName: 'run_lark_cli', actionClass: 'execute', riskLevel: 'high', extractors: ['lark-subcommand'] },
      { args: ['doc', 'get', '--token', 'x'] },
      env
    )
    expect(facts.signals.some((s) => s.kind === 'outbound-target')).toBe(true)
  })
})
