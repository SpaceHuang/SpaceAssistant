import { useCallback, useMemo, useState } from 'react'
import { App, Button, Form, Input, Popover, Radio, Space, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react'
import type { WorkDirProfile } from '../../../shared/feishuTypes'
import type { NamespaceKeyMap } from '../../i18n/types'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type ConfigT = (key: NamespaceKeyMap['config'], options?: Record<string, unknown>) => string

type ProfileDraft = {
  name: string
  path: string
  feishuAlias: string
}

const EMPTY_DRAFT: ProfileDraft = { name: '', path: '', feishuAlias: '' }

export function buildFeishuAliasHint(alias: string, t: ConfigT): string {
  const trimmed = alias.trim()
  if (!trimmed) {
    return t('workDir.aliasHint.empty')
  }
  return t('workDir.aliasHint.withAlias', { alias: trimmed })
}

function parseFeishuAlias(raw: string, t: ConfigT): { aliases?: string[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  if (/[,，]/.test(trimmed)) {
    return { error: t('workDir.validation.aliasSingle') }
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
  const { t } = useTypedTranslation('config')
  const feishuAlias = Form.useWatch('feishuAlias', form) ?? ''

  return (
    <Form form={form} component={false}>
      <div className="config-add-model-popover config-workdir-popover">
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('workDir.form.pathLabel')}</span>
          <Space.Compact block className="config-workdir-path-compact">
            <Form.Item name="path" noStyle rules={[{ required: true, message: t('workDir.form.pathRequired') }]}>
              <Input placeholder={t('workDir.form.pathPlaceholder')} aria-label={t('workDir.form.pathAria')} />
            </Form.Item>
            <Button
              className="config-workdir-browse-btn"
              icon={<FolderOpen size={14} aria-hidden />}
              onClick={onSelectDirectory}
              aria-label={t('workDir.form.browseAria')}
            >
              {t('workDir.form.browse')}
            </Button>
          </Space.Compact>
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('workDir.form.nameLabel')}</span>
          <Form.Item name="name" noStyle rules={[{ required: true, message: t('workDir.form.nameRequired') }]}>
            <Input placeholder={t('workDir.form.namePlaceholder')} aria-label={t('workDir.form.nameAria')} />
          </Form.Item>
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">{t('workDir.form.feishuAliasLabel')}</span>
          <Form.Item name="feishuAlias" noStyle>
            <Input placeholder={t('workDir.form.feishuAliasPlaceholder')} aria-label={t('workDir.form.feishuAliasAria')} />
          </Form.Item>
          <p className="config-add-model-hint">{buildFeishuAliasHint(feishuAlias, t)}</p>
        </div>
        <Button type="primary" size="small" block onClick={onConfirm}>
          {mode === 'add' ? t('workDir.form.addButton') : t('workDir.form.editButton')}
        </Button>
      </div>
    </Form>
  )
}

export function WorkDirList({ profiles, onChange }: Props) {
  const { t } = useTypedTranslation('config')
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
      message.error(t('workDir.validation.dirNotWritable', { error: r.error ?? t('workDir.validation.dirNotWritableFallback') }))
      return false
    }
    return true
  }

  const validateDraft = useCallback(
    (values: ProfileDraft, excludeId?: string): string | null => {
      const name = values.name.trim()
      const dirPath = values.path.trim()
      if (!name) return t('workDir.validation.nameRequired')
      if (!dirPath) return t('workDir.validation.pathRequired')
      if (profiles.some((p) => p.id !== excludeId && p.name === name)) {
        return t('workDir.validation.nameDuplicate')
      }
      const norm = normalizePath(dirPath)
      if (profiles.some((p) => p.id !== excludeId && normalizePath(p.path) === norm)) {
        return t('workDir.validation.pathDuplicate')
      }
      return null
    },
    [profiles, t]
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
    const parsedAlias = parseFeishuAlias(draftValues.feishuAlias, t)
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
    const parsedAlias = parseFeishuAlias(draftValues.feishuAlias, t)
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
      message.error(t('workDir.validation.atLeastOneProfile'))
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
      title: t('workDir.table.columnDefault'),
      width: 56,
      align: 'center',
      onCell: () => ({ style: { verticalAlign: 'middle' } }),
      render: (_, profile) => (
        <Radio
          checked={profile.id === defaultId}
          onChange={() => handleDefaultChange(profile.id)}
          aria-label={t('workDir.table.setDefaultAria', { name: profileLabel(profile) })}
        />
      )
    },
    {
      title: t('workDir.table.columnDir'),
      render: (_, profile) => (
        <div className="config-workdir-table-cell">
          <span className="config-field__label">{profileLabel(profile)}</span>
          <span className="config-workdir-table-path" title={profile.path}>
            {profile.path}
          </span>
          {profile.aliases?.[0] ? (
            <span className="config-field__hint">{t('workDir.table.feishuAliasPrefix')}{profile.aliases[0]}</span>
          ) : null}
        </div>
      )
    },
    {
      title: t('workDir.table.columnActions'),
      width: 96,
      align: 'center',
      onCell: () => ({ style: { verticalAlign: 'middle' } }),
      render: (_, profile) => (
        <Space size={4} className="config-workdir-table-actions">
          <Popover
            classNames={{ root: 'config-settings-popover' }}
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
            <Button type="link" size="small" icon={<Pencil size={14} aria-hidden />} aria-label={t('workDir.actions.editAria')}>
              {t('workDir.actions.edit')}
            </Button>
          </Popover>
          <Button
            type="link"
            size="small"
            danger
            icon={<Trash2 size={14} aria-hidden />}
            aria-label={t('workDir.actions.removeAria')}
            onClick={() => handleRemove(profile.id)}
          >
            {t('workDir.actions.remove')}
          </Button>
        </Space>
      )
    }
  ]

  return (
    <div className="config-field config-workdir-field">
      <div className="config-field-row">
        <span className="config-field__label">{t('workDir.fieldLabel')}</span>
        <Space size={6} className="config-workdir-field__actions">
          <Popover
            classNames={{ root: 'config-settings-popover' }}
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
            <Tooltip title={t('workDir.actions.addTooltip')}>
              <Button
                size="small"
                type="primary"
                icon={<Plus size={14} aria-hidden />}
                aria-label={t('workDir.actions.addAria')}
              />
            </Tooltip>
          </Popover>
        </Space>
      </div>
      <p className="config-field__hint">
        {t('workDir.hint')}
      </p>
      <div className="config-field__control">
        <Table
          className="config-workdir-table"
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={profiles}
          columns={columns}
          locale={{ emptyText: t('workDir.table.emptyText') }}
        />
      </div>
    </div>
  )
}

export function validateWorkDirProfiles(profiles: WorkDirProfile[], t: ConfigT): string | null {
  if (profiles.length === 0) return t('workDir.validation.atLeastOne')
  const defaultCount = profiles.filter((p) => p.isDefault).length
  if (defaultCount !== 1) return t('workDir.validation.specifyDefault')
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const p of profiles) {
    const name = p.name.trim()
    if (!name) return t('workDir.validation.nameEmpty')
    if (!p.path.trim()) return t('workDir.validation.pathEmpty')
    if (names.has(name)) return t('workDir.validation.nameDuplicate')
    const norm = normalizePath(p.path)
    if (paths.has(norm)) return t('workDir.validation.pathDuplicate')
    names.add(name)
    paths.add(norm)
  }
  return null
}
