import { useCallback } from 'react'
import { Button } from 'antd'
import { AlertTriangle } from 'lucide-react'
import { isInteractiveShellTuiCommand, SHELL_TUI_FALLBACK_TITLE, shellTuiFallbackHintLines } from '../../../shared/shellInteractiveTui'
import { message as antMessage } from 'antd'

type Props = {
  command: string
  workDir?: string
}

export function ShellTuiFallbackHint({ command, workDir }: Props) {
  if (!isInteractiveShellTuiCommand(command)) return null

  const handleOpenShellTerminal = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!workDir?.trim()) {
        antMessage.warning('未配置工作目录，请先在设置中指定工作目录')
        return
      }
      try {
        const result = await window.api.shellOpenTerminal({ cwd: workDir })
        if (!result.ok) {
          antMessage.error(result.error || '无法打开终端')
        }
      } catch (err) {
        antMessage.error(err instanceof Error ? err.message : '无法打开终端')
      }
    },
    [workDir]
  )

  return (
    <div className="shell-tui-fallback" role="alert">
      <div className="shell-tui-fallback__header">
        <AlertTriangle size={14} strokeWidth={2} aria-hidden />
        <span className="shell-tui-fallback__title">{SHELL_TUI_FALLBACK_TITLE}</span>
      </div>
      <div className="shell-tui-fallback__body">
        {shellTuiFallbackHintLines().map((line) => (
          <p key={line} className="shell-tui-fallback__line">
            {line}
          </p>
        ))}
      </div>
      {workDir?.trim() ? (
        <Button size="small" type="link" className="shell-tui-fallback__action" onClick={(e) => void handleOpenShellTerminal(e)}>
          在工作目录打开终端
        </Button>
      ) : null}
    </div>
  )
}
