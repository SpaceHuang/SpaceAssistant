import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Collapse, Modal, Select, Space, Switch, Table, Tag, Typography, message } from 'antd'
import type { AppConfig, SkillDefinition, SkillActivationLogEntry } from '../../../shared/domainTypes'

function RefreshIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M2 12.08c-.006-.862.91-1.356 1.618-.975l.095.058 2.678 1.804c.972.655.377 2.143-.734 2.007l-.117-.02-1.063-.234a8.002 8.002 0 0 0 14.804.605 1 1 0 0 1 1.82.828c-1.987 4.37-6.896 6.793-11.687 5.509A10.003 10.003 0 0 1 2 12.08m.903-4.228C4.89 3.482 9.799 1.06 14.59 2.343a10.002 10.002 0 0 1 7.414 9.581c.007.863-.91 1.358-1.617.976l-.096-.058-2.678-1.804c-.972-.655-.377-2.143.734-2.007l.117.02 1.063.234A8.002 8.002 0 0 0 4.723 8.68a1 1 0 1 1-1.82-.828"
      />
    </svg>
  )
}

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

type Props = {
  config: AppConfig
  onConfigSaved: () => Promise<void>
  activationLog?: SkillActivationLogEntry[]
}

export function SkillsTab({ config, onConfigSaved, activationLog = [] }: Props) {
  const [skills, setSkills] = useState<SkillDefinition[]>([])
  const [loading, setLoading] = useState(false)
  const [alert, setAlert] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [highlightName, setHighlightName] = useState<string | null>(null)
  const [autoDetect, setAutoDetect] = useState(config.skills.autoDetect)
  const [alwaysLoad, setAlwaysLoad] = useState<string[]>(config.skills.alwaysLoad)
  const [disabledGlobal, setDisabledGlobal] = useState<string[]>(config.skills.disabled)

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
    void loadSkills()
  }, [loadSkills])

  useEffect(() => {
    setAutoDetect(config.skills.autoDetect)
    setAlwaysLoad(config.skills.alwaysLoad)
    setDisabledGlobal(config.skills.disabled)
  }, [config.skills])

  const saveSkillsConfig = async (patch: Partial<AppConfig['skills']>) => {
    await window.api.configSet({ skills: patch })
    await onConfigSaved()
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
        Modal.confirm({
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
    setAlert({ type: 'success', text: `Skill「${res.skill.meta.name}」安装成功` })
    setHighlightName(res.skill.meta.name)
    setTimeout(() => setHighlightName(null), 2000)
    await loadSkills()
  }

  const onDelete = (skill: SkillDefinition) => {
    if (skill.scope === 'project') return
    Modal.confirm({
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

  const skillOptions = skills.map((s) => ({ label: s.meta.name, value: s.meta.name }))

  return (
    <div>
      {alert ? <Alert type={alert.type} message={alert.text} showIcon style={{ marginBottom: 12 }} closable onClose={() => setAlert(null)} /> : null}

      <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size="middle">
        <Space wrap>
          <Typography.Text>自动检测</Typography.Text>
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
            value={alwaysLoad}
            onChange={async (v) => {
              setAlwaysLoad(v)
              await saveSkillsConfig({ alwaysLoad: v })
            }}
          />
        </div>
        <div>
          <Typography.Text style={{ display: 'block', marginBottom: 4 }}>全局禁用</Typography.Text>
          <Select
            mode="multiple"
            allowClear
            style={{ width: '100%' }}
            placeholder="选择永久禁用的 Skill"
            options={skillOptions}
            value={disabledGlobal}
            onChange={async (v) => {
              setDisabledGlobal(v)
              await saveSkillsConfig({ disabled: v })
            }}
          />
        </div>
      </Space>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong>Skill 管理</Typography.Text>
        <Space>
          <Button icon={<RefreshIcon />} loading={loading} onClick={() => void loadSkills()}>
            扫描 Skill
          </Button>
          <Button icon={<DownloadIcon />} onClick={() => void onInstall()}>
            安装 Skill
          </Button>
          <Button icon={<FolderOpenIcon />} onClick={() => void window.api.skillOpenDirectory({ scope: 'user' })}>
            打开目录
          </Button>
        </Space>
      </div>

      <Table
        size="small"
        rowKey={(r) => `${r.scope}-${r.meta.name}`}
        loading={loading}
        pagination={false}
        dataSource={skills}
        rowClassName={(r) => (r.meta.name === highlightName ? 'sa-skill-row-highlight' : '')}
        columns={[
          {
            title: '启用',
            width: 64,
            render: (_, skill) => {
              const disabled = disabledGlobal.includes(skill.meta.name)
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
            title: '名称',
            dataIndex: ['meta', 'name'],
            width: 140
          },
          {
            title: '作用域',
            width: 88,
            render: (_, skill) => (
              <Tag color={skill.scope === 'project' ? 'blue' : 'green'}>{skill.scope === 'project' ? '项目级' : '用户级'}</Tag>
            )
          },
          {
            title: '描述',
            ellipsis: true,
            render: (_, skill) => skill.meta.description
          },
          {
            title: '版本',
            width: 72,
            render: (_, skill) => skill.meta.version
          },
          {
            title: '操作',
            width: 120,
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

