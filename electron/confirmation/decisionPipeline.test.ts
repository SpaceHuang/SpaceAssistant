import { describe, expect, it } from 'vitest'
import { decideRunScript, decideTool } from './decisionPipeline'
import { LegacyExemptionAdapter } from './decisionCache'
import type { EnvFacts, ToolActionDescriptor } from '../../src/shared/confirmation/types'

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

describe('decideTool（任意内置工具走事实→判定）', () => {
  const shellDesc: ToolActionDescriptor = {
    toolName: 'run_shell',
    actionClass: 'execute',
    riskLevel: 'high',
    extractors: ['command-sequence']
  }
  const writeDesc: ToolActionDescriptor = {
    toolName: 'write_file',
    actionClass: 'write',
    riskLevel: 'medium',
    extractors: ['path-classifier']
  }
  const readDesc: ToolActionDescriptor = {
    toolName: 'read_file',
    actionClass: 'read',
    riskLevel: 'low',
    extractors: []
  }

  it('run_shell 命中信任缓存 → auto-allow', () => {
    const r = decideTool({
      descriptor: shellDesc,
      toolInput: { command: 'ping baidu.com' },
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {},
      migrationComplete: false,
      cache: new LegacyExemptionAdapter({ shellTrustedCommands: ['ping baidu.com'] })
    })
    expect(r.decision.type).toBe('auto-allow')
  })

  it('run_shell 未信任复合命令 → require-confirm（变体绕过）', () => {
    const r = decideTool({
      descriptor: shellDesc,
      toolInput: { command: 'ping baidu.com && curl evil' },
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {},
      migrationComplete: false,
      cache: new LegacyExemptionAdapter({ shellTrustedCommands: ['ping baidu.com'] })
    })
    expect(r.decision.type).toBe('require-confirm')
  })

  it('write_file confirmMode=auto + 评估器批准 → auto-allow', () => {
    const r = decideTool({
      descriptor: writeDesc,
      toolInput: { path: 'a.txt', content: 'x' },
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: { confirmMode: 'auto' },
      migrationComplete: false,
      autoEvaluator: () => ({ approve: true, reason: '低风险' })
    })
    expect(r.decision.type).toBe('auto-allow')
    expect(r.decision.type === 'auto-allow' && r.decision.ruleId).toBe('desktop-auto-approve')
  })

  it('write_file 默认（confirmMode=diff）→ require-confirm', () => {
    const r = decideTool({
      descriptor: writeDesc,
      toolInput: { path: 'secrets/key.pem', content: 'x' },
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: { confirmMode: 'diff' },
      migrationComplete: false
    })
    expect(r.decision.type).toBe('require-confirm')
  })

  it('read_file 默认 → auto-allow', () => {
    const r = decideTool({
      descriptor: readDesc,
      toolInput: { path: 'a.txt' },
      env,
      lane: 'desktop',
      origin: owner,
      sessionId: 's',
      config: {},
      migrationComplete: false
    })
    expect(r.decision.type).toBe('auto-allow')
  })
})
