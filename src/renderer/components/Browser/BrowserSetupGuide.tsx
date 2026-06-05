import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Collapse, Space, Typography } from 'antd'
import type { BrowserDetectResult } from '../../../shared/browserTypes'
import {
  buildBrowserSetupGuideContent,
  buildDiagnosticText
} from '../../../shared/browserSetupGuideContent'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import {
  BrowserDetectDetailValue,
  BrowserRuntimeCheckCompactRow,
  ExpandChevronIcon
} from './BrowserRuntimeCheckUi'

type Props = {
  detect: BrowserDetectResult | null
  detecting?: boolean
  onRefresh: (force?: boolean) => Promise<void>
  mode?: 'settings' | 'chat'
  platform?: string
}

function detectPlatform(): string {
  if (typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)) return 'darwin'
  if (typeof navigator !== 'undefined' && /Win/i.test(navigator.userAgent)) return 'win32'
  return 'linux'
}

function isBrowserEnvironmentReady(detect: BrowserDetectResult): boolean {
  return (
    detect.canInitialize &&
    detect.stagehand.installed &&
    detect.playwright.installed &&
    detect.chromium.ready &&
    detect.node.meetsRequirement
  )
}

export function BrowserSetupGuide({
  detect,
  detecting = false,
  onRefresh,
  mode = 'settings',
  platform = detectPlatform()
}: Props) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('common')
  const { t: tf } = useTypedTranslation('feishu')
  const [detailsExpanded, setDetailsExpanded] = useState(false)
  const wasReadyRef = useRef<boolean | null>(null)

  const copyText = useCallback(
    async (text: string, label: string) => {
      await navigator.clipboard.writeText(text)
      message.success(`${label}已复制`)
    },
    [message]
  )

  useEffect(() => {
    if (!detect) return
    const ready = isBrowserEnvironmentReady(detect)
    if (!ready) {
      setDetailsExpanded(true)
    } else if (wasReadyRef.current === false) {
      setDetailsExpanded(false)
    }
    wasReadyRef.current = ready
  }, [detect])

  if (!detect) return null

  const content = buildBrowserSetupGuideContent(detect, platform, (key: string) => {
    // 移除 'feishu:' 前缀，因为 tf 已经是 feishu namespace 下的
    const keyWithoutPrefix = key.replace(/^feishu:/, '')
    return tf(keyWithoutPrefix as any)
  })
  const ready = isBrowserEnvironmentReady(detect)
  const guideClass =
    mode === 'chat' ? 'browser-setup-guide browser-setup-guide--chat' : 'browser-setup-guide'

  if (ready && !detailsExpanded) {
    const expand = () => setDetailsExpanded(true)
    return (
      <div
        className="browser-setup-guide--compact-wrap"
        title={tf('remote.browser.setup.clickToExpand')}
        role="button"
        tabIndex={0}
        onClick={expand}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            expand()
          }
        }}
      >
        <BrowserRuntimeCheckCompactRow tone="success" className={guideClass}>
          <span>{tf('remote.browser.setup.networkOk')}</span>
          <ExpandChevronIcon />
        </BrowserRuntimeCheckCompactRow>
      </div>
    )
  }

  return (
    <div className={guideClass}>
      <div className="browser-setup-guide__header">
        <Typography.Text strong>{content.title}</Typography.Text>
        {ready ? (
          <Button type="link" size="small" className="browser-setup-guide__collapse" onClick={() => setDetailsExpanded(false)}>
            {t('chat:confirm.collapsible.collapse')}
          </Button>
        ) : null}
      </div>
      {content.summary ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
          {content.summary}
        </Typography.Paragraph>
      ) : null}

      <div className="browser-setup-guide__status" style={{ marginBottom: 12 }}>
        <div>
          Stagehand:{' '}
          <BrowserDetectDetailValue ok={detect.stagehand.installed}>
            {detect.stagehand.installed
              ? `${t('status.installed')} ${detect.stagehand.version ?? ''}`
              : t('status.notInstalled')}
          </BrowserDetectDetailValue>
        </div>
        <div>
          Playwright:{' '}
          <BrowserDetectDetailValue ok={detect.playwright.installed}>
            {detect.playwright.installed ? t('status.installed') : t('status.notInstalled')}
          </BrowserDetectDetailValue>
        </div>
        <div>
          Chromium:{' '}
          <BrowserDetectDetailValue ok={detect.chromium.ready}>
            {detect.chromium.ready ? t('status.ready') : t('status.notInstalled')}
          </BrowserDetectDetailValue>
        </div>
        <div>
          Node: {detect.node.version}{' '}
          <BrowserDetectDetailValue ok={detect.node.meetsRequirement}>
            {detect.node.meetsRequirement ? `${t('status.builtinNode')} ✓` : '✗'}
          </BrowserDetectDetailValue>
        </div>
      </div>

      {ready ? (
        <>
          <BrowserRuntimeCheckCompactRow tone="success" className="browser-runtime-check-row--static">
            {tf('remote.browser.setup.detectPassed')}
          </BrowserRuntimeCheckCompactRow>
          <Space wrap style={{ marginTop: 12 }}>
            <Button loading={detecting} onClick={() => void onRefresh(true)}>
              {tf('remote.browser.setup.redetect')}
            </Button>
            <Button onClick={() => void copyText(buildDiagnosticText(detect, platform), tf('remote.browser.setup.diagnosticInfo'))}>
              {tf('remote.browser.setup.copyDiagnostic')}
            </Button>
          </Space>
        </>
      ) : (
        <>
          {content.showPackagedDefect ? (
            <Alert type="error" showIcon message={content.summary} style={{ marginBottom: 12 }} />
          ) : (
            <>
              <Typography.Text strong>{tf('remote.browser.setup.installSteps')}</Typography.Text>
              <ol className="browser-setup-guide__steps" style={{ paddingLeft: 20, marginTop: 8 }}>
                <li>{content.terminalHint}</li>
                <li>
                  {content.cwdLabel}
                  <Space style={{ marginTop: 4 }}>
                    <Typography.Text code>{detect.recommendedCwd}</Typography.Text>
                    <Button size="small" onClick={() => void copyText(detect.recommendedCwd, tf('remote.browser.setup.copyDir'))}>
                      {tf('remote.browser.setup.copyDir')}
                    </Button>
                  </Space>
                </li>
                {content.showNpmInstall ? (
                  <li>
                    {tf('remote.browser.setup.stepInstall')}
                    <Space style={{ marginTop: 4 }}>
                      <Typography.Text code>{content.npmInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.npmInstallCmd, tf('remote.browser.setup.copy'))}>
                        {tf('remote.browser.setup.copy')}
                      </Button>
                    </Space>
                  </li>
                ) : null}
                {!content.showPackagedDefect ? (
                  <li>
                    {tf('remote.browser.setup.stepRunInstall')}
                    <Space style={{ marginTop: 4 }}>
                      <Typography.Text code>{content.chromiumInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.chromiumInstallCmd, tf('remote.browser.setup.copyCmd'))}>
                        {tf('remote.browser.setup.copyCmd')}
                      </Button>
                    </Space>
                  </li>
                ) : null}
                <li>{tf('remote.browser.setup.stepRedetect')}</li>
              </ol>
            </>
          )}

          <Space wrap style={{ marginTop: 12 }}>
            {typeof window.api?.browserOpenTerminal === 'function' ? (
              <Button
                onClick={() => {
                  void window.api.browserOpenTerminal().then((r) => {
                    if (!r.ok) message.error(formatUserFacingError(r.error))
                  })
                }}
              >
                {tf('remote.browser.setup.openInTerminal')}
              </Button>
            ) : null}
            <Button loading={detecting} onClick={() => void onRefresh(true)}>
              {tf('remote.browser.setup.redetect')}
            </Button>
            <Button
              onClick={() => {
                const all = [
                  content.terminalHint,
                  `cd "${detect.recommendedCwd}"`,
                  content.showNpmInstall ? content.npmInstallCmd : '',
                  content.chromiumInstallCmd
                ]
                  .filter(Boolean)
                  .join('\n')
                void copyText(all, tf('remote.browser.setup.allSteps'))
              }}
            >
              {tf('remote.browser.setup.copyAllSteps')}
            </Button>
            <Button onClick={() => void copyText(buildDiagnosticText(detect, platform), tf('remote.browser.setup.diagnosticInfo'))}>
              {tf('remote.browser.setup.copyDiagnostic')}
            </Button>
          </Space>

          {content.showForceInstall ? (
            <Collapse
              style={{ marginTop: 12 }}
              items={[
                {
                  key: 'force',
                  label: tf('remote.browser.setup.forceInstallLabel'),
                  children: (
                    <Space>
                      <Typography.Text code>{content.forceInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.forceInstallCmd, tf('remote.browser.setup.copy'))}>
                        {tf('remote.browser.setup.copy')}
                      </Button>
                    </Space>
                  )
                }
              ]}
            />
          ) : null}

          <Collapse
            style={{ marginTop: 12 }}
            items={[
              {
                key: 'troubleshoot',
                label: tf('remote.browser.setup.troubleshootLabel'),
                children: (
                  <Space direction="vertical">
                    {content.troubleshooting.map((item) => (
                      <div key={item.title}>
                        <Typography.Text strong>{item.title}</Typography.Text>
                        <div>{item.body}</div>
                      </div>
                    ))}
                  </Space>
                )
              }
            ]}
          />
        </>
      )}
    </div>
  )
}
