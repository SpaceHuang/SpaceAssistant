import { Alert, App, Button, Input, Select, Space, Table, Tooltip } from 'antd'
import { Info } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { BrowserConfig, ModelEntry } from '../../../shared/domainTypes'
import {
  BROWSER_SETUP_REPAIR_INITIAL_MESSAGE,
  BROWSER_SETUP_REPAIR_SESSION_NAME
} from '../../../shared/domainTypes'
import { BrowserDetectStatusSummary } from '../Browser/BrowserDetectStatusSummary'
import { useBrowserDetect } from '../../hooks/useBrowserDetect'
import { useAppDispatch } from '../../hooks'
import { setSettingsOpen } from '../../store/configSlice'
import { setChatLaunchIntent } from '../../store/chatLaunchSlice'
import { setSession } from '../../store/chatSlice'
import { upsertSession } from '../../store/sessionSlice'
import refresh2LineRaw from '../../assets/refresh_2_line.svg?raw'
import { patchSvg } from '../../utils/patchSvg'
import { SaIconButton } from '../ui/SaIconButton'
import { ConfigModelOptionContent, sortModelsFastFirst } from './ConfigModelOption'
import { configModalModelSelectPopupClassNames, configModalSelectPopupClassNames } from './configModalUi'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

const refreshSvg = patchSvg(refresh2LineRaw)

const DOMAIN_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i

