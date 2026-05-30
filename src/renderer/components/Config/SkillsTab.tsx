import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, App, Button, Collapse, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
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
import { CONFIG_MODAL_SELECT_POPUP } from './configModalUi'

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
      setAlert({ type: 'success', text: `Skill「${skillNames[0]}」安装成功` })
      setHighlightName(skillNames[0]!)
    } else {
      setAlert({ type: 'success', text: `已成功安装 ${skillNames.length} 个 Skill` })
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
      const ok = await new Promise<boolean>((resolve) => {
        modal.confirm({
          title: 'Skill 已存在',
          content: `${res.error}，是否覆盖？`,
          onOk: () => resolve(true),
          onCancel: () => resolve(false)
        })
      })
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
        const ok = await new Promise<boolean>((resolve) => {
          modal.confirm({
            title: 'Skill 已存在',
            content: `${res.error}，是否覆盖？`,
            onOk: () => resolve(true),
            onCancel: () => resolve(false)
          })
        })
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
      title: `删除 Skill「${skill.meta.name}」？`,
      content: '将永久删除用户级 Skill 目录，此操作不可撤销。',
      okType: 'danger',
      onOk: async () => {
        await window.api.skillDelete({ name: skill.meta.name })
        await loadSkills()
        message.success('已删除')
      }
    })
  }

  const onExport = async (skill: SkillDefinition) => {
    const picked = await window.api.dialogSelectDirectory()
    if ('canceled' in picked && picked.canceled) return
    if ('error' in picked) {
      message.error(picked.error)
      return
    }
    const dest = `${picked.path}/${skill.meta.name}`
    const res = await window.api.skillExport({ name: skill.meta.name, destPath: dest })
    if (!res.ok) message.error(res.error)
    else message.success(`已导出到 ${dest}`)
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
      {alert ? <Alert type={alert.type} message={alert.text} showIcon style={{ marginBottom: 12 }} closable onClose={() => setAlert(null)} /> : null}

      <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size="middle">
        <Space wrap>
          <Typography.Text>由 AI 根据 Skill 描述自动选择要加载的 Skill</Typography.Text>
          <Switch
            checked={autoDetect}
            onChange={async (checked) => {
              setAutoDetect(checked)
              await saveSkillsConfig({ autoDetect: checked })
            }}
          />
        </Space>
        <div>
          <Typography.Text style={{ display: 'block', marginBottom: 4 }}>始终加载</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ width: '100%' }}
            placeholder="选择每次会话始终加载的 Skill"
            options={skillOptions}
            value={alwaysLoad.filter((n) => !isProductBuiltinSkill(n))}
            popupClassName={CONFIG_MODAL_SELECT_POPUP}
            onChange={async (v) => {
              setAlwaysLoad(v)
              await saveSkillsConfig({ alwaysLoad: v })
            }}
          />
        </div>
      </Space>

      <div className="config-skill-section-header">
        <span className="config-section-title">Skill 管理</span>
        <Space size={4}>
          {managementTab === 'installed' ? (
            <Tooltip title="安装本地 Skill">
              <Button
                type="primary"
                size="small"
                icon={<DownloadIcon />}
                aria-label="安装本地 Skill"
                onClick={() => void onInstall()}
              />
            </Tooltip>
          ) : null}
          <Tooltip title="打开目录">
            <Button
              size="small"
              icon={<FolderOpenIcon />}
              aria-label="打开目录"
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
            label: '已安装',
            children: (
              <Table
                size="small"
                rowKey={(r) => `${r.scope}-${r.meta.name}`}
                loading={loading}
                pagination={false}
                dataSource={visibleSkills}
                rowClassName={(r) => (r.meta.name === highlightName ? 'sa-skill-row-highlight' : '')}
                onRow={() => ({ style: { fontSize: 12 } })}
                columns={[
                  {
                    title: headerTitle('enable', '启用'),
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
                    title: headerTitle('skill', 'Skill'),
                    width: widths.skill,
                    render: (_, skill) => (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.5 }}>
                        <span className="config-field__label">{skill.meta.name}</span>
                        <Typography.Text type="secondary" className="config-field__hint" style={{ display: 'block' }}>
                          {skill.meta.description}
                        </Typography.Text>
                      </div>
                    )
                  },
                  {
                    title: headerTitle('actions', '操作', 'center'),
                    width: widths.actions,
                    onHeaderCell: () => ({ style: { textAlign: 'center' } }),
                    onCell: () => ({ style: { verticalAlign: 'middle' } }),
                    render: (_, skill) => (
                      <Space size={4}>
                        <Button type="link" size="small" onClick={() => void onExport(skill)}>
                          导出
                        </Button>
                        <Button type="link" size="small" danger disabled={skill.scope === 'project'} onClick={() => onDelete(skill)}>
                          删除
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
            label: '推荐',
            children: (
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={RECOMMENDED_SKILLS}
                onRow={() => ({ style: { fontSize: 12 } })}
                columns={[
                  {
                    title: recommendedWidths.headerTitle('skill', 'Skill'),
                    width: recommendedWidths.widths.skill,
                    render: (_, entry) => (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.5 }}>
                        <span className="config-field__label">{entry.name}</span>
                        <Typography.Text type="secondary" className="config-field__hint" style={{ display: 'block' }}>
                          {entry.description}
                        </Typography.Text>
                      </div>
                    )
                  },
                  {
                    title: recommendedWidths.headerTitle('source', '来源'),
                    width: recommendedWidths.widths.source,
                    render: (_, entry) => (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, lineHeight: 1.5 }}>
                        <Typography.Text style={{ fontSize: 12 }}>{getRecommendedSkillAuthor(entry)}</Typography.Text>
                        <Typography.Link href={entry.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                          GitHub
                        </Typography.Link>
                      </div>
                    )
                  },
                  {
                    title: recommendedWidths.headerTitle('actions', '操作'),
                    width: recommendedWidths.widths.actions,
                    onCell: () => ({ style: { verticalAlign: 'middle' } }),
                    render: (_, entry) => {
                      const installed = isRecommendedSkillInstalled(entry, installedSkillNames)
                      return installed ? (
                        <Tag color="success">已安装</Tag>
                      ) : (
                        <Button
                          type="primary"
                          size="small"
                          icon={<DownloadIcon />}
                          loading={installingRecommendedId === entry.id}
                          onClick={() => void onInstallRecommended(entry)}
                        >
                          安装
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
          style={{ marginTop: 12 }}
          size="small"
          items={[
            {
              key: 'log',
              label: '激活审计（当前会话）',
              children: (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
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
