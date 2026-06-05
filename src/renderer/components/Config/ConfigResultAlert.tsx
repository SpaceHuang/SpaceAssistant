import { Alert } from 'antd'
import { CheckCircle2, CircleX } from 'lucide-react'

type Props = {
  ok: boolean
  message: string
  className?: string
  closable?: boolean
  onClose?: () => void
}

export function ConfigResultAlert({ ok, message, className, closable, onClose }: Props) {
  const iconClass = ok ? 'config-feedback-icon config-feedback-icon--success' : 'config-feedback-icon config-feedback-icon--error'
  const icon = ok ? (
    <CheckCircle2 size={16} strokeWidth={2} className={iconClass} aria-hidden />
  ) : (
    <CircleX size={16} strokeWidth={2} className={iconClass} aria-hidden />
  )

  return (
    <Alert
      type={ok ? 'success' : 'error'}
      message={message}
      showIcon
      icon={icon}
      closable={closable}
      onClose={onClose}
      className={['config-alert-block', 'config-alert--feedback', className].filter(Boolean).join(' ')}
    />
  )
}
