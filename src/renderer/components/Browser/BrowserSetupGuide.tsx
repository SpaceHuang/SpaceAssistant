import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Collapse, Space, Typography } from 'antd'
import type { BrowserDetectResult } from '../../../shared/browserTypes'
import {
  buildBrowserSetupGuideContent,
  buildDiagnosticText
} from '../../../shared/browserSetupGuideContent'

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

function ExpandChevronIcon() {
  return (
    <svg
      className="browser-setup-guide__expand-icon"
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path fill="currentColor" d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
    </svg>
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

  const content = buildBrowserSetupGuideContent(detect, platform)
  const ready = isBrowserEnvironmentReady(detect)
  const guideClass =
    mode === 'chat' ? 'browser-setup-guide browser-setup-guide--chat' : 'browser-setup-guide'

  if (ready && !detailsExpanded) {
    const expand = () => setDetailsExpanded(true)
    return (
      <div
        className="browser-setup-guide--compact-wrap"
        title="点击展开详情"
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
        <Alert
          className={`${guideClass} browser-setup-guide--compact`}
          type="success"
          showIcon
          message={
            <span className="browser-setup-guide__compact-row">
              <span>网络访问功能正常</span>
              <ExpandChevronIcon />
            </span>
          }
        />
      </div>
    )
  }

  return (
    <div className={guideClass}>
      <div className="browser-setup-guide__header">
        <Typography.Text strong>{content.title}</Typography.Text>
        {ready ? (
          <Button type="link" size="small" className="browser-setup-guide__collapse" onClick={() => setDetailsExpanded(false)}>
            收起
          </Button>
        ) : null}
      </div>
      {content.summary ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 8 }}>
          {content.summary}
        </Typography.Paragraph>
      ) : null}

      <div className="browser-setup-guide__status" style={{ fontSize: 13, marginBottom: 12 }}>
        <div>
          Stagehand:{' '}
          {detect.stagehand.installed ? (
            <Typography.Text type="success">已安装 {detect.stagehand.version ?? ''}</Typography.Text>
          ) : (
            <Typography.Text type="danger">未安装</Typography.Text>
          )}
        </div>
        <div>
          Playwright:{' '}
          {detect.playwright.installed ? (
            <Typography.Text type="success">已安装</Typography.Text>
          ) : (
            <Typography.Text type="danger">未安装</Typography.Text>
          )}
        </div>
        <div>
          Chromium:{' '}
          {detect.chromium.ready ? (
            <Typography.Text type="success">已就绪</Typography.Text>
          ) : (
            <Typography.Text type="danger">未安装</Typography.Text>
          )}
        </div>
        <div>
          Node: {detect.node.version}{' '}
          {detect.node.meetsRequirement ? (
            <Typography.Text type="success">（应用内置）✓</Typography.Text>
          ) : (
            <Typography.Text type="danger">✗</Typography.Text>
          )}
        </div>
      </div>

      {ready ? (
        <>
          <Alert type="success" showIcon message="检测通过，浏览器工具可以初始化。" />
          <Space wrap style={{ marginTop: 12 }}>
            <Button loading={detecting} onClick={() => void onRefresh(true)}>
              重新检测
            </Button>
            <Button onClick={() => void copyText(buildDiagnosticText(detect, platform), '诊断信息')}>
              复制诊断信息
            </Button>
          </Space>
        </>
      ) : (
        <>
          {content.showPackagedDefect ? (
            <Alert type="error" showIcon message={content.summary} style={{ marginBottom: 12 }} />
          ) : (
            <>
              <Typography.Text strong>安装步骤</Typography.Text>
              <ol className="browser-setup-guide__steps" style={{ paddingLeft: 20, marginTop: 8 }}>
                <li>{content.terminalHint}</li>
                <li>
                  {content.cwdLabel}
                  <Space style={{ marginTop: 4 }}>
                    <Typography.Text code>{detect.recommendedCwd}</Typography.Text>
                    <Button size="small" onClick={() => void copyText(detect.recommendedCwd, '目录')}>
                      复制目录
                    </Button>
                  </Space>
                </li>
                {content.showNpmInstall ? (
                  <li>
                    安装 npm 依赖后继续执行 Chromium 步骤：
                    <Space style={{ marginTop: 4 }}>
                      <Typography.Text code>{content.npmInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.npmInstallCmd, '命令')}>
                        复制
                      </Button>
                    </Space>
                  </li>
                ) : null}
                {!content.showPackagedDefect ? (
                  <li>
                    执行安装命令：
                    <Space style={{ marginTop: 4 }}>
                      <Typography.Text code>{content.chromiumInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.chromiumInstallCmd, '命令')}>
                        复制命令
                      </Button>
                    </Space>
                  </li>
                ) : null}
                <li>完成后点击「重新检测」</li>
              </ol>
            </>
          )}

          <Space wrap style={{ marginTop: 12 }}>
            {typeof window.api?.browserOpenTerminal === 'function' ? (
              <Button
                onClick={() => {
                  void window.api.browserOpenTerminal().then((r) => {
                    if (!r.ok) message.error(r.error)
                  })
                }}
              >
                在终端中打开
              </Button>
            ) : null}
            <Button loading={detecting} onClick={() => void onRefresh(true)}>
              重新检测
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
                void copyText(all, '全部步骤')
              }}
            >
              复制全部步骤
            </Button>
            <Button onClick={() => void copyText(buildDiagnosticText(detect, platform), '诊断信息')}>
              复制诊断信息
            </Button>
          </Space>

          {content.showForceInstall ? (
            <Collapse
              style={{ marginTop: 12 }}
              items={[
                {
                  key: 'force',
                  label: '覆盖损坏安装（进阶）',
                  children: (
                    <Space>
                      <Typography.Text code>{content.forceInstallCmd}</Typography.Text>
                      <Button size="small" onClick={() => void copyText(content.forceInstallCmd, '命令')}>
                        复制
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
                label: '安装很慢 / 失败？查看故障排除',
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
