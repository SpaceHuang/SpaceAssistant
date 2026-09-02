import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Radio, Select, Space, Switch, Table, Tabs, Tag } from 'antd'
import type { FileConfirmMode } from '../../../shared/domainTypes'
import type { RemoteImCommonConfig } from '../../../shared/imTypes'
import type {
  DecisionCacheEntry,
  ExecutionLane,
  SecurityAuditEvent
} from '../../../shared/confirmation/types'
import type {
  SecuritySettingsModelPayload,
  SecuritySettingsRuleView
} from '../../../shared/confirmation/settingsCenter'
import type { PolicyPackage } from '../../../shared/policy/policyPackages'
import { ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'
import { groupMemoryEntries, memoryEntrySummary } from './toolsSecurityFormat'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  /** 子 Tab 激活时加载即时数据（套餐/记忆/审计）。 */
  active: boolean
  /** 链路硬约束（remoteAllowLocalWrite）读写 RemoteImCommon 同一份配置。 */
  remoteImValue: RemoteImCommonConfig
  onRemoteImChange: (patch: Partial<RemoteImCommonConfig>) => void
}

const PACKAGE_VALUES: PolicyPackage[] = ['strict', 'standard', 'loose', 'custom']
const LANES: Array<'desktop' | 'wechat' | 'feishu'> = ['desktop', 'wechat', 'feishu']

const AUDIT_EVENT_KINDS = [
  'policy.decision',
  'policy.deny-ingress',
  'policy.deny-exposure',
  'confirm.request',
  'confirm.outcome',
  'cache.hit',
  'cache.write',
  'cache.clear',
  'cache.expire-dormant',
  'cache.generation-reset',
  'settings.policy-change',
  'settings.tool-toggle',
  'budget.exhausted'
] as const

function formatTs(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleString() : '—'
}

