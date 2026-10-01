import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Button } from 'antd'
import { GripVertical } from 'lucide-react'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import type { Message } from '../../../shared/domainTypes'

type Props = {
  items: Message[]
  editingId: string | null
  draft: string
  submitting?: boolean
  onBeginEdit: (messageId: string) => void
  onDraftChange: (text: string) => void
  onSubmitEdit: () => void
  onCancelEdit: () => void
  onCancel: (messageId: string) => void
  onReorder: (messageIds: string[]) => void
}

export function QueuedTaskBar({ items, editingId, draft, submitting, onBeginEdit, onDraftChange, onSubmitEdit, onCancelEdit, onCancel, onReorder }: Props) {
  const { t } = useTypedTranslation('chat')
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const listRef = useRef<HTMLDivElement>(null)
  const previousEditingId = useRef<string | null>(null)
  const draggedId = useRef<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  const reorder = (messageId: string, targetIndex: number) => {
    const ids = items.map((item) => item.id)
    const sourceIndex = ids.indexOf(messageId)
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= ids.length || sourceIndex === targetIndex) return
    ids.splice(sourceIndex, 1)
    ids.splice(targetIndex, 0, messageId)
    onReorder(ids)
  }

  const handleDrop = (targetId: string, event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const sourceId = draggedId.current || event.dataTransfer.getData('text/plain')
    const sourceIndex = items.findIndex((item) => item.id === sourceId)
    const targetIndex = items.findIndex((item) => item.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return
    const rect = event.currentTarget.getBoundingClientRect()
    const insertAfterTarget = event.clientY >= rect.top + rect.height / 2
    const finalIndex = targetIndex + (insertAfterTarget ? 1 : 0) - (sourceIndex < targetIndex ? 1 : 0)
    const ids = items.map((item) => item.id)
    ids.splice(sourceIndex, 1)
    ids.splice(finalIndex, 0, sourceId)
    onReorder(ids)
    draggedId.current = null
    setDraggingId(null)
  }

  useEffect(() => {
    if (editingId && previousEditingId.current !== editingId) {
      editorRef.current?.focus()
      const end = draft.length
      if (editorRef.current) editorRef.current.setSelectionRange(end, end)
    } else if (!editingId && previousEditingId.current) {
      const prior = previousEditingId.current
      if (items.some((item) => item.id === prior)) rowRefs.current.get(prior)?.focus()
      else if (items.length > 0) listRef.current?.focus()
    } else if (editingId && !items.some((item) => item.id === editingId) && items.length > 0) {
      listRef.current?.focus()
      previousEditingId.current = null
      return
    }
    previousEditingId.current = editingId
  }, [editingId, items])

  if (items.length === 0) return null

  return <section className={`queued-task-bar${editingId ? ' queued-task-bar--editing' : ''}`} aria-label={t('queuedBar.heading', { count: items.length })}>
    <div className="queued-task-bar__heading">{t('queuedBar.heading', { count: items.length })}</div>
    <div className="queued-task-bar__list" role="list" tabIndex={-1} ref={listRef}>
      {items.map((item, index) => {
        const preview = item.content.trim() || t('queuedBar.imageOnly')
        const editing = item.id === editingId
        return <div className={`queued-task-bar__row${draggingId === item.id ? ' queued-task-bar__row--dragging' : ''}`} role="listitem" key={item.id}
          onDragOver={(event) => event.preventDefault()} onDrop={(event) => handleDrop(item.id, event)}>
          <button type="button" className="queued-task-bar__drag-handle" aria-label={t('queuedBar.dragHandle', { index: index + 1 })}
            title={t('queuedBar.dragHint')} disabled={items.length < 2 || Boolean(editingId)} draggable={items.length > 1 && !editing}
            onDragStart={(event) => { draggedId.current = item.id; setDraggingId(item.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.id) }}
            onDragEnd={() => { draggedId.current = null; setDraggingId(null) }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const targetIndex = index + (event.key === 'ArrowUp' ? -1 : 1)
              reorder(item.id, targetIndex)
            }}><GripVertical size={14} aria-hidden="true" /></button>
          <span className="queued-task-bar__index">#{index + 1}</span>
          <span className="queued-task-bar__dot" aria-hidden="true" />
          {editing ? <div className="queued-task-bar__editor">
            <textarea ref={editorRef} rows={Math.min(4, Math.max(1, draft.split('\n').length))} value={draft}
              aria-label={t('queuedBar.editAria', { preview })}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (draft.trim()) onSubmitEdit() }
                if (event.key === 'Escape') { event.preventDefault(); onCancelEdit() }
              }} />
            <Button className="queued-task-bar__save" disabled={submitting || !draft.trim()} onClick={onSubmitEdit}>{t('queuedBar.save')}</Button>
            <Button className="queued-task-bar__discard" onClick={onCancelEdit}>{t('queuedBar.discardEdit')}</Button>
            <Button className="queued-task-bar__cancel" aria-label={t('queuedBar.cancelAria', { preview })} onClick={() => onCancel(item.id)}>{t('queuedBar.cancel')}</Button>
          </div> : <>
            <button type="button" className="queued-task-bar__summary" title={item.content || preview}
              aria-label={t('queuedBar.editAria', { preview })} ref={(node) => { if (node) rowRefs.current.set(item.id, node); else rowRefs.current.delete(item.id) }}
              onClick={() => onBeginEdit(item.id)}>{preview}</button>
            {item.attachments?.length ? <span className="queued-task-bar__badge">{item.attachments.length}</span> : null}
            <Button className="queued-task-bar__cancel" aria-label={t('queuedBar.cancelAria', { preview })} onClick={() => onCancel(item.id)}>{t('queuedBar.cancel')}</Button>
          </>}
        </div>
      })}
    </div>
  </section>
}
