import { useCallback, useEffect, useState } from 'react'
import { App, Badge, Button, Checkbox, Collapse, Input, InputNumber, Radio, Select, Space, Switch, Tooltip } from 'antd'
import type { FeishuConfig, FeishuEventStatus } from '../../../shared/feishuTypes'
import { FeishuAuditDrawer } from './FeishuAuditDrawer'
import { formatFeishuSettingsEventStatus } from './feishuEventStatusText'
import type { ModelEntry } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  feishu: FeishuConfig
  onChange: (next: FeishuConfig) => void
  models?: ModelEntry[]
}

export function FeishuSettingsTab({ feishu, onChange, models = [] }: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [cliStatus, setCliStatus] = useState<string>(t('feishu.detecting'))
  const [eventStatus, setEventStatus] = useState<FeishuEventStatus | null>(null)
  const [authStatus, setAuthStatus] = useState<string>('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [installingCli, setInstallingCli] = useState(false)
  const [configuringApp, setConfiguringApp] = useState(false)
  const [configStatus, setConfigStatus] = useState('')
  const [authLoggingIn, setAuthLoggingIn] = useState(false)

  const patch = useCallback((p: Partial<FeishuConfig>) => onChange({ ...feishu, ...p }), [feishu, onChange])

  const refreshStatus = useCallback(async () => {
    try {
      const detect = await window.api.feishuDetectCli()
      setCliStatus(
        detect.installed
          ? t('feishu.cliInstalled', {
              version: detect.version ?? '',
              path: detect.path ? `(${detect.path})` : ''
            })
          : t('feishu.cliNotDetected', {
              node: detect.nodeAvailable ? t('feishu.checkMark') : t('feishu.crossMark'),
              npm: detect.npmAvailable ? t('feishu.checkMark') : t('feishu.crossMark')
            })
      )
      const auth = await window.api.feishuAuthStatus()
      setAuthStatus(
        auth.authorized
          ? t('feishu.authorized')
          : auth.stderr?.trim()
            ? t('feishu.notLoggedInWithDetail', {
                detail: `${auth.stderr.trim()}${auth.hint ? `，${auth.hint}` : ''}`
              })
            : t('feishu.notLoggedIn')
      )
      if (auth.authorized !== feishu.userAuthorized) {
        patch({ userAuthorized: auth.authorized })
      }
      if (feishu.remoteEnabled) {
        const es = await window.api.feishuEventStatus()
        setEventStatus(es ?? null)
      }
    } catch (e) {
      setCliStatus(e instanceof Error ? e.message : String(e))
    }
  }, [feishu.remoteEnabled, feishu.userAuthorized, patch, t])

  useEffect(() => {
    if (feishu.enabled) void refreshStatus()
  }, [feishu.enabled, refreshStatus])

  useEffect(() => {
    if (!feishu.remoteEnabled) return
    const timer = setInterval(() => {
      void window.api.feishuEventStatus().then(setEventStatus)
    }, 5000)
    return () => clearInterval(timer)
  }, [feishu.remoteEnabled])

  const installCli = async () => {
    if (typeof window.api.feishuInstallCli !== 'function') {
      message.error(t('feishu.ipcMissingBuild'))
      return
    }
    setInstallingCli(true)
    setCliStatus(t('feishu.installingCli'))
    try {
      const r = await window.api.feishuInstallCli()
      if (r.success) {
        message.success(t('feishu.installSuccess'))
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || t('feishu.unknownError')).trim().slice(-800)
        message.error(r.timedOut ? t('feishu.installTimeout') : t('feishu.installFailed', { detail }))
        setCliStatus(r.timedOut ? t('feishu.installFailedTimeoutStatus') : t('feishu.installFailedStatus'))
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      message.error(t('feishu.installCliFailed', { error: err }))
      setCliStatus(t('feishu.installFailedStatus') + `: ${err}`)
    } finally {
      setInstallingCli(false)
    }
  }

  const configInit = async () => {
    if (typeof window.api.feishuConfigInit !== 'function') {
      message.error(t('feishu.ipcMissingRebuild'))
      return
    }
    setConfiguringApp(true)
    setConfigStatus(t('feishu.configuringApp'))
    const unsub =
      typeof window.api.feishuOnConfigInitProgress === 'function'
        ? window.api.feishuOnConfigInitProgress(({ line }) => {
            if (/https?:\/\//.test(line)) {
              setConfigStatus(t('feishu.configBrowserOpened'))
            } else if (line) {
              setConfigStatus(line.slice(-120))
            }
          })
        : undefined
    try {
      const r = await window.api.feishuConfigInit()
      if (r.success) {
        message.success(t('feishu.configSuccess'))
        patch({ appConfigured: true })
        setConfigStatus(t('feishu.configDone'))
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || t('feishu.unknownError')).trim().slice(-800)
        message.error(r.timedOut ? t('feishu.configTimeout') : t('feishu.configFailed', { detail }))
        if (r.authUrl) {
          message.info(t('feishu.configManualUrl'))
        }
        setConfigStatus(r.timedOut ? t('feishu.configFailedTimeoutStatus') : t('feishu.configFailedStatus'))
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      message.error(t('feishu.configAppFailed', { error: err }))
      setConfigStatus(`${t('feishu.configFailedStatus')}: ${err}`)
    } finally {
      unsub?.()
      setConfiguringApp(false)
    }
  }

  const authLogin = async () => {
    if (typeof window.api.feishuAuthLogin !== 'function') {
      message.error(t('feishu.ipcMissingRebuild'))
      return
    }
    setAuthLoggingIn(true)
    try {
      const r = await window.api.feishuAuthLogin()
      if (r.success) {
        message.success(t('feishu.loginSuccess'))
        patch({ userAuthorized: true })
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || t('feishu.unknownError')).trim().slice(-800)
        message.error(r.timedOut ? t('feishu.loginTimeout') : t('feishu.loginFailed', { detail }))
      }
      if (r.authUrl) message.info(t('feishu.loginBrowserOpened'))
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setAuthLoggingIn(false)
    }
  }

  return (
    <>
      <ConfigSettingsStack>
        <ConfigSwitchRow
          label={t('feishu.enableLabel')}
          checked={feishu.enabled}
          onChange={(enabled) => patch({ enabled })}
        />

        <div className="config-field">
          <div className="config-field__label">{t('feishu.cliStatusLabel')}</div>
          <div className="config-status-text">{cliStatus}</div>
          <Space wrap className="config-field__control">
            <Button loading={installingCli} disabled={installingCli} onClick={() => void installCli()}>
              {t('feishu.installCli')}
            </Button>
            <Button onClick={() => void refreshStatus()}>{t('feishu.redetect')}</Button>
            <Input
              className="config-field__control-input-flex"
              placeholder={t('feishu.cliPathPlaceholder')}
              value={feishu.cliPath ?? ''}
              onChange={(e) => patch({ cliPath: e.target.value || undefined })}
            />
          </Space>
        </div>

        <div className="config-field">
          <Space wrap>
            <Button loading={configuringApp} disabled={configuringApp} onClick={() => void configInit()}>
              {t('feishu.configApp')}
            </Button>
            <Switch checked={feishu.appConfigured} onChange={(appConfigured) => patch({ appConfigured })} />
            <span className="config-inline-label">{t('feishu.appConfigured')}</span>
          </Space>
          {configStatus ? <div className="config-status-text">{configStatus}</div> : null}
        </div>

        <Space wrap>
          <Button loading={authLoggingIn} disabled={authLoggingIn} onClick={() => void authLogin()}>
            {t('feishu.loginAccount')}
          </Button>
          <span className="config-status-text">{authStatus}</span>
        </Space>

        <Space wrap align="center">
          <Switch checked={feishu.remoteEnabled} onChange={(remoteEnabled) => patch({ remoteEnabled })} />
          <span className="config-inline-label">{t('feishu.remoteListen')}</span>
          {eventStatus && (
            <Badge
              status={
                eventStatus.state === 'connected' ? 'success' : eventStatus.state === 'error' ? 'error' : 'processing'
              }
              text={formatFeishuSettingsEventStatus(eventStatus, t)}
            />
          )}
          <Button size="small" onClick={() => void window.api.feishuEventStart().then(setEventStatus)}>
            {t('feishu.start')}
          </Button>
          <Button size="small" onClick={() => void window.api.feishuEventStop().then(setEventStatus)}>
            {t('feishu.stop')}
          </Button>
        </Space>

        <Checkbox checked={feishu.remoteNotifyOnReceive} onChange={(e) => patch({ remoteNotifyOnReceive: e.target.checked })}>
          {t('feishu.notifyOnReceive')}
        </Checkbox>

        <ConfigField label={t('feishu.groupTriggerLabel')}>
          <Radio.Group value={feishu.remoteGroupTrigger} onChange={(e) => patch({ remoteGroupTrigger: e.target.value })}>
            <Radio value="mention">{t('feishu.groupTriggerMention')}</Radio>
            <Radio value="prefix">{t('feishu.groupTriggerPrefix')}</Radio>
            <Radio value="both">{t('feishu.groupTriggerBoth')}</Radio>
          </Radio.Group>
          <Input
            className="config-field__control-nested"
            value={feishu.remoteCommandPrefix ?? '/sa '}
            onChange={(e) => patch({ remoteCommandPrefix: e.target.value })}
            placeholder={t('feishu.commandPrefixPlaceholder')}
          />
        </ConfigField>

        <ConfigField label={t('feishu.sessionMergeLabel')}>
          <InputNumber
            min={0}
            max={120}
            value={feishu.remoteSessionMergeMinutes ?? 0}
            onChange={(v) => patch({ remoteSessionMergeMinutes: v ?? 0 })}
          />
        </ConfigField>

        <ConfigField label={t('feishu.remoteConfirmLabel')}>
          <Select
            value={feishu.remoteConfirmPolicy}
            onChange={(remoteConfirmPolicy) => patch({ remoteConfirmPolicy })}
            classNames={configModalSelectPopupClassNames}
            options={[
              { value: 'remote_read_only', label: t('feishu.remoteConfirmReadOnly') },
              { value: 'feishu_confirm', label: t('feishu.remoteConfirmFeishu') },
              { value: 'always', label: t('feishu.remoteConfirmAlways') },
              {
                value: 'inherit',
                label: (
                  <Tooltip title={t('feishu.remoteConfirmInheritHint')}>
                    <span>{t('feishu.remoteConfirmInherit')}</span>
                  </Tooltip>
                )
              }
            ]}
          />
        </ConfigField>

        <Collapse
          ghost
          items={[
            {
              key: 'remoteProgress',
              label: t('feishu.remoteProgressTitle'),
              children: (
                <Space direction="vertical" size="middle" className="config-settings-stack">
                  <ConfigField label={t('feishu.remoteProgressModeLabel')}>
                    <Select
                      value={feishu.remoteProgressMode ?? 'activity_snapshot'}
                      onChange={(remoteProgressMode) => patch({ remoteProgressMode })}
                      classNames={configModalSelectPopupClassNames}
                      options={[
                        { value: 'activity_snapshot', label: t('feishu.remoteProgressModeActivity') },
                        { value: 'legacy_heartbeat', label: t('feishu.remoteProgressModeLegacy') },
                        { value: 'off', label: t('feishu.remoteProgressModeOff') }
                      ]}
                    />
                  </ConfigField>
                  <ConfigField label={t('feishu.remoteProgressHeartbeatLabel')}>
                    <InputNumber
                      min={0}
                      max={600}
                      value={feishu.remoteProgressHeartbeatSec ?? 60}
                      onChange={(v) => patch({ remoteProgressHeartbeatSec: v ?? 60 })}
                    />
                  </ConfigField>
                  <Checkbox
                    checked={feishu.remoteTypingEnabled ?? false}
                    onChange={(e) => patch({ remoteTypingEnabled: e.target.checked })}
                  >
                    {t('feishu.remoteTypingEnabled')}
                  </Checkbox>
                  <ConfigField label={t('feishu.remoteProgressMinIntervalLabel')}>
                    <InputNumber
                      min={0}
                      max={120}
                      value={feishu.remoteProgressMinIntervalSec ?? 5}
                      onChange={(v) => patch({ remoteProgressMinIntervalSec: v ?? 5 })}
                    />
                  </ConfigField>
                </Space>
              )
            }
          ]}
        />

        <Checkbox checked={feishu.remoteAllowLocalWrite} onChange={(e) => patch({ remoteAllowLocalWrite: e.target.checked })}>
          {t('feishu.remoteAllowLocalWrite')}
        </Checkbox>

        <ConfigField label={t('feishu.regionLabel')}>
          <Radio.Group value={feishu.region} onChange={(e) => patch({ region: e.target.value })}>
            <Radio value="feishu">{t('feishu.regionFeishu')}</Radio>
            <Radio value="lark">{t('feishu.regionLark')}</Radio>
          </Radio.Group>
        </ConfigField>

        <ConfigField label={t('feishu.remoteDefaultModelLabel')}>
          <Select
            allowClear
            placeholder={t('feishu.remoteDefaultModelPlaceholder')}
            value={feishu.remoteDefaultModelId}
            onChange={(remoteDefaultModelId) => patch({ remoteDefaultModelId })}
            classNames={configModalSelectPopupClassNames}
            options={models.filter((m) => m.enabled).map((m) => ({ value: m.name, label: m.name }))}
          />
        </ConfigField>

        <Button onClick={() => setAuditOpen(true)}>{t('feishu.viewAudit')}</Button>
      </ConfigSettingsStack>

      <FeishuAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