/** 区 1：策略套餐 + 规则覆盖 + 链路硬约束（确认模式并入 desktop-auto-approve 规则行）。 */
function PolicyPackageSection({
  model,
  remoteImValue,
  onRemoteImChange,
  onModelChange
}: {
  model: SecuritySettingsModelPayload | null
  remoteImValue: RemoteImCommonConfig
  onRemoteImChange: (patch: Partial<RemoteImCommonConfig>) => void
  onModelChange: () => void
}) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')

  const laneLabel = (lane: (typeof LANES)[number]): string =>
    lane === 'desktop'
      ? t('toolsSecurity.policy.laneDesktop')
      : lane === 'wechat'
        ? t('toolsSecurity.policy.laneWechat')
        : t('toolsSecurity.policy.laneFeishu')

  const changePackage = (lane: (typeof LANES)[number], pkg: PolicyPackage) => {
    const apply = async () => {
      const res = await window.api.securitySetPolicyPackage({ lane, package: pkg })
      if (!res.ok) {
        message.error(t('toolsSecurity.policy.saveFailed'))
        return
      }
      onModelChange()
    }
    // 宽松档下调确认为自动放行：显式二次确认
    if (pkg === 'loose' && model?.packages[lane] !== 'loose') {
      modal.confirm({
        title: t('toolsSecurity.policy.packageLoose'),
        content: t('toolsSecurity.policy.looseHint'),
        onOk: () => void apply()
      })
      return
    }
    void apply()
  }

  /** 规则动作改覆盖：写 policy_rules（settings.policy-change 审计在主进程落）。 */
  const changeRuleAction = (
    rule: SecuritySettingsRuleView,
    action: 'deny' | 'allow' | 'ask' | 'auto-evaluator'
  ) => {
    void (async () => {
      const res = await window.api.securitySetRuleOverride({ ruleId: rule.id, action })
      if (!res.ok) {
        message.error(t('toolsSecurity.policy.saveFailed'))
        return
      }
      onModelChange()
    })()
  }

  /** 选择"自动"（启用自动审批器）保留二次确认警示。 */
  const changeRuleActionGuarded = (
    rule: SecuritySettingsRuleView,
    action: 'deny' | 'allow' | 'ask' | 'auto-evaluator'
  ) => {
    if (action === 'auto-evaluator' && rule.action !== 'auto-evaluator') {
      modal.confirm({
        title: t('tools.file.autoApprove.confirmTitle'),
        content: (
          <div>
            <p>{t('tools.file.autoApprove.confirmMessage')}</p>
            <p>{t('tools.file.autoApprove.confirmWarning')}</p>
          </div>
        ),
        okText: t('tools.file.autoApprove.confirmOk'),
        cancelText: t('tools.file.autoApprove.confirmCancel'),
        onOk: () => changeRuleAction(rule, action)
      })
      return
    }
    changeRuleAction(rule, action)
  }

  const resetRule = (rule: SecuritySettingsRuleView) => {
    void (async () => {
      await window.api.securityRemoveRuleOverride({ ruleId: rule.id })
      onModelChange()
    })()
  }

  const toggleHardConstraint = (checked: boolean) => {
    modal.confirm({
      title: t('toolsSecurity.policy.hardConstraintConfirmTitle'),
      content: t('toolsSecurity.policy.hardConstraintConfirmContent'),
      onOk: () => onRemoteImChange({ remoteAllowLocalWrite: checked })
    })
  }

  const packageHint = (pkg: PolicyPackage): string | null => {
    if (pkg === 'strict') return t('toolsSecurity.policy.strictHint')
    if (pkg === 'loose') return t('toolsSecurity.policy.looseHint')
    if (pkg === 'custom') return t('toolsSecurity.policy.customHint')
    return null
  }

  /** 当前 Tab 链路的生效规则：无 lane 限定的通用规则对每个链路都适用。 */
  const rulesForLane = (lane: (typeof LANES)[number]): SecuritySettingsRuleView[] =>
    (model?.rules ?? []).filter((r) => !r.lanes || r.lanes.includes(lane))

  const renderRulesTable = (lane: (typeof LANES)[number]) => (
    <Table<SecuritySettingsRuleView>
      size="small"
      pagination={false}
      rowKey="id"
      dataSource={rulesForLane(lane)}
      columns={[
        {
          title: t('toolsSecurity.policy.ruleColumn'),
          render: (_, r) => (
            <span>
              <code className="config-tool-row__id">{r.id}</code>
              <div className="config-field__hint">{r.reason}</div>
            </span>
          )
        },
        {
          title: t('toolsSecurity.policy.whenColumn'),
          width: 100,
          render: (_, r) =>
            r.when === 'invocation'
              ? t('toolsSecurity.policy.whenInvocation')
              : r.when === 'exposure'
                ? t('toolsSecurity.policy.whenExposure')
                : t('toolsSecurity.policy.whenIngress')
        },
        {
          title: t('toolsSecurity.policy.actionColumn'),
          width: 140,
          render: (_, r) => {
            const actionLabel = (v: 'deny' | 'allow' | 'ask' | 'auto-evaluator') =>
              v === 'deny'
                ? t('toolsSecurity.policy.actionDeny')
                : v === 'allow'
                  ? t('toolsSecurity.policy.actionAllow')
                  : v === 'ask'
                    ? t('toolsSecurity.policy.actionAsk')
                    : t('toolsSecurity.policy.actionAutoShort')
            if (r.locked) {
              return <span>{actionLabel(r.action as 'deny' | 'allow' | 'ask' | 'auto-evaluator')}</span>
            }
            // 默认动作即 auto-evaluator 的规则（自动审批器入口，如 desktop-auto-approve）：
            // 动作域为 询问/允许/自动，与其他规则同口径受套餐管理（custom 可编辑）
            const options =
              r.defaultAction === 'auto-evaluator'
                ? (['ask', 'allow', 'auto-evaluator'] as const)
                : (['deny', 'allow', 'ask'] as const)
            return (
              <Select
                size="small"
                value={r.action}
                disabled={(model?.packages[lane] ?? 'standard') !== 'custom'}
                style={{ width: '100%' }}
                classNames={configModalSelectPopupClassNames}
                options={options.map((v) => ({ value: v, label: actionLabel(v) }))}
                onChange={(v) => changeRuleActionGuarded(r, v)}
              />
            )
          }
        },
        {
          title: t('toolsSecurity.policy.stateColumn'),
          width: 140,
          render: (_, r) => (
            <Space size={4}>
              {r.locked ? <Tag>{t('toolsSecurity.policy.lockedTag')}</Tag> : null}
              {r.overridden ? <Tag color="orange">{t('toolsSecurity.policy.overriddenTag')}</Tag> : null}
              {r.overridden ? (
                <Button size="small" type="link" onClick={() => resetRule(r)}>
                  {t('toolsSecurity.policy.reset')}
                </Button>
              ) : null}
            </Space>
          )
        }
      ]}
    />
  )

  return (
    <ConfigSettingsStack>
      <p className="config-field__hint">{t('toolsSecurity.policy.hint')}</p>
      <Tabs
        items={LANES.map((lane) => {
          const pkg = model?.packages[lane] ?? 'standard'
          const hint = packageHint(pkg)
          return {
            key: lane,
            label: laneLabel(lane),
            children: (
              <ConfigSettingsStack>
                <Form.Item label={t('toolsSecurity.policy.packageLabel')} className="config-form-item-inline">
                  <Select
                    value={pkg}
                    style={{ width: 200 }}
                    classNames={configModalSelectPopupClassNames}
                    options={PACKAGE_VALUES.map((v) => ({
                      value: v,
                      label:
                        v === 'strict'
                          ? t('toolsSecurity.policy.packageStrict')
                          : v === 'standard'
                            ? t('toolsSecurity.policy.packageStandard')
                            : v === 'loose'
                              ? t('toolsSecurity.policy.packageLoose')
                              : t('toolsSecurity.policy.packageCustom')
                    }))}
                    onChange={(v) => changePackage(lane, v)}
                  />
                  {hint ? <p className="config-field__hint">{hint}</p> : null}
                </Form.Item>
                {/* 链路硬约束（remoteAllowLocalWrite）仅远程链路相关，桌面 Tab 不展示 */}
                {lane !== 'desktop' ? (
                  <ConfigSwitchRow
                    label={t('toolsSecurity.policy.hardConstraintTitle')}
                    hint={t('toolsSecurity.policy.hardConstraintHint')}
                    checked={remoteImValue.remoteAllowLocalWrite}
                    onChange={toggleHardConstraint}
                  />
                ) : null}
                {renderRulesTable(lane)}
              </ConfigSettingsStack>
            )
          }
        })}
      />
    </ConfigSettingsStack>
  )
}

