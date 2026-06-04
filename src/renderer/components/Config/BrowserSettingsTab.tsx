import { Alert, Button, Select, Tooltip } from 'antd'
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

type Props = {
  browser: BrowserConfig
  onChange: (next: BrowserConfig) => void
  models?: ModelEntry[]
  /** 进入「网络访问」子 Tab 时为 true，用于触发依赖检测 */
  active?: boolean
}

export function BrowserSettingsTab({ browser, onChange, models = [], active = false }: Props) {
  const { t } = useTypedTranslation('config')
  const dispatch = useAppDispatch()
  const { detect, detecting, refresh } = useBrowserDetect({ active })
  const [repairLoading, setRepairLoading] = useState(false)

  const patch = (p: Partial<BrowserConfig>) => onChange({ ...browser, ...p })
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
          className="config-alert--compact"
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

      <ConfigField label={t('browser.trustedDomainsLabel')} hint={t('browser.trustedDomainsHint')}>
        <Select
          mode="tags"
          placeholder={t('browser.trustedDomainsPlaceholder')}
          value={browser.trustedDomains}
          onChange={(v) => patch({ trustedDomains: v })}
          classNames={configModalSelectPopupClassNames}
        />
      </ConfigField>

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
