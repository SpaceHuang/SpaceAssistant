import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { App, Button, Collapse, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
import { ConfigResultAlert } from './ConfigResultAlert'
import {
  isProductBuiltinSkill,
  type AppConfig,
  type SkillActivationLogEntry,
  type SkillDefinition
} from '../../../shared/domainTypes'
import {
  getRecommendedSkillAuthor,
  isRecommendedSkillInstalled,
  RECOMMENDED_SKILLS,
  type RecommendedSkillEntry
} from '../../../shared/recommendedSkills'
import { configModalSelectPopupClassNames } from './configModalUi'
import { formatUserFacingError } from '../../utils/formatUserFacingError'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function FolderOpenIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M3.087 9a2 2 0 0 1 .166-.77l.046-.095L4.77 4.97A3 3 0 0 1 7.47 3h9.06a3 3 0 0 1 2.7 1.97l1.47 3.165c.12.252.2.528.227.82a1 1 0 0 1 .073.37v6.695a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9.37a1 1 0 0 1 .087-.37M7.47 5a1 1 0 0 0-.9.657L5.588 8H9V5zm4 0H11v3h4V5zm3.06 0H15v3h3.412l-.982-2.343A1 1 0 0 0 16.53 5M5 16.695a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10H5z"
      />
    </svg>
  )
}

function DownloadIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M12 3a1 1 0 0 1 1 1v9.382l2.447-2.447a1 1 0 0 1 1.414 1.414l-4.062 4.062a1 1 0 0 1-1.414 0l-4.062-4.062a1 1 0 1 1 1.414-1.414L11 13.382V4a1 1 0 0 1 1-1M4 18a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1"
      />
    </svg>
  )
}

