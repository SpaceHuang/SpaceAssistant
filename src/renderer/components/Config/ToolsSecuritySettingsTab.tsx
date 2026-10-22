import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Select, Space, Table, Tabs, Tag } from 'antd'
import type { BrowserConfig } from '../../../shared/domainTypes'
import { DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'
import type {
  DecisionCacheEntry,
  ExecutionLane,
  PolicyAction,
  SecurityAuditEvent
} from '../../../shared/confirmation/types'
import type {
  SecuritySettingsModelPayload,
  SecuritySettingsRuleView
} from '../../../shared/confirmation/settingsCenter'
import type { PolicyPackage } from '../../../shared/policy/policyPackages'
import { IM_STANDARD_BEHAVIOR_DIFF_IDS } from '../../../shared/policy/imPolicyBehavior'
import { LANE_PROFILES, effectiveActionFor, imEffectiveActionFor, isPolicyPackage, resolvePolicyRules } from '../../../shared/policy/policyPackages'
import type { PolicyRule } from '../../../shared/confirmation/types'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'
import { groupMemoryEntries, memoryEntrySummary } from './toolsSecurityFormat'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  /** 子 Tab 激活时加载即时数据（套餐/记忆/审计）。 */
  active: boolean
  /** act 会话级信任开关（R6：自网络访问页迁入区 4，仍读写 browser 配置）。 */
  browser: BrowserConfig
  onBrowserChange: (next: BrowserConfig) => void
}

/** IM 是共享策略域；微信 lane 仅作为现有规则目录的兼容视图键。 */
const LANES: Array<'desktop' | 'wechat'> = ['desktop', 'wechat']

