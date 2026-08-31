import { describe, expect, it } from 'vitest'
import { decideRunScript } from './decisionPipeline'
import type { EnvFacts } from '../../src/shared/confirmation/types'

const env: EnvFacts = { os: 'win32', workDir: 'C:\\work', sensitivePaths: [] }
const owner = { kind: 'direct-owner' as const, senderId: 'u1' }

describe('decideRunScript：脚本 lane 分叉行为等价（§9）', () => {
  it('桌面 clean 脚本 → auto-allow', () => {
    const r = decideRunScript({
      code: 'x = 1',
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {}
    })
    expect(r.decision.type).toBe('auto-allow')
  })

  it('桌面含网络脚本 → 仍确认（不升级为拒绝）', () => {
    const r = decideRunScript({
      code: "import requests\nrequests.get('http://x')",
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {}
    })
    expect(r.decision.type).toBe('require-confirm')
  })

  it('远程(wechat)含网络脚本 → 拒绝', () => {
    const r = decideRunScript({
      code: "import requests\nrequests.get('http://x')",
      env,
      lane: 'wechat',
      origin: owner,
      sessionId: 's',
      config: {}
    })
    expect(r.decision.type).toBe('deny')
  })

  it('远程 clean 未认证脚本 → 必确认（即使 remoteScriptRequiresConfirm=false 且迁移完成）', () => {
    const r = decideRunScript({
      code: "print('hi')()",
      env,
      lane: 'feishu',
      origin: owner,
      sessionId: 's',
      config: { remoteScriptRequiresConfirm: false },
      migrationComplete: true
    })
    expect(r.decision.type).toBe('require-confirm')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=false + 迁移完成 → 免确认', () => {
    const r = decideRunScript({
      code: 'x = 1',
      env,
      lane: 'feishu',
      origin: owner,
      sessionId: 's',
      config: { remoteScriptRequiresConfirm: false },
      migrationComplete: true
    })
    expect(r.decision.type).toBe('auto-allow')
  })

  it('远程 clean 已认证 + remoteScriptRequiresConfirm=true（默认）→ 确认', () => {
    const r = decideRunScript({
      code: 'x = 1',
      env,
      lane: 'wechat',
      origin: owner,
      sessionId: 's',
      config: { remoteScriptRequiresConfirm: true },
      migrationComplete: true
    })
    expect(r.decision.type).toBe('require-confirm')
  })

  it('危险脚本 → 拒绝', () => {
    const r = decideRunScript({
      code: "import ctypes\nctypes.CDLL('libc.so')",
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {}
    })
    expect(r.decision.type).toBe('deny')
  })
})