/** 区 4：确认记忆管理（decision_cache 统一列表，按档位分组，支持清除）。 */
function MemorySection({ active }: { active: boolean }) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [entries, setEntries] = useState<DecisionCacheEntry[]>([])

  const reload = useCallback(async () => {
    try {
      setEntries(await window.api.securityListDecisionCache())
    } catch {
      /* 读取失败保持现状 */
    }
  }, [])

  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

  const groups = useMemo(() => groupMemoryEntries(entries), [entries])

  const clearOne = (entry: DecisionCacheEntry) => {
    void (async () => {
      await window.api.securityClearDecisionCache({ key: entry.key })
      await reload()
    })()
  }

  const clearAll = () => {
    modal.confirm({
      title: t('toolsSecurity.memory.clearAllConfirmTitle'),
      content: t('toolsSecurity.memory.clearAllConfirmContent', { count: entries.length }),
      onOk: async () => {
        const res = await window.api.securityClearDecisionCache({})
        message.success(t('toolsSecurity.memory.cleared', { count: res.cleared }))
        await reload()
      }
    })
  }

  return (
    <ConfigSettingsStack>
      <div className="config-skill-section-header">
        <Space size="small">
          <Button size="small" onClick={() => void reload()}>
            {t('toolsSecurity.audit.refresh')}
          </Button>
          <Button size="small" danger disabled={entries.length === 0} onClick={clearAll}>
            {t('toolsSecurity.memory.clearAll')}
          </Button>
        </Space>
      </div>
      <p className="config-field__hint">{t('toolsSecurity.memory.hint')}</p>
      {groups.length === 0 ? (
        <p className="config-field__hint">{t('toolsSecurity.memory.empty')}</p>
      ) : (
        groups.map((group) => (
          <div key={group.id} className="config-shell-section">
            <p className="config-field__hint">
              {group.scope === 'persistent'
                ? t('toolsSecurity.memory.scopePersistent')
                : t('toolsSecurity.memory.scopeSession')}
              {' · '}
              {t(group.tierKey)}
            </p>
            <Table<DecisionCacheEntry>
              size="small"
              pagination={false}
              rowKey="id"
              dataSource={group.entries}
              columns={[
                {
                  title: t('toolsSecurity.memory.columnSummary'),
                  render: (_, r) => memoryEntrySummary(r.key)
                },
                {
                  title: t('toolsSecurity.memory.columnLane'),
                  width: 90,
                  render: (_, r) => (r.lane === '*' ? t('toolsSecurity.memory.laneAll') : r.lane)
                },
                {
                  title: t('toolsSecurity.memory.columnHits'),
                  dataIndex: 'hitCount',
                  width: 70
                },
                {
                  title: t('toolsSecurity.memory.columnCreated'),
                  width: 170,
                  render: (_, r) => formatTs(r.createdAt)
                },
                {
                  title: '',
                  width: 70,
                  render: (_, r) => (
                    <Button size="small" type="link" danger onClick={() => clearOne(r)}>
                      {tCommon('delete')}
                    </Button>
                  )
                }
              ]}
            />
          </div>
        ))
      )}
    </ConfigSettingsStack>
  )
}