function isValidTrustDomain(domain: string): boolean {
  if (!domain || domain.length > 253) return false
  if (domain === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return true
  return DOMAIN_HOST_RE.test(domain)
}

type Props = {
  browser: BrowserConfig
  onChange: (next: BrowserConfig) => void
  models?: ModelEntry[]
  /** 进入「网络访问」子 Tab 时为 true，用于触发依赖检测 */
  active?: boolean
}

export function BrowserSettingsTab({ browser, onChange, models = [], active = false }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const dispatch = useAppDispatch()
  const { detect, detecting, refresh } = useBrowserDetect({ active })
  const [repairLoading, setRepairLoading] = useState(false)
  const [newDomain, setNewDomain] = useState('')
  const [selectedDomains, setSelectedDomains] = useState<string[]>([])

  const patch = (p: Partial<BrowserConfig>) => onChange({ ...browser, ...p })

  const addTrustedDomain = () => {
    const d = newDomain.trim().toLowerCase()
    if (!d) return
    if (!isValidTrustDomain(d)) {
      message.warning(t('browser.trust.invalidDomain'))
      return
    }
    if (browser.trustedDomains.includes(d)) {
      setNewDomain('')
      return
    }
    patch({ trustedDomains: [...browser.trustedDomains, d] })
    setNewDomain('')
  }

  const removeSelectedDomains = () => {
    if (!selectedDomains.length) return
    const remove = new Set(selectedDomains)
    patch({ trustedDomains: browser.trustedDomains.filter((d) => !remove.has(d)) })
    setSelectedDomains([])
  }
  const stagehandModels = useMemo(
    () => sortModelsFastFirst(models.filter((m) => m.enabled)),
    [models]
  )

  const handleRepairInChat = async () => {
    if (repairLoading) return
    setRepairLoading(true)
    try {
      dispatch(setSettingsOpen(false))
      const session = await window.api.sessionCreate({
        name: BROWSER_SETUP_REPAIR_SESSION_NAME,
        metadata: { chatLaunchSource: 'browser-settings-repair' }
      })
      dispatch(upsertSession(session))
      dispatch(setSession(session.id))
      dispatch(
        setChatLaunchIntent({
          sessionId: session.id,
          skillName: 'browser-setup-guide',
          initialUserMessage: BROWSER_SETUP_REPAIR_INITIAL_MESSAGE,
          source: 'browser-settings-repair'
        })
      )
    } finally {
      setRepairLoading(false)
    }
  }

  return (
    <ConfigSettingsStack>
      <ConfigSwitchRow
        label={t('browser.allowRemoteLabel')}
        hint={t('browser.allowRemoteHint')}
        checked={browser.allowRemoteSessions}
        onChange={(v) => patch({ allowRemoteSessions: v })}
      />
      {detect && !detect.canInitialize ? (
        <Alert
          type="warning"
          showIcon
          icon={<Info size={16} strokeWidth={2} className="config-notice-icon" aria-hidden />}
          className="config-alert--compact config-alert--notice"
          message={t('browser.depsNotReadyTitle')}
          description={detect.errors[0] ?? t('browser.depsNotReadyDescription')}
        />
      ) : null}

      <div className="browser-detect-section">
        <div className="browser-detect-section__header">
          <span className="config-field__label">{t('browser.detectSectionLabel')}</span>
          <Tooltip title={detect ? t('browser.redetect') : t('browser.detectDeps')}>
            <SaIconButton
              size="sm"
              className={detecting ? 'browser-detect-section__refresh--loading' : undefined}
              disabled={detecting}
              aria-label={detect ? t('browser.redetect') : t('browser.detectDeps')}
              onClick={() => refresh(true)}
            >
              <span dangerouslySetInnerHTML={{ __html: refreshSvg }} />
            </SaIconButton>
          </Tooltip>
        </div>
        {detect ? (
          <BrowserDetectStatusSummary detect={detect} detecting={detecting}>
            {!detect.canInitialize ? (
              <Button type="primary" block loading={repairLoading} onClick={() => void handleRepairInChat()}>
                {t('browser.repair')}
              </Button>
            ) : null}
          </BrowserDetectStatusSummary>
        ) : null}
      </div>

      <section className="browser-engine-section">
        <h3 className="config-section-title">{t('browser.stagehandTitle')}</h3>
        <ConfigSettingsStack className="browser-engine-section__body">
          <ConfigField label={t('browser.stagehandModelLabel')}>
            <Select
              className="config-stagehand-model-select"
              allowClear
              placeholder={t('browser.stagehandModelPlaceholder')}
              value={browser.stagehandModel || undefined}
              onChange={(v) => patch({ stagehandModel: v ?? '' })}
              classNames={configModalModelSelectPopupClassNames}
              options={stagehandModels.map((m) => ({ value: m.name, label: m.name }))}
              optionRender={(opt) => {
                const m = stagehandModels.find((x) => x.name === opt.value)
                return m ? <ConfigModelOptionContent m={m} compact /> : opt.label
              }}
              labelRender={(item) => {
                const m = stagehandModels.find((x) => x.name === item.value)
                return m ? <ConfigModelOptionContent m={m} compact selected /> : item.label
              }}
            />
          </ConfigField>
          <ConfigField label={t('browser.maxInferencesLabel')}>
            <Select
              value={browser.maxInferencesPerRequest}
              onChange={(v) => patch({ maxInferencesPerRequest: v })}
              classNames={configModalSelectPopupClassNames}
              options={[2, 4, 6, 8, 12, 16].map((n) => ({ value: n, label: String(n) }))}
            />
          </ConfigField>
        </ConfigSettingsStack>
      </section>

      <section className="browser-rate-limit-section">
        <h3 className="config-section-title">{t('browser.rateLimitTitle')}</h3>
        <p className="config-section-hint">{t('browser.rateLimitTitleHint')}</p>
        <ConfigSettingsStack className="browser-rate-limit-section__body">
          <ConfigSwitchRow
            label={t('browser.rateLimitEnabledLabel')}
            hint={t('browser.rateLimitEnabledHint')}
            checked={browser.rateLimitEnabled}
            onChange={(v) => patch({ rateLimitEnabled: v })}
          />
          {browser.rateLimitEnabled ? (
            <>
              <ConfigField
                label={t('browser.rateLimitMinIntervalLabel')}
                hint={t('browser.rateLimitMinIntervalHint')}
              >
                <Select
                  value={browser.rateLimitMinIntervalMs}
                  onChange={(v) => patch({ rateLimitMinIntervalMs: v })}
                  classNames={configModalSelectPopupClassNames}
                  options={[500, 1000, 2000, 3000, 5000].map((ms) => ({
                    value: ms,
                    label: String(ms / 1000)
                  }))}
                />
              </ConfigField>
              <ConfigField
                label={t('browser.rateLimitPerMinuteLabel')}
                hint={t('browser.rateLimitPerMinuteHint')}
              >
                <Select
                  value={browser.rateLimitPerMinute}
                  onChange={(v) => patch({ rateLimitPerMinute: v })}
                  classNames={configModalSelectPopupClassNames}
                  options={[10, 20, 30, 40, 60].map((n) => ({ value: n, label: String(n) }))}
                />
              </ConfigField>
              <ConfigField
                label={t('browser.rateLimitPerHourLabel')}
                hint={t('browser.rateLimitPerHourHint')}
              >
                <Select
                  value={browser.rateLimitPerHour}
                  onChange={(v) => patch({ rateLimitPerHour: v })}
                  classNames={configModalSelectPopupClassNames}
                  options={[100, 200, 300, 500, 1000].map((n) => ({ value: n, label: String(n) }))}
                />
              </ConfigField>
              <ConfigField
                label={t('browser.rateLimitPerDomainPerMinuteLabel')}
                hint={t('browser.rateLimitPerDomainPerMinuteHint')}
              >
                <Select
                  value={browser.rateLimitPerDomainPerMinute}
                  onChange={(v) => patch({ rateLimitPerDomainPerMinute: v })}
                  classNames={configModalSelectPopupClassNames}
                  options={[5, 10, 15, 20, 30].map((n) => ({ value: n, label: String(n) }))}
                />
              </ConfigField>
              <ConfigField
                label={t('browser.rateLimitModeLabel')}
                hint={t('browser.rateLimitModeHint')}
              >
                <Select
                  value={browser.rateLimitMode}
                  onChange={(v) => patch({ rateLimitMode: v })}
                  classNames={configModalSelectPopupClassNames}
                  options={[
                    { value: 'wait', label: t('browser.rateLimitModeWait') },
                    { value: 'reject', label: t('browser.rateLimitModeReject') }
                  ]}
                />
              </ConfigField>
              {browser.rateLimitMode === 'wait' ? (
                <ConfigField
                  label={t('browser.rateLimitMaxWaitSecLabel')}
                  hint={t('browser.rateLimitMaxWaitSecHint')}
                >
                  <Select
                    value={browser.rateLimitMaxWaitSec}
                    onChange={(v) => patch({ rateLimitMaxWaitSec: v })}
                    classNames={configModalSelectPopupClassNames}
                    options={[10, 30, 60, 120].map((n) => ({ value: n, label: String(n) }))}
                  />
                </ConfigField>
              ) : null}
            </>
          ) : (
            <Alert
              type="warning"
              showIcon
              className="config-alert--compact config-alert--notice"
              message={t('browser.rateLimitDisabledWarning')}
            />
          )}
        </ConfigSettingsStack>
      </section>

      <section className="browser-trust-section">
        <div className="config-skill-section-header">
          <h3 className="config-section-title">{t('browser.trust.title')}</h3>
          <Space size="small">
            <Button
              size="small"
              danger
              disabled={!selectedDomains.length}
              onClick={removeSelectedDomains}
            >
              {t('browser.trust.batchDelete')}
            </Button>
          </Space>
        </div>
        <p className="config-field__hint">{t('browser.trustedDomainsHint')}</p>
        <ConfigField label={t('browser.trust.addDomain')}>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={newDomain}
              placeholder={t('browser.trustedDomainsPlaceholder')}
              onChange={(e) => setNewDomain(e.target.value)}
              onPressEnter={addTrustedDomain}
            />
            <Button onClick={addTrustedDomain}>{t('browser.trust.addDomainButton')}</Button>
          </Space.Compact>
        </ConfigField>
        <Table
          size="small"
          pagination={false}
          rowKey="domain"
          rowSelection={{
            selectedRowKeys: selectedDomains,
            onChange: (keys) => setSelectedDomains(keys as string[])
          }}
          dataSource={browser.trustedDomains.map((domain) => ({ domain }))}
          locale={{ emptyText: t('browser.trust.empty') }}
          columns={[
            {
              title: t('browser.trust.columnDomain'),
              dataIndex: 'domain'
            }
          ]}
        />
      </section>

      <ConfigSwitchRow
        label={t('browser.allowHttpLabel')}
        hint={t('browser.allowHttpHint')}
        checked={browser.allowHttp}
        onChange={(v) => patch({ allowHttp: v })}
      />

      <ConfigSwitchRow
        label={t('browser.headlessLabel')}
        hint={t('browser.headlessHint')}
        checked={browser.headless}
        onChange={(v) => patch({ headless: v })}
      />

      <ConfigField label={t('browser.actionTimeoutLabel')}>
        <Select
          value={browser.actionTimeoutSec}
          onChange={(v) => patch({ actionTimeoutSec: v })}
          classNames={configModalSelectPopupClassNames}
          options={[30, 60, 90, 120, 180].map((n) => ({ value: n, label: String(n) }))}
        />
      </ConfigField>

      <ConfigField label={t('browser.idleTimeoutLabel')}>
        <Select
          value={browser.idleTimeoutSec}
          onChange={(v) => patch({ idleTimeoutSec: v })}
          classNames={configModalSelectPopupClassNames}
          options={[600, 1200, 1800, 3600].map((n) => ({ value: n, label: String(n) }))}
        />
      </ConfigField>

      <ConfigField label={t('browser.deniedActionsLabel')}>
        <Select
          mode="multiple"
          placeholder={t('browser.deniedActionsPlaceholder')}
          value={browser.deniedActions}
          onChange={(v) => patch({ deniedActions: v })}
          classNames={configModalSelectPopupClassNames}
          options={['navigate', 'observe', 'extract', 'act', 'screenshot', 'close'].map((a) => ({
            value: a,
            label: a
          }))}
        />
      </ConfigField>
    </ConfigSettingsStack>
  )
}
