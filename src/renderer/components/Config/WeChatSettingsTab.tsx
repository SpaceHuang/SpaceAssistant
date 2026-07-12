import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { App, Badge, Button, Checkbox, Collapse, Input, InputNumber, Select, Space } from 'antd'
import type { WeChatConfig, WeChatConnectionStatus, WeChatLoginProgress } from '../../../shared/wechatTypes'
import { WeChatAuditDrawer } from './WeChatAuditDrawer'
import type { ModelEntry } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack } from './ConfigField'
import { configModalSelectPopupClassNames } from './configModalUi'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { ConfigResultAlert } from './ConfigResultAlert'
import {
  formatWeChatPollError,
  isWeChatPollStartFailed,
  notifyWeChatPollResult,
  resolveWeChatPollBadgeStatus,
  resolveWeChatPollStatusText
} from '../../services/wechatPollFeedback'

type Props = {
  wechat: WeChatConfig
  onChange: (next: WeChatConfig) => void
  models?: ModelEntry[]
}

function loginProgressLabel(stage: WeChatLoginProgress, t: ReturnType<typeof useTypedTranslation<'config'>>['t'], code?: string): string {
  switch (stage) {
    case 'waiting':
      return t('settings.wechat.waitingScan')
    case 'scanned':
      return t('settings.wechat.scannedConfirm')
    case 'confirmed':
      return t('settings.wechat.boundSuccess')
    case 'expired':
      return t('settings.wechat.qrExpired')
    case 'verify_code':
      return t('settings.wechat.verifyCode', { code: code ?? '' })
    default:
      return ''
  }
}

