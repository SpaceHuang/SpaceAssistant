import { useEffect, useState } from 'react'
import { Button, Drawer, Table } from 'antd'
import type { WeChatAuditEvent } from '../../../shared/wechatTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import i18n from '../../i18n'

function renderWeChatDetail(event: WeChatAuditEvent, pendingLabel: string): string {
  switch (event.type) {
    case 'inbound':
      return `${event.accepted ? '✓' : '✗'} ${event.reason ?? ''}`
    case 'agent_start':
      return event.sessionId
    case 'agent_done':
      return `${event.success ? '✓' : '✗'} ${event.summaryLen} 字`
    case 'send':
      return `${event.success ? '✓' : '✗'} ${event.targetId}`
    case 'reply':
      return `${event.success ? '✓' : '✗'} ${event.len} 字`
    case 'confirm_request':
      return event.decision ?? pendingLabel
    case 'rate_limit':
      return event.senderId
    case 'login':
      return event.botIdSuffix ?? ''
    case 'logout':
    case 'session_expired':
      return event.type
    default:
      return JSON.stringify(event).slice(0, 80)
  }
}

export function WeChatAuditTable() {
  const { t } = useTypedTranslation('config')
  const [rows, setRows] = useState<WeChatAuditEvent[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await window.api.wechatAuditQuery({ limit: 200 })
      setRows(r.events)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Button onClick={() => void load()}>{t('wechatAudit.refresh')}</Button>
      </div>
      <Table
        size="small"
        loading={loading}
        rowKey={(r, i) => `${r.type}-${r.ts}-${i}`}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        columns={[
          {
            title: t('wechatAudit.columnTime'),
            dataIndex: 'ts',
            render: (ts: number) => new Date(ts).toLocaleString(i18n.language)
          },
          { title: t('wechatAudit.columnType'), dataIndex: 'type' },
          {
            title: t('wechatAudit.columnDetail'),
            render: (_: unknown, r: WeChatAuditEvent) => renderWeChatDetail(r, t('wechatAudit.pending'))
          }
        ]}
      />
    </>
  )
}

type Props = {
  open: boolean
  onClose: () => void
}

export function WeChatAuditDrawer({ open, onClose }: Props) {
  const { t } = useTypedTranslation('config')

  return (
    <Drawer
      title={t('wechatAudit.title')}
      width={720}
      open={open}
      onClose={onClose}
    >
      <WeChatAuditTable />
    </Drawer>
  )
}
