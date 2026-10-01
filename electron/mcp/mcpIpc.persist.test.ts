import { describe, expect, it } from 'vitest'
import { writeInputToProfile } from './mcpIpc'
import { McpServerProfileSchema, McpServerWriteInputSchema, parseMcpServerProfiles } from '../../src/shared/mcpTypes'

/**
 * FR14/评审 B5：alwaysLoad 持久化链路完整性——写入侧 strict schema 放行、
 * writeInputToProfile 白名单拷贝不丢、读取侧 schema 不剥字段、往返不抛错不丢字段。
 * zod 运行时校验 typecheck 兜不住，必须逐层测试。
 */

const BASE_WRITE_INPUT = {
  id: 'srv-always',
  name: '大服务',
  enabled: true,
  transport: 'stdio' as const,
  timeoutSec: 60,
  auth: { mode: 'none' as const },
  stdio: { command: 'node', args: ['server.js'], env: [] },
  enabledToolNames: ['big_tool']
}

describe('FR14：alwaysLoad 持久化链路（B5）', () => {
  it('写侧 strict schema 放行 alwaysLoad 字段（不加字段即抛错）', () => {
    const result = McpServerWriteInputSchema.safeParse({ ...BASE_WRITE_INPUT, alwaysLoad: true })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.alwaysLoad).toBe(true)
  })

  it('读侧 schema 不剥离 alwaysLoad（非 strict 默认 strip，不加字段即静默丢失）', () => {
    const profile = writeInputToProfile({ ...BASE_WRITE_INPUT, alwaysLoad: true } as never)
    const parsed = McpServerProfileSchema.safeParse(JSON.parse(JSON.stringify(profile)))
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.alwaysLoad).toBe(true)
  })

  it('writeInputToProfile 白名单拷贝携带 alwaysLoad', () => {
    const on = writeInputToProfile({ ...BASE_WRITE_INPUT, alwaysLoad: true } as never)
    expect(on.alwaysLoad).toBe(true)
    // 未设置 = 跟随全局（字段缺省）
    const unset = writeInputToProfile(BASE_WRITE_INPUT)
    expect(unset.alwaysLoad).toBeUndefined()
  })

  it('parseMcpServerProfiles 保存→读回往返不丢字段', () => {
    const profile = writeInputToProfile({ ...BASE_WRITE_INPUT, alwaysLoad: true } as never)
    const raw = JSON.stringify([profile])
    const restored = parseMcpServerProfiles(raw)
    expect(restored).toHaveLength(1)
    expect(restored[0]!.alwaysLoad).toBe(true)
  })

  it('alwaysLoad: false 同样可往返（显式关闭）', () => {
    const profile = writeInputToProfile({ ...BASE_WRITE_INPUT, alwaysLoad: false } as never)
    const restored = parseMcpServerProfiles(JSON.stringify([profile]))
    expect(restored[0]!.alwaysLoad).toBe(false)
  })
})
