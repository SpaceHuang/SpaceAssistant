import { Tooltip } from 'antd'
import { ChevronRight, FolderOpen, Glasses, Loader2, Pencil, Terminal } from 'lucide-react'
import { getToolDescription, getToolIconKind } from './toolCallDisplay'

type Props = {
  toolName: string
  active?: boolean
}

export function ToolRowIcon({ toolName, active }: Props) {
  const kind = getToolIconKind(toolName)
  const cls = `tool-row__icon${active ? ' tool-row__icon--active' : ''}`
  const props = { size: 14, strokeWidth: 1.75, className: cls }

  let icon
  if (active) {
    icon = <Loader2 {...props} />
  } else {
    switch (kind) {
      case 'grep':
        icon = <ChevronRight {...props} />
        break
      case 'read':
        icon = <Glasses {...props} />
        break
      case 'list':
        icon = <FolderOpen {...props} />
        break
      case 'edit':
        icon = <Pencil {...props} />
        break
      case 'script':
        icon = <Terminal {...props} />
        break
      default:
        icon = <ChevronRight {...props} />
    }
  }

  return (
    <Tooltip title={getToolDescription(toolName)} mouseEnterDelay={0.35}>
      <span className="tool-row__icon-wrap">{icon}</span>
    </Tooltip>
  )
}
