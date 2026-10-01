export type BrowserConfirmSummary = {
  headline: string
  detailLabel: string
  detailValue: string
  hint?: string
  instructionValue?: string
  pageUrl?: string
}

import { runtimeText } from '../../i18n/runtimeText'

function navigationLabel(mode: string): string | undefined {
  switch (mode) {
    case 'open': return runtimeText('chat.browser.openPage')
    case 'refresh': return runtimeText('chat.browser.refreshPage')
    case 'back': return runtimeText('chat.browser.back')
    case 'forward': return runtimeText('chat.browser.forward')
    default: return undefined
  }
}

export function summarizeBrowserConfirmInput(
  input: Record<string, unknown>,
  currentPageUrl?: string
): BrowserConfirmSummary | null {
  const action = typeof input.action === 'string' ? input.action : ''
  if (action === 'navigate') {
    const mode = typeof input.mode === 'string' ? input.mode : 'open'
    const headline = navigationLabel(mode) ?? runtimeText('chat.browser.navigate')
    if (mode === 'open') {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      return {
        headline,
        detailLabel: 'URL',
        detailValue: url || runtimeText('chat.browser.unspecifiedUrl'),
        hint: runtimeText('chat.browser.hintOpen')
      }
    }
    return {
      headline,
      detailLabel: runtimeText('chat.browser.action'),
      detailValue: mode,
      hint: runtimeText('chat.browser.hintNavigate')
    }
  }
  if (action === 'act') {
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : ''
    const pageUrl = typeof currentPageUrl === 'string' ? currentPageUrl.trim() : ''
    return {
      headline: runtimeText('chat.browser.actionLabel'),
      detailLabel: runtimeText('chat.browser.commandLabel'),
      detailValue: instruction || runtimeText('chat.browser.unspecifiedInstruction'),
      instructionValue: instruction || runtimeText('chat.browser.unspecifiedInstruction'),
      pageUrl: pageUrl || undefined,
      hint: runtimeText('chat.browser.hintAct')
    }
  }
  return {
    headline: action ? `browser · ${action}` : 'browser',
    detailLabel: runtimeText('chat.browser.arguments'),
    detailValue: JSON.stringify(input, null, 2)
  }
}

export function formatBrowserToolLabel(input: Record<string, unknown>): string {
  const summary = summarizeBrowserConfirmInput(input)
  if (!summary) return 'browser'
  if (summary.detailLabel === 'URL' && summary.detailValue && summary.detailValue !== runtimeText('chat.browser.unspecifiedUrl')) {
    try {
      const u = new URL(summary.detailValue)
      return runtimeText('chat.browser.openHost', { target: `${u.hostname}${u.pathname !== '/' ? u.pathname : ''}` })
    } catch {
      return runtimeText('chat.browser.openHost', { target: summary.detailValue.slice(0, 48) })
    }
  }
  if (summary.detailLabel === runtimeText('chat.browser.commandLabel')) {
    const t = summary.detailValue
    return runtimeText('chat.browser.actionSummary', { instruction: t.length > 40 ? `${t.slice(0, 40)}…` : t })
  }
  return summary.headline
}

export function formatBrowserToolLabelTitle(input: Record<string, unknown>): string | undefined {
  const summary = summarizeBrowserConfirmInput(input)
  if (!summary) return undefined
  if (summary.detailLabel === 'URL') return summary.detailValue
  if (summary.detailLabel === runtimeText('chat.browser.commandLabel')) return summary.detailValue
  return undefined
}
