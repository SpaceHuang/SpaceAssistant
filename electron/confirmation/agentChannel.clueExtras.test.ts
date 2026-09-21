import { describe, expect, it } from 'vitest'
import { deriveClueExtras } from './agentChannel'
import type { ConfirmRequest } from '../../src/shared/confirmation/types'

function factsWithCommands(verbs: string[]): ConfirmRequest['facts'] {
  return {
    workDir: 'C:\\work',
    os: 'win32',
    signals: [
      {
        kind: 'command-sequence',
        commands: verbs.map((verb, index) => ({
          verb,
          args: [],
          signature: verb,
          effectiveCwd: 'C:\\work',
          ...(index > 0 ? { pipesInto: `segment-${index - 1}`, connector: ';' } : {})
        }))
      }
    ]
  } as unknown as ConfirmRequest['facts']
}

// ===== P1-E(c)：审批线索包覆盖全部子命令（回归 D7，§7.1 #11）=====
describe('deriveClueExtras 线索包子命令覆盖', () => {
  it('多子命令时 [命令] 覆盖前 N 条并标注总数（而不仅是 commands[0]），触发风险的 whoami 可见', () => {
    const extras = deriveClueExtras(factsWithCommands(['echo', 'whoami', 'net', 'user', 'show', 'config']))
    expect(extras.command).toContain('echo')
    expect(extras.command).toContain('whoami')
    expect(extras.command).toContain('共 6 条')
    // 超出前 N 的条目不出现（有界），只以总数标注
    expect(extras.command).not.toContain('config')
  })

  it('超过上限时有界：只列前 N 条并标注总数', () => {
    const verbs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']
    const extras = deriveClueExtras(factsWithCommands(verbs))
    expect(extras.command).toContain('共 7 条')
    expect(extras.command).toContain('a5')
    expect(extras.command).not.toContain('a7 ')
  })
})
