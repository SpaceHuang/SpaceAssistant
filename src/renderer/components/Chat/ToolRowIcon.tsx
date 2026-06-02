import { Tooltip } from 'antd'
import {
  Braces,
  Computer,
  FolderOpen,
  Glasses,
  Globe,
  MessagesSquare,
  Pencil,
  Search,
  Wrench
} from 'lucide-react'
import { getToolDescription, getToolIconKind } from './toolCallDisplay'

type Props = {
  toolName: string
  /** 执行中：保留工具图标，仅轻微透明度提示 */
  pending?: boolean
}

export function ToolRowIcon({ toolName, pending }: Props) {
  const kind = getToolIconKind(toolName)
  const cls = `tool-row__icon${pending ? ' tool-row__icon--pending' : ''}`
  const props = { size: 14, strokeWidth: 1.75, className: cls }

  let icon
  switch (kind) {
    case 'grep':
      icon = <Search {...props} />
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
      icon = <Braces {...props} />
      break
    case 'shell':
      icon = <Computer {...props} />
      break
    case 'browser':
      icon = <Globe {...props} />
      break
    case 'lark':
      icon = <MessagesSquare {...props} />
      break
    default:
      icon = <Wrench {...props} />
  }

  return (
    <Tooltip title={getToolDescription(toolName)} mouseEnterDelay={0.35}>
      <span className="tool-row__icon-wrap">{icon}</span>
    </Tooltip>
  )
}
