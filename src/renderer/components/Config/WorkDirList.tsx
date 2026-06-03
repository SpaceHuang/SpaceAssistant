import { useCallback, useMemo, useState } from 'react'
import { App, Button, Form, Input, Popover, Radio, Space, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import type { WorkDirProfile } from '../../../shared/feishuTypes'

type ProfileDraft = {
  name: string
  path: string
  feishuAlias: string
}

const EMPTY_DRAFT: ProfileDraft = { name: '', path: '', feishuAlias: '' }

export function buildFeishuAliasHint(alias: string): string {
  const trimmed = alias.trim()
  if (!trimmed) {
    return '仅用于飞书远程：在消息里用 @别名 或「在名称 项目里…」指定此工作目录。留空则只按名称匹配。'
  }
  return `仅用于飞书远程：在消息里用 @别名 或「在 ${trimmed} 项目里…」指定此工作目录。例如别名 ${trimmed} 时，可发 /sa @${trimmed} 跑测试。`
}

function parseFeishuAlias(raw: string): { aliases?: string[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (/[,，]/.test(trimmed)) {
    return { error: '飞书别名只能填写一个' }
  }
  return { aliases: [trimmed] }
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

function basenameFromPath(dirPath: string): string {
  const parts = dirPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? dirPath
}

function profileLabel(profile: Pick<WorkDirProfile, 'name' | 'path'>): string {
  const trimmed = profile.name.trim()
  if (trimmed) return trimmed
  const base = profile.path.replace(/\\/g, '/').split('/').filter(Boolean).pop()
  return base ?? profile.path
}

type Props = {
  profiles: WorkDirProfile[]
  onChange: (profiles: WorkDirProfile[]) => void
}

type ProfileFormProps = {
  mode: 'add' | 'edit'
  profileId?: string
  form: ReturnType<typeof Form.useForm>[0]
  onSelectDirectory: () => void
  onConfirm: () => void
}

function WorkDirProfileForm({ mode, form, onSelectDirectory, onConfirm }: ProfileFormProps) {
  const feishuAlias = Form.useWatch('feishuAlias', form) ?? ''

  return (
    <Form form={form} component={false}>
      <div className="config-add-model-popover config-workdir-popover">
        <div className="config-add-model-field">
          <span className="config-add-model-label">路径</span>
          <Space.Compact block className="config-workdir-path-compact">
            <Form.Item name="path" noStyle rules={[{ required: true, message: '请选择路径' }]}>
              <Input placeholder="选择或输入绝对路径" aria-label="工作目录路径" />
            </Form.Item>
            <Button
              className="config-workdir-browse-btn"
              icon={<FolderOpen size={14} aria-hidden />}
              onClick={onSelectDirectory}
              aria-label="选择目录"
            >
              浏览
            </Button>
          </Space.Compact>
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">名称</span>
          <Form.Item name="name" noStyle rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="项目名称" aria-label="工作目录名称" />
          </Form.Item>
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">飞书别名（可选）</span>
          <Form.Item name="feishuAlias" noStyle>
            <Input placeholder="SX" aria-label="飞书别名" />
          </Form.Item>
          <p className="config-add-model-hint">{buildFeishuAliasHint(feishuAlias)}</p>
        </div>
        <Button type="primary" size="small" block onClick={onConfirm}>
          {mode === 'add' ? '添加目录' : '保存更改'}
        </Button>
      </div>
    </Form>
  )
}

export function WorkDirList({ profiles, onChange }: Props) {
  const { message } = App.useApp()
  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form] = Form.useForm<ProfileDraft>()

  const defaultId = useMemo(() => profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? '', [profiles])

  const resetDraft = () => {
    form.resetFields()
    form.setFieldsValue(EMPTY_DRAFT)
  }

  const selectDirectory = async () => {
    const result = await window.api.dialogSelectDirectory()
    if ('path' in result) {
      const name = basenameFromPath(result.path)
      form.setFieldsValue({ path: result.path, name })
      void checkPathWritable(result.path)
    }
  }

  const checkPathWritable = async (dir: string) => {
    if (!dir.trim()) return true
    const r = await window.api.workdirCheckWritable(dir)
    if (!r.ok) {
      message.error(`目录不可写入：${r.error ?? '权限不足'}`)
      return false
    }
    return true
  }

  const validateDraft = useCallback(
    (values: ProfileDraft, excludeId?: string): string | null => {
      const name = values.name.trim()
      const dirPath = values.path.trim()
      if (!name) return '名称不能为空'
      if (!dirPath) return '路径不能为空'
      if (profiles.some((p) => p.id !== excludeId && p.name === name)) {
        return '工作目录名称不能重复'
      }
      const norm = normalizePath(dirPath)
      if (profiles.some((p) => p.id !== excludeId && normalizePath(p.path) === norm)) {
        return '工作目录路径不能重复'
      }
      return null
    },
    [profiles]
  )

  const handleAdd = async () => {
    const values = await form.validateFields()
    const draftValues: ProfileDraft = {
      name: values.name,
      path: values.path,
      feishuAlias: values.feishuAlias ?? ''
    }
    const err = validateDraft(draftValues)
    if (err) {
      message.error(err)
      return
    }
    const parsedAlias = parseFeishuAlias(draftValues.feishuAlias)
    if (parsedAlias.error) {
      message.error(parsedAlias.error)
      return
    }
    const writable = await checkPathWritable(draftValues.path)
    if (!writable) return

    const id = crypto.randomUUID()
    const isFirst = profiles.length === 0
    const next: WorkDirProfile = {
      id,
      name: draftValues.name.trim(),
      path: normalizePath(draftValues.path),
      aliases: parsedAlias.aliases,
      isDefault: isFirst
    }
    const updated = profiles.map((p) => ({ ...p, isDefault: isFirst ? false : p.isDefault }))
    onChange([...updated, next])
    setAddOpen(false)
    resetDraft()
  }

  const handleEdit = async (profileId: string) => {
    const values = await form.validateFields()
    const draftValues: ProfileDraft = {
      name: values.name,
      path: values.path,
      feishuAlias: values.feishuAlias ?? ''
    }
    const err = validateDraft(draftValues, profileId)
    if (err) {
      message.error(err)
      return
    }
    const parsedAlias = parseFeishuAlias(draftValues.feishuAlias)
    if (parsedAlias.error) {
      message.error(parsedAlias.error)
      return
    }
    const writable = await checkPathWritable(draftValues.path)
    if (!writable) return

    onChange(
      profiles.map((p) =>
        p.id === profileId
          ? {
              ...p,
              name: draftValues.name.trim(),
              path: normalizePath(draftValues.path),
              aliases: parsedAlias.aliases
            }
          : p
      )
    )
    setEditId(null)
    resetDraft()
  }

  const handleRemove = (profileId: string) => {
    if (profiles.length <= 1) {
      message.error('请至少保留一个工作目录')
      return
    }
    const target = profiles.find((p) => p.id === profileId)
    if (!target) return
    const remaining = profiles.filter((p) => p.id !== profileId)
    if (target.isDefault && remaining.length > 0) {
      remaining[0] = { ...remaining[0], isDefault: true }
    }
    onChange(remaining)
  }

  const handleDefaultChange = (profileId: string) => {
    onChange(profiles.map((p) => ({ ...p, isDefault: p.id === profileId })))
  }

  const openEdit = (profile: WorkDirProfile) => {
    setAddOpen(false)
    setEditId(profile.id)
    form.setFieldsValue({
      name: profile.name,
      path: profile.path,
      feishuAlias: profile.aliases?.[0] ?? ''
    })
  }

  const addPopoverContent = (
    <WorkDirProfileForm
      mode="add"
      form={form}
      onSelectDirectory={() => void selectDirectory()}
      onConfirm={() => void handleAdd()}
    />
  )

  const columns: ColumnsType<WorkDirProfile> = [
    {
      title: '默认',
      width: 56,
      align: 'center',
      onCell: () => ({ style: { verticalAlign: 'middle' } }),
      render: (_, profile) => (
        <Radio
          checked={profile.id === defaultId}
          onChange={() => handleDefaultChange(profile.id)}
          aria-label={`设为默认：${profileLabel(profile)}`}
        />
      )
    },
    {
      title: '目录',
      render: (_, profile) => (
        <div className="config-workdir-table-cell">
          <span className="config-field__label">{profileLabel(profile)}</span>
          <span className="config-workdir-table-path" title={profile.path}>
            {profile.path}
          </span>
          {profile.aliases?.[0] ? (
            <span className="config-field__hint">飞书别名：{profile.aliases[0]}</span>
          ) : null}
        </div>
      )
    },
    {
      title: '操作',
      width: 96,
      align: 'center',
      onCell: () => ({ style: { verticalAlign: 'middle' } }),
      render: (_, profile) => (
        <Space size={4} className="config-workdir-table-actions">
          <Popover
            overlayClassName="config-settings-popover"
            placement="bottomRight"
            trigger="click"
            open={editId === profile.id}
            onOpenChange={(open) => {
              if (open) openEdit(profile)
              else {
                setEditId(null)
                resetDraft()
              }
            }}
            content={
              <WorkDirProfileForm
                mode="edit"
                profileId={profile.id}
                form={form}
                onSelectDirectory={() => void selectDirectory()}
                onConfirm={() => void handleEdit(profile.id)}
              />
            }
          >
            <Button type="link" size="small" icon={<Pencil size={14} aria-hidden />} aria-label="编辑">
              编辑
            </Button>
          </Popover>
          <Button
            type="link"
            size="small"
            danger
            icon={<Trash2 size={14} aria-hidden />}
            aria-label="移除"
            onClick={() => handleRemove(profile.id)}
          >
            移除
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div className="config-field config-workdir-field">
      <div className="config-field-row">
        <span className="config-field__label">工作目录</span>
        <Space size={6} className="config-workdir-field__actions">
          <Popover
            overlayClassName="config-settings-popover"
            placement="bottomRight"
            trigger="click"
            open={addOpen}
            onOpenChange={(open) => {
              setAddOpen(open)
              if (open) {
                setEditId(null)
                resetDraft()
              } else {
                resetDraft()
              }
            }}
            content={addPopoverContent}
          >
            <Tooltip title="添加目录">
              <Button
                size="small"
                type="primary"
                icon={<Plus size={14} aria-hidden />}
                aria-label="添加目录"
              />
            </Tooltip>
          </Popover>
        </Space>
      </div>
      <p className="config-field__hint">
        为不同目的设置相互独立的工作目录，比如「自媒体创作」、「学习笔记」。随时切换状态，避免相互干扰。
      </p>
      <div className="config-field__control">
        <Table
          className="config-workdir-table"
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={profiles}
          columns={columns}
          locale={{ emptyText: '请添加工作目录' }}
        />
      </div>
    </div>
  )
}

export function validateWorkDirProfiles(profiles: WorkDirProfile[]): string | null {
  if (profiles.length === 0) return '请至少添加一个工作目录'
  const defaultCount = profiles.filter((p) => p.isDefault).length
  if (defaultCount !== 1) return '请指定一个默认工作目录'
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const p of profiles) {
    const name = p.name.trim()
    if (!name) return '工作目录名称不能为空'
    if (!p.path.trim()) return '工作目录路径不能为空'
    if (names.has(name)) return '工作目录名称不能重复'
    const norm = normalizePath(p.path)
    if (paths.has(norm)) return '工作目录路径不能重复'
    names.add(name)
    paths.add(norm)
  }
  return null
}
