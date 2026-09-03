import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS, getBuiltinToolMetadata } from './builtinToolDefinitions'
import { builtinToolNeedsConfirmation, builtinToolRiskLevel } from './domainTypes'

/** 16 个内置工具名（与 §3.2.1 防遗漏基线一致） */
const ALL_TOOLS = BUILTIN_TOOL_DEFINITIONS.map((d) => d.name)

describe('builtin tool metadata（P0 概念收敛）', () => {
  it('每个内置工具都注册了 actionClass / riskLevel / extractors 元数据', () => {
    expect(ALL_TOOLS).toHaveLength(16)
    for (const name of ALL_TOOLS) {
      const meta = getBuiltinToolMetadata(name)
      expect(meta, `${name} 缺元数据`).toBeDefined()
      expect(['read', 'write', 'execute', 'outbound']).toContain(meta!.actionClass)
      expect(['low', 'medium', 'high']).toContain(meta!.riskLevel)
      expect(Array.isArray(meta!.extractors)).toBe(true)
    }
  })

  it('未注册元数据的工具返回 undefined（信息不足走默认策略）', () => {
    expect(getBuiltinToolMetadata('non_existent_tool')).toBeUndefined()
  })
})

describe('builtinToolRiskLevel 读元数据且对外行为不变', () => {
  it('read / outbound 低风险工具保持 low', () => {
    for (const name of [
      'read_file', 'grep', 'list_directory', 'browser_detect', 'read_feishu_attachment',
      'list_work_dirs', 'switch_work_dir', 'switch_session', 'browser'
    ]) {
      expect(builtinToolRiskLevel(name)).toBe('low')
    }
  })
  it('write 类保持 medium', () => {
    expect(builtinToolRiskLevel('edit_file')).toBe('medium')
    expect(builtinToolRiskLevel('write_file')).toBe('medium')
  })
  it('execute 类保持 high', () => {
    for (const name of ['run_script', 'run_shell', 'run_lark_cli']) {
      expect(builtinToolRiskLevel(name)).toBe('high')
    }
  })
  it('wechat 出站工具保持 medium（现状默认值）', () => {
    expect(builtinToolRiskLevel('wechat_reply')).toBe('medium')
    expect(builtinToolRiskLevel('wechat_send')).toBe('medium')
  })
})

describe('builtinToolNeedsConfirmation 读元数据且对外行为不变', () => {
  it('write / execute 工具需要确认', () => {
    for (const name of ['edit_file', 'write_file', 'run_script', 'run_shell', 'run_lark_cli']) {
      expect(builtinToolNeedsConfirmation(name)).toBe(true)
    }
  })
  it('read / outbound 工具不需要确认', () => {
    for (const name of [
      'read_file', 'grep', 'list_directory', 'browser_detect', 'read_feishu_attachment',
      'list_work_dirs', 'switch_work_dir', 'switch_session', 'browser',
      'wechat_reply', 'wechat_send'
    ]) {
      expect(builtinToolNeedsConfirmation(name)).toBe(false)
    }
  })
  it('未知工具默认不确认（保持现状）', () => {
    expect(builtinToolNeedsConfirmation('non_existent_tool')).toBe(false)
  })
})
