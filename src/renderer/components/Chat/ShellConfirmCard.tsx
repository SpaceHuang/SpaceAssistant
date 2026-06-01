import { useMemo } from 'react'
import { AlertTriangle, Check, Terminal, X } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ShellTuiFallbackHint } from './ShellTuiFallbackHint'

type Props = {
  record: ToolCallRecord
  workDir?: string
  onConfirm: (approved: boolean) => void
}

function commandPreviewLines(command: string): string[] {
  if (!command) return ['(空)']
  const lines = command.split('\n')
  return lines.length > 0 ? lines : ['(空)']
}

export function ShellConfirmCard({ record, workDir, onConfirm }: Props) {
  const command = typeof record.input.command === 'string' ? record.input.command : ''
  const description = typeof record.input.description === 'string' ? record.input.description.trim() : ''
  const timeout = typeof record.input.timeout === 'number' ? record.input.timeout : undefined
  const hints = record.shellSecurityHints
  const requiresRiskAck = hints?.requiresRiskAck === true
  const warnings = hints?.warnings ?? []
  const allowLabel = requiresRiskAck ? '我了解风险，确认执行' : '确认执行'
  const commandLines = useMemo(() => commandPreviewLines(command), [command])

  return (
    <div className={`write-confirm-card shell-confirm-card${requiresRiskAck ? ' shell-confirm-card--risk' : ''}`}>
      <div className="write-confirm-card__header shell-confirm-card__header">
        <span className="write-confirm-card__icon-badge" aria-hidden>
          <Terminal size={14} strokeWidth={1.75} className="write-confirm-card__file-icon" />
        </span>
        <span className="shell-confirm-card__title">Shell 命令</span>
        {requiresRiskAck ? (
          <span className="write-confirm-card__stat write-confirm-card__stat--remove">风险</span>
        ) : null}
        <div className="write-confirm-card__actions">
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--allow"
            aria-label={allowLabel}
            title={allowLabel}
            onClick={() => onConfirm(true)}
          >
            <Check size={16} strokeWidth={2.25} />
          </button>
          <button
            type="button"
            className="write-confirm-card__action write-confirm-card__action--deny"
            aria-label="拒绝执行"
            title="拒绝执行"
            onClick={() => onConfirm(false)}
          >
            <X size={16} strokeWidth={2.25} />
          </button>
        </div>
      </div>
      <div className="write-confirm-card__body shell-confirm-card__body">
        {description ? <p className="shell-confirm-card__description">{description}</p> : null}
        {warnings.length > 0 ? (
          <div className="shell-confirm-card__alert" role="alert">
            <AlertTriangle size={14} strokeWidth={2} className="shell-confirm-card__alert-icon" aria-hidden />
            <div className="shell-confirm-card__alert-content">
              <span className="shell-confirm-card__alert-title">路径安全警示</span>
              <ul className="shell-confirm-card__warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        <ShellTuiFallbackHint command={command} workDir={workDir} />
        <pre className="shell-confirm-card__command">
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
      </div>
    </div>
  )
}
