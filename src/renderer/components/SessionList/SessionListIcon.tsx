import { Loader2 } from 'lucide-react'

type Props = {
  loading?: boolean
}

export function SessionListIcon({ loading }: Props) {
  if (loading) {
    return (
      <span className="session-item-icon session-item-icon--loading" aria-hidden>
        <Loader2 size={14} strokeWidth={2} />
      </span>
    )
  }

  return <span className="session-item-icon session-item-icon--idle" aria-hidden />
}
