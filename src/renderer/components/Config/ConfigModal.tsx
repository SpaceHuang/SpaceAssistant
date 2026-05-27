import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Modal, Popover, Radio, Space, Switch, Tabs, Tag } from 'antd'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { setConfig, setSettingsOpen } from '../../store/configSlice'
import type { ModelEntry, UiThemeMode, WikiConfig, PlanConfig } from '../../../shared/domainTypes'
import { DEFAULT_WIKI_CONFIG, DEFAULT_PLAN_CONFIG } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG, type FeishuConfig } from '../../../shared/feishuTypes'
import type { ChatMode } from '../../../shared/planTypes'
import { DEFAULT_CHAT_MODE } from '../../../shared/planTypes'
import { DEFAULT_MODELS, builtinToolRiskLevel } from '../../../shared/domainTypes'
import {
  DEFAULT_MAX_PARALLEL_CHAT_SESSIONS,
  MAX_MAX_PARALLEL_CHAT_SESSIONS,
  MIN_MAX_PARALLEL_CHAT_SESSIONS
} from '../../../shared/chatParallelConfig'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import { SkillsTab } from './SkillsTab'
import { WikiTab } from './WikiTab'
import { FeishuSettingsTab } from './FeishuSettingsTab'
import { LlmServiceTab } from './LlmServiceTab'
import {
  buildLlmServicesSavePayload,
  useLlmServiceDrafts,
  validateLlmServiceDrafts
} from './useLlmServiceDrafts'
import { readSkillActivationLog } from '../../services/skillActivationLog'

function AddIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path fill="currentColor" d="M11 20a1 1 0 1 0 2 0v-7h7a1 1 0 1 0 0-2h-7V4a1 1 0 1 0-2 0v7H4a1 1 0 1 0 0 2h7z" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M14.28 2a2 2 0 0 1 1.897 1.368L16.72 5H20a1 1 0 1 1 0 2l-.003.071-.867 12.143A3 3 0 0 1 16.138 22H7.862a3 3 0 0 1-2.992-2.786L4.003 7.07A1.01 1.01 0 0 1 4 7a1 1 0 0 1 0-2h3.28l.543-1.632A2 2 0 0 1 9.721 2zm3.717 5H6.003l.862 12.071a1 1 0 0 0 .997.929h8.276a1 1 0 0 0 .997-.929zM10 10a1 1 0 0 1 .993.883L11 11v5a1 1 0 0 1-1.993.117L9 16v-5a1 1 0 0 1 1-1m4 0a1 1 0 0 1 1 1v5a1 1 0 1 1-2 0v-5a1 1 0 0 1 1-1m.28-6H9.72l-.333 1h5.226z"
      />
    </svg>
  )
}

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

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}

