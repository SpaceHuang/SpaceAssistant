import { useState } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'
import { ConfirmCardDecision } from './ConfirmCardDecision'

type Props = {
  record: ToolCallRecord
  onConfirm: ToolConfirmHandler
  sessionId?: string
}

export function McpConfirmCard({ record, onConfirm, sessionId }: Props) {
  const { t } = useTypedTranslation('chat')
  const [trustSession, setTrustSession] = useState(false)
  const mcp = record.mcp
  if (!mcp) return null

  const maskedArgs = record.input
  const argEntries = Object.entries(maskedArgs ?? {})

  const decide = (approved: boolean) => {
    if (!approved) {
      onConfirm(false)
      return
    }
    if (trustSession) {
      onConfirm(true, {
        sessionId,
        trustMcpServerId: mcp.serverId,
        trustMcpToolName: mcp.originalToolName
      })
    } else {
      onConfirm(true)
    }
  }

  return (
    <div className="write-confirm-card">
      <ConfirmCardDecision
        actionSummary={t('confirm.mcp.title')}
        allowLabel={t('confirm.mcp.allow')}
        denyLabel={t('confirm.mcp.deny')}
        onConfirm={decide}
        badges={
          <>
            <span>{t('confirm.mcp.server', { name: mcp.serverName })}</span>
            <span>{t('confirm.mcp.originalTool', { name: mcp.originalToolName })}</span>
          </>
        }
      >
        <div className="write-confirm-card__subject">
          {mcp.description ? (
            <p className="write-confirm-card__subject-note">{mcp.description}</p>
          ) : null}
          <p className="write-confirm-card__subject-note">{t('confirm.mcp.riskHint')}</p>
          <p className="write-confirm-card__subject-note">{t('confirm.mcp.argsLabel')}</p>
          <ConfirmCardCollapsible lineCount={argEntries.length}>
            {argEntries.length === 0 ? (
              <p className="write-confirm-card__subject-note">{t('confirm.mcp.emptyArgs')}</p>
            ) : (
              <pre className="write-confirm-card__subject-value write-confirm-card__subject-value--code mcp-confirm-card__args">
                {JSON.stringify(maskedArgs, null, 2)}
              </pre>
            )}
          </ConfirmCardCollapsible>
          <label className="write-confirm-card__trust-option">
            <span className="write-confirm-card__trust-control">
              <input
                type="checkbox"
                checked={trustSession}
                onChange={(e) => setTrustSession(e.target.checked)}
              />
            </span>
            <span className="write-confirm-card__trust-label">
              {t('confirm.mcp.trustSession')}
              <small className="write-confirm-card__subject-note">{t('confirm.mcp.trustHint')}</small>
            </span>
          </label>
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
