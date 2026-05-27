import { useEffect, useState } from 'react'
import { Button, Drawer, Table } from 'antd'
import type { FeishuAuditEvent } from '../../../shared/feishuTypes'

type Props = {
  open: boolean
  onClose: () => void
}

export function FeishuAuditDrawer({ open, onClose }: Props) {
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
    <Drawer title="飞书操作记录" width={720} open={open} onClose={onClose} extra={<Button onClick={() => void load()}>刷新</Button>}>
      <Table
        size="small"
        loading={loading}
        rowKey={(r) => `${r.type}-${r.ts}`}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        columns={[
          { title: '时间', dataIndex: 'ts', render: (ts: number) => new Date(ts).toLocaleString('zh-CN') },
          { title: '类型', dataIndex: 'type' },
          {
            title: '详情',
            render: (_: unknown, r: FeishuAuditEvent) => {
              if (r.type === 'inbound') return `${r.accepted ? '✓' : '✗'} ${r.reason ?? ''}`
              if (r.type === 'lark_cli') return `${r.success ? '✓' : '✗'} ${r.args.slice(0, 3).join(' ')}`
              if (r.type === 'confirm_request') return r.decision ?? 'pending'
              return JSON.stringify(r).slice(0, 80)
            }
          }
        ]}
      />
    </Drawer>
  )
}
