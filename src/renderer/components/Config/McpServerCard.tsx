import { Button, Divider, Input, InputNumber, Radio, Select, Space, Switch, Tag, Typography } from 'antd'
import type { McpServerProfile, McpToolDescriptor } from '../../../shared/mcpTypes'
import type { McpServerDraft } from './mcpDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type McpServerCardProps = {
  draft: McpServerDraft
  profile?: McpServerProfile
  tools: McpToolDescriptor[]
  skippedCount: number
  expanded: boolean
  testing: boolean
  saving: boolean
  oauthStarting?: boolean
  dirty: boolean
  canEnable: boolean
  toolsStale?: boolean
  onToggleExpanded: () => void
  onPatch: (patch: Partial<McpServerDraft>) => void
  onSave: () => void
  onTest: () => void
  onDelete: () => void
  onClearSecret: () => void
  onOpenDiagnostics: () => void
  onOauthStart: () => void
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
  'streamable-http': 'transport.http'
} as const

export function McpServerCard({
  draft,
  profile,
  tools,
  skippedCount,
  expanded,
  testing,
  saving,
  oauthStarting,
  dirty,
  canEnable,
  toolsStale,
  onToggleExpanded,
  onPatch,
  onSave,
  onTest,
  onDelete,
  onClearSecret,
  onOpenDiagnostics,
  onOauthStart
}: McpServerCardProps) {
  const { t } = useTypedTranslation('mcp')
  const status = profile?.status ?? 'untested'
  const enabledCount = draft.enabledToolNames.length

  const patchEnv = (index: number, patch: Partial<{ key: string; value: string; clear: boolean }>) => {
    const env = [...(draft.stdio?.env ?? [])]
    env[index] = { ...env[index]!, ...patch }
    onPatch({ stdio: { ...(draft.stdio ?? { command: '', args: [], env: [] }), env } })
  }

  const patchArg = (index: number, value: string) => {
    const args = [...(draft.stdio?.args ?? [])]
    args[index] = value
    onPatch({ stdio: { ...(draft.stdio ?? { command: '', args: [], env: [] }), args } })
  }

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
          onChange={(checked) => onPatch({ enabled: checked })}
          aria-label={t('form.enabledLabel')}
        />
        <span className="mcp-server-card__name">{draft.name || t('card.untestedHint')}</span>
        <Tag>{t(TRANSPORT_KEYS[draft.transport])}</Tag>
        <Tag color={status === 'connected' ? 'green' : status === 'failed' || status === 'auth-expired' ? 'red' : 'default'}>
          {t(STATUS_KEYS[status])}
        </Tag>
        {dirty ? <Tag color="orange">{t('card.dirty')}</Tag> : null}
        <span className="mcp-server-card__spacer" />
        <Button type="text" size="small" onClick={onToggleExpanded}>
          {expanded ? t('card.collapse') : t('card.expand')}
        </Button>
        <Button type="text" size="small" danger onClick={onDelete}>
          {t('card.delete')}
        </Button>
      </div>

      <div className="mcp-server-card__summary">
        <Typography.Text type="secondary" ellipsis={{ tooltip: summary }}>
          {summary}
        </Typography.Text>
        <Typography.Text type="secondary">
          {' · '}
          {t('card.toolSummary', { enabled: enabledCount, total: tools.length })}
          {toolsStale ? ` · ${t('card.toolsStale')}` : ''}
        </Typography.Text>
      </div>

      {expanded ? (
        <div className="mcp-server-card__form">
          <Divider orientation="left">{t('form.basicTitle')}</Divider>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.nameLabel')}</span>
              <Input
                value={draft.name}
                placeholder={t('form.namePlaceholder')}
                onChange={(e) => onPatch({ name: e.target.value })}
              />
            </div>
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.enabledLabel')}</span>
              <Switch
                checked={draft.enabled}
                disabled={!canEnable}
                onChange={(checked) => onPatch({ enabled: checked })}
              />
            </div>
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.transportLabel')}</span>
              <Radio.Group
                value={draft.transport}
                onChange={(e) =>
                  onPatch({
                    transport: e.target.value,
                    ...(e.target.value === 'stdio'
                      ? { http: undefined, stdio: { command: '', args: [], env: [] } }
                      : { stdio: undefined, http: { endpoint: '' } })
                  })
                }
              >
                <Radio value="stdio">{t('transport.stdio')}</Radio>
                <Radio value="streamable-http">{t('transport.http')}</Radio>
              </Radio.Group>
            </div>
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.timeoutLabel')}</span>
              <InputNumber
                min={5}
                max={300}
                value={draft.timeoutSec}
                onChange={(v) => onPatch({ timeoutSec: v ?? 60 })}
                style={{ width: 140 }}
              />
            </div>
          </Space>

          <Divider orientation="left">{t('form.connTitle')}</Divider>
          {draft.transport === 'stdio' && draft.stdio ? (
            <Space direction="vertical" style={{ width: '100%' }} size="small">
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t('card.stdioNotice')}
              </Typography.Paragraph>
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.commandLabel')}</span>
                <Input
                  value={draft.stdio.command}
                  placeholder={t('form.commandPlaceholder')}
                  onChange={(e) =>
                    onPatch({ stdio: { ...draft.stdio!, command: e.target.value } })
                  }
                />
              </div>
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.argsLabel')}</span>
                <Space direction="vertical" style={{ width: '100%' }} size={4}>
                  {draft.stdio.args.map((arg, i) => (
                    <Space.Compact key={i} style={{ width: '100%' }}>
                      <Input value={arg} onChange={(e) => patchArg(i, e.target.value)} />
                      <Button
                        onClick={() =>
                          onPatch({
                            stdio: {
                              ...draft.stdio!,
                              args: draft.stdio!.args.filter((_, idx) => idx !== i)
                            }
                          })
                        }
                      >
                        ×
                      </Button>
                    </Space.Compact>
                  ))}
                  <Button
                    size="small"
                    onClick={() =>
                      onPatch({ stdio: { ...draft.stdio!, args: [...draft.stdio!.args, ''] } })
                    }
                  >
                    {t('form.addArg')}
                  </Button>
                </Space>
              </div>
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.cwdLabel')}</span>
                <Input
                  value={draft.stdio.cwd ?? ''}
                  onChange={(e) =>
                    onPatch({ stdio: { ...draft.stdio!, cwd: e.target.value || undefined } })
                  }
                />
              </div>
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.envLabel')}</span>
                <Space direction="vertical" style={{ width: '100%' }} size={4}>
                  {draft.stdio.env.map((env, i) => (
                    <Space.Compact key={`${env.key}-${i}`} style={{ width: '100%' }}>
                      <Input
                        value={env.key}
                        placeholder={t('form.envKeyPlaceholder')}
                        style={{ width: '35%' }}
                        onChange={(e) => patchEnv(i, { key: e.target.value })}
                      />
                      <Input.Password
                        value={env.value}
                        placeholder={env.valuePresent ? t('form.secretPresentHint') : t('form.envValuePlaceholder')}
                        onChange={(e) => patchEnv(i, { value: e.target.value, clear: false })}
                      />
                      {env.valuePresent ? (
                        <Button
                          onClick={() => patchEnv(i, { value: '', clear: true })}
                          title={t('card.clearToken')}
                        >
                          ×
                        </Button>
                      ) : null}
                      <Button
                        onClick={() =>
                          onPatch({
                            stdio: {
                              ...draft.stdio!,
                              env: draft.stdio!.env.filter((_, idx) => idx !== i)
                            }
                          })
                        }
                      >
                        ✕
                      </Button>
                    </Space.Compact>
                  ))}
                  <Button
                    size="small"
                    onClick={() =>
                      onPatch({
                        stdio: {
                          ...draft.stdio!,
                          env: [...draft.stdio!.env, { key: '', value: '', valuePresent: false }]
                        }
                      })
                    }
                  >
                    {t('form.addEnv')}
                  </Button>
                </Space>
              </div>
            </Space>
          ) : (
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.httpEndpointLabel')}</span>
              <Input
                value={draft.http?.endpoint ?? ''}
                placeholder="https://…"
                onChange={(e) => onPatch({ http: { endpoint: e.target.value } })}
              />
            </div>
          )}

          <Divider orientation="left">{t('form.authTitle')}</Divider>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            <div className="config-form-row">
              <span className="config-form-row__label">{t('form.authModeLabel')}</span>
              <Select
                value={draft.auth.mode}
                style={{ width: 220 }}
                onChange={(mode) => onPatch({ auth: { ...draft.auth, mode } })}
                options={[
                  { value: 'none', label: t('form.authNone') },
                  { value: 'bearer-token', label: t('form.authBearer') },
                  { value: 'custom-header', label: t('form.authCustomHeader') },
                  { value: 'oauth', label: t('form.authOauth') }
                ]}
              />
            </div>
            {draft.auth.mode === 'bearer-token' ? (
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.accessTokenLabel')}</span>
                <Input.Password
                  value={draft.auth.accessToken ?? ''}
                  placeholder={profile?.auth.secretPresent ? t('form.secretPresentHint') : t('form.accessTokenPlaceholder')}
                  onChange={(e) => onPatch({ auth: { ...draft.auth, accessToken: e.target.value } })}
                />
              </div>
            ) : null}
            {draft.auth.mode === 'custom-header' ? (
              <>
                <div className="config-form-row">
                  <span className="config-form-row__label">{t('form.headerNameLabel')}</span>
                  <Input
                    value={draft.auth.headerName ?? ''}
                    onChange={(e) => onPatch({ auth: { ...draft.auth, headerName: e.target.value } })}
                  />
                </div>
                <div className="config-form-row">
                  <span className="config-form-row__label">{t('form.valuePrefixLabel')}</span>
                  <Input
                    value={draft.auth.valuePrefix ?? ''}
                    onChange={(e) => onPatch({ auth: { ...draft.auth, valuePrefix: e.target.value } })}
                  />
                </div>
                <div className="config-form-row">
                  <span className="config-form-row__label">{t('form.headerValueLabel')}</span>
                  <Input.Password
                    value={draft.auth.headerValue ?? ''}
                    placeholder={profile?.auth.secretPresent ? t('form.secretPresentHint') : t('form.accessTokenPlaceholder')}
                    onChange={(e) => onPatch({ auth: { ...draft.auth, headerValue: e.target.value } })}
                  />
                </div>
              </>
            ) : null}
            {draft.auth.mode === 'oauth' ? (
              <div className="config-form-row">
                <span className="config-form-row__label">{t('form.oauthClientIdLabel')}</span>
                <Input
                  value={draft.auth.oauthClientId ?? ''}
                  placeholder={t('form.oauthClientIdPlaceholder')}
                  onChange={(e) => onPatch({ auth: { ...draft.auth, oauthClientId: e.target.value } })}
                />
              </div>
            ) : null}
          </Space>

          <Divider orientation="left">{t('form.toolsTitle')}</Divider>
          {tools.length === 0 ? (
            <Typography.Paragraph type="secondary">{t('form.noToolsHint')}</Typography.Paragraph>
          ) : (
            <div className="mcp-server-card__tools">
              {tools.map((tool) => {
                const on = draft.enabledToolNames.includes(tool.originalName)
                return (
                  <div key={tool.originalName} className="config-tool-row">
                    <Switch
                      size="small"
                      checked={on}
                      onChange={(checked) =>
                        onPatch({
                          enabledToolNames: checked
                            ? [...draft.enabledToolNames, tool.originalName]
                            : draft.enabledToolNames.filter((n) => n !== tool.originalName)
                        })
                      }
                    />
                    <div className="config-tool-row__body">
                      <span className="config-tool-row__name">{tool.originalName}</span>
                      <code className="config-tool-row__id">{tool.mappedName}</code>
                      <span className="config-tool-row__summary">{tool.description}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {skippedCount > 0 ? (
            <Typography.Paragraph type="warning">
              {t('form.skippedHint', { count: skippedCount })}
            </Typography.Paragraph>
          ) : null}
          <div className="config-form-row">
            <span className="config-form-row__label">{t('form.confirmPolicyLabel')}</span>
            <Radio.Group
              value={draft.toolConfirmPolicy}
              onChange={(e) => onPatch({ toolConfirmPolicy: e.target.value })}
            >
              <Radio value="always">{t('form.confirmAlways')}</Radio>
              <Radio value="readonly-auto">{t('form.confirmReadonlyAuto')}</Radio>
            </Radio.Group>
          </div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('form.confirmReadonlyAutoHint')}
          </Typography.Paragraph>
        </div>
      ) : null}

      <div className="mcp-server-card__actions">
        <Button size="small" loading={testing} onClick={onTest}>
          {testing ? t('card.testing') : t('card.test')}
        </Button>
        <Button size="small" type="primary" loading={saving} onClick={onSave}>
          {saving ? t('card.saving') : t('card.save')}
        </Button>
        <Button size="small" onClick={onClearSecret}>
          {t('card.clearToken')}
        </Button>
        {draft.auth.mode === 'oauth' ? (
          <Button size="small" loading={oauthStarting} onClick={onOauthStart}>
            {t('card.connectAccount')}
          </Button>
        ) : null}
        <Button size="small" onClick={onOpenDiagnostics}>
          {t('card.diagnostics')}
        </Button>
      </div>
    </div>
  )
}
