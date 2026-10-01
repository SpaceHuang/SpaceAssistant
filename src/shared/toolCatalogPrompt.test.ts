import { describe, expect, it } from 'vitest'
import { buildMcpToolCatalogSection } from './toolCatalogPrompt'
import type { McpToolSnapshotEntry } from '../../electron/mcp/mcpToolRegistry'

function entry(overrides: Partial<McpToolSnapshotEntry> & { mappedName: string }): McpToolSnapshotEntry {
  return {
    serverId: 'srv1',
    serverName: '飞书',
    originalName: overrides.mappedName,
    description: '创建文档',
    inputSchema: { type: 'object' },
    serverId: overrides.serverId ?? 'srv1',
    serverName: overrides.serverName ?? '飞书',
    ...overrides
  }
}

describe('buildMcpToolCatalogSection（FR1 / FR4 / §6.2）', () => {
  it('空集返回 null，不产生空区块', () => {
    expect(buildMcpToolCatalogSection([], 200_000)).toBeNull()
  })

  it('行格式对齐 skills 目录：- mappedName（服务名）：描述', () => {
    const section = buildMcpToolCatalogSection([entry({ mappedName: 'mcp_feishu_create_doc_1', description: '创建飞书文档' })], 200_000)
    expect(section).not.toBeNull()
    expect(section!.name).toBe('mcp:catalog')
    expect(section!.order).toBe(45)
    expect(section!.text).toContain('- mcp_feishu_create_doc_1（飞书）：创建飞书文档')
  })

  it('描述取首行、超长截 120 字符', () => {
    const multiLine = entry({ mappedName: 'mcp_x_1', description: '第一行描述\n第二行描述' })
    const section = buildMcpToolCatalogSection([multiLine], 200_000)!
    expect(section.text).toContain('- mcp_x_1（飞书）：第一行描述')
    expect(section.text).not.toContain('第二行描述')

    const long = entry({ mappedName: 'mcp_x_2', description: '长'.repeat(300) })
    const section2 = buildMcpToolCatalogSection([long], 200_000)!
    expect(section2.text).toContain('长'.repeat(120))
    expect(section2.text).not.toContain('长'.repeat(121))
  })

  it('头部计数「共 N 个工具，已列出前 K 个」（10.1.13）', () => {
    const entries = Array.from({ length: 3 }, (_, i) => entry({ mappedName: `mcp_x_${i}` }))
    const section = buildMcpToolCatalogSection(entries, 200_000)!
    expect(section.text).toContain('共 3 个工具，已列出 3 个')
  })

  it('预算截断：按行累加超出 skillCatalogBudget 口径即停止；截断时 K 与头部一致并附检索提示（FR4）', () => {
    // 200k 窗口 → 2% = 4000 token → 字符预算 14000；每行约 120+50 字符，需要 >100 行才截断
    const entries = Array.from({ length: 150 }, (_, i) => entry({
      mappedName: `mcp_big_${String(i).padStart(4, '0')}`,
      description: '描'.repeat(120)
    }))
    const section = buildMcpToolCatalogSection(entries, 200_000)!
    const lines = section.text.split('\n').filter((line) => line.startsWith('- mcp_big_'))
    expect(lines.length).toBeLessThan(150)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    // 头部计数与实际列出行数一致
    expect(section.text).toContain(`已列出 ${lines.length} 个`)
    expect(section.text).not.toContain(`已列出 ${entries.length} 个`)
    // 截断提示
    expect(section.text).toContain('tool_search')
    // 未被列出的条目仍可被检索发现（索引是截断视图而非准入名单）——尾部提示存在即可
    expect(section.text).toContain('检索')
  })

  it('小窗口预算极小时至少保留头部与提示（不产生超预算区块）', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry({ mappedName: `mcp_y_${i}`, description: 'd'.repeat(120) }))
    const section = buildMcpToolCatalogSection(entries, 1000)!
    // 1000 * 0.02 = 20 token → 70 字符预算；不应列出全部 50 行
    const lines = section.text.split('\n').filter((line) => line.startsWith('- mcp_y_'))
    expect(lines.length).toBeLessThan(50)
    expect(section.text).toContain('tool_search')
  })
})
