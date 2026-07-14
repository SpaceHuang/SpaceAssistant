import { Checkbox, Collapse, Input, InputNumber, Select, Space, Tooltip } from 'antd'
import type { ModelEntry } from '../../../shared/domainTypes'
import type { ImConfirmPolicy, RemoteImCommonConfig } from '../../../shared/imTypes'
import { DEFAULT_REMOTE_PROGRESS_CONFIG } from '../../../shared/remoteProgressTypes'
import { readRemoteSessionIdleMinutes } from '../../../shared/remoteSessionResolve'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'

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

  return (
    <ConfigSettingsStack>
      <p className="config-field__hint">{t('remoteImCommon.hint')}</p>

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

      <Checkbox
        checked={value.remoteAllowLocalWrite}
        onChange={(e) => onChange({ remoteAllowLocalWrite: e.target.checked })}
      >
        {t('remoteImCommon.remoteAllowLocalWrite')}
      </Checkbox>

      <ConfigField label={t('remoteImCommon.remoteConfirmLabel')}>
        <Select
          value={value.remoteConfirmPolicy}
          onChange={(remoteConfirmPolicy: ImConfirmPolicy) => onChange({ remoteConfirmPolicy })}
          classNames={configModalSelectPopupClassNames}
          options={[
            { value: 'im_confirm', label: t('remoteImCommon.remoteConfirmIm') },
            { value: 'remote_read_only', label: t('remoteImCommon.remoteConfirmReadOnly') },
            { value: 'always', label: t('remoteImCommon.remoteConfirmAlways') },
            {
              value: 'inherit',
              label: (
                <Tooltip title={t('remoteImCommon.remoteConfirmInheritHint')}>
                  <span>{t('remoteImCommon.remoteConfirmInherit')}</span>
                </Tooltip>
              )
            }
          ]}
        />
      </ConfigField>

      <ConfigField label={t('remoteImCommon.rateLimitLabel')}>
        <InputNumber
          min={1}
          max={120}
          value={value.remoteRateLimitPerMinute}
          onChange={(v) => onChange({ remoteRateLimitPerMinute: v ?? 10 })}
        />
      </ConfigField>

      <ConfigField label={t('remoteImCommon.senderAllowlistLabel')}>
        <Input.TextArea
          rows={3}
          placeholder={t('remoteImCommon.senderAllowlistPlaceholder')}
          value={(value.remoteSenderAllowlist ?? []).join('\n')}
          onChange={(e) => {
            const list = e.target.value
              .split(/[\n,]+/)
              .map((s) => s.trim())
              .filter(Boolean)
            onChange({ remoteSenderAllowlist: list.length ? list : undefined })
          }}
        />
      </ConfigField>
    </ConfigSettingsStack>
  )
}