const AUDIT_EVENT_KINDS = [
  'policy.decision',
  'policy.deny-ingress',
  'policy.deny-exposure',
  'confirm.request',
  'confirm.outcome',
  'confirm.answerer-fallback',
  'confirm.answerer-fallback-to-user',
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

/** 区 1：策略套餐 + 规则覆盖（custom 套餐可编辑每条规则动作）。 */
function PolicyPackageSection({
  model,
  onModelChange
}: {
  model: SecuritySettingsModelPayload | null
  onModelChange: () => void
}) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [imPackageOverride, setImPackageOverride] = useState<PolicyPackage | null>(null)
  const [imPolicyVersion, setImPolicyVersion] = useState<string | null>(null)
  const [imRuleOverrides, setImRuleOverrides] = useState<Record<string, string>>({})
  const [imMigratedLegacyDisabledRuleIds, setImMigratedLegacyDisabledRuleIds] = useState<string[]>([])
  const [savingRuleIds, setSavingRuleIds] = useState<Set<string>>(() => new Set())

  const actionLabel = (action: PolicyAction): string =>
    action === 'deny'
      ? t('toolsSecurity.policy.actionDeny')
      : action === 'allow'
        ? t('toolsSecurity.policy.actionAllow')
        : action === 'auto-evaluator'
          ? t('toolsSecurity.policy.actionAutoShort')
          : t('toolsSecurity.policy.actionAsk')

  const effectiveImAction = (
    pkg: PolicyPackage,
    rule: Pick<PolicyRule, 'id' | 'action' | 'locked'>,
    override?: PolicyAction
  ): PolicyAction => imPolicyVersion === 'im-standard-v2'
    ? imEffectiveActionFor('im', pkg, rule, override)
    : (override as PolicyAction | undefined) ?? rule.action

  const applyImSnapshot = (snapshot: Record<string, unknown>) => {
    if (isPolicyPackage(snapshot.selectedPackage)) setImPackageOverride(snapshot.selectedPackage)
    setImRuleOverrides(snapshot.ruleOverrides && typeof snapshot.ruleOverrides === 'object' && !Array.isArray(snapshot.ruleOverrides)
      ? snapshot.ruleOverrides as Record<string, string> : {})
    setImMigratedLegacyDisabledRuleIds(Array.isArray(snapshot.migratedLegacyDisabledRuleIds)
      ? [...new Set(snapshot.migratedLegacyDisabledRuleIds.filter((id): id is string => typeof id === 'string'))] : [])
  }

  const refreshImPolicy = async () => {
    const latest = await window.api.securityReadPolicyForLane({ lane: 'wechat' })
    setImPolicyVersion(latest.policyBehaviorVersion)
    applyImSnapshot(latest.snapshot)
    return latest
  }

  const switchImStandard = () => {
    const behaviorDiffLabels = {
      'mcp-public-read-auto': t('toolsSecurity.policy.behaviorDiffs.mcpPublicReadAuto'),
      'low-risk-browser-and-feishu-auto': t('toolsSecurity.policy.behaviorDiffs.lowRiskBrowserAndFeishuAuto'),
      'sensitive-write-and-external-outbound-manual': t('toolsSecurity.policy.behaviorDiffs.sensitiveWriteAndExternalOutboundManual')
    }
    modal.confirm({
      title: t('toolsSecurity.policy.switchToCurrentStandardTitle'),
      content: (
        <div>
          <p>{t('toolsSecurity.policy.switchToCurrentStandardIntro')}</p>
          <ul>
            {IM_STANDARD_BEHAVIOR_DIFF_IDS.map((id) => (
              <li key={id}>{behaviorDiffLabels[id]}</li>
            ))}
          </ul>
          <p>{t('toolsSecurity.policy.switchToCurrentStandardGateNote')}</p>
        </div>
      ),
      okText: t('toolsSecurity.policy.switchToCurrentStandardConfirm'),
      cancelText: t('toolsSecurity.policy.switchToCurrentStandardCancel'),
      onOk: async () => {
        try {
          const current = await window.api.securityReadPolicyForLane({ lane: 'wechat' })
          const result = await window.api.securityWritePolicy({
            lane: 'wechat', expectedRevision: current.revision,
            change: { kind: 'switch-to-standard', userChoiceConfirmed: true, displayedDiffs: IM_STANDARD_BEHAVIOR_DIFF_IDS }
          })
          if (result.status === 'conflict') {
            await refreshImPolicy()
            message.error(t('toolsSecurity.policy.saveConflict'))
            return
          }
          if (result.status !== 'committed') {
            message.error(t('toolsSecurity.policy.saveFailed'))
            return
          }
          await refreshImPolicy()
          onModelChange()
          message.success(t('toolsSecurity.policy.switchToCurrentStandardSuccess'))
        } catch {
          message.error(t('toolsSecurity.policy.saveFailed'))
        }
      }
    })
  }

  useEffect(() => {
    let current = true
    void refreshImPolicy().catch(() => {
      // Keep the legacy read-only model visible if snapshot loading fails.
    })
    return () => { current = false }
  }, [])

  const writePolicy = async (
    lane: 'desktop' | 'wechat',
    change:
      | { kind: 'package'; package: PolicyPackage }
      | { kind: 'rule-override'; ruleId: string; action: 'deny' | 'allow' | 'ask' | 'auto-evaluator' }
      | { kind: 'rule-reset'; ruleId: string }
  ): Promise<boolean> => {
    if (lane === 'desktop') return false
    try {
      const current = await window.api.securityReadPolicyForLane({ lane })
      const result = await window.api.securityWritePolicy({ lane, expectedRevision: current.revision, change })
      if (result.status === 'conflict') {
        await refreshImPolicy()
        onModelChange()
        message.error(t('toolsSecurity.policy.saveConflict'))
        return false
      }
      if (result.status !== 'committed' && result.status !== 'already-migrated') return false
      if (change.kind === 'package') setImPackageOverride(change.package)
      if (change.kind === 'rule-override') setImRuleOverrides((current) => ({ ...current, [change.ruleId]: change.action }))
      if (change.kind === 'rule-override' || change.kind === 'rule-reset') {
        setImMigratedLegacyDisabledRuleIds((current) => current.filter((id) => id !== change.ruleId))
      }
      if (change.kind === 'rule-reset') setImRuleOverrides((current) => {
        const next = { ...current }
        delete next[change.ruleId]
        return next
      })
      return true
    } catch {
      message.error(t('toolsSecurity.policy.saveFailed'))
      return false
    }
  }

  const laneLabel = (lane: (typeof LANES)[number]): string =>
    lane === 'desktop'
      ? t('toolsSecurity.policy.laneDesktop')
      : t('toolsSecurity.policy.laneImRemote')

  const changePackage = (lane: (typeof LANES)[number], pkg: PolicyPackage) => {
    const apply = async () => {
      if (lane === 'wechat') {
        if (!(await writePolicy(lane, { kind: 'package', package: pkg }))) return
        setImPackageOverride(pkg)
        onModelChange()
        return
      }
      const res = await window.api.securitySetPolicyPackage({ lane, package: pkg, expectedRevision: model?.policyRevisions?.desktop ?? 0 })
      if (!res.ok) {
        if (res.error === 'POLICY_REVISION_CONFLICT') {
          onModelChange()
          message.error(t('toolsSecurity.policy.saveConflict'))
          return
        }
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

  /** 规则动作改覆盖：写 policy_rules（settings.policy-change 审计在主进程落）。B2：提交携带链路。 */
  const changeRuleAction = (
    lane: (typeof LANES)[number],
    rule: SecuritySettingsRuleView,
    action: 'deny' | 'allow' | 'ask' | 'auto-evaluator'
  ) => {
    setSavingRuleIds((current) => new Set(current).add(rule.id))
    void (async () => {
      try {
        if (lane === 'wechat') {
          if (!(await writePolicy(lane, { kind: 'rule-override', ruleId: rule.id, action }))) return
          onModelChange()
          message.success(t('toolsSecurity.policy.saveSuccess'))
          return
        }
        const current = await window.api.securityReadPolicyForLane({ lane: 'desktop' })
        const res = await window.api.securitySetRuleOverride({ ruleId: rule.id, action, lane, expectedRevision: current.revision })
        if (!res.ok) {
          if (res.error === 'POLICY_REVISION_CONFLICT') {
            onModelChange()
            message.error(t('toolsSecurity.policy.saveConflict'))
            return
          }
          message.error(t('toolsSecurity.policy.saveFailed'))
          return
        }
        onModelChange()
        message.success(t('toolsSecurity.policy.saveSuccess'))
      } catch {
        message.error(t('toolsSecurity.policy.saveFailed'))
      } finally {
        setSavingRuleIds((current) => { const next = new Set(current); next.delete(rule.id); return next })
      }
    })()
  }

  /** 选择"自动"（启用自动审批器）保留二次确认警示。 */
  const changeRuleActionGuarded = (
    lane: (typeof LANES)[number],
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
        onOk: () => changeRuleAction(lane, rule, action)
      })
      return
    }
    changeRuleAction(lane, rule, action)
  }

  const resetRule = (lane: (typeof LANES)[number], rule: SecuritySettingsRuleView) => {
    setSavingRuleIds((current) => new Set(current).add(rule.id))
    void (async () => {
      try {
        if (lane === 'wechat') {
          if (!(await writePolicy(lane, { kind: 'rule-reset', ruleId: rule.id }))) return
          onModelChange()
          message.success(t('toolsSecurity.policy.saveSuccess'))
          return
        }
        const current = await window.api.securityReadPolicyForLane({ lane: 'desktop' })
        const res = await window.api.securityRemoveRuleOverride({ ruleId: rule.id, expectedRevision: current.revision })
        if (!res.ok && res.error === 'POLICY_REVISION_CONFLICT') {
          onModelChange()
          message.error(t('toolsSecurity.policy.saveConflict'))
          return
        }
        if (!res.ok) { message.error(t('toolsSecurity.policy.saveFailed')); return }
        onModelChange()
        message.success(t('toolsSecurity.policy.saveSuccess'))
      } catch {
        message.error(t('toolsSecurity.policy.saveFailed'))
      } finally {
        setSavingRuleIds((current) => { const next = new Set(current); next.delete(rule.id); return next })
      }
    })()
  }

  const packageHint = (pkg: PolicyPackage): string | null => {
    if (pkg === 'strict') return t('toolsSecurity.policy.strictHint')
    if (pkg === 'standard') return t('toolsSecurity.policy.standardHint')
    if (pkg === 'loose') return t('toolsSecurity.policy.looseHint')
    if (pkg === 'custom') return t('toolsSecurity.policy.customHint')
    return null
  }

  /** 范围条目（scope-*，S1 偏差 15）合成视图行：档位机制产物，不在用户可编辑覆盖体系内。 */
  const scopeView = (rule: PolicyRule, lane: (typeof LANES)[number]): SecuritySettingsRuleView => ({
    id: rule.id,
    when: rule.when,
    action: rule.action,
    defaultAction: rule.action,
    enabled: true,
    locked: false,
    reason: rule.reason,
    overridden: false,
    lanes: [lane]
  })

  /** 当前 Tab 链路的生效规则（显示=实际）：经 resolvePolicyRules 注入当前档位的范围条目（scope-*）；
   * 无 lane 限定的通用规则对每个链路都适用。 */
  const rulesForLane = (lane: (typeof LANES)[number]): SecuritySettingsRuleView[] => {
    const views = model?.rules ?? []
    const packages = lane === 'wechat'
      ? { ...model?.packages, wechat: imPackageOverride ?? model?.packages.wechat ?? 'standard' }
      : model?.packages
    const effective = resolvePolicyRules({ lane, packages, rules: views as PolicyRule[] })
    return effective
      .map((r) => {
        const view = views.find((v) => v.id === r.id) ?? scopeView(r, lane)
        if (lane !== 'wechat') return view
        return {
          ...view,
          action: (imRuleOverrides[r.id] ?? view.action) as SecuritySettingsRuleView['action'],
          migratedFromLegacyDisabled: imMigratedLegacyDisabledRuleIds.includes(r.id),
        }
      })
      .filter((r) => !r.lanes || r.lanes.includes(lane))
  }

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
              {r.capabilities?.length ? (
                <div className="config-field__hint">
                  {t('toolsSecurity.policy.applicableCapabilities')}: {r.capabilities.join(', ')}
                </div>
              ) : null}
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
            // 生效动作（显示=实际）：按当前链路 + 档位经 LANE_PROFILES 计算（standard 桌面「询问」→「自动」）；
            // locked 条目不参与档位变换，原样展示
            const pkg = lane === 'wechat'
              ? imPackageOverride ?? model?.packages.wechat ?? 'standard'
              : model?.packages[lane] ?? 'standard'
            const imAction = lane === 'wechat'
              ? effectiveImAction(pkg, { id: r.id, action: r.action, locked: r.locked }, imRuleOverrides[r.id] as PolicyRule['action'] | undefined)
              : null
            if (pkg !== 'custom') {
              // 非 custom 档只读：展示当前档位下的生效动作
              return <span>{actionLabel(imAction ?? effectiveActionFor(lane, pkg, { id: r.id, action: r.action, locked: r.locked }))}</span>
            }
            // 自定义档：动作域按 lane（desktop 4 态，IM 3 态），含原锁定规则。
            const options = LANE_PROFILES[lane].availableActions.filter((v) => v !== 'confirm-every-time')
            return (
              <Select
                size="small"
                value={r.action}
                style={{ width: '100%' }}
                classNames={configModalSelectPopupClassNames}
                options={options.map((v) => ({ value: v, label: actionLabel(v) }))}
                loading={savingRuleIds.has(r.id)}
                disabled={savingRuleIds.has(r.id)}
                onChange={(v) => changeRuleActionGuarded(lane, r, v as 'deny' | 'allow' | 'ask' | 'auto-evaluator')}
              />
            )
          }
        },
        {
          title: t('toolsSecurity.policy.stateColumn'),
          width: 140,
          render: (_, r) => (
            <Space size={4}>
              {r.migratedFromLegacyDisabled ? <Tag color="blue">{t('toolsSecurity.policy.migratedFromLegacyDisabled')}</Tag> : null}
              {r.overridden ? <Tag color="orange">{t('toolsSecurity.policy.overriddenTag')}</Tag> : null}
              {r.overridden ? (
                <Button size="small" type="link" loading={savingRuleIds.has(r.id)} disabled={savingRuleIds.has(r.id)} onClick={() => resetRule(lane, r)}>
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
          const pkg = lane === 'wechat'
            ? imPackageOverride ?? model?.packages.wechat ?? 'standard'
            : model?.packages[lane] ?? 'standard'
          const hint = lane === 'wechat' && imPolicyVersion === 'im-standard-v2'
            ? t('toolsSecurity.policy.imStandardHint')
            : packageHint(pkg)
          return {
            key: lane,
            label: laneLabel(lane),
            children: (
              <ConfigSettingsStack>
                {lane === 'wechat' && imPolicyVersion !== 'im-standard-v2' ? (
                  <Alert
                    type="info"
                    showIcon
                    message={t('toolsSecurity.policy.currentStandardAvailable')}
                    description={(
                      <Space direction="vertical" align="start">
                        <span>{t('toolsSecurity.policy.currentStandardAvailableHint')}</span>
                        <Button onClick={switchImStandard}>{t('toolsSecurity.policy.switchToCurrentStandard')}</Button>
                      </Space>
                    )}
                  />
                ) : null}
                <div className="config-policy-selector">
                  <div className="config-policy-selector__head">
                    <span className="config-policy-selector__label">
                      {t('toolsSecurity.policy.packageLabel')}
                    </span>
                    <span className="config-policy-selector__meta">
                      {t('toolsSecurity.policy.packageSelectHint')}
                    </span>
                  </div>
                  <Select
                    value={pkg}
                    className="config-policy-selector__select"
                    classNames={configModalSelectPopupClassNames}
                    options={LANE_PROFILES[lane].availablePackages.map((v) => ({
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
                  {hint ? (
                    <p className={`config-field__hint${pkg === 'loose' ? ' config-field__hint--warn' : ''}`}>
                      {hint}
                    </p>
                  ) : null}
                </div>
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
function MemorySection({
  active,
  browser,
  onBrowserChange
}: {
  active: boolean
  browser: BrowserConfig
  onBrowserChange: (next: BrowserConfig) => void
}) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [entries, setEntries] = useState<DecisionCacheEntry[]>([])
  const [actKeywordsOpen, setActKeywordsOpen] = useState(false)
  // null = 未编辑（展示已保存值）；空串是合法草稿（允许清空为 0 个关键词）
  const [actKeywordsDraft, setActKeywordsDraft] = useState<string | null>(null)

  const saveActKeywords = () => {
    const list = (actKeywordsDraft ?? browser.actHighRiskKeywords.join(', '))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    onBrowserChange({ ...browser, actHighRiskKeywords: list })
    setActKeywordsDraft(null)
  }

  const resetActKeywords = () => {
    onBrowserChange({ ...browser, actHighRiskKeywords: [...DEFAULT_BROWSER_CONFIG.actHighRiskKeywords] })
    setActKeywordsDraft(null)
  }

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
      {/* R6：act 会话级信任开关自网络访问页迁入，控制确认记忆（域名+动作 档）的派生 */}
      <ConfigSwitchRow
        label={t('toolsSecurity.memory.actSessionTrustLabel')}
        hint={t('toolsSecurity.memory.actSessionTrustHint')}
        checked={browser.actSessionTrustEnabled}
        onChange={(v) => onBrowserChange({ ...browser, actSessionTrustEnabled: v })}
      />
      {/* R7：act 高风险关键词编辑区自网络访问页迁入，仍读写 browser.actHighRiskKeywords */}
      <ConfigField
        label={t('toolsSecurity.memory.actHighRiskKeywordsLabel')}
        hint={t('toolsSecurity.memory.actHighRiskKeywordsHint')}
      >
        <Button type="link" size="small" onClick={() => setActKeywordsOpen((v) => !v)}>
          {actKeywordsOpen ? t('browser.detectCollapse') : t('browser.detectExpandHint')}
        </Button>
        {actKeywordsOpen ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Input.TextArea
              value={actKeywordsDraft ?? browser.actHighRiskKeywords.join(', ')}
              placeholder={t('toolsSecurity.memory.actHighRiskKeywordsPlaceholder')}
              onChange={(e) => setActKeywordsDraft(e.target.value)}
              autoSize={{ minRows: 2, maxRows: 6 }}
            />
            <Space>
              <Button size="small" onClick={saveActKeywords}>
                {t('toolsSecurity.memory.actHighRiskKeywordsSave')}
              </Button>
              <Button size="small" onClick={resetActKeywords}>
                {t('toolsSecurity.memory.actHighRiskKeywordsReset')}
              </Button>
            </Space>
          </Space>
        ) : null}
      </ConfigField>
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
 * 「安全策略」设置页（§7，P4）：1. 策略套餐（含规则列表；规则行展示当前链路+档位的生效动作，
 * custom 档动作域按 lane）2. 确认记忆管理 3. 安全审计记录。
 * 安全策略同时覆盖工具调用和 IM 操作策略，因此作为全局设置页单独展示。
 */
export function SecuritySettingsTab({ active, browser, onBrowserChange }: Props) {
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
        className="config-security-settings"
        defaultActiveKey={['policy']}
        items={[
          {
            key: 'policy',
            label: t('toolsSecurity.policy.title'),
            children: (
              <PolicyPackageSection
                model={model}
                onModelChange={() => void reloadModel()}
              />
            )
          },
          {
            key: 'memory',
            label: t('toolsSecurity.memory.title'),
            children: <MemorySection active={active} browser={browser} onBrowserChange={onBrowserChange} />,
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
