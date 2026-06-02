import { Tooltip } from 'antd'
import type { LucideProps } from 'lucide-react'
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
import { getToolDescription, getToolIconKind, type ToolIconKind } from './toolCallDisplay'

type KindIconProps = {
  kind: ToolIconKind
  className?: string
  size?: number
  strokeWidth?: number
}

/** 与活动流 tool-row 共用的工具语义图标（确认卡、横幅等复用） */
export function ToolKindIcon({ kind, className, size = 14, strokeWidth = 1.75 }: KindIconProps) {
  const props: LucideProps = { size, strokeWidth, className }

  switch (kind) {
    case 'grep':
      return <Search {...props} />
    case 'read':
      return <Glasses {...props} />
    case 'list':
      return <FolderOpen {...props} />
    case 'edit':
      return <Pencil {...props} />
    case 'script':
      return <Braces {...props} />
    case 'shell':
      return <Computer {...props} />
    case 'browser':
      return <Globe {...props} />
    case 'lark':
      return <MessagesSquare {...props} />
    default:
      return <Wrench {...props} />
  }
}

type Props = {
  toolName: string
  /** 执行中：保留工具图标，仅轻微透明度提示 */
  pending?: boolean
}

export function ToolRowIcon({ toolName, pending }: Props) {
  const kind = getToolIconKind(toolName)
  const cls = `tool-row__icon${pending ? ' tool-row__icon--pending' : ''}`

  return (
    <Tooltip title={getToolDescription(toolName)} mouseEnterDelay={0.35}>
      <span className="tool-row__icon-wrap">
        <ToolKindIcon kind={kind} className={cls} />
      </span>
    </Tooltip>
  )
}
