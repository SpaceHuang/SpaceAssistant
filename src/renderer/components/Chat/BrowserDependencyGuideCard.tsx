import { App } from 'antd'
import { Terminal } from 'lucide-react'
import type { BrowserDependencyToolError } from '../../../shared/browserTypes'
import { formatUserFacingError } from '../../utils/formatUserFacingError'

type Props = {
  dependencyRecovery: BrowserDependencyToolError
  /** 失败的浏览器操作摘要，例如「打开 example.com」 */
  actionLabel?: string
}

export function BrowserDependencyGuideCard({ dependencyRecovery, actionLabel }: Props) {
  const { message } = App.useApp()
  const canOpenTerminal = typeof window.api?.browserOpenTerminal === 'function'
  const cwd = dependencyRecovery.recommendedCwd
  const showFooter = Boolean(cwd || canOpenTerminal)

  return (
    <div className="write-confirm-card browser-dependency-guide-card">
      <div className="browser-dependency-guide-card__body">
        {actionLabel ? (
          <p className="write-confirm-card__intro-label browser-dependency-guide-card__action">
            {actionLabel}
          </p>
        ) : null}
        <p className="browser-dependency-guide-card__status">
          <span className="browser-dependency-guide-card__status-dot" aria-hidden />
          <span>网络访问依赖未就绪</span>
        </p>
        <p className="write-confirm-card__subject-note browser-dependency-guide-card__note">
          助手将代为运行安装命令（需你确认）；若 Shell 未启用，可使用下方按钮在终端中手动操作。
        </p>
      </div>
      {showFooter ? (
        <div className="write-confirm-card__footer browser-dependency-guide-card__footer">
          {cwd ? (
            <p className="browser-dependency-guide-card__cwd">
              <span className="browser-dependency-guide-card__cwd-label">工作目录</span>
              <span className="browser-dependency-guide-card__cwd-path" title={cwd}>
                {cwd}
              </span>
            </p>
          ) : null}
          {canOpenTerminal ? (
            <div className="write-confirm-card__actions">
              <button
                type="button"
                className="write-confirm-card__action write-confirm-card__action--allow browser-dependency-guide-card__action"
                onClick={() => {
                  void window.api.browserOpenTerminal().then((r) => {
                    if (!r.ok) message.error(formatUserFacingError(r.error))
                  })
                }}
              >
                <Terminal size={14} strokeWidth={2.25} aria-hidden />
                <span>在终端中打开</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