/** 区 5：安全审计记录（只读查询 + 保留天数设置）。 */
function AuditSection({
  active,
  model,
  onModelChange
}: {
  active: boolean
  model: SecuritySettingsModelPayload | null
  onModelChange: () => void
}) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [events, setEvents] = useState<SecurityAuditEvent[]>([])
  const [range, setRange] = useState<'all' | 'today' | '7d' | '30d'>('7d')
  const [lane, setLane] = useState<ExecutionLane | undefined>(undefined)
  const [eventKind, setEventKind] = useState<string | undefined>(undefined)
  const [toolName, setToolName] = useState('')
  const [retention, setRetention] = useState<number>(model?.audit.retentionDays ?? 180)

  useEffect(() => {
    if (model) setRetention(model.audit.retentionDays)
  }, [model])

  const query = useCallback(async () => {
    const dayMs = 24 * 3600 * 1000
    const now = Date.now()
    const since =
      range === 'today'
        ? new Date().setHours(0, 0, 0, 0)
        : range === '7d'
          ? now - 7 * dayMs
          : range === '30d'
            ? now - 30 * dayMs
            : undefined
    try {
      setEvents(
        await window.api.securityQueryAudit({
          ...(since != null ? { since } : {}),
          ...(lane ? { lane } : {}),
          ...(eventKind ? { event: eventKind } : {}),
          ...(toolName.trim() ? { toolName: toolName.trim() } : {})
        })
      )
    } catch {
      /* 查询失败保持现状 */
    }
  }, [range, lane, eventKind, toolName])

  useEffect(() => {
    if (active) void query()
  }, [active, query])

  const saveRetention = async () => {
    const res = await window.api.securitySetAuditRetention({ days: retention })
    if (!res.ok) {
      message.error(t('toolsSecurity.policy.saveFailed'))
      return
    }
    message.success(t('toolsSecurity.audit.retentionSaved'))
    onModelChange()
  }

  return (
    <ConfigSettingsStack>
      <div className="config-skill-section-header">
        <Button size="small" onClick={() => void query()}>
          {t('toolsSecurity.audit.refresh')}
        </Button>
      </div>
      <p className="config-field__hint">{t('toolsSecurity.audit.hint')}</p>
      {model && !model.audit.haveAuditLog ? (
        <Alert type="info" showIcon className="config-alert--compact" message={t('toolsSecurity.audit.noLog')} />
      ) : null}
      <Space wrap size="small">
        <Select
          value={range}
          style={{ width: 120 }}
          classNames={configModalSelectPopupClassNames}
          options={[
            { value: 'all', label: t('toolsSecurity.audit.rangeAll') },
            { value: 'today', label: t('toolsSecurity.audit.rangeToday') },
            { value: '7d', label: t('toolsSecurity.audit.range7d') },
            { value: '30d', label: t('toolsSecurity.audit.range30d') }
          ]}
          onChange={setRange}
        />
        <Select
          allowClear
          placeholder={t('toolsSecurity.audit.filterLane')}
          style={{ width: 120 }}
          classNames={configModalSelectPopupClassNames}
          value={lane}
          options={(['desktop', 'wechat', 'feishu', 'automation'] as const).map((v) => ({ value: v, label: v }))}
          onChange={(v) => setLane(v ?? undefined)}
        />
        <Select
          allowClear
          placeholder={t('toolsSecurity.audit.filterEvent')}
          style={{ width: 200 }}
          classNames={configModalSelectPopupClassNames}
          value={eventKind}
          options={AUDIT_EVENT_KINDS.map((v) => ({ value: v, label: v }))}
          onChange={(v) => setEventKind(v ?? undefined)}
        />
        <Input
          allowClear
          placeholder={t('toolsSecurity.audit.filterTool')}
          style={{ width: 160 }}
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
        />
      </Space>
      <Table<SecurityAuditEvent>
        size="small"
        pagination={{ pageSize: 20, showSizeChanger: false }}
        rowKey={(r) => `${r.ts}-${r.event}-${r.requestId ?? ''}-${r.cacheKey ?? ''}`}
        dataSource={events}
        locale={{ emptyText: t('toolsSecurity.audit.empty') }}
        columns={[
          { title: t('toolsSecurity.audit.columnTime'), width: 170, render: (_, r) => formatTs(r.ts) },
          { title: t('toolsSecurity.audit.columnEvent'), dataIndex: 'event', width: 170 },
          { title: t('toolsSecurity.audit.columnLane'), dataIndex: 'lane', width: 90 },
          {
            title: t('toolsSecurity.audit.columnTool'),
            width: 120,
            render: (_, r) => r.toolName ?? '—'
          },
          {
            title: t('toolsSecurity.audit.columnSummary'),
            render: (_, r) => r.factsSummary ?? r.cacheKey ?? r.reason ?? '—'
          }
        ]}
      />
      <Form.Item label={t('toolsSecurity.audit.retentionLabel')} extra={t('toolsSecurity.audit.retentionHint')}>
        <Space>
          <InputNumber min={1} max={3650} value={retention} onChange={(v) => setRetention(v ?? 180)} />
          <Button onClick={() => void saveRetention()}>{tCommon('save')}</Button>
        </Space>
      </Form.Item>
    </ConfigSettingsStack>
  )
}

