export type BrowserConfirmSummary = {
  headline: string
  detailLabel: string
  detailValue: string
  hint?: string
  instructionValue?: string
  pageUrl?: string
}

const NAV_MODE_LABELS: Record<string, string> = {
  open: '打开网页',
  refresh: '刷新页面',
  back: '后退',
  forward: '前进'
}

export function summarizeBrowserConfirmInput(
  input: Record<string, unknown>,
  currentPageUrl?: string
): BrowserConfirmSummary | null {
  const action = typeof input.action === 'string' ? input.action : ''
  if (action === 'navigate') {
    const mode = typeof input.mode === 'string' ? input.mode : 'open'
    const headline = NAV_MODE_LABELS[mode] ?? '导航'
    if (mode === 'open') {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      return {
        headline,
        detailLabel: 'URL',
        detailValue: url || '(未指定 URL)',
        hint: '将在隔离浏览器中打开上述地址。确认后，本会话内访问同域名将不再询问。'
      }
    }
    return {
      headline,
      detailLabel: '操作',
      detailValue: mode,
      hint: '将在当前浏览器会话中执行导航'
    }
  }
  if (action === 'act') {
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
    const pageUrl = typeof currentPageUrl === 'string' ? currentPageUrl.trim() : ''
    return {
      headline: '浏览器操作',
      detailLabel: '指令',
      detailValue: instruction || '(未指定指令)',
      instructionValue: instruction || '(未指定指令)',
      pageUrl: pageUrl || undefined,
      hint: '将在当前页面执行单步自然语言操作。'
    }
  }
  return {
    headline: action ? `browser · ${action}` : 'browser',
    detailLabel: '参数',
    detailValue: JSON.stringify(input, null, 2)
  }
}

export function formatBrowserToolLabel(input: Record<string, unknown>): string {
  const summary = summarizeBrowserConfirmInput(input)
  if (!summary) return 'browser'
  if (summary.detailLabel === 'URL' && summary.detailValue && summary.detailValue !== '(未指定 URL)') {
    try {
      const u = new URL(summary.detailValue)
      return `打开 ${u.hostname}${u.pathname !== '/' ? u.pathname : ''}`
    } catch {
      return `打开 ${summary.detailValue.slice(0, 48)}`
    }
  }
  if (summary.detailLabel === '指令') {
    const t = summary.detailValue
    return t.length > 40 ? `浏览器操作 · ${t.slice(0, 40)}…` : `浏览器操作 · ${t}`
  }
  return summary.headline
}

export function formatBrowserToolLabelTitle(input: Record<string, unknown>): string | undefined {
  const summary = summarizeBrowserConfirmInput(input)
  if (!summary) return undefined
  if (summary.detailLabel === 'URL') return summary.detailValue
  if (summary.detailLabel === '指令') return summary.detailValue
  return undefined
}