function ModelList({ value, onChange }: { value: ModelEntry[]; onChange: (v: ModelEntry[]) => void }) {
  const removeModel = (id: string) => {
    const next = value.filter((m) => m.id !== id)
    if (next.length > 0 && !next.some((m) => m.isDefault)) {
      next[0].isDefault = true
    }
    onChange(next)
  }

  const toggleDefault = (id: string) => {
    onChange(value.map((m) => ({ ...m, isDefault: m.id === id })))
  }

  const toggleFast = (id: string) => {
    onChange(value.map((m) => (m.id === id ? { ...m, isFast: !m.isFast } : m)))
  }

  const toggleEnabled = (id: string) => {
    const next = value.map((m) => (m.id === id ? { ...m, enabled: !m.enabled } : m))
    if (next.length > 0 && !next.some((m) => m.isDefault && m.enabled)) {
      const first = next.find((m) => m.enabled)
      if (first) {
        for (const m of next) m.isDefault = m.id === first.id
      }
    }
    onChange(next)
  }

  if (value.length === 0) {
    return (
      <div className="config-model-list" style={{ color: '#999', textAlign: 'center', padding: '16px 0' }}>
        暂无模型，请点击 + 添加
      </div>
    )
  }

  return (
    <div className="config-model-list">
      {value.map((m) => (
        <div
          key={m.id}
          style={{
            padding: '8px 10px',
            borderBottom: '1px solid #f0f0f0',
            opacity: m.enabled ? 1 : 0.45
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Switch size="small" checked={m.enabled} onChange={() => toggleEnabled(m.id)} />
            <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {m.name}
            </span>
            {m.isDefault && <span className="config-model-badge config-model-badge--default">默认</span>}
            {m.isFast && <span className="config-model-badge config-model-badge--fast">快速</span>}
            <Button size="small" type="text" danger icon={<DeleteIcon />} onClick={() => removeModel(m.id)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4, paddingLeft: 28, color: '#888' }}>
            <span>上下文 {formatNumber(m.maximumContext)}</span>
            <span>输出 {formatNumber(m.maxTokens)}</span>
            <span style={{ flex: 1 }} />
            <Checkbox checked={m.isDefault} onChange={() => toggleDefault(m.id)} disabled={!m.enabled}>
              默认
            </Checkbox>
            <Checkbox checked={m.isFast} onChange={() => toggleFast(m.id)} disabled={!m.enabled}>
              快速
            </Checkbox>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ConfigModal() {
  const { message } = App.useApp()
  const open = useTypedSelector((s) => s.config.settingsOpen)
  const cfg = useTypedSelector((s) => s.config.config)
  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)
  const sessions = useTypedSelector((s) => s.session.list)
  const dispatch = useAppDispatch()
  const [form] = Form.useForm()
  const llmDrafts = useLlmServiceDrafts(open, cfg)
  const [workDirError, setWorkDirError] = useState<string | null>(null)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addMaxCtx, setAddMaxCtx] = useState(200000)
  const [addMaxTokens, setAddMaxTokens] = useState(8192)
  const [addDefault, setAddDefault] = useState(false)
  const [addFast, setAddFast] = useState(false)
  const [toolUi, setToolUi] = useState({
    enabled: true,
    confirmMode: 'diff' as 'diff' | 'direct',
    deniedTools: [] as string[],
    /** 白名单模式下：允许的内置工具名 */
    allowedEdit: [] as string[],
    whitelistMode: false,
    pythonPath: 'python',
    scriptTimeout: 300,
    fileCheckpointingEnabled: true,
    maxFileSnapshots: 100,
    grepTimeoutSec: 60
  })
  const [pyTest, setPyTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [pyTesting, setPyTesting] = useState(false)
  const [uiTheme, setUiTheme] = useState<UiThemeMode>('system')
  const [maxParallelChatSessions, setMaxParallelChatSessions] = useState(DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
  const [defaultChatMode, setDefaultChatMode] = useState<ChatMode>(DEFAULT_CHAT_MODE)
  const [wikiUi, setWikiUi] = useState<WikiConfig>({ ...DEFAULT_WIKI_CONFIG })
  const [feishuUi, setFeishuUi] = useState<FeishuConfig>({ ...DEFAULT_FEISHU_CONFIG })
  const [planUi, setPlanUi] = useState<PlanConfig>({ ...DEFAULT_PLAN_CONFIG })

  const refreshConfig = async () => {
    const next = await window.api.configGet()
    dispatch(setConfig(next))
  }

  const skillActivationLog = currentSessionId
    ? readSkillActivationLog(sessions.find((s) => s.id === currentSessionId)?.metadata ?? {})
    : []

  useEffect(() => {
    if (open && cfg) {
      form.setFieldsValue({
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        workDir: cfg.workDir,
        thinkingEnabled: cfg.thinkingEnabled
      })
      setModels(cfg.models.length > 0 ? cfg.models : DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))
      setWorkDirError(null)
      const wl = cfg.tools.allowedTools.length > 0
      const allBuiltin = BUILTIN_TOOL_DEFINITIONS.map((d) => d.name)
      setToolUi({
        enabled: cfg.tools.enabled,
        confirmMode: cfg.tools.confirmMode,
        deniedTools: wl ? [] : [...cfg.tools.deniedTools],
        allowedEdit: wl ? cfg.tools.allowedTools.filter((n) => allBuiltin.includes(n)) : [],
        whitelistMode: wl,
        pythonPath: cfg.tools.pythonPath,
        scriptTimeout: cfg.tools.scriptTimeout,
        fileCheckpointingEnabled: cfg.tools.fileCheckpointingEnabled,
        maxFileSnapshots: cfg.tools.maxFileSnapshots,
        grepTimeoutSec: cfg.tools.grepTimeoutSec
      })
      setPyTest(null)
      setUiTheme(cfg.uiTheme ?? 'system')
      setMaxParallelChatSessions(cfg.maxParallelChatSessions ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
      setDefaultChatMode(cfg.defaultChatMode ?? DEFAULT_CHAT_MODE)
      setWikiUi(cfg.wiki ?? { ...DEFAULT_WIKI_CONFIG })
      setFeishuUi(cfg.feishu ?? { ...DEFAULT_FEISHU_CONFIG })
      setPlanUi(cfg.plan ?? { ...DEFAULT_PLAN_CONFIG })
    }
  }, [open, cfg, form])

  const selectDirectory = async () => {
    const result = await window.api.dialogSelectDirectory()
    if ('path' in result) {
      form.setFieldValue('workDir', result.path)
      void checkWorkDir(result.path)
    }
  }

  const checkWorkDir = async (dir: string) => {
    if (!dir) {
      setWorkDirError(null)
      return
    }
    const r = await window.api.configCheckWorkdirWritable(dir)
    setWorkDirError(r.writable ? null : `该目录不可写入：${r.error ?? '权限不足'}，请更换工作目录`)
  }

  const addModel = () => {
    const name = addName.trim()
    if (!name) return
    if (models.some((m) => m.name === name)) {
      message.warning('模型名称已存在')
      return
    }
    const id = crypto.randomUUID()
    const entry: ModelEntry = { id, name, maximumContext: addMaxCtx, maxTokens: addMaxTokens, isDefault: addDefault, isFast: addFast, enabled: true }
    const updated = [...models, entry]
    if (addDefault) {
      for (const m of updated) {
        if (m.id !== id) m.isDefault = false
      }
    }
    if (updated.length > 0 && !updated.some((m) => m.isDefault)) {
      updated[0].isDefault = true
    }
    setModels(updated)
    setAddName('')
    setAddMaxCtx(200000)
    setAddMaxTokens(8192)
    setAddDefault(false)
    setAddFast(false)
    setAddOpen(false)
  }

  const resetModels = () => {
    setModels(DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))
  }

  const save = async () => {
    const v = await form.validateFields()
    if (v.workDir) {
      const r = await window.api.configCheckWorkdirWritable(v.workDir)
      if (!r.writable) {
        setWorkDirError(`该目录不可写入：${r.error ?? '权限不足'}，请更换工作目录`)
        return
      }
    }
    const enabledModels = models.filter((m) => m.enabled)
    if (enabledModels.length === 0) {
      message.warning('请至少启用一个模型')
      return
    }
    const llmErr = validateLlmServiceDrafts(llmDrafts.state)
    if (llmErr) {
      message.warning(llmErr)
      return
    }
    const llmPayload = buildLlmServicesSavePayload(llmDrafts.state)
    try {
      await window.api.configSet({
        temperature: v.temperature,
        maxTokens: v.maxTokens,
        workDir: v.workDir,
        thinkingEnabled: v.thinkingEnabled,
        models,
        ...llmPayload,
        tools: {
          enabled: toolUi.enabled,
          confirmMode: toolUi.confirmMode,
          deniedTools: toolUi.whitelistMode ? [] : toolUi.deniedTools,
          allowedTools: toolUi.whitelistMode ? toolUi.allowedEdit.filter((n) => BUILTIN_TOOL_DEFINITIONS.some((d) => d.name === n)) : [],
          pythonPath: toolUi.pythonPath,
          scriptTimeout: toolUi.scriptTimeout,
          fileCheckpointingEnabled: toolUi.fileCheckpointingEnabled,
          maxFileSnapshots: toolUi.maxFileSnapshots,
          grepTimeoutSec: toolUi.grepTimeoutSec
        },
        uiTheme,
        maxParallelChatSessions,
        defaultChatMode,
        wiki: wikiUi,
        feishu: feishuUi,
        plan: planUi
      })
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
      return
    }
    const next = await window.api.configGet()
    dispatch(setConfig(next))
    llmDrafts.resetFromConfig(next)
    message.success('已保存')
    dispatch(setSettingsOpen(false))
  }

  const testPython = async () => {
    setPyTesting(true)
    setPyTest(null)
    try {
      const r = await window.api.toolTestInterpreter({ path: toolUi.pythonPath })
      if (r.ok) setPyTest({ ok: true, text: r.version })
      else setPyTest({ ok: false, text: r.error })
    } finally {
      setPyTesting(false)
    }
  }

  const addContent = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 260 }}>
      <Input
        placeholder="模型名称"
        value={addName}
        onChange={(e) => setAddName(e.target.value)}
        onPressEnter={addModel}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <InputNumber
          placeholder="最大上下文"
          value={addMaxCtx}
          onChange={(v) => setAddMaxCtx(v ?? 200000)}
          min={1}
          style={{ flex: 1 }}
        />
        <InputNumber
          placeholder="最大输出"
          value={addMaxTokens}
          onChange={(v) => setAddMaxTokens(v ?? 8192)}
          min={1}
          style={{ flex: 1 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <Checkbox checked={addDefault} onChange={(e) => setAddDefault(e.target.checked)}>
          默认
        </Checkbox>
        <Checkbox checked={addFast} onChange={(e) => setAddFast(e.target.checked)}>
          快速
        </Checkbox>
      </div>
      <Button type="primary" size="small" onClick={addModel} disabled={!addName.trim()}>
        确认
      </Button>
    </div>
  )

  return (
    <Modal
      className="config-modal"
      title="设置"
      open={open}
      onCancel={() => dispatch(setSettingsOpen(false))}
      width={560}
      footer={
        <Space>
          <Button onClick={() => dispatch(setSettingsOpen(false))}>取消</Button>
          <Button type="primary" onClick={save}>
            保存
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical">
        <Tabs
          items={[
            {
              key: 'general',
              label: '通用',
              children: (
                <>
                  <Form.Item label="工作目录（会话明文备份等）" required>
                    <Space.Compact style={{ width: '100%' }}>
                      <Form.Item name="workDir" noStyle rules={[{ required: true }]}>
                        <Input onBlur={(e) => void checkWorkDir(e.target.value)} />
                      </Form.Item>
                      <Button icon={<FolderOpenIcon />} onClick={selectDirectory} title="选择目录" />
                    </Space.Compact>
                  </Form.Item>
                  {workDirError && <Alert type="error" message={workDirError} showIcon style={{ marginBottom: 16 }} />}
                  <Form.Item label="界面主题">
                    <Radio.Group value={uiTheme} onChange={(e) => setUiTheme(e.target.value)}>
                      <Radio value="system">跟随系统</Radio>
                      <Radio value="light">浅色</Radio>
                      <Radio value="dark">深色</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item label="默认聊天模式" extra="发送消息时可临时切换；Plan 模式需先规划并审批后再写入。">
                    <Radio.Group value={defaultChatMode} onChange={(e) => setDefaultChatMode(e.target.value)}>
                      <Radio value="normal">普通模式</Radio>
                      <Radio value="plan">Plan 模式</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item
                    label="并行会话上限"
                    extra="多个会话可同时向 AI 发起请求（含工具循环）。超出上限时将提示稍后再试。"
                  >
                    <InputNumber
                      min={MIN_MAX_PARALLEL_CHAT_SESSIONS}
                      max={MAX_MAX_PARALLEL_CHAT_SESSIONS}
                      value={maxParallelChatSessions}
                      onChange={(v) => setMaxParallelChatSessions(v ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                </>
              )
            },
            {
              key: 'plan',
              label: 'Plan 模式',
              children: (
                <>
                  <Form.Item label="执行方式" extra="批准后如何推进计划步骤。">
                    <Radio.Group
                      value={planUi.executionMode}
                      onChange={(e) => setPlanUi((p) => ({ ...p, executionMode: e.target.value }))}
                    >
                      <Radio value="auto">自动连续执行（推荐）</Radio>
                      <Radio value="step_manual">每步完成后手动继续</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item label="工具确认策略" extra="Plan 执行期的写入与脚本确认策略。">
                    <Radio.Group
                      value={planUi.toolConfirmPolicy}
                      onChange={(e) => setPlanUi((p) => ({ ...p, toolConfirmPolicy: e.target.value }))}
                    >
                      <Radio value="confirm_high_risk">计划级信任（仅高风险确认）</Radio>
                      <Radio value="always_confirm">逐步逐工具确认</Radio>
                      <Radio value="trust_plan_all">全部自动批准（激进）</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item
                    label="自动批准 Agent 生成的脚本"
                    extra="Plan 执行中，若 run_script 的代码由 Agent 在本步骤内编写（非直接运行仓库已有脚本），则不再单独确认。"
                  >
                    <Switch
                      checked={planUi.autoApproveAgentGeneratedScripts}
                      onChange={(checked) => setPlanUi((p) => ({ ...p, autoApproveAgentGeneratedScripts: checked }))}
                    />
                  </Form.Item>
                  <Form.Item label="步骤完成进度消息">
                    <Switch
                      checked={planUi.emitStepProgressMessages}
                      onChange={(checked) => setPlanUi((p) => ({ ...p, emitStepProgressMessages: checked }))}
                    />
                  </Form.Item>
                </>
              )
            },
            {
              key: 'llm-service',
              label: '大模型服务',
              children: <LlmServiceTab draftsApi={llmDrafts} />
            },
            {
              key: 'llm-defaults',
              label: '默认大模型设置',
              children: (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span className="config-section-title">模型列表</span>
                    <Space size={4}>
                      <Button size="small" icon={<RefreshIcon />} onClick={resetModels} title="恢复默认" />
                      <Popover
                        overlayClassName="config-modal-popover"
                        content={addContent}
                        open={addOpen}
                        onOpenChange={setAddOpen}
                        trigger="click"
                        placement="bottomRight"
                      >
                        <Button size="small" type="primary" icon={<AddIcon />} />
                      </Popover>
                    </Space>
                  </div>
                  <ModelList value={models} onChange={setModels} />
                  <Form.Item name="temperature" label="Temperature">
                    <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item
                    name="maxTokens"
                    label="最大输出 tokens（兜底）"
                    extra="实际请求优先使用模型列表中与当前模型名称对应行的「输出」；仅当无法匹配时使用此处数值。"
                  >
                    <InputNumber min={256} max={1_000_000} step={256} style={{ width: '100%' }} />
                  </Form.Item>
                  <Form.Item
                    name="thinkingEnabled"
                    label="默认开启 Thinking"
                    valuePropName="checked"
                    className="config-form-item-inline"
                  >
                    <Switch />
                  </Form.Item>
                </>
              )
            },
            {
              key: 'tools',
              label: '工具',
              children: (
                <>
                  <Form.Item label="启用内置工具" className="config-form-item-inline">
                    <Switch checked={toolUi.enabled} onChange={(checked) => setToolUi((s) => ({ ...s, enabled: checked }))} />
                  </Form.Item>
                  <Form.Item
                    label="仅允许选中的工具（白名单）"
                    className="config-form-item-inline config-form-item-inline--with-extra"
                    extra="开启后仅下方勾选的工具会注入模型；关闭时未勾选表示禁止（denied）。"
                  >
                    <Switch
                      checked={toolUi.whitelistMode}
                      onChange={(checked) => {
                        setToolUi((s) => {
                          const allNames = BUILTIN_TOOL_DEFINITIONS.map((d) => d.name)
                          if (checked) {
                            const enabled = allNames.filter((n) => !s.deniedTools.includes(n))
                            return {
                              ...s,
                              whitelistMode: true,
                              allowedEdit: enabled,
                              deniedTools: []
                            }
                          }
                          const enabledSet = new Set(
                            s.whitelistMode ? s.allowedEdit : allNames.filter((n) => !s.deniedTools.includes(n))
                          )
                          const denied = allNames.filter((n) => !enabledSet.has(n))
                          return { ...s, whitelistMode: false, deniedTools: denied, allowedEdit: [] }
                        })
                      }}
                    />
                  </Form.Item>
                  <Form.Item label="文件写入确认模式">
                    <Radio.Group
                      value={toolUi.confirmMode}
                      onChange={(e) => setToolUi((s) => ({ ...s, confirmMode: e.target.value }))}
                    >
                      <Radio value="diff">diff 预览</Radio>
                      <Radio value="direct">直接确认</Radio>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item label="Python 路径">
                    <Space.Compact style={{ width: '100%' }}>
                      <Input
                        value={toolUi.pythonPath}
                        onChange={(e) => setToolUi((s) => ({ ...s, pythonPath: e.target.value }))}
                        placeholder="python 或绝对路径"
                      />
                      <Button loading={pyTesting} onClick={testPython}>
                        测试
                      </Button>
                    </Space.Compact>
                  </Form.Item>
                  {pyTest ? (
                    <Alert type={pyTest.ok ? 'success' : 'error'} message={pyTest.text} showIcon style={{ marginBottom: 12 }} />
                  ) : null}
                  <Form.Item label="脚本默认超时（秒）">
                    <InputNumber
                      min={10}
                      max={86400}
                      value={toolUi.scriptTimeout}
                      onChange={(v) => setToolUi((s) => ({ ...s, scriptTimeout: v ?? 300 }))}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item label="grep 超时（秒）">
                    <InputNumber
                      min={5}
                      max={600}
                      value={toolUi.grepTimeoutSec}
                      onChange={(v) => setToolUi((s) => ({ ...s, grepTimeoutSec: v ?? 60 }))}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <Form.Item label="文件历史备份" className="config-form-item-inline">
                    <Switch
                      checked={toolUi.fileCheckpointingEnabled}
                      onChange={(c) => setToolUi((s) => ({ ...s, fileCheckpointingEnabled: c }))}
                    />
                  </Form.Item>
                  <Form.Item label="每文件最多快照数">
                    <InputNumber
                      min={1}
                      max={500}
                      value={toolUi.maxFileSnapshots}
                      onChange={(v) => setToolUi((s) => ({ ...s, maxFileSnapshots: v ?? 100 }))}
                      style={{ width: '100%' }}
                    />
                  </Form.Item>
                  <div className="config-section-title" style={{ marginBottom: 8 }}>
                    内置工具
                  </div>
                  <div className="config-tool-list" style={{ border: '1px solid #f0f0f0', borderRadius: 8, maxHeight: 220, overflow: 'auto' }}>
                    {BUILTIN_TOOL_DEFINITIONS.map((def) => {
                      const on = toolUi.whitelistMode
                        ? toolUi.allowedEdit.includes(def.name)
                        : !toolUi.deniedTools.includes(def.name)
                      const risk = builtinToolRiskLevel(def.name)
                      return (
                        <div
                          key={def.name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '8px 10px',
                            borderBottom: '1px solid #f5f5f5'
                          }}
                        >
                          <Switch
                            size="small"
                            checked={on}
                            onChange={(checked) => {
                              if (toolUi.whitelistMode) {
                                setToolUi((s) => ({
                                  ...s,
                                  allowedEdit: checked
                                    ? [...new Set([...s.allowedEdit, def.name])]
                                    : s.allowedEdit.filter((x) => x !== def.name)
                                }))
                              } else {
                                setToolUi((s) => ({
                                  ...s,
                                  deniedTools: checked
                                    ? s.deniedTools.filter((x) => x !== def.name)
                                    : [...s.deniedTools, def.name]
                                }))
                              }
                            }}
                          />
                          <span style={{ flex: 1 }}>{def.name}</span>
                          <Tag color={risk === 'low' ? 'green' : risk === 'medium' ? 'orange' : 'red'}>{risk}</Tag>
                          <Tag>
                            {def.name === 'read_file' || def.name === 'list_directory' || def.name === 'grep' ? '免确认' : '需确认'}
                          </Tag>
                        </div>
                      )
                    })}
                  </div>
                </>
              )
            },
            {
              key: 'wiki',
              label: 'LLM Wiki',
              children: <WikiTab wiki={wikiUi} onChange={setWikiUi} />
            },
            {
              key: 'feishu',
              label: '飞书',
              children: <FeishuSettingsTab feishu={feishuUi} onChange={setFeishuUi} models={models} />
            },
            {
              key: 'skills',
              label: 'Skill',
              children: cfg ? (
                <SkillsTab config={cfg} onConfigSaved={refreshConfig} activationLog={skillActivationLog} />
              ) : null
            }
          ]}
        />
      </Form>
    </Modal>
  )
}
