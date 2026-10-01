import { App } from 'antd'
import { Terminal } from 'lucide-react'
import type { BrowserDependencyToolError } from '../../../shared/browserTypes'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { runtimeText } from '../../i18n/runtimeText'

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
          <span>{runtimeText('chat.browserDependency.title')}</span>
        </p>
        <p className="write-confirm-card__subject-note browser-dependency-guide-card__note">
          {runtimeText('chat.browserDependency.description')}
        </p>
      </div>
      {showFooter ? (
        <div className="write-confirm-card__footer browser-dependency-guide-card__footer">
          {cwd ? (
            <p className="browser-dependency-guide-card__cwd">
              <span className="browser-dependency-guide-card__cwd-label">{runtimeText('chat.browserDependency.workDir')}</span>
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
                <span>{runtimeText('chat.browserDependency.openTerminal')}</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
