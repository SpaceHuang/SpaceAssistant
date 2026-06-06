import { useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import type { ToolConfirmHandler } from '../../../shared/toolConfirm'
import { ConfirmCardDecision } from './ConfirmCardDecision'
import { ShellTuiFallbackHint } from './ShellTuiFallbackHint'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  record: ToolCallRecord
  workDir?: string
  onConfirm: ToolConfirmHandler
}

export function ShellConfirmCard({ record, workDir, onConfirm }: Props) {
  const { t } = useTypedTranslation('chat')
  const [trustChecked, setTrustChecked] = useState(false)
  const emptyLabel = t('tool.empty')

  const commandPreviewLines = (command: string): string[] => {
    if (!command) return [emptyLabel]
    const lines = command.split('\n')
    return lines.length > 0 ? lines : [emptyLabel]
  }

  const command = typeof record.input.command === 'string' ? record.input.command : ''
  const description = typeof record.input.description === 'string' ? record.input.description.trim() : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const hints = record.shellSecurityHints
  const requiresRiskAck = hints?.requiresRiskAck === true
  const securityWarning = hints?.securityWarning?.trim()
  const warnings = hints?.warnings ?? []
  const canTrust = hints?.canTrust === true
  const allowLabel = requiresRiskAck ? t('confirm.shell.allowWithRisk') : t('confirm.shell.allow')
  const commandLines = useMemo(() => commandPreviewLines(command), [command, emptyLabel])
  const commandHead = commandLines[0]?.trim()
  const hasCommandHead = Boolean(commandHead && commandHead !== emptyLabel)
  const actionSummary = requiresRiskAck
    ? hasCommandHead
      ? commandHead!
      : t('confirm.shell.defaultTitle')
    : description
      ? t('confirm.shell.executeTitle')
      : hasCommandHead
        ? commandHead!
        : t('confirm.shell.executeTitle')

  const handleConfirm: ToolConfirmHandler = (approved, options) => {
    if (approved && trustChecked && canTrust && command.trim()) {
      onConfirm(approved, { ...options, trustCommand: command.trim() })
      return
    }
    onConfirm(approved, options)
  }

  return (
    <div className={`write-confirm-card shell-confirm-card${requiresRiskAck ? ' shell-confirm-card--risk' : ''}`}>
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel={allowLabel}
        denyLabel={t('confirm.shell.deny')}
        onConfirm={handleConfirm}
        badges={
          requiresRiskAck ? (
            <span className="write-confirm-card__stat write-confirm-card__stat--risk">{t('confirm.shell.highRisk')}</span>
          ) : undefined
        }
      >
        <div className="write-confirm-card__subject shell-confirm-card__subject">
          {description ? (
            <p className="write-confirm-card__subject-note shell-confirm-card__description">{description}</p>
          ) : null}
          {securityWarning ? (
            <div className="shell-confirm-card__alert" role="alert">
              <AlertTriangle size={14} strokeWidth={2} className="shell-confirm-card__alert-icon" aria-hidden />
              <div className="shell-confirm-card__alert-content">
                {securityWarning.split('\n').map((line, i) =>
                  line.trim() ? (
                    i === 0 ? (
                      <span key={`sw-${i}`} className="shell-confirm-card__alert-title">
                        {line}
                      </span>
                    ) : (
                      <p key={`sw-${i}`} className="shell-confirm-card__security-warning-line">
                        {line}
                      </p>
                    )
                  ) : (
                    <br key={`sw-${i}`} />
                  )
                )}
              </div>
            </div>
          ) : warnings.length > 0 ? (
            <div className="shell-confirm-card__alert" role="alert">
              <AlertTriangle size={14} strokeWidth={2} className="shell-confirm-card__alert-icon" aria-hidden />
              <div className="shell-confirm-card__alert-content">
                <span className="shell-confirm-card__alert-title">{t('confirm.shell.pathSecurityWarning')}</span>
                <ul className="shell-confirm-card__warnings">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
          <ShellTuiFallbackHint command={command} workDir={workDir} />
          <pre className="write-confirm-card__subject-value write-confirm-card__subject-value--code shell-confirm-card__command">
            {commandLines.map((line, i) => (
              <code key={`cmd-${i}`} className="shell-confirm-card__command-line">
                {line || ' '}
              </code>
            ))}
          </pre>
          {workDir || timeout !== undefined ? (
            <div className="shell-confirm-card__meta">
              {workDir ? (
                <span className="shell-confirm-card__meta-item">
                  <span className="shell-confirm-card__meta-key">cwd</span>
                  <span className="shell-confirm-card__meta-value">{workDir}</span>
                </span>
              ) : null}
              {timeout !== undefined ? (
                <span className="shell-confirm-card__meta-item">
                  <span className="shell-confirm-card__meta-key">timeout</span>
                  <span className="shell-confirm-card__meta-value">{timeout}s</span>
                </span>
              ) : null}
            </div>
          ) : null}
          {canTrust ? (
            <label className="write-confirm-card__trust-option">
              <input
                type="checkbox"
                checked={trustChecked}
                onChange={(e) => setTrustChecked(e.target.checked)}
              />
              <span>{t('toolCall.confirm.trustThisCommand')}</span>
            </label>
          ) : null}
        </div>
      </ConfirmCardDecision>
    </div>
  )
}
