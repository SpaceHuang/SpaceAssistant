export type ToolCallLabelT = (key: string, options?: Record<string, unknown>) => string

export function pathBasename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

export function formatToolLabel(
  toolName: string,
  input: Record<string, unknown>,
  t: ToolCallLabelT
): string {
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
    default:
      return toolName
  }
}
