import { Button, Collapse, Input, InputNumber, Radio, Select, Space, Switch, Tabs, Typography } from 'antd'
import { Plus, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { McpServerProfile, McpToolDescriptor } from '../../../shared/mcpTypes'
import type { McpServerDraft } from './mcpDrafts'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type McpServerFormProps = {
  draft: McpServerDraft
  profile?: McpServerProfile
  tools: McpToolDescriptor[]
  skippedCount: number
  testing: boolean
  saving: boolean
  canEnable: boolean
  onPatch: (patch: Partial<McpServerDraft>) => void
  onTest: () => void
  onSave: () => void
  onToggleEnabled: (checked: boolean) => void
}

function McpField({
  label,
  children,
  row = false,
  labelAction
}: {
  label: string
  children: ReactNode
  row?: boolean
  labelAction?: ReactNode
}) {
  return (
    <div className={`mcp-server-field${row ? ' mcp-server-field--row' : ''}`}>
      <div className="mcp-server-field__label-row">
        <span className="mcp-server-field__label">{label}</span>
        {labelAction ? <div className="mcp-server-field__label-action">{labelAction}</div> : null}
      </div>
      <div className="mcp-server-field__control">{children}</div>
    </div>
  )
}

function McpSectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="mcp-server-section__title">{children}</h4>
}

