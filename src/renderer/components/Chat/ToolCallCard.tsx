import { useMemo } from 'react'
import { Button, Card, Collapse, Progress, Space, Tag, Typography } from 'antd'
import type { ToolCallRecord } from '../../../shared/domainTypes'

export type ToolConfirmDiff = NonNullable<ToolCallRecord['confirmDiff']>

type Props = {
  record: ToolCallRecord
  confirmMode: 'diff' | 'direct'
  onConfirm?: (approved: boolean) => void
  onCancel?: () => void
}

function statusLabel(s: ToolCallRecord['status']): string {
  switch (s) {
    case 'calling':
      return '调用中'
    case 'confirming':
      return '待确认'
    case 'executing':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'rejected':
      return '已拒绝'
    default:
      return s
  }
}

function riskColor(level: ToolCallRecord['riskLevel']): string {
  if (level === 'low') return 'green'
  if (level === 'medium') return 'orange'
  return 'red'
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + '\n…'
}

export function ToolCallCard({ record, confirmMode, onConfirm, onCancel }: Props) {
  const title = (
    <Space wrap>
      <Text strong>{record.toolName}</Text>
      <Tag color={riskColor(record.riskLevel)}>{record.riskLevel}</Tag>
      <Tag>{statusLabel(record.status)}</Tag>
    </Space>
  )

  const paramPreview = useMemo(() => {
    try {
      return JSON.stringify(record.input, null, 2)
    } catch {
      return String(record.input)
    }
  }, [record.input])

  const resultStr = useMemo(() => {
    if (!record.result) return ''
    if (record.result.success) {
      if (record.result.data === undefined) return ''
      return typeof record.result.data === 'string' ? record.result.data : JSON.stringify(record.result.data, null, 2)
    }
    return record.result.error ?? ''
  }, [record.result])

  return (
    <Card size="small" title={title} style={{ marginTop: 8 }}>
      {(record.status === 'calling' || record.status === 'executing') && (
        <Progress percent={undefined} status="active" showInfo={false} />
      )}
      <Collapse
        size="small"
        items={[
          {
            key: 'params',
            label: '参数',
            children: (
              <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{paramPreview}</pre>
            )
          }
        ]}
      />
      {record.status === 'confirming' && onConfirm ? (
        <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
          {record.toolName === 'run_script' && typeof record.input.code === 'string' ? (
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: 'var(--sa-code-bg, #1e1e1e)',
                color: '#d4d4d4',
                borderRadius: 6,
                fontSize: 12,
                maxHeight: 240,
                overflow: 'auto'
              }}
            >
              {record.input.code}
            </pre>
          ) : null}
          {confirmMode === 'diff' && record.confirmDiff ? (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text type="secondary">{record.confirmDiff.oldPath}</Text>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: '#fff1f0',
                  borderRadius: 6,
                  fontSize: 11,
                  maxHeight: 160,
                  overflow: 'auto'
                }}
              >
                {truncate(record.confirmDiff.oldContent, 8000)}
              </pre>
              <pre
                style={{
                  margin: 0,
                  padding: 8,
                  background: '#f6ffed',
                  borderRadius: 6,
                  fontSize: 11,
                  maxHeight: 160,
                  overflow: 'auto'
                }}
              >
                {truncate(record.confirmDiff.newContent, 8000)}
              </pre>
            </Space>
          ) : null}
          {confirmMode === 'direct' && (record.toolName === 'edit_file' || record.toolName === 'write_file') ? (
            <Text type="secondary">{(record.input as { path?: string }).path}</Text>
          ) : null}
          <Space>
            <Button type="primary" size="small" onClick={() => onConfirm(true)}>
              确认
            </Button>
            <Button size="small" onClick={() => onConfirm(false)}>
              拒绝
            </Button>
          </Space>
        </Space>
      ) : null}
      {record.status === 'executing' && onCancel ? (
        <Button danger size="small" style={{ marginTop: 8 }} onClick={onCancel}>
          取消执行
        </Button>
      ) : null}
      {(record.status === 'completed' || record.status === 'failed' || record.status === 'rejected') && (
        <Collapse
          size="small"
          style={{ marginTop: 8 }}
          items={[
            {
              key: 'res',
              label: record.result?.success ? '结果' : '详情',
              children: (
                <div>
                  {record.result?.success ? (
                    <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto' }}>{resultStr}</pre>
                  ) : (
                    <Text type="danger">{record.result?.error ?? '失败'}</Text>
                  )}
                </div>
              )
            }
          ]}
        />
      )}
    </Card>
  )
}
