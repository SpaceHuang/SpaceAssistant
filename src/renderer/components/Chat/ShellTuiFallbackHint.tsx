import { useCallback } from 'react'
import { Button } from 'antd'
import { AlertTriangle } from 'lucide-react'
import { isInteractiveShellTuiCommand } from '../../../shared/shellInteractiveTui'
import { message as antMessage } from 'antd'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Props = {
  command: string
  workDir?: string
}

export function ShellTuiFallbackHint({ command, workDir }: Props) {
  const { t } = useTypedTranslation('chat')

  const handleOpenShellTerminal = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!workDir?.trim()) {
        antMessage.warning(t('shell.workDirNotConfigured'))
        return
      }
      try {
        const result = await window.api.shellOpenTerminal({ cwd: workDir })
        if (!result.ok) {
          antMessage.error(formatUserFacingError(result.error) || formatUserFacingError('CANNOT_OPEN_TERMINAL'))
        }
      } catch (err) {
        antMessage.error(formatUserFacingError(err instanceof Error ? err.message : 'CANNOT_OPEN_TERMINAL'))
      }
    },
    [workDir, t]
  )

  if (!isInteractiveShellTuiCommand(command)) return null

  const hintLines = [t('shell.tuiLine1'), t('shell.tuiLine2')]

  return (
    <div className="shell-tui-fallback" role="alert">
      <div className="shell-tui-fallback__header">
        <AlertTriangle size={14} strokeWidth={2} aria-hidden />
        <span className="shell-tui-fallback__title">{t('shell.tuiTitle')}</span>
      </div>
      <div className="shell-tui-fallback__body">
        {hintLines.map((line) => (
          <p key={line} className="shell-tui-fallback__line">
            {line}
          </p>
        ))}
      </div>
      {workDir?.trim() ? (
        <Button size="small" type="link" className="shell-tui-fallback__action" onClick={(e) => void handleOpenShellTerminal(e)}>
          {t('shell.openTerminal')}
        </Button>
      ) : null}
    </div>
  )
}
