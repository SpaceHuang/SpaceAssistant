import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Collapse, Popover, Space, Spin, Switch, Tag, Typography } from 'antd'
import { BookOpenText, RefreshCw } from 'lucide-react'
import { useAppDispatch, useTypedSelector } from '../../hooks'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { upsertSession } from '../../store/sessionSlice'
import type { AgentsMdRequestSnapshotBody, AgentsMdRequestSnapshotIndexEntry, AgentsMdRequestSnapshotsResponse } from '../../../shared/api'

const STATUS_KEYS = [
  'loaded', 'missing', 'empty', 'disabled', 'too-large', 'token-budget-exceeded', 'invalid-workdir',
  'outside-workdir', 'not-file', 'invalid-encoding', 'read-error', 'unstable', 'unavailable'
] as const

export function ProjectInstructionsControl() {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('chat')
  const dispatch = useAppDispatch()
  const sessionId = useTypedSelector((state) => state.chat.currentSessionId)
  const session = useTypedSelector((state) => state.session.list.find((item) => item.id === sessionId))
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<AgentsMdRequestSnapshotsResponse>()
  const [selected, setSelected] = useState<string>()
  const [body, setBody] = useState<AgentsMdRequestSnapshotBody>()
  const [bodyLoading, setBodyLoading] = useState(false)
  const enabled = session?.metadata.agentsMdEnabled !== false

  const loadIndex = useCallback(async () => {
    if (!sessionId) return
    setLoading(true)
    try {
      setResponse(await window.api.chatGetAgentsMdRequestSnapshots({ sessionId, limit: 50 }))
    } catch {
      message.error(t('projectInstructions.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [message, sessionId, t])

  useEffect(() => {
    if (open) void loadIndex()
  }, [open, loadIndex])

  const statusText = useCallback((status: string) => {
    const key = STATUS_KEYS.find((candidate) => candidate === status) ?? 'unavailable'
    return t(`projectInstructions.status.${key}`)
  }, [t])

  const latest = response?.entries[0]
  const pendingChange = enabled && latest !== undefined && (
    latest.status !== response?.current.status || latest.digest !== response?.current.digest
  )

  const handleToggle = async (next: boolean) => {
    if (!sessionId || !session) return
    setSaving(true)
    try {
      const updated = await window.api.sessionUpdate({ sessionId, agentsMdEnabled: next })
      if (updated) dispatch(upsertSession(updated))
    } catch {
      message.error(t('projectInstructions.loadFailed'))
    } finally {
      setSaving(false)
    }
  }

  const loadBody = async (entry: AgentsMdRequestSnapshotIndexEntry) => {
    const id = `${entry.invocationId}:${entry.modelTurn}`
    if (selected === id) {
      setSelected(undefined)
      setBody(undefined)
      return
    }
    setSelected(id)
    setBody(undefined)
    setBodyLoading(true)
    try {
      setBody(await window.api.chatGetAgentsMdRequestSnapshot({ sessionId: sessionId!, invocationId: entry.invocationId, modelTurn: entry.modelTurn }))
    } catch {
      setBody(undefined)
    } finally {
      setBodyLoading(false)
    }
  }

  const requestItems = useMemo(() => (response?.entries ?? []).map((entry, index) => {
    const id = `${entry.invocationId}:${entry.modelTurn}`
    const heading = <Space wrap size={6}>
      <Tag color={entry.status === 'loaded' ? 'green' : 'default'}>{statusText(entry.status)}</Tag>
      <Typography.Text type="secondary">R{entry.modelTurn} · #{entry.attempt}</Typography.Text>
      {entry.workDirName ? <Typography.Text type="secondary">{entry.workDirName}</Typography.Text> : null}
      {entry.approvalTools?.map((toolName) => <Tag key={`${id}:${toolName}`}>{t('projectInstructions.approval', { tool: toolName })}</Tag>)}
      {entry.digest ? <Typography.Text code>{entry.digest.slice(0, 10)}</Typography.Text> : null}
    </Space>
    return {
      key: `${id}:${entry.attempt}:${index}`,
      label: heading,
      children: <Space direction="vertical" size={6}>
        <Typography.Text type="secondary">{new Date(entry.loadedAt).toLocaleString()}</Typography.Text>
        {entry.bodyAvailable ? <Button type="link" size="small" onClick={() => void loadBody(entry)}>{t('projectInstructions.view')}</Button> : <Typography.Text type="secondary">{t('projectInstructions.unavailableBody')}</Typography.Text>}
        {selected === id ? bodyLoading ? <Spin size="small" /> : body?.content ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>{body.content}</Typography.Paragraph> : <Typography.Text type="secondary">{t('projectInstructions.unavailableBody')}</Typography.Text> : null}
      </Space>
    }
  }), [body, bodyLoading, loadBody, response?.entries, selected, statusText, t])

  if (!sessionId || !session) return null

  return <Popover
    trigger="click"
    open={open}
    onOpenChange={setOpen}
    placement="topRight"
    overlayStyle={{ width: 380, maxWidth: 'calc(100vw - 32px)' }}
    content={<div style={{ width: '100%', maxHeight: 'min(65vh, 560px)', overflow: 'auto' }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Typography.Text strong>{t('projectInstructions.title')}</Typography.Text>
        <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text>{t('projectInstructions.enabled')}</Typography.Text>
          <Switch checked={enabled} loading={saving} onChange={(value) => void handleToggle(value)} />
        </Space>
        <Typography.Text type="secondary">{t('projectInstructions.toggleHint')}</Typography.Text>
        {response ? <Typography.Text type="secondary">{t('projectInstructions.current', { status: statusText(response.current.status) })}</Typography.Text> : null}
        {pendingChange ? <Tag color="orange">{t('projectInstructions.pending')}</Tag> : null}
        <Button size="small" icon={<RefreshCw size={14} />} loading={loading} onClick={() => void loadIndex()}>{t('projectInstructions.refresh')}</Button>
        <Typography.Text strong>{t('projectInstructions.requests')}</Typography.Text>
        {loading && !response ? <Spin size="small" /> : requestItems.length ? <Collapse size="small" items={requestItems} /> : <Typography.Text type="secondary">{t('projectInstructions.empty')}</Typography.Text>}
      </Space>
    </div>}
  >
    <Button size="small" icon={<BookOpenText size={14} />} disabled={!sessionId}>{t('projectInstructions.button')}</Button>
  </Popover>
}
