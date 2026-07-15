import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, InputNumber, Select, Space } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import {
  applyRemoteRestrictWritesAndOutbound,
  isRemoteRestrictWritesAndOutbound,
  type RemoteImCommonConfig
} from '../../../shared/imTypes'
import type {
  RemoteSecurityMigrationPlan,
  RemoteSecurityPatch
} from '../../../shared/remoteSecurityMigration'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../../shared/remoteProgressTypes'
import { readRemoteSessionIdleMinutes } from '../../../shared/remoteSessionResolve'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'
import { RemoteSecurityUpgradeModal } from './RemoteSecurityUpgradeModal'

type Props = {
  value: RemoteImCommonConfig
  onChange: (patch: Partial<RemoteImCommonConfig>) => void
  models?: ModelEntry[]
  allowRemoteBrowserSessions: boolean
  onAllowRemoteBrowserSessionsChange: (enabled: boolean) => void
}

export function RemoteImCommonSettings({
  value,
  onChange,
  models = [],
  allowRemoteBrowserSessions,
  onAllowRemoteBrowserSessionsChange
}: Props) {
  const { t } = useTypedTranslation('config')
  const restrictOn = isRemoteRestrictWritesAndOutbound(value)

  const [plan, setPlan] = useState<RemoteSecurityMigrationPlan | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const load = window.api?.remoteSecurityPlan
    if (!load) return
    void load().then((p) => {
      if (alive) setPlan(p)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const handleCommit = async (patch: RemoteSecurityPatch): Promise<void> => {
    await window.api.remoteSecurityCommit(patch)
    // Reflect the confirmed switches into the in-memory config (dual-write to both channels).
    onChange({ ...patch.common })
    setPlan((prev) => (prev ? { ...prev, needsSummary: false, isMigrated: true } : prev))
    setModalOpen(false)
  }

  return (
    <ConfigSettingsStack>
      <p className="config-field__hint">{t('remoteImCommon.hint')}</p>

      {plan?.needsSummary && (
        <Alert
          type="warning"
          showIcon
          message={t('remoteSecurityUpgrade.title')}
          description={t('remoteSecurityUpgrade.intro')}
          action={
            <Button size="small" type="primary" onClick={() => setModalOpen(true)}>
              {t('remoteSecurityUpgrade.confirm')}
            </Button>
          }
        />
      )}

      <RemoteSecurityUpgradeModal
        open={modalOpen}
        plan={plan}
        onCommit={handleCommit}
        onCancel={() => setModalOpen(false)}
      />

      <ConfigSwitchRow
        label={t('remoteImCommon.allowRemoteBrowserLabel')}
        hint={t('remoteImCommon.allowRemoteBrowserHint')}
        checked={allowRemoteBrowserSessions}
        onChange={(v) => onAllowRemoteBrowserSessionsChange(Boolean(v))}
      />

      <Checkbox
        checked={value.remoteNotifyOnReceive}
        onChange={(e) => onChange({ remoteNotifyOnReceive: e.target.checked })}
      >
        {t('remoteImCommon.notifyOnReceive')}
      </Checkbox>

      <ConfigField label={t('remoteImCommon.sessionIdleLabel')}>
        <InputNumber
          min={0}
          max={120}
          value={readRemoteSessionIdleMinutes(value)}
          onChange={(v) => onChange({ remoteSessionIdleMinutes: v ?? 0 })}
        />
        <span className="config-inline-label">{t('remoteImCommon.sessionIdleUnit')}</span>
      </ConfigField>

      <ConfigField label={t('remoteImCommon.remoteDefaultModelLabel')}>
        <Select
          allowClear
          placeholder={t('remoteImCommon.remoteDefaultModelPlaceholder')}
          value={value.remoteDefaultModelId}
          onChange={(remoteDefaultModelId) => onChange({ remoteDefaultModelId })}
          classNames={configModalSelectPopupClassNames}
          options={models.filter((m) => m.enabled).map((m) => ({ value: m.name, label: m.name }))}
        />
      </ConfigField>

      <Collapse
        ghost
        items={[
          {
            key: 'remoteProgress',
            label: t('remoteImCommon.remoteProgressTitle'),
            children: (
              <Space direction="vertical" size="middle" className="config-settings-stack">
                <ConfigField label={t('remoteImCommon.remoteProgressModeLabel')}>
                  <Select
                    value={value.remoteProgressMode ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMode}
                    onChange={(remoteProgressMode) => onChange({ remoteProgressMode })}
                    classNames={configModalSelectPopupClassNames}
                    options={[
                      { value: 'activity_snapshot', label: t('remoteImCommon.remoteProgressModeActivity') },
                      { value: 'legacy_heartbeat', label: t('remoteImCommon.remoteProgressModeLegacy') },
                      { value: 'off', label: t('remoteImCommon.remoteProgressModeOff') }
                    ]}
                  />
                </ConfigField>
                <ConfigField label={t('remoteImCommon.remoteProgressHeartbeatLabel')}>
                  <InputNumber
                    min={0}
                    max={600}
                    value={
                      value.remoteProgressHeartbeatSec ??
                      DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec
                    }
                    onChange={(v) =>
                      onChange({
                        remoteProgressHeartbeatSec:
                          v ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressHeartbeatSec
                      })
                    }
                  />
                </ConfigField>
                <Checkbox
                  checked={value.remoteTypingEnabled ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteTypingEnabled}
                  onChange={(e) => onChange({ remoteTypingEnabled: e.target.checked })}
                >
                  {t('remoteImCommon.remoteTypingEnabled')}
                </Checkbox>
                <ConfigField label={t('remoteImCommon.remoteProgressMinIntervalLabel')}>
                  <InputNumber
                    min={0}
                    max={120}
                    value={
                      value.remoteProgressMinIntervalSec ??
                      DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec
                    }
                    onChange={(v) =>
                      onChange({
                        remoteProgressMinIntervalSec:
                          v ?? DEFAULT_REMOTE_PROGRESS_CONFIG.remoteProgressMinIntervalSec
                      })
                    }
                  />
                </ConfigField>
              </Space>
            )
          }
        ]}
      />

      <ConfigSwitchRow
        label={t('remoteImCommon.restrictWritesAndOutbound')}
        hint={t('remoteImCommon.restrictWritesAndOutboundHint')}
        checked={restrictOn}
        onChange={(enabled) => onChange(applyRemoteRestrictWritesAndOutbound(Boolean(enabled)))}
      />

      <Checkbox
        checked={value.remoteAllowLocalWrite}
        onChange={(e) => onChange({ remoteAllowLocalWrite: e.target.checked })}
      >
        {t('remoteImCommon.remoteAllowLocalWrite')}
      </Checkbox>

      <Checkbox
        checked={value.remoteDenyOutbound}
        onChange={(e) => onChange({ remoteDenyOutbound: e.target.checked })}
      >
        {t('remoteImCommon.remoteDenyOutbound')}
      </Checkbox>

      <ConfigSwitchRow
        label={t('remoteImCommon.remoteBrowserRequiresConfirm')}
        hint={t('remoteImCommon.remoteBrowserRequiresConfirmHint')}
        checked={value.remoteBrowserRequiresConfirm}
        onChange={(v) => onChange({ remoteBrowserRequiresConfirm: Boolean(v) })}
      />

      <ConfigField label={t('remoteImCommon.rateLimitLabel')}>
        <InputNumber
          min={1}
          max={120}
          value={value.remoteRateLimitPerMinute}
          onChange={(v) => onChange({ remoteRateLimitPerMinute: v ?? 60 })}
        />
      </ConfigField>

      <ConfigField label={t('remoteImCommon.senderAllowlistLabel')}>
        <Input.TextArea
          rows={3}
          readOnly
          placeholder={t('remoteImCommon.senderAllowlistPlaceholder')}
          value={(value.remoteSenderAllowlist ?? []).join('\n')}
        />
        <p className="config-field__hint">{t('remoteImCommon.senderAllowlistReadonlyHint')}</p>
      </ConfigField>
    </ConfigSettingsStack>
  )
}
