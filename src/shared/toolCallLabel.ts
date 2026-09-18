export type ToolCallLabelT = (key: string, options?: Record<string, unknown>) => string
export type McpToolLabelMetadata = { serverId?: string; serverName?: string; originalToolName?: string; description?: string }

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export function formatToolLabel(
  toolName: string,
  input: Record<string, unknown>,
  t: ToolCallLabelT,
  mcp?: McpToolLabelMetadata
): string {
  if (toolName.startsWith('mcp_')) {
    const mappedParts = toolName.slice(4).split('_')
    const fallbackTool = mappedParts.slice(1, -1).join('_') || undefined
    const server = mcp?.serverName || t('tool.labels.mcpUnknownServer')
    const original = mcp?.originalToolName || fallbackTool
    if (!original) return t('tool.labels.mcpUnresolved')
    return `${server} · ${original}`
  }
  switch (toolName) {
    case 'grep': {
      const pattern = typeof input.pattern === 'string' ? input.pattern : ''
      return pattern ? t('tool.labels.grep.withPattern', { pattern }) : t('tool.labels.grep.default')
    }
    case 'read_file':
      return typeof input.path === 'string' ? pathBasename(input.path) : t('tool.labels.readFile')
    case 'list_directory':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.listDirectory')
    case 'edit_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.editFile')
    case 'write_file':
      return typeof input.path === 'string' && input.path ? pathBasename(input.path) : t('tool.labels.writeFile')
    case 'run_script':
      return t('tool.labels.runScript')
    case 'run_shell': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      if (!cmd) return t('tool.labels.runShellEmpty')
      return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
    }
    case 'browser':
      return 'browser'
    case 'browser_detect':
      return t('tool.labels.browserDetect')
    // toolkit 网关：UI 收到的事件名是 compat 名（toolkit_find/toolkit_call），双口径覆盖（需求 §3.6）
    case 'toolkit.find':
    case 'toolkit_find':
      return t('tool.labels.toolkitFind')
    case 'toolkit.call':
    case 'toolkit_call': {
      const id = typeof input.id === 'string' && input.id ? input.id : ''
      return id ? t('tool.labels.toolkitCall', { id }) : t('tool.labels.toolkitCall', { id: '…' })
    }
    default:
      return toolName
  }
}
