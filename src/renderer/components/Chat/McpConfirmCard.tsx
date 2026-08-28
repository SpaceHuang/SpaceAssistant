import { useState } from 'react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfirmCardCollapsible } from './ConfirmCardCollapsible'

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

  const approve = () => {
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
      <div className="write-confirm-card__intro">
        <p className="write-confirm-card__intro-label">{t('confirm.mcp.title')}</p>
        <span className="write-confirm-card__intro-badges">
          <span>{t('confirm.mcp.server', { name: mcp.serverName })}</span>
          <span>{t('confirm.mcp.originalTool', { name: mcp.originalToolName })}</span>
        </span>
      </div>

      {mcp.description ? (
        <p className="write-confirm-card__detail">{mcp.description}</p>
      ) : null}
      <p className="write-confirm-card__detail">{t('confirm.mcp.riskHint')}</p>

      <p className="write-confirm-card__detail">{t('confirm.mcp.argsLabel')}</p>
      <ConfirmCardCollapsible lineCount={argEntries.length}>
        {argEntries.length === 0 ? (
          <p className="write-confirm-card__detail">{t('confirm.mcp.emptyArgs')}</p>
        ) : (
          <pre className="write-confirm-card__args">
            {JSON.stringify(maskedArgs, null, 2)}
          </pre>
        )}
      </ConfirmCardCollapsible>

      <label className="write-confirm-card__trust">
        <input
          type="checkbox"
          checked={trustSession}
          onChange={(e) => setTrustSession(e.target.checked)}
        />
        <span>
          {t('confirm.mcp.trustSession')}
          <small>{t('confirm.mcp.trustHint')}</small>
        </span>
      </label>

      <div className="write-confirm-card__footer" role="group">
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            onClick={() => onConfirm(false)}
          >
            {t('confirm.mcp.deny')}
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            onClick={approve}
          >
            {t('confirm.mcp.allow')}
          </button>
        </div>
      </div>
    </div>
  )
}
