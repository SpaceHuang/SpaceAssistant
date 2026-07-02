import { Button, Form, Input, Space, Switch, Table, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { ExtensionSubdirMapEntry, WorkspaceLayoutConfig } from '../../../shared/domainTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

interface Props {
  value: WorkspaceLayoutConfig
  onChange: (v: WorkspaceLayoutConfig) => void
}

export function WorkspaceLayoutTab({ value, onChange }: Props) {
  const { t } = useTypedTranslation('config')
  const disabled = !value.enabled

  const updateEntry = (idx: number, patch: Partial<ExtensionSubdirMapEntry>) => {
    const next = value.extensionSubdirMap.map((e, i) => (i === idx ? { ...e, ...patch } : e))
    onChange({ ...value, extensionSubdirMap: next })
  }

  const addRow = () =>
    onChange({
      ...value,
      extensionSubdirMap: [...value.extensionSubdirMap, { extension: '', subdir: '' }]
    })

  const removeRow = (idx: number) =>
    onChange({
      ...value,
      extensionSubdirMap: value.extensionSubdirMap.filter((_, i) => i !== idx)
    })

  const columns = [
    {
      title: t('workspaceLayout.colExtension'),
      key: 'extension',
      render: (_: unknown, _r: ExtensionSubdirMapEntry, idx: number) => (
        <Input
          placeholder={t('workspaceLayout.extPlaceholder')}
          value={value.extensionSubdirMap[idx]?.extension ?? ''}
          disabled={disabled}
          onChange={(e) =>
            updateEntry(idx, { extension: e.target.value.replace(/^\./, '').toLowerCase() })
          }
        />
      )
    },
    {
      title: t('workspaceLayout.colSubdir'),
      key: 'subdir',
      render: (_: unknown, r: ExtensionSubdirMapEntry, idx: number) => {
        const invalid = /[\\/]/.test(r.subdir) || r.subdir.includes('..')
        return (
          <Space direction="vertical" size={0}>
            <Input
              placeholder={t('workspaceLayout.subdirPlaceholder')}
              value={r.subdir}
              disabled={disabled}
              onChange={(e) => updateEntry(idx, { subdir: e.target.value })}
            />
            {invalid ? (
              <Typography.Text type="danger">{t('workspaceLayout.invalidSubdir')}</Typography.Text>
            ) : null}
          </Space>
        )
      }
    },
    {
      title: t('workspaceLayout.colAction'),
      key: 'action',
      width: 72,
      render: (_: unknown, _r: ExtensionSubdirMapEntry, idx: number) => (
        <Button icon={<DeleteOutlined />} disabled={disabled} onClick={() => removeRow(idx)} />
      )
    }
  ]

  return (
    <Space direction="vertical" className="config-form-stack" style={{ width: '100%' }} size="middle">
      <Form layout="vertical">
        <Form.Item label={t('workspaceLayout.enabledLabel')}>
          <Switch
            checked={value.enabled}
            onChange={(v) => onChange({ ...value, enabled: v })}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" className="config-field__hint">
          {t('workspaceLayout.enabledHint')}
        </Typography.Paragraph>
        <Form.Item label={t('workspaceLayout.writeDirConfirmEnabledLabel')}>
          <Switch
            checked={value.writeDirConfirmEnabled}
            disabled={disabled}
            onChange={(v) => onChange({ ...value, writeDirConfirmEnabled: v })}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" className="config-field__hint">
          {t('workspaceLayout.writeDirConfirmEnabledHint')}
        </Typography.Paragraph>
      </Form>
      <Table
        size="small"
        pagination={false}
        rowKey={(_, idx) => String(idx)}
        dataSource={value.extensionSubdirMap}
        columns={columns}
      />
      <Button icon={<PlusOutlined />} disabled={disabled} onClick={addRow}>
        {t('workspaceLayout.addMapping')}
      </Button>
      <Typography.Paragraph type="secondary" className="config-field__hint">
        {t('workspaceLayout.rulesHint')}
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="config-field__hint">
        {t('workspaceLayout.securityHint')}
      </Typography.Paragraph>
    </Space>
  )
}
