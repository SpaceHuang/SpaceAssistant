import { useEffect, useState } from 'react'
import { Button, Drawer, Table } from 'antd'
import type { FeishuAuditEvent } from '../../../shared/feishuTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import i18n from '../../i18n'

function renderFeishuDetail(event: FeishuAuditEvent, pendingLabel: string): string {
  if (event.type === 'inbound') return `${event.accepted ? '✓' : '✗'} ${event.reason ?? ''}`
  if (event.type === 'lark_cli') return `${event.success ? '✓' : '✗'} ${event.args.slice(0, 3).join(' ')}`
  if (event.type === 'confirm_request') return event.decision ?? pendingLabel
  return JSON.stringify(event).slice(0, 80)
}

export function FeishuAuditTable() {
  const { t } = useTypedTranslation('config')
  const [rows, setRows] = useState<FeishuAuditEvent[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await window.api.feishuAuditQuery({ limit: 200 })
      setRows(r.entries)
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
        <Button onClick={() => void load()}>{t('feishuAudit.refresh')}</Button>
      </div>
      <Table
        size="small"
        loading={loading}
        rowKey={(r) => `${r.type}-${r.ts}`}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        columns={[
          {
            title: t('feishuAudit.columnTime'),
            dataIndex: 'ts',
            render: (ts: number) => new Date(ts).toLocaleString(i18n.language)
          },
          { title: t('feishuAudit.columnType'), dataIndex: 'type' },
          {
            title: t('feishuAudit.columnDetail'),
            render: (_: unknown, r: FeishuAuditEvent) => renderFeishuDetail(r, t('feishuAudit.pending'))
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

export function FeishuAuditDrawer({ open, onClose }: Props) {
  const { t } = useTypedTranslation('config')

  return (
    <Drawer
      title={t('feishuAudit.title')}
      width={720}
      open={open}
      onClose={onClose}
    >
      <FeishuAuditTable />
    </Drawer>
  )
}