/**
 * 「安全策略」设置页（§7，P4）：1. 策略套餐（含规则列表；确认模式并入 desktop-auto-approve
 * 规则行，动作域 询问/允许/自动，统一受套餐管理）2. 确认记忆管理 3. 安全审计记录。
 * 工具开关（Agent 可用能力面）在「工具 → 工具开关」独立子 Tab，与安全策略管控并列。
 */
export function ToolsSecuritySettingsTab({ active, remoteImValue, onRemoteImChange }: Props) {
  const { t } = useTypedTranslation('config')
  const [model, setModel] = useState<SecuritySettingsModelPayload | null>(null)

  const reloadModel = useCallback(async () => {
    try {
      setModel(await window.api.securityGetSettingsModel())
    } catch {
      /* 装配失败保持现状 */
    }
  }, [])

  useEffect(() => {
    if (active) void reloadModel()
  }, [active, reloadModel])

  return (
    <ConfigSettingsStack>
      <p className="config-field__hint">{t('toolsSecurity.intro')}</p>
      <Collapse
        ghost
        className="config-tools-security"
        defaultActiveKey={['policy']}
        items={[
          {
            key: 'policy',
            label: t('toolsSecurity.policy.title'),
            children: (
              <PolicyPackageSection
                model={model}
                remoteImValue={remoteImValue}
                onRemoteImChange={onRemoteImChange}
                onModelChange={() => void reloadModel()}
              />
            )
          },
          {
            key: 'memory',
            label: t('toolsSecurity.memory.title'),
            children: <MemorySection active={active} />,
            forceRender: true
          },
          {
            key: 'audit',
            label: t('toolsSecurity.audit.title'),
            children: <AuditSection active={active} model={model} onModelChange={() => void reloadModel()} />,
            forceRender: true
          }
        ]}
      />
    </ConfigSettingsStack>
  )
}