function useResizableColumns(initialWidths: Record<string, number>) {
  const [widths, setWidths] = useState(initialWidths)
  const draggingRef = useRef<{ key: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    setWidths(initialWidths)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleMouseDown = (key: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = { key, startX: e.clientX, startW: widths[key] ?? 80 }

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = ev.clientX - draggingRef.current.startX
      const newW = Math.max(40, draggingRef.current.startW + delta)
      setWidths((prev) => ({ ...prev, [key]: newW }))
    }
    const onUp = () => {
      draggingRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const headerTitle = (key: string, label: string, align: 'left' | 'center' = 'left') => (
    <span style={{ position: 'relative', display: 'inline-block', width: '100%', textAlign: align }}>
      {label}
      <span
        onMouseDown={(e) => handleMouseDown(key, e)}
        style={{
          position: 'absolute',
          right: -8,
          top: -8,
          bottom: -8,
          width: 12,
          cursor: 'col-resize',
          zIndex: 1,
          userSelect: 'none'
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </span>
  )

  return { widths, headerTitle }
}

type Props = {
  active: boolean
  config: AppConfig
  onConfigSaved: () => Promise<void>
  activationLog?: SkillActivationLogEntry[]
}

export function SkillsTab({ active, config, onConfigSaved, activationLog = [] }: Props) {
  const { message, modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const { t: tCommon } = useTypedTranslation('common')
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [highlightName, setHighlightName] = useState<string | null>(null)
  const [autoDetect, setAutoDetect] = useState(config.skills.autoDetect)
  const [alwaysLoad, setAlwaysLoad] = useState<string[]>(config.skills.alwaysLoad)
  const [managementTab, setManagementTab] = useState<'installed' | 'recommended'>('installed')
  const [installingRecommendedId, setInstallingRecommendedId] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    setLoading(true)
    try {
      await window.api.skillInvalidateCache()
      const list = await window.api.skillList()
      setSkills(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) void loadSkills()
  }, [active, loadSkills])

  useEffect(() => {
    setAutoDetect(config.skills.autoDetect)
    setAlwaysLoad(config.skills.alwaysLoad)
  }, [config.skills])

  const saveSkillsConfig = async (patch: Partial<AppConfig['skills']>) => {
    await window.api.configSet({ skills: patch })
    await onConfigSaved()
  }

  const showInstallSuccess = (skillNames: string[]) => {
    if (skillNames.length === 1) {
      setAlert({ type: 'success', text: t('skills.installSuccessOne', { name: skillNames[0] }) })
      setHighlightName(skillNames[0]!)
    } else {
      setAlert({ type: 'success', text: t('skills.installSuccessMany', { count: skillNames.length }) })
      setHighlightName(skillNames[0] ?? null)
    }
    setTimeout(() => setHighlightName(null), 2000)
  }

  const installFromUrl = async (
    entry: Pick<RecommendedSkillEntry, 'sourceUrl' | 'subPath' | 'installAll'>,
    overwrite = false
  ) => {
    return window.api.skillInstallFromUrl({
      sourceUrl: entry.sourceUrl,
      subPath: entry.subPath,
      installAll: entry.installAll,
      overwrite
    })
  }

  const confirmOverwrite = (error: string) =>
    new Promise<boolean>((resolve) => {
      modal.confirm({
        title: t('skills.existsTitle'),
        content: t('skills.existsContent', { error }),
        okText: tCommon('confirm'),
        cancelText: tCommon('cancel'),
        onOk: () => resolve(true),
        onCancel: () => resolve(false)
      })
    })

  const onInstall = async () => {
    setAlert(null)
    const picked = await window.api.dialogSelectDirectory()
    if ('canceled' in picked && picked.canceled) return
    if ('error' in picked) {
      setAlert({ type: 'error', text: picked.error })
      return
    }
    let res = await window.api.skillInstall({ sourcePath: picked.path })
    if (!res.ok && res.error.includes('已存在')) {
      const ok = await confirmOverwrite(res.error)
      if (!ok) return
      res = await window.api.skillInstall({ sourcePath: picked.path, overwrite: true })
    }
    if (!res.ok) {
      setAlert({ type: 'error', text: res.error })
      return
    }
    showInstallSuccess([res.skill.meta.name])
    await loadSkills()
  }

  const onInstallRecommended = async (entry: RecommendedSkillEntry) => {
    setAlert(null)
    setInstallingRecommendedId(entry.id)
    try {
      let res = await installFromUrl(entry)
      if (!res.ok && res.error.includes('已存在')) {
        const ok = await confirmOverwrite(res.error)
        if (!ok) return
        res = await installFromUrl(entry, true)
      }
      if (!res.ok) {
        setAlert({ type: 'error', text: res.error })
        return
      }
      showInstallSuccess(res.skills.map((skill) => skill.meta.name))
      setManagementTab('installed')
      await loadSkills()
    } finally {
      setInstallingRecommendedId(null)
    }
  }

  const onDelete = (skill: SkillDefinition) => {
    if (skill.scope === 'project') return
    modal.confirm({
      title: t('skills.deleteTitle', { name: skill.meta.name }),
      content: t('skills.deleteContent'),
      okText: tCommon('delete'),
      okType: 'danger',
      cancelText: tCommon('cancel'),
      onOk: async () => {
        await window.api.skillDelete({ name: skill.meta.name })
        await loadSkills()
        message.success(t('skills.deleted'))
      }
    })
  }

  const onExport = async (skill: SkillDefinition) => {
    const picked = await window.api.dialogSelectDirectory()
    if ('canceled' in picked && picked.canceled) return
    if ('error' in picked) {
      message.error(formatUserFacingError(picked.error))
      return
    }
    const dest = `${picked.path}/${skill.meta.name}`
    const res = await window.api.skillExport({ name: skill.meta.name, destPath: dest })
    if (!res.ok) message.error(formatUserFacingError(res.error))
    else message.success(t('skills.exportedTo', { path: dest }))
  }

  const visibleSkills = skills.filter((s) => !isProductBuiltinSkill(s.meta.name))
  const skillOptions = visibleSkills.map((s) => ({ label: s.meta.name, value: s.meta.name }))
  const installedSkillNames = useMemo(() => new Set(visibleSkills.map((s) => s.meta.name)), [visibleSkills])

  const { widths, headerTitle } = useResizableColumns({
    enable: 64,
    skill: 320,
    actions: 120
  })

  const recommendedWidths = useResizableColumns({
    skill: 320,
    source: 140,
    actions: 96
  })

  return (
    <div>
      {alert ? (
        <ConfigResultAlert
          ok={alert.type === 'success'}
          message={alert.text}
          closable
          onClose={() => setAlert(null)}
        />
      ) : null}

      <Space direction="vertical" className="config-stack-block" size="middle">
        <Space wrap>
          <Typography.Text>{t('skills.autoDetect')}</Typography.Text>
          <Switch
            checked={autoDetect}
            onChange={async (checked) => {
              setAutoDetect(checked)
              await saveSkillsConfig({ autoDetect: checked })
            }}
          />
        </Space>
        <div>
          <Typography.Text className="config-field-label-block">{t('skills.alwaysLoad')}</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ width: '100%' }}
            placeholder={t('skills.alwaysLoadPlaceholder')}
            options={skillOptions}
            value={alwaysLoad.filter((n) => !isProductBuiltinSkill(n))}
            classNames={configModalSelectPopupClassNames}
            onChange={async (v) => {
              setAlwaysLoad(v)
              await saveSkillsConfig({ alwaysLoad: v })
            }}
          />
        </div>
      </Space>

      <div className="config-skill-section-header">
        <span className="config-section-title">{t('skills.managementTitle')}</span>
        <Space size={4}>
          {managementTab === 'installed' ? (
            <Tooltip title={t('skills.installLocal')}>
              <Button
                type="primary"
                size="small"
                icon={<DownloadIcon />}
                aria-label={t('skills.installLocalAria')}
                onClick={() => void onInstall()}
              />
            </Tooltip>
          ) : null}
          <Tooltip title={t('skills.openDirectory')}>
            <Button
              size="small"
              icon={<FolderOpenIcon />}
              aria-label={t('skills.openDirectoryAria')}
              onClick={() => void window.api.skillOpenDirectory({ scope: 'user' })}
            />
          </Tooltip>
        </Space>
      </div>

      <Tabs
        size="small"
        activeKey={managementTab}
        onChange={(key) => setManagementTab(key as 'installed' | 'recommended')}
        items={[
          {
            key: 'installed',
            label: t('skills.tabInstalled'),
            children: (
              <Table
                size="small"
                rowKey={(r) => `${r.scope}-${r.meta.name}`}
                loading={loading}
                pagination={false}
                dataSource={visibleSkills}
                rowClassName={(r) => (r.meta.name === highlightName ? 'sa-skill-row-highlight' : '')}
                columns={[
                  {
                    title: headerTitle('enable', t('skills.columnEnable')),
                    width: widths.enable,
                    onCell: () => ({ style: { verticalAlign: 'middle' } }),
                    render: (_, skill) => {
                      const disabled = config.skills.disabled.includes(skill.meta.name)
                      return (
                        <Switch
                          size="small"
                          checked={!disabled}
                          onChange={async (checked) => {
                            await window.api.skillToggleDisable({ name: skill.meta.name, disabled: !checked })
                            await onConfigSaved()
                          }}
                        />
                      )
                    }
                  },
                  {
                    title: headerTitle('skill', t('skills.columnSkill')),
                    width: widths.skill,
                    render: (_, skill) => (
                      <div className="config-skill-table-cell">
                        <span className="config-field__label">{skill.meta.name}</span>
                        <Typography.Text type="secondary" className="config-field__hint">
                          {skill.meta.description}
                        </Typography.Text>
                      </div>
                    )
                  },
                  {
                    title: headerTitle('actions', t('skills.columnActions'), 'center'),
                    width: widths.actions,
                    onHeaderCell: () => ({ style: { textAlign: 'center' } }),
                    onCell: () => ({ style: { verticalAlign: 'middle' } }),
                    render: (_, skill) => (
                      <Space size={4}>
                        <Button type="link" size="small" onClick={() => void onExport(skill)}>
                          {t('skills.export')}
                        </Button>
                        <Button type="link" size="small" danger disabled={skill.scope === 'project'} onClick={() => onDelete(skill)}>
                          {tCommon('delete')}
                        </Button>
                      </Space>
                    )
                  }
                ]}
              />
            )
          },
          {
            key: 'recommended',
            label: t('skills.tabRecommended'),
            children: (
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={RECOMMENDED_SKILLS}
                columns={[
                  {
                    title: recommendedWidths.headerTitle('skill', t('skills.columnSkill')),
                    width: recommendedWidths.widths.skill,
                    render: (_, entry) => (
                      <div className="config-skill-table-cell">
                        <span className="config-field__label">{entry.name}</span>
                        <Typography.Text type="secondary" className="config-field__hint">
                          {entry.description}
                        </Typography.Text>
                      </div>
                    )
                  },
                  {
                    title: recommendedWidths.headerTitle('source', t('skills.columnSource')),
                    width: recommendedWidths.widths.source,
                    render: (_, entry) => (
                      <div className="config-skill-table-cell">
                        <Typography.Text>{getRecommendedSkillAuthor(entry)}</Typography.Text>
                        <Typography.Link href={entry.sourceUrl} target="_blank" rel="noreferrer">
                          GitHub
                        </Typography.Link>
                      </div>
                    )
                  },
                  {
                    title: recommendedWidths.headerTitle('actions', t('skills.columnActions')),
                    width: recommendedWidths.widths.actions,
                    onCell: () => ({ style: { verticalAlign: 'middle' } }),
                    render: (_, entry) => {
                      const installed = isRecommendedSkillInstalled(entry, installedSkillNames)
                      return installed ? (
                        <Tag color="success">{t('skills.installed')}</Tag>
                      ) : (
                        <Button
                          type="primary"
                          size="small"
                          icon={<DownloadIcon />}
                          loading={installingRecommendedId === entry.id}
                          onClick={() => void onInstallRecommended(entry)}
                        >
                          {t('skills.install')}
                        </Button>
                      )
                    }
                  }
                ]}
              />
            )
          }
        ]}
      />

      {activationLog.length > 0 ? (
        <Collapse
          className="config-block-spacer"
          size="small"
          items={[
            {
              key: 'log',
              label: t('skills.activationAudit'),
              children: (
                <ul className="config-activation-log">
                  {activationLog.map((e, i) => (
                    <li key={i}>
                      {new Date(e.timestamp).toLocaleString()} — {e.skillNames.join('、')} ({e.source})
                    </li>
                  ))}
                </ul>
              )
            }
          ]}
        />
      ) : null}
    </div>
  )
}
