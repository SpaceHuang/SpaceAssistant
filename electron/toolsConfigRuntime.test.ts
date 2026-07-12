import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOLS_CONFIG } from '../src/shared/domainTypes'
import { filterBuiltinToolsForApi } from './toolsConfigRuntime'
import type { FeishuRemoteContext } from '../tools/types'

describe('filterBuiltinToolsForApi workdir tools', () => {
  const feishuRemoteContext: FeishuRemoteContext = {
    source: 'feishu',
    messageId: 'm1',
    confirmPolicy: 'remote_confirm'
  }

  it('hides workdir tools for desktop sessions', () => {
    const list = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, null, null, null)
    const names = list.map((t) => t.name)
    expect(names).not.toContain('list_work_dirs')
    expect(names).not.toContain('switch_work_dir')
  })

  it('includes workdir tools for remote sessions', () => {
    const list = filterBuiltinToolsForApi(DEFAULT_TOOLS_CONFIG, null, null, feishuRemoteContext)
    const names = list.map((t) => t.name)
    expect(names).toContain('list_work_dirs')
    expect(names).toContain('switch_work_dir')
  })

  it('respects deniedTools for remote sessions', () => {
    const cfg = {
      ...DEFAULT_TOOLS_CONFIG,
      deniedTools: [...DEFAULT_TOOLS_CONFIG.deniedTools, 'list_work_dirs', 'switch_work_dir']
    }
    const list = filterBuiltinToolsForApi(cfg, null, null, feishuRemoteContext)
    const names = list.map((t) => t.name)
    expect(names).not.toContain('list_work_dirs')
    expect(names).not.toContain('switch_work_dir')
  })
})
