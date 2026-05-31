import { describe, expect, it } from 'vitest'
import { resolveEffectiveShellOutputMode } from './shellOutputMode'
import { DEFAULT_SHELL_CONFIG } from './domainTypes'

describe('resolveEffectiveShellOutputMode', () => {
  it('defaults to terminal for desktop sessions', () => {
    expect(resolveEffectiveShellOutputMode(DEFAULT_SHELL_CONFIG, {})).toBe('terminal')
  })

  it('respects plain setting', () => {
    expect(resolveEffectiveShellOutputMode({ ...DEFAULT_SHELL_CONFIG, outputMode: 'plain' }, {})).toBe('plain')
  })

  it('forces plain for feishu session metadata', () => {
    expect(resolveEffectiveShellOutputMode({ ...DEFAULT_SHELL_CONFIG, outputMode: 'terminal' }, { source: 'feishu' })).toBe(
      'plain'
    )
  })

  it('forces plain for feishu remoteContext', () => {
    expect(resolveEffectiveShellOutputMode({ ...DEFAULT_SHELL_CONFIG, outputMode: 'terminal' }, {}, 'feishu')).toBe('plain')
  })
})
