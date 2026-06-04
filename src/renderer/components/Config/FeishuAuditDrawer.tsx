import { useEffect, useState } from 'react'
import { Button, Drawer, Table } from 'antd'
import type { FeishuAuditEvent } from '../../../shared/feishuTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import i18n from '../../i18n'

type Props = {
  open: boolean
  onClose: () => void
}

export function FeishuAuditDrawer({ open, onClose }: Props) {
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
    if (open) void load()
  }, [open])

  return (
    <Drawer
      title={t('feishuAudit.title')}
      width={720}
      open={open}
      onClose={onClose}
      extra={
        <Button onClick={() => void load()}>{t('feishuAudit.refresh')}</Button>
      }
    >
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
            render: (_: unknown, r: FeishuAuditEvent) => {
              if (r.type === 'inbound') return `${r.accepted ? '✓' : '✗'} ${r.reason ?? ''}`
              if (r.type === 'lark_cli') return `${r.success ? '✓' : '✗'} ${r.args.slice(0, 3).join(' ')}`
              if (r.type === 'confirm_request') return r.decision ?? t('feishuAudit.pending')
              return JSON.stringify(r).slice(0, 80)
            }
          }
        ]}
      />
    </Drawer>
  )
}
