import { useEffect, useState } from 'react'
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Modal, Popover, Radio, Select, Space, Switch, Tabs } from 'antd'
import { useTypedSelector, useAppDispatch } from '../../hooks'
import { setConfig, setSettingsActiveTab, setSettingsOpen } from '../../store/configSlice'
import type { ModelEntry, UiThemeMode, WikiConfig, PlanConfig } from '../../../shared/domainTypes'
import { DEFAULT_WIKI_CONFIG, DEFAULT_PLAN_CONFIG, DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'
import type { BrowserConfig } from '../../../shared/domainTypes'
import { DEFAULT_FEISHU_CONFIG, type FeishuConfig } from '../../../shared/feishuTypes'
import type { ChatMode } from '../../../shared/planTypes'
import { DEFAULT_CHAT_MODE } from '../../../shared/planTypes'
import { DEFAULT_MODELS, DEFAULT_MODEL_MAX_CONTEXT, DEFAULT_MODEL_MAX_TOKENS } from '../../../shared/domainTypes'
import {
  DEFAULT_MAX_PARALLEL_CHAT_SESSIONS,
  MAX_MAX_PARALLEL_CHAT_SESSIONS,
  MIN_MAX_PARALLEL_CHAT_SESSIONS
} from '../../../shared/chatParallelConfig'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import { SkillsTab } from './SkillsTab'
import { WikiTab } from './WikiTab'
import { FeishuSettingsTab } from './FeishuSettingsTab'
import { ToolsSettingsTab } from './ToolsSettingsTab'
import { LlmServiceTab } from './LlmServiceTab'
import {
  buildLlmServicesSavePayload,
  useLlmServiceDrafts,
  validateLlmServiceDrafts
} from './useLlmServiceDrafts'
import { readSkillActivationLog } from '../../services/skillActivationLog'
import { ConfigModelOptionContent } from './ConfigModelOption'
import { CONFIG_MODAL_SELECT_POPUP } from './configModalUi'

const DEFAULT_ADD_MODEL_MAX_CONTEXT = DEFAULT_MODEL_MAX_CONTEXT
const DEFAULT_ADD_MODEL_MAX_TOKENS = DEFAULT_MODEL_MAX_TOKENS

function AddIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24">
      <path fill="currentColor" d="M11 20a1 1 0 1 0 2 0v-7h7a1 1 0 1 0 0-2h-7V4a1 1 0 1 0-2 0v7H4a1 1 0 1 0 0 2h7z" />
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

function ModelSelect({ value, onChange }: { value: ModelEntry[]; onChange: (v: ModelEntry[]) => void }) {
  const selectable = value.filter((m) => m.enabled)
  const defaultModel = selectable.find((m) => m.isDefault) ?? selectable[0]

  const handleChange = (id: string) => {
    onChange(value.map((m) => ({ ...m, isDefault: m.id === id })))
  }

  if (selectable.length === 0) {
    return (
      <div className="config-model-select-empty">暂无可用模型</div>
    )
  }

  return (
    <Select
      className="config-model-select"
      style={{ width: '100%' }}
      value={defaultModel?.id}
      onChange={handleChange}
      popupClassName={`${CONFIG_MODAL_SELECT_POPUP} config-model-select-popup`}
      options={selectable.map((m) => ({ value: m.id, label: m.name }))}
      optionRender={(opt) => {
        const m = selectable.find((x) => x.id === opt.value)
        return m ? <ConfigModelOptionContent m={m} /> : opt.label
      }}
      labelRender={(item) => {
        const m = selectable.find((x) => x.id === item.value)
        return m ? <ConfigModelOptionContent m={m} selected /> : item.label
      }}
    />
  )
}

export function ConfigModal() {
  const { message } = App.useApp()
  const open = useTypedSelector((s) => s.config.settingsOpen)
  const settingsActiveTab = useTypedSelector((s) => s.config.settingsActiveTab)
  const settingsToolsSubTab = useTypedSelector((s) => s.config.settingsToolsSubTab)
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
  const [addMaxCtx, setAddMaxCtx] = useState<number | null>(null)
  const [addMaxTokens, setAddMaxTokens] = useState<number | null>(null)
  const [addFast, setAddFast] = useState(false)
  const [toolUi, setToolUi] = useState({
    confirmMode: 'diff' as 'diff' | 'direct',
    deniedTools: [] as string[],
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
  const [browserUi, setBrowserUi] = useState<BrowserConfig>({ ...DEFAULT_BROWSER_CONFIG })
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
        workDir: cfg.workDir,
        thinkingEnabled: cfg.thinkingEnabled
      })
      setModels(cfg.models.length > 0 ? cfg.models : DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))
      setWorkDirError(null)
      const allBuiltin = BUILTIN_TOOL_DEFINITIONS.map((d) => d.name)
      let deniedTools: string[]
      if (!cfg.tools.enabled) {
        deniedTools = [...allBuiltin]
      } else if (cfg.tools.allowedTools.length > 0) {
        deniedTools = allBuiltin.filter((n) => !cfg.tools.allowedTools.includes(n))
      } else {
        deniedTools = [...cfg.tools.deniedTools]
      }
      const browserCfg = cfg.browser ?? { ...DEFAULT_BROWSER_CONFIG }
      if (!browserCfg.enabled && !deniedTools.includes('browser')) {
        deniedTools = [...deniedTools, 'browser']
      }
      const trustedDomains = [
        ...new Set([...(browserCfg.trustedDomains ?? []), ...(browserCfg.allowedDomains ?? [])])
      ]
      setToolUi({
        confirmMode: cfg.tools.confirmMode,
        deniedTools,
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
      setBrowserUi({ ...browserCfg, enabled: true, trustedDomains, allowedDomains: [] })
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
    const maximumContext = addMaxCtx ?? DEFAULT_ADD_MODEL_MAX_CONTEXT
    const maxTokens = addMaxTokens ?? DEFAULT_ADD_MODEL_MAX_TOKENS
    const entry: ModelEntry = { id, name, maximumContext, maxTokens, isDefault: false, isFast: addFast, enabled: true }
    const updated = [...models, entry]
    if (updated.length === 1) {
      entry.isDefault = true
    }
    if (updated.length > 0 && !updated.some((m) => m.isDefault)) {
      updated[0].isDefault = true
    }
    setModels(updated)
    setAddName('')
    setAddMaxCtx(null)
    setAddMaxTokens(null)
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
        workDir: v.workDir,
        thinkingEnabled: v.thinkingEnabled,
        models,
        ...llmPayload,
        tools: {
          enabled: true,
          confirmMode: toolUi.confirmMode,
          deniedTools: toolUi.deniedTools,
          allowedTools: [],
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
        browser: { ...browserUi, enabled: true, allowedDomains: [] },
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
    <div className="config-add-model-popover">
      <div className="config-add-model-field">
        <span className="config-add-model-label">模型名称</span>
        <Input
          placeholder="（按照您的服务商提供的模型名称填写）"
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onPressEnter={addModel}
          autoFocus
        />
      </div>
      <div className="config-add-model-row">
        <div className="config-add-model-field">
          <span className="config-add-model-label">最大上下文</span>
          <InputNumber
            placeholder="留空默认 200K"
            value={addMaxCtx}
            onChange={(v) => setAddMaxCtx(typeof v === 'number' ? v : null)}
            min={1}
            style={{ width: '100%' }}
          />
        </div>
        <div className="config-add-model-field">
          <span className="config-add-model-label">最大输出</span>
          <InputNumber
            placeholder="留空默认 64K"
            value={addMaxTokens}
            onChange={(v) => setAddMaxTokens(typeof v === 'number' ? v : null)}
            min={1}
            style={{ width: '100%' }}
          />
        </div>
      </div>
      <p className="config-add-model-hint">用于帮助 Agent 更好的管理上下文。若您不确定，可以留空。</p>
      <Checkbox checked={addFast} onChange={(e) => setAddFast(e.target.checked)}>
        标注为快速模型（用于处理低成本简单任务）
      </Checkbox>
      <Button type="primary" size="small" block onClick={addModel} disabled={!addName.trim()}>
        确认
      </Button>
    </div>
  )

  const settingsTabKey =
    settingsActiveTab === 'browser' ? 'tools' : (settingsActiveTab ?? 'general')

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
          activeKey={settingsTabKey}
          onChange={(key) => dispatch(setSettingsActiveTab(key))}
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
                  <div className="config-model-field">
                    <div className="config-model-field__header">
                      <span className="config-model-field__label">默认模型</span>
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
                    <ModelSelect value={models} onChange={setModels} />
                  </div>
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
                <ToolsSettingsTab
                  toolUi={toolUi}
                  setToolUi={setToolUi}
                  browserUi={browserUi}
                  setBrowserUi={setBrowserUi}
                  models={models}
                  pyTest={pyTest}
                  pyTesting={pyTesting}
                  onTestPython={() => void testPython()}
                  initialSubTab={
                    settingsToolsSubTab ?? (settingsActiveTab === 'browser' ? 'browser' : undefined)
                  }
                />
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
                <SkillsTab
                  active={open && settingsTabKey === 'skills'}
                  config={cfg}
                  onConfigSaved={refreshConfig}
                  activationLog={skillActivationLog}
                />
              ) : null
            }
          ]}
        />
      </Form>
    </Modal>
  )
}
