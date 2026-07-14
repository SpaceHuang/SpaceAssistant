import { useCallback, useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { App, Badge, Button, Input, Space } from 'antd'
import type { WeChatConfig, WeChatConnectionStatus, WeChatLoginProgress } from '../../../shared/wechatTypes'
import { WeChatAuditDrawer } from './WeChatAuditDrawer'
import { ConfigSettingsStack } from './ConfigField'
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
}

function loginProgressLabel(
  stage: WeChatLoginProgress,
  t: ReturnType<typeof useTypedTranslation<'config'>>['t'],
  opts?: { isRetry?: boolean }
): string {
  switch (stage) {
    case 'waiting':
      return t('settings.wechat.waitingScan')
    case 'scanned':
      return t('settings.wechat.scannedConfirm')
    case 'confirmed':
      return t('settings.wechat.boundSuccess')
    case 'refreshing':
      return t('settings.wechat.qrRefreshing')
    case 'expired':
      return t('settings.wechat.qrExpired')
    case 'session_expired':
      return t('settings.wechat.sessionExpired')
    case 'verify_code':
      return opts?.isRetry ? t('settings.wechat.verifyCodeRetry') : t('settings.wechat.verifyCode')
    default:
      return ''
  }
}

export function WeChatSettingsTab({ wechat, onChange }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const [sdkStatus, setSdkStatus] = useState<string>(t('settings.wechat.detecting'))
  const [connection, setConnection] = useState<WeChatConnectionStatus | null>(null)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [qrExpired, setQrExpired] = useState(false)
  const [loginStage, setLoginStage] = useState<WeChatLoginProgress | null>(null)
  const [verifyRetry, setVerifyRetry] = useState(false)
  const [verifyInput, setVerifyInput] = useState('')
  const [verifySubmitting, setVerifySubmitting] = useState(false)
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
      if (url) {
        setQrUrl(url)
        setQrExpired(false)
        setShowQr(true)
        return
      }
      setQrUrl(null)
      if (expired) setQrExpired(true)
    })
    const offProgress = window.api.wechatOnLoginProgress(({ stage, isRetry }) => {
      setLoginStage(stage as WeChatLoginProgress)
      if (stage === 'verify_code') {
        setVerifyRetry(Boolean(isRetry))
        setVerifyInput('')
      }
      if (stage === 'confirmed') {
        patch({ loggedIn: true, enabled: true, remoteEnabled: true })
        setShowQr(false)
        setQrUrl(null)
        setQrExpired(false)
        void refreshStatus()
        void startListening()
        message.success(t('settings.wechat.boundSuccess'))
      }
      if (stage === 'expired') {
        setQrExpired(true)
        setQrUrl(null)
      }
      if (stage === 'session_expired') {
        message.warning(t('settings.wechat.sessionExpired'))
        void refreshStatus()
      }
    })
    return () => {
      offQr()
      offProgress()
    }
  }, [message, patch, refreshStatus, startListening, t])

  const startBind = async (opts?: { force?: boolean }) => {
    setBinding(true)
    setShowQr(true)
    setQrExpired(false)
    setLoginStage('waiting')
    setVerifyInput('')
    setVerifyRetry(false)
    patch({ enabled: true })
    try {
      const r = await window.api.wechatLoginStart({ force: Boolean(opts?.force) })
      if (!r.ok && r.error !== 'aborted') {
        message.error(r.error ?? t('settings.wechat.loginFailed'))
        // Keep QR panel on final expiry so user can tap retry; hide for other failures.
        if (!/QR code expired|qr.?expired|expired/i.test(r.error ?? '')) {
          setShowQr(false)
        } else {
          setQrExpired(true)
        }
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
    setQrExpired(false)
    setLoginStage(null)
    setVerifyInput('')
  }

  const rebind = async () => {
    await stopBind()
    await startBind({ force: true })
  }

  const submitVerifyCode = async () => {
    const code = verifyInput.trim()
    if (!code) return
    setVerifySubmitting(true)
    try {
      const r = await window.api.wechatSubmitVerifyCode(code)
      if (!r.ok) message.warning(t('settings.wechat.verifyCodeNotWaiting'))
    } catch (e) {
      message.error(e instanceof Error ? e.message : t('settings.wechat.networkFailed'))
    } finally {
      setVerifySubmitting(false)
    }
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
  const showQrImage = Boolean(qrUrl) && !qrExpired
  const qrRefreshing = loginStage === 'refreshing'

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
                <Button type="primary" loading={binding} onClick={() => void startBind({ force: true })}>
                  {t('settings.wechat.bindButton')}
                </Button>
              ) : null}
              {showQr ? (
                <div className="wechat-qr-panel">
                  {showQrImage ? (
                    <div style={{ opacity: qrRefreshing ? 0.45 : 1 }}>
                      <QRCodeSVG value={qrUrl!} size={180} level="M" />
                    </div>
                  ) : (
                    <div className="wechat-qr-placeholder">
                      {qrExpired ? t('settings.wechat.qrExpired') : t('settings.wechat.waitingScan')}
                    </div>
                  )}
                  {loginStage ? (
                    <div className="config-status-text">
                      {loginProgressLabel(loginStage, t, { isRetry: verifyRetry })}
                    </div>
                  ) : null}
                  {loginStage === 'verify_code' ? (
                    <Space.Compact style={{ width: '100%', maxWidth: 280 }}>
                      <Input
                        value={verifyInput}
                        onChange={(e) => setVerifyInput(e.target.value)}
                        placeholder={t('settings.wechat.verifyCodePlaceholder')}
                        onPressEnter={() => void submitVerifyCode()}
                      />
                      <Button
                        type="primary"
                        loading={verifySubmitting}
                        disabled={!verifyInput.trim()}
                        onClick={() => void submitVerifyCode()}
                      >
                        {t('settings.wechat.verifyCodeSubmit')}
                      </Button>
                    </Space.Compact>
                  ) : null}
                  <Space wrap>
                    {qrExpired ? (
                      <Button loading={binding} onClick={() => void startBind({ force: true })}>
                        {t('settings.wechat.retryQr')}
                      </Button>
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

        <Button onClick={() => setAuditOpen(true)}>{t('settings.wechat.viewAudit')}</Button>
      </ConfigSettingsStack>

      <WeChatAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