export function WeChatSettingsTab({ wechat, onChange, models = [] }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [sdkStatus, setSdkStatus] = useState<string>(t('settings.wechat.detecting'))
  const [connection, setConnection] = useState<WeChatConnectionStatus | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [qrExpired, setQrExpired] = useState(false)
  const [loginStage, setLoginStage] = useState<WeChatLoginProgress | null>(null)
  const [verifyCode, setVerifyCode] = useState<string | undefined>()
  const [binding, setBinding] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [pollActionLoading, setPollActionLoading] = useState(false)

  const patch = useCallback((p: Partial<WeChatConfig>) => onChange({ ...wechat, ...p }), [wechat, onChange])

  const applyPollStatus = useCallback(
    (status: WeChatConnectionStatus, opts?: { notify?: boolean }) => {
      setConnection(status)
      if (opts?.notify !== false) {
        notifyWeChatPollResult(status, message, t)
      }
      return !isWeChatPollStartFailed(status)
    },
    [message, t]
  )

  const startListening = useCallback(async () => {
    setPollActionLoading(true)
    patch({ remoteEnabled: true })
    try {
      const status = await window.api.wechatPollStart()
      applyPollStatus(status)
    } catch (e) {
      const detail = e instanceof Error ? e.message : t('settings.wechat.networkFailed')
      message.error(t('settings.wechat.listenFailedDetail', { detail }))
    } finally {
      setPollActionLoading(false)
    }
  }, [applyPollStatus, message, patch, t])

  const refreshStatus = useCallback(async () => {
    try {
      const detect = await window.api.wechatDetectSdk()
      setSdkStatus(
        detect.available
          ? t('settings.wechat.sdkReady', { version: detect.version ?? '' })
          : t('settings.wechat.sdkMissing', { error: detect.error ?? '' })
      )
      const status = await window.api.wechatConnectionStatus()
      setConnection(status)
      if (status.loggedIn !== wechat.loggedIn) {
        patch({
          loggedIn: status.loggedIn,
          displayName: status.displayName,
          botIdSuffix: status.botIdSuffix
        })
      }
    } catch (e) {
      setSdkStatus(e instanceof Error ? e.message : String(e))
    }
  }, [patch, t, wechat.loggedIn])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const bound = wechat.loggedIn || connection?.loggedIn

  useEffect(() => {
    if (!bound) return
    const timer = setInterval(() => {
      void window.api.wechatConnectionStatus().then(setConnection)
    }, 5000)
    return () => clearInterval(timer)
  }, [bound])

  useEffect(() => {
    const offQr = window.api.wechatOnQrUrl(({ url, expired }) => {
      setQrUrl(url)
      setQrExpired(Boolean(expired))
      if (url) setShowQr(true)
    })
    const offProgress = window.api.wechatOnLoginProgress(({ stage, code }) => {
      setLoginStage(stage as WeChatLoginProgress)
      setVerifyCode(code)
      if (stage === 'confirmed') {
        patch({ loggedIn: true, enabled: true, remoteEnabled: true })
        setShowQr(false)
        setQrUrl(null)
        void refreshStatus()
        void startListening()
        message.success(t('settings.wechat.boundSuccess'))
      }
      if (stage === 'expired') {
        setQrExpired(true)
      }
    })
    return () => {
      offQr()
      offProgress()
    }
  }, [message, patch, refreshStatus, startListening, t])

  const startBind = async () => {
    setBinding(true)
    setShowQr(true)
    setQrExpired(false)
    setLoginStage('waiting')
    patch({ enabled: true })
    try {
      const r = await window.api.wechatLoginStart()
      if (!r.ok) {
        message.error(r.error ?? t('settings.wechat.loginFailed'))
        setShowQr(false)
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('settings.wechat.networkFailed'))
      setShowQr(false)
    } finally {
      setBinding(false)
    }
  }

  const stopBind = async () => {
    await window.api.wechatLoginStop()
    setShowQr(false)
    setQrUrl(null)
    setLoginStage(null)
  }

  const rebind = async () => {
    await stopBind()
    await startBind()
  }

  const unbind = () => {
    modal.confirm({
      title: t('settings.wechat.unbindButton'),
      content: t('settings.wechat.unbindConfirm'),
      okType: 'danger',
      onOk: async () => {
        await window.api.wechatPollStop().catch(() => undefined)
        await window.api.wechatLogout()
        patch({
          loggedIn: false,
          enabled: false,
          remoteEnabled: false,
          displayName: undefined,
          botIdSuffix: undefined
        })
        setConnection(null)
        setShowQr(false)
        setQrUrl(null)
        message.success(t('settings.wechat.unbound'))
      }
    })
  }

  const pollBadge = resolveWeChatPollBadgeStatus(connection)

  const pollText = resolveWeChatPollStatusText(connection, t)
  const listenError =
    connection && isWeChatPollStartFailed(connection) ? formatWeChatPollError(connection, t) : null

  return (
    <>
      <ConfigSettingsStack>
        <div className="config-field">
          <div className="config-field__label">{t('settings.wechat.description')}</div>
          <p className="config-field__hint">{t('settings.wechat.descriptionHint')}</p>
        </div>

        <div className="config-field">
          <div className="config-field__label">{t('settings.wechat.sdkStatusLabel')}</div>
          <div className="config-status-text">{sdkStatus}</div>
          <Button size="small" onClick={() => void refreshStatus()}>
            {t('settings.wechat.redetect')}
          </Button>
        </div>

        <div className="config-field">
          {bound ? (
            <Space direction="vertical" size="small">
              <span className="config-status-text">
                ● {t('settings.wechat.boundStatus', { displayName: wechat.displayName ?? connection?.displayName ?? '' })}
              </span>
              <Space wrap>
                <Button onClick={() => void rebind()}>{t('settings.wechat.rebindButton')}</Button>
                <Button danger onClick={unbind}>
                  {t('settings.wechat.unbindButton')}
                </Button>
              </Space>
            </Space>
          ) : (
            <Space direction="vertical" size="middle">
              {!showQr ? (
                <Button type="primary" loading={binding} onClick={() => void startBind()}>
                  {t('settings.wechat.bindButton')}
                </Button>
              ) : null}
              {showQr ? (
                <div className="wechat-qr-panel">
                  {qrUrl && !qrExpired ? (
                    <QRCodeSVG value={qrUrl} size={180} level="M" />
                  ) : (
                    <div className="wechat-qr-placeholder">
                      {qrExpired ? t('settings.wechat.qrExpired') : t('settings.wechat.waitingScan')}
                    </div>
                  )}
                  {loginStage ? (
                    <div className="config-status-text">{loginProgressLabel(loginStage, t, verifyCode)}</div>
                  ) : null}
                  <Space wrap>
                    {qrExpired ? (
                      <Button onClick={() => void startBind()}>{t('settings.wechat.retryQr')}</Button>
                    ) : null}
                    <Button onClick={() => void stopBind()}>{t('settings.wechat.cancelBind')}</Button>
                  </Space>
                </div>
              ) : null}
            </Space>
          )}
        </div>

        <div className="config-field">
          <div className="config-field__label">{bound ? t('settings.wechat.listenStatusLabel') : null}</div>
          {bound ? (
            <Space direction="vertical" size="small" className="config-settings-stack">
              <Space wrap align="center">
                <Badge status={pollBadge} text={pollText} />
                <Button
                  size="small"
                  loading={pollActionLoading}
                  disabled={
                    pollActionLoading ||
                    connection?.pollState === 'polling' ||
                    connection?.pollState === 'connecting'
                  }
                  onClick={() => void startListening()}
                >
                  {t('settings.wechat.start')}
                </Button>
                <Button
                  size="small"
                  disabled={
                    pollActionLoading ||
                    connection?.pollState === 'stopped' ||
                    connection?.pollState === 'logged_out'
                  }
                  onClick={() => {
                    patch({ remoteEnabled: false })
                    void window.api.wechatPollStop().then((status) => applyPollStatus(status, { notify: false }))
                  }}
                >
                  {t('settings.wechat.stop')}
                </Button>
              </Space>
              {listenError ? <ConfigResultAlert ok={false} message={listenError} /> : null}
            </Space>
          ) : null}
        </div>

        {bound ? (
          <>
            <Checkbox
              checked={wechat.remoteNotifyOnReceive}
              onChange={(e) => patch({ remoteNotifyOnReceive: e.target.checked })}
            >
              {t('settings.wechat.notifyOnReceive')}
            </Checkbox>

            <ConfigField label={t('settings.wechat.sessionMergeLabel')}>
              <InputNumber
                min={0}
                max={120}
                value={wechat.remoteSessionMergeMinutes ?? 0}
                onChange={(v) => patch({ remoteSessionMergeMinutes: v ?? 0 })}
              />
              <span className="config-inline-label">{t('settings.wechat.sessionMergeUnit')}</span>
            </ConfigField>

            <ConfigField label={t('settings.wechat.remoteDefaultModelLabel')}>
              <Select
                allowClear
                placeholder={t('settings.wechat.remoteDefaultModelPlaceholder')}
                value={wechat.remoteDefaultModelId}
                onChange={(remoteDefaultModelId) => patch({ remoteDefaultModelId })}
                classNames={configModalSelectPopupClassNames}
                options={models.filter((m) => m.enabled).map((m) => ({ value: m.name, label: m.name }))}
              />
            </ConfigField>

            <Collapse
              ghost
              items={[
                {
                  key: 'security',
                  label: t('settings.wechat.securityTitle'),
                  children: (
                    <Space direction="vertical" size="middle" className="config-settings-stack">
                      <Checkbox
                        checked={wechat.remoteAllowLocalWrite}
                        onChange={(e) => patch({ remoteAllowLocalWrite: e.target.checked })}
                      >
                        {t('settings.wechat.allowLocalWrite')}
                      </Checkbox>
                      <ConfigField label={t('settings.wechat.rateLimitLabel')}>
                        <InputNumber
                          min={1}
                          max={120}
                          value={wechat.remoteRateLimitPerMinute}
                          onChange={(v) => patch({ remoteRateLimitPerMinute: v ?? 10 })}
                        />
                      </ConfigField>
                      <ConfigField label={t('settings.wechat.remoteConfirmLabel')}>
                        <Select
                          value={wechat.remoteConfirmPolicy}
                          onChange={(remoteConfirmPolicy) => patch({ remoteConfirmPolicy })}
                          classNames={configModalSelectPopupClassNames}
                          options={[
                            { value: 'remote_read_only', label: t('settings.wechat.policyReadOnly') },
                            { value: 'always', label: t('settings.wechat.policyAlways') },
                            { value: 'inherit', label: t('settings.wechat.policyInherit') }
                          ]}
                        />
                      </ConfigField>
                      <ConfigField label={t('settings.wechat.senderAllowlistLabel')}>
                        <Input.TextArea
                          rows={3}
                          placeholder={t('settings.wechat.senderAllowlistPlaceholder')}
                          value={(wechat.remoteSenderAllowlist ?? []).join('\n')}
                          onChange={(e) => {
                            const list = e.target.value
                              .split(/[\n,]+/)
                              .map((s) => s.trim())
                              .filter(Boolean)
                            patch({ remoteSenderAllowlist: list.length ? list : undefined })
                          }}
                        />
                      </ConfigField>
                      <Button onClick={() => setAuditOpen(true)}>{t('settings.wechat.viewAudit')}</Button>
                    </Space>
                  )
                }
              ]}
            />
          </>
        ) : null}
      </ConfigSettingsStack>

      <WeChatAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
