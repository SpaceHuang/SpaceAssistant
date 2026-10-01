import type { BrowserConfig } from '../../src/shared/domainTypes'
import type { ActDangerAssessment } from '../browser/browserActionPolicy'

export type HostedBrowserGateSupplement = Readonly<{
  currentPageUrl?: string
  dangerAssessment?: ActDangerAssessment | null
}>

/** Rebuild volatile browser facts on each Hosted policy pass, including the post-confirm recheck. */
export async function resolveHostedBrowserGateFacts(input: {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  browserConfig?: BrowserConfig
  remote: boolean
  peekCurrentUrl(sessionId: string): string | undefined
  assess(sessionId: string, toolInput: Record<string, unknown>, config: BrowserConfig, failClosedOnUncertainty: boolean): Promise<ActDangerAssessment>
  onAssessing?(): void
}): Promise<HostedBrowserGateSupplement> {
  if (input.toolName !== 'browser') return {}
  const currentPageUrl = input.sessionId ? input.peekCurrentUrl(input.sessionId) : undefined
  const shouldAssess = input.toolInput.action === 'act' && Boolean(input.sessionId && input.browserConfig)
    && (input.remote || input.browserConfig?.actRequiresConfirm === true)
  if (!shouldAssess || !input.browserConfig) return currentPageUrl ? { currentPageUrl } : {}
  input.onAssessing?.()
  try {
    const dangerAssessment = await input.assess(input.sessionId, input.toolInput, input.browserConfig, input.remote)
    return { ...(currentPageUrl ? { currentPageUrl } : {}), dangerAssessment }
  } catch {
    const dangerAssessment: ActDangerAssessment | null = input.remote ? {
      dangerous: true,
      source: 'page-effect',
      userReason: '无法可靠判断本次页面操作风险，需确认后继续',
      consequence: 'generic',
      detail: 'assess_error'
    } : null
    return { ...(currentPageUrl ? { currentPageUrl } : {}), dangerAssessment }
  }
}
