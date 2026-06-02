import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'
import type { ToolCallRecord } from '../../../shared/domainTypes'
import { ConfirmCardDecision } from './ConfirmCardDecision'
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
  const commandHead = commandLines[0]?.trim()
  const hasCommandHead = Boolean(commandHead && commandHead !== '(空)')
  const actionSummary = requiresRiskAck
    ? hasCommandHead
      ? commandHead!
      : 'Shell 命令'
    : description
      ? '执行 Shell 命令'
      : hasCommandHead
        ? commandHead!
        : '执行 Shell 命令'

  return (
    <div className={`write-confirm-card shell-confirm-card${requiresRiskAck ? ' shell-confirm-card--risk' : ''}`}>
      <ConfirmCardDecision
        actionSummary={actionSummary}
        allowLabel={allowLabel}
        denyLabel="拒绝执行"
        onConfirm={onConfirm}
        badges={
          requiresRiskAck ? (
            <span className="write-confirm-card__stat write-confirm-card__stat--risk">
              高风险
            </span>
          ) : undefined
        }
      />
      <div className="write-confirm-card__detail shell-confirm-card__detail">
        {description ? <p className="write-confirm-card__note shell-confirm-card__description">{description}</p> : null}
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
        <pre className="write-confirm-card__command shell-confirm-card__command">
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
