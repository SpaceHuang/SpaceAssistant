import { useRef, useEffect } from 'react'
import { App as AntdApp } from 'antd'
import type { Session } from '../../../shared/domainTypes'
import { useAppDispatch } from '../../hooks'
import { upsertSession } from '../../store/sessionSlice'
import { SESSION_TITLE_MAX_LENGTH } from '../../utils/sessionDisplay'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { formatUserFacingError } from '../../utils/formatUserFacingError'

interface SessionTitleEditorProps {
  session: Session
  onDone: () => void
}

function clampTitleLength(value: string): string {
  return Array.from(value).slice(0, SESSION_TITLE_MAX_LENGTH).join('')
}

export function SessionTitleEditor({ session, onDone }: SessionTitleEditorProps) {
  const { t } = useTypedTranslation('common')
  const { message } = AntdApp.useApp()
  const dispatch = useAppDispatch()
  const ref = useRef<HTMLInputElement>(null)
  const confirmedRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  const handleConfirm = async () => {
    if (confirmedRef.current) return
    confirmedRef.current = true
    const raw = ref.current?.value ?? ''
    const trimmed = raw.trim()
    if (!trimmed) {
      onDone()
      return
    }
    const clamped = clampTitleLength(trimmed)
    if (clamped.length < Array.from(trimmed).length) {
      message.warning(t('session.rename.tooLong', { max: SESSION_TITLE_MAX_LENGTH }))
      confirmedRef.current = false
      return
    }
    if (clamped === (session.name ?? '').trim()) {
      onDone()
      return
    }
    try {
      const updated = await window.api.sessionUpdate({ sessionId: session.id, name: clamped })
      if (updated) {
        dispatch(upsertSession(updated))
        message.success(t('session.rename.success'))
      }
      onDone()
    } catch (e) {
      message.error(
        formatUserFacingError(e instanceof Error ? e.message : t('session.rename.failed'))
      )
      confirmedRef.current = false
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      void handleConfirm()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      confirmedRef.current = true
      onDone()
    }
  }

  return (
    <input
      ref={ref}
      className="session-item-name-input"
      defaultValue={session.name}
      maxLength={SESSION_TITLE_MAX_LENGTH}
      aria-label={t('session.rename.inputAria')}
      data-editing="true"
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        void handleConfirm()
      }}
      onFocus={() => {
        confirmedRef.current = false
      }}
    />
  )
}
