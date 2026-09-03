import { describe, expect, it } from 'vitest'
import { LegacyExemptionAdapter } from './decisionCache'
import { normalizeShellSignature } from './extractors/commandSequenceExtractor'
import type { CacheKey } from '../../src/shared/confirmation/types'

describe('LegacyExemptionAdapter：shell 信任签名规范化（变体绕过防护）', () => {
  const shellPeek = (trusted: string[], verb: string) =>
    new LegacyExemptionAdapter({ shellTrustedCommands: trusted }).lookup({
      kind: 'shell-command',
      verb,
      level: 'exact'
    })

  it('精确签名命中信任命令 → allow', () => {
    expect(shellPeek(['ping baidu.com'], 'ping baidu.com')).not.toBeNull()
    expect(shellPeek(['ping baidu.com'], 'ping baidu.com')!.decision).toBe('allow')
  })

  it('引号/空白变体归一化后命中（缓存可对账）', () => {
    expect(shellPeek(['ping "baidu.com"'], normalizeShellSignature('ping baidu.com'))).not.toBeNull()
    expect(shellPeek(['ping   baidu.com '], 'ping baidu.com')).not.toBeNull()
  })

  it('`FOO=1 cmd` 变体不命中 `cmd` 缓存', () => {
    expect(shellPeek(['cmd'], 'FOO=1 cmd')).toBeNull()
    expect(shellPeek(['ping baidu.com'], 'FOO=1 ping baidu.com')).toBeNull()
  })

  it('`cd x && cmd` 复合命令不命中单条精确签名缓存', () => {
    expect(shellPeek(['cmd'], 'cd x && cmd')).toBeNull()
  })

  it('未知命令不命中', () => {
    expect(shellPeek(['ping baidu.com'], 'rm -rf /')).toBeNull()
  })
})

describe('LegacyExemptionAdapter：域名 / 会话信任', () => {
  it('持久域名信任命中 → allow(persistent)', () => {
    const cache = new LegacyExemptionAdapter({ browserTrustedDomains: ['example.com'] })
    const key: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain-any-action' }
    expect(cache.lookup(key)?.decision).toBe('allow')
    expect(cache.lookup(key)?.scope).toBe('persistent')
  })

  it('会话级 act 域名信任命中 → allow(session)', () => {
    const cache = new LegacyExemptionAdapter({
      isBrowserSessionActTrusted: (sessionId, host) => sessionId === '*' && host === 'example.com'
    })
    const key: CacheKey = { kind: 'domain', domain: 'example.com', level: 'domain+action' }
    expect(cache.lookup(key)?.scope).toBe('session')
  })

  it('未信任域名不命中', () => {
    const cache = new LegacyExemptionAdapter({ browserTrustedDomains: ['example.com'] })
    const key: CacheKey = { kind: 'domain', domain: 'evil.com', level: 'domain-any-action' }
    expect(cache.lookup(key)).toBeNull()
  })
})