export function McpServerForm({
  draft,
  profile,
  tools,
  skippedCount,
  testing,
  saving,
  canEnable,
  onPatch,
  onTest,
  onSave,
  onToggleEnabled
}: McpServerFormProps) {
  const { t } = useTypedTranslation('mcp')

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

  const addArg = () => {
    if (!draft.stdio) return
    onPatch({ stdio: { ...draft.stdio, args: [...draft.stdio.args, ''] } })
  }

  const removeArg = (index: number) => {
    if (!draft.stdio) return
    onPatch({ stdio: { ...draft.stdio, args: draft.stdio.args.filter((_, i) => i !== index) } })
  }

  const addEnv = () => {
    if (!draft.stdio) return
    onPatch({
      stdio: {
        ...draft.stdio,
        env: [...draft.stdio.env, { key: '', value: '', valuePresent: false }]
      }
    })
  }

  const removeEnv = (index: number) => {
    if (!draft.stdio) return
    const removed = draft.stdio.env[index]!
    onPatch({
      stdio: { ...draft.stdio, env: draft.stdio.env.filter((_, i) => i !== index) },
      ...(removed.valuePresent && removed.key
        ? { clearSecretKinds: [...(draft.clearSecretKinds ?? []), `env:${removed.key}`] }
        : {})
    })
  }

  const argsEmpty = Boolean(draft.stdio && draft.stdio.args.length === 0)
  const envEmpty = Boolean(draft.stdio && draft.stdio.env.length === 0)

  return (
    <div className="mcp-server-form">
      <div className="mcp-server-section">
        <McpField label={t('form.nameLabel')}>
          <Input
            value={draft.name}
            placeholder={t('form.namePlaceholder')}
            onChange={(e) => onPatch({ name: e.target.value })}
          />
        </McpField>
        <McpField label={t('form.enabledLabel')} row>
          <Switch
            checked={draft.enabled}
            disabled={!canEnable}
            onChange={onToggleEnabled}
          />
        </McpField>
      </div>

      <Collapse
        ghost
        className="mcp-server-common"
        items={[
          {
            key: 'common',
            label: (
              <span className="mcp-server-common__label">
                <span className="mcp-server-common__title">{t('form.commonTitle')}</span>
                <span className="mcp-server-common__summary">
                  {t('form.timeoutValue', { value: draft.timeoutSec })} ·{' '}
                  {draft.toolConfirmPolicy === 'always'
                    ? t('form.confirmAlways')
                    : t('form.confirmReadonlyAuto')}
                </span>
              </span>
            ),
            children: (
              <div className="mcp-server-section">
                <McpField label={t('form.timeoutLabel')}>
                  <InputNumber
                    min={5}
                    max={300}
                    value={draft.timeoutSec}
                    onChange={(v) => onPatch({ timeoutSec: v ?? 60 })}
                  />
                </McpField>
                <McpField label={t('form.confirmPolicyLabel')} row>
                  <Radio.Group
                    value={draft.toolConfirmPolicy}
                    onChange={(e) => onPatch({ toolConfirmPolicy: e.target.value })}
                  >
                    <Radio value="always">{t('form.confirmAlways')}</Radio>
                    <Radio value="readonly-auto">{t('form.confirmReadonlyAuto')}</Radio>
                  </Radio.Group>
                </McpField>
              </div>
            )
          }
        ]}
      />

      <div className="mcp-server-section">
        <Tabs
          className="mcp-server-transport-tabs"
          tabBarExtraContent={{
            left: <span className="mcp-server-conn-title">{t('form.connTitle')}</span>
          }}
          activeKey={draft.transport}
          onChange={(key) =>
            onPatch({
              transport: key as McpServerDraft['transport'],
              // 切换 Tab 只是浏览/编辑另一组连接字段：保留已填数据，
              // 仅在目标组从未初始化时补一个空表单。
              ...(key === 'stdio'
                ? draft.stdio
                  ? {}
                  : { stdio: { command: '', args: [], env: [] } }
                : draft.http
                  ? {}
                  : { http: { endpoint: '' } })
            })
          }
          items={[
            {
              key: 'stdio',
              label: t('transport.stdio'),
              children: draft.stdio ? (
                <div className="mcp-server-section">
                  <McpField label={t('form.commandLabel')}>
                    <Input
                      value={draft.stdio.command}
                      placeholder={t('form.commandPlaceholder')}
                      onChange={(e) =>
                        onPatch({ stdio: { ...draft.stdio!, command: e.target.value } })
                      }
                    />
                  </McpField>
              <McpField
                label={t('form.argsLabel')}
                labelAction={
                  argsEmpty ? undefined : (
                    <Button type="text" size="small" icon={<Plus size={14} />} onClick={addArg}>
                      {t('form.add')}
                    </Button>
                  )
                }
              >
                {argsEmpty ? (
                  <Button type="dashed" block icon={<Plus size={14} />} onClick={addArg}>
                    {t('form.add')}
                  </Button>
                ) : (
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    {draft.stdio!.args.map((arg, i) => (
                      <div key={i} className="mcp-server-list-row">
                        <Input value={arg} onChange={(e) => patchArg(i, e.target.value)} />
                        <Button
                          type="text"
                          icon={<X size={14} />}
                          aria-label={t('card.delete')}
                          onClick={() => removeArg(i)}
                        />
                      </div>
                    ))}
                  </Space>
                )}
              </McpField>
                  <McpField label={t('form.cwdLabel')}>
                    <Input
                      value={draft.stdio.cwd ?? ''}
                      onChange={(e) =>
                        onPatch({ stdio: { ...draft.stdio!, cwd: e.target.value || undefined } })
                      }
                    />
                  </McpField>
              <McpField
                label={t('form.envLabel')}
                labelAction={
                  envEmpty ? undefined : (
                    <Button type="text" size="small" icon={<Plus size={14} />} onClick={addEnv}>
                      {t('form.add')}
                    </Button>
                  )
                }
              >
                {envEmpty ? (
                  <Button type="dashed" block icon={<Plus size={14} />} onClick={addEnv}>
                    {t('form.add')}
                  </Button>
                ) : (
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    {draft.stdio!.env.map((env, i) => (
                      <div key={`${env.key}-${i}`} className="mcp-server-list-row mcp-server-list-row--env">
                        <Input
                          value={env.key}
                          placeholder={t('form.envKeyPlaceholder')}
                          onChange={(e) => patchEnv(i, { key: e.target.value })}
                        />
                        <Input.Password
                          value={env.value}
                          placeholder={env.valuePresent ? t('form.secretPresentHint') : t('form.envValuePlaceholder')}
                          onChange={(e) => patchEnv(i, { value: e.target.value, clear: false })}
                        />
                        <Button
                          type="text"
                          icon={<X size={14} />}
                          aria-label={t('card.delete')}
                          onClick={() => removeEnv(i)}
                        />
                      </div>
                    ))}
                  </Space>
                )}
              </McpField>
                </div>
              ) : null
            },
            {
              key: 'streamable-http',
              label: t('transport.http'),
              children: draft.http ? (
                <div className="mcp-server-section">
                  <McpField label={t('form.httpEndpointLabel')}>
                    <Input
                      value={draft.http.endpoint}
                      placeholder="https://…"
                      onChange={(e) => onPatch({ http: { endpoint: e.target.value } })}
                    />
                  </McpField>
                  <McpField label={t('form.authModeLabel')}>
                    <Select
                      value={draft.auth.mode}
                      onChange={(mode) => onPatch({ auth: { ...draft.auth, mode } })}
                      options={[
                        { value: 'none', label: t('form.authNone') },
                        { value: 'bearer-token', label: t('form.authBearer') },
                        { value: 'custom-header', label: t('form.authCustomHeader') },
                        { value: 'oauth', label: t('form.authOauth') }
                      ]}
                    />
                  </McpField>
                  {draft.auth.mode === 'bearer-token' ? (
                    <McpField label={t('form.accessTokenLabel')}>
                      <Input.Password
                        value={draft.auth.accessToken ?? ''}
                        placeholder={profile?.auth.secretPresent ? t('form.secretPresentHint') : t('form.accessTokenPlaceholder')}
                        onChange={(e) => onPatch({ auth: { ...draft.auth, accessToken: e.target.value } })}
                      />
                    </McpField>
                  ) : null}
                  {draft.auth.mode === 'custom-header' ? (
                    <>
                      <McpField label={t('form.headerNameLabel')}>
                        <Input
                          value={draft.auth.headerName ?? ''}
                          onChange={(e) => onPatch({ auth: { ...draft.auth, headerName: e.target.value } })}
                        />
                      </McpField>
                      <McpField label={t('form.valuePrefixLabel')}>
                        <Input
                          value={draft.auth.valuePrefix ?? ''}
                          onChange={(e) => onPatch({ auth: { ...draft.auth, valuePrefix: e.target.value } })}
                        />
                      </McpField>
                      <McpField label={t('form.headerValueLabel')}>
                        <Input.Password
                          value={draft.auth.headerValue ?? ''}
                          placeholder={profile?.auth.secretPresent ? t('form.secretPresentHint') : t('form.accessTokenPlaceholder')}
                          onChange={(e) => onPatch({ auth: { ...draft.auth, headerValue: e.target.value } })}
                        />
                      </McpField>
                    </>
                  ) : null}
                  {draft.auth.mode === 'oauth' ? (
                    <McpField label={t('form.oauthClientIdLabel')}>
                      <Input
                        value={draft.auth.oauthClientId ?? ''}
                        placeholder={t('form.oauthClientIdPlaceholder')}
                        onChange={(e) => onPatch({ auth: { ...draft.auth, oauthClientId: e.target.value } })}
                      />
                    </McpField>
                  ) : null}
                </div>
              ) : null
            }
          ]}
        />
      </div>

      <div className="mcp-server-section">
        <McpSectionTitle>{t('form.toolsTitle')}</McpSectionTitle>
        {tools.length === 0 ? (
          <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
            {t('form.noToolsHint')}
          </Typography.Paragraph>
        ) : (
          <div className="mcp-server-tools">
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
                    <span className="config-tool-row__name" title={tool.originalName}>
                      {tool.originalName}
                    </span>
                    <code className="config-tool-row__id" title={tool.mappedName}>
                      {tool.mappedName}
                    </code>
                    <span className="config-tool-row__summary" title={tool.description}>
                      {tool.description}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {skippedCount > 0 ? (
          <Typography.Paragraph type="warning" style={{ margin: 0 }}>
            {t('form.skippedHint', { count: skippedCount })}
          </Typography.Paragraph>
        ) : null}
      </div>

      <div className="mcp-server-form__footer">
        <Button size="small" loading={testing} onClick={onTest}>
          {testing ? t('card.testing') : t('form.testDraft')}
        </Button>
        <Button size="small" type="primary" loading={saving} onClick={onSave}>
          {saving ? t('card.saving') : t('card.save')}
        </Button>
      </div>
    </div>
  )
}
