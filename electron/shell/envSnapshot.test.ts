import { describe, expect, it } from 'vitest'
import { diffEnvSnapshots, snapshotEnvForLog } from './envSnapshot'

// ===== P0-D3 组 5：env 完整快照（键集合 + 脱敏逐键哈希）与双路径 diff（§5.4.3）=====
// 目标：run_shell 与 run_script 的 env 是否逐键等价可事后比对，且秘密（值）永不落日志。

describe('snapshotEnvForLog', () => {
  it('输出键计数与哈希，不包含任何环境变量值', () => {
    const snap = snapshotEnvForLog({ PATH: '/usr/bin', HOME: '/home/space', ANTHROPIC_API_KEY: 'sk-secret' })
    expect(snap.keyCount).toBe(3)
    expect(snap.keysSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.entriesSha256).toMatch(/^[0-9a-f]{64}$/)
    // 评审观察项 6：字段名拼写为 valueHashByKey
    expect(Object.keys(snap)).toContain('valueHashByKey')
    expect(Object.keys(snap)).not.toContain('valueHashBykey')
    const serialized = JSON.stringify(snap)
    expect(serialized).not.toContain('/usr/bin')
    expect(serialized).not.toContain('sk-secret')
    expect(serialized).not.toContain('/home/space')
  })

  it('确定性：同 env 同快照；值变化只动 entriesSha256，键变化同时动 keysSha256', () => {
    const a = snapshotEnvForLog({ A: '1', B: '2' })
    const a2 = snapshotEnvForLog({ B: '2', A: '1' })
    expect(a).toEqual(a2)
    const valueChanged = snapshotEnvForLog({ A: '1', B: '3' })
    expect(valueChanged.entriesSha256).not.toBe(a.entriesSha256)
    expect(valueChanged.keysSha256).toBe(a.keysSha256)
    const keyAdded = snapshotEnvForLog({ A: '1', B: '2', C: '3' })
    expect(keyAdded.keysSha256).not.toBe(a.keysSha256)
    expect(keyAdded.keyCount).toBe(3)
  })

  it('undefined 值按缺键处理', () => {
    const snap = snapshotEnvForLog({ A: '1', B: undefined })
    expect(snap.keyCount).toBe(1)
  })
})

describe('diffEnvSnapshots（双路径 env diff）', () => {
  it('一致 / 仅键差异 / 仅值差异分别可判', () => {
    const a = snapshotEnvForLog({ A: '1', B: '2' })
    const identical = snapshotEnvForLog({ B: '2', A: '1' })
    expect(diffEnvSnapshots(a, identical)).toMatchObject({ identical: true, keysOnlyInA: [], keysOnlyInB: [], valueChangedKeys: [] })

    const b = snapshotEnvForLog({ A: '1', C: '3' })
    const diff = diffEnvSnapshots(a, b)
    expect(diff.identical).toBe(false)
    expect(diff.keysOnlyInA).toEqual(['B'])
    expect(diff.keysOnlyInB).toEqual(['C'])
    expect(diff.valueChangedKeys).toEqual([])
  })

  it('键集合相同但某键值不同 → valueChangedKeys 标注该键（值本身不出现）', () => {
    const a = snapshotEnvForLog({ A: '1', B: '2' })
    const b = snapshotEnvForLog({ A: '1', B: 'other' })
    const diff = diffEnvSnapshots(a, b)
    expect(diff.identical).toBe(false)
    expect(diff.valueChangedKeys).toEqual(['B'])
    expect(JSON.stringify(diff)).not.toContain('other')
  })
})
