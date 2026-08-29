import { Button, Switch, Tag } from 'antd'
import type { McpServerProfile, McpToolDescriptor } from '../../../shared/mcpTypes'
import type { McpServerDraft } from './mcpDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type McpServerCardProps = {
  draft: McpServerDraft
  profile?: McpServerProfile
  tools: McpToolDescriptor[]
  refreshing: boolean
  oauthStarting?: boolean
  dirty: boolean
  canEnable: boolean
  toolsStale?: boolean
  onEdit: () => void
  onRefresh: () => void
  onDelete: () => void
  onClearSecret: () => void
  onOpenDiagnostics: () => void
  onOauthStart: () => void
  onToggleEnabled: (checked: boolean) => void
}

const STATUS_KEYS = {
  untested: 'status.untested',
  connecting: 'status.connecting',
  'auth-required': 'status.authRequired',
  'auth-expired': 'status.authExpired',
  connected: 'status.connected',
  failed: 'status.failed',
  'no-tools': 'status.noTools',
  disabled: 'status.disabled'
} as const

const TRANSPORT_KEYS = {
  stdio: 'transport.stdio',
  'streamable-http': 'transport.http',
  sse: 'transport.sse'
} as const

export function McpServerCard({
  draft,
  profile,
  tools,
  refreshing,
  oauthStarting,
  dirty,
  canEnable,
  toolsStale,
  onEdit,
  onRefresh,
  onDelete,
  onClearSecret,
  onOpenDiagnostics,
  onOauthStart,
  onToggleEnabled
}: McpServerCardProps) {
  const { t } = useTypedTranslation('mcp')
  const status = profile?.status ?? 'untested'
  const enabledCount = draft.enabledToolNames.length

  const summary = draft.transport === 'stdio'
    ? t('card.commandSummary', { command: draft.stdio?.command || '—' })
    : t('card.endpointSummary', { endpoint: draft.http?.endpoint || '—' })

  return (
    <div className={`mcp-server-card${dirty ? ' mcp-server-card--dirty' : ''}`}>
      <div className="mcp-server-card__header">
        <Switch
          size="small"
          checked={draft.enabled}
          disabled={!canEnable}
          onChange={onToggleEnabled}
          aria-label={t('form.enabledLabel')}
        />
        <span className="mcp-server-card__title" title={draft.name || t('card.untestedHint')}>
          {draft.name || t('card.untestedHint')}
        </span>
        <Tag>{t(TRANSPORT_KEYS[draft.transport])}</Tag>
        <Tag color={status === 'connected' ? 'green' : status === 'failed' || status === 'auth-expired' ? 'red' : 'default'}>
          {t(STATUS_KEYS[status])}
        </Tag>
        <div className="mcp-server-card__header-actions">
          <Button type="text" size="small" onClick={onEdit}>
            {t('card.edit')}
          </Button>
          <Button type="text" size="small" danger onClick={onDelete}>
            {t('card.delete')}
          </Button>
        </div>
      </div>

      <div className="mcp-server-card__summary">
        <span className="mcp-server-card__summary-text" title={summary}>
          {summary}
        </span>
        <span className="mcp-server-card__summary-meta">
          {t('card.toolSummary', { enabled: enabledCount, total: tools.length })}
          {toolsStale ? ` · ${t('card.toolsStale')}` : ''}
        </span>
      </div>

      <div className="mcp-server-card__footer">
        <div className="mcp-server-card__footer-actions">
          <Button type="text" size="small" onClick={onClearSecret}>
            {t('card.clearToken')}
          </Button>
          {draft.auth.mode === 'oauth' ? (
            <Button type="text" size="small" loading={oauthStarting} onClick={onOauthStart}>
              {t('card.connectAccount')}
            </Button>
          ) : null}
          <Button type="text" size="small" onClick={onOpenDiagnostics}>
            {t('card.diagnostics')}
          </Button>
        </div>
        <div className="mcp-server-card__footer-actions mcp-server-card__footer-actions--primary">
          <Button size="small" loading={refreshing} onClick={onRefresh}>
            {refreshing ? t('card.refreshing') : t('card.test')}
          </Button>
        </div>
      </div>
    </div>
  )
}
