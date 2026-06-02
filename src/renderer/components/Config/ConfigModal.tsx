import { useEffect, useMemo, useRef, useState } from 'react'

import { Alert, App, Button, Form, Input, InputNumber, Radio, Space } from 'antd'

import { ArrowLeft } from 'lucide-react'

import { useTypedSelector, useAppDispatch } from '../../hooks'

import { setConfig, setSettingsActiveTab, setSettingsOpen, setSettingsToolsSubTab } from '../../store/configSlice'

import type { ModelEntry, WikiConfig } from '../../../shared/domainTypes'

import { DEFAULT_WIKI_CONFIG, DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'

import type { BrowserConfig, ShellConfig } from '../../../shared/domainTypes'

import { DEFAULT_FEISHU_CONFIG, type FeishuConfig } from '../../../shared/feishuTypes'

import { DEFAULT_MODELS } from '../../../shared/domainTypes'

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

import { ModelsSettingsTab } from './ModelsSettingsTab'

import {

  buildConfigModalSnapshot,

  buildConfigModalSnapshotFromConfig,

  configModalSnapshotsEqual,

  normalizeSettingsTabKey

} from './configModalSnapshot'

import {

  buildLlmServicesSavePayload,

  useLlmServiceDrafts,

  validateLlmServiceDrafts

} from './useLlmServiceDrafts'

import { initLlmServiceTabState } from './llmServiceDrafts'

import { readSkillActivationLog } from '../../services/skillActivationLog'
import type { ToolsSettingsSubTab } from '../../store/configSlice'
import {
  DEFAULT_TOOLS_SETTINGS_SUB_TAB,
  getToolsSettingsSectionLabel,
  TOOLS_SETTINGS_NAV
} from './toolsSettingsNav'

const SETTINGS_SECTIONS = [
  { key: 'general', label: '通用' },
  { key: 'models', label: '模型' },
  { key: 'skills', label: '技能' },
  { key: 'wiki', label: '项目 Wiki' },
  { key: 'feishu', label: '飞书' }
] as const



type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key']

/** 表单项随 Tab 卸载时 useWatch 会变为 undefined，脏检查须回退到 form / cfg */
function resolveWorkDirForSnapshot(
  watch: unknown,
  form: ReturnType<typeof Form.useForm>[0],
  cfg: { workDir: string } | null
): string {
  if (typeof watch === 'string') return watch
  const fromForm = form.getFieldValue('workDir')
  if (typeof fromForm === 'string') return fromForm
  return cfg?.workDir ?? ''
}

function resolveThinkingEnabledForSnapshot(
  watch: unknown,
  form: ReturnType<typeof Form.useForm>[0],
  cfg: { thinkingEnabled: boolean } | null
): boolean {
  if (typeof watch === 'boolean') return watch
  const fromForm = form.getFieldValue('thinkingEnabled')
  if (typeof fromForm === 'boolean') return fromForm
  return Boolean(cfg?.thinkingEnabled)
}

function FolderOpenIcon() {

  return (

    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden>

      <path

        fill="currentColor"

        d="M3.087 9a2 2 0 0 1 .166-.77l.046-.095L4.77 4.97A3 3 0 0 1 7.47 3h9.06a3 3 0 0 1 2.7 1.97l1.47 3.165c.12.252.2.528.227.82a1 1 0 0 1 .073.37v6.695a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V9.37a1 1 0 0 1 .087-.37M7.47 5a1 1 0 0 0-.9.657L5.588 8H9V5zm4 0H11v3h4V5zm3.06 0H15v3h3.412l-.982-2.343A1 1 0 0 0 16.53 5M5 16.695a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V10H5z"

      />

    </svg>

  )

}



/** @deprecated 使用 ConfigSettingsPage；保留别名以兼容现有 import */

export const ConfigModal = ConfigSettingsPage



export function ConfigSettingsPage() {

  const { message, modal } = App.useApp()

  const open = useTypedSelector((s) => s.config.settingsOpen)

  const settingsActiveTab = useTypedSelector((s) => s.config.settingsActiveTab)

  const settingsToolsSubTab = useTypedSelector((s) => s.config.settingsToolsSubTab)

  const cfg = useTypedSelector((s) => s.config.config)

  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)

  const sessions = useTypedSelector((s) => s.session.list)

  const dispatch = useAppDispatch()

  const [form] = Form.useForm()

  const workDirWatch = Form.useWatch('workDir', form)

  const thinkingEnabledWatch = Form.useWatch('thinkingEnabled', form)

  const llmDrafts = useLlmServiceDrafts(open, cfg)

  const baselineRef = useRef<string | null>(null)

  const closeBtnRef = useRef<HTMLButtonElement>(null)

  const [workDirError, setWorkDirError] = useState<string | null>(null)

  const [models, setModels] = useState<ModelEntry[]>([])

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

  const [maxParallelChatSessions, setMaxParallelChatSessions] = useState(DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)

  const [wikiUi, setWikiUi] = useState<WikiConfig>({ ...DEFAULT_WIKI_CONFIG })

  const [feishuUi, setFeishuUi] = useState<FeishuConfig>({ ...DEFAULT_FEISHU_CONFIG })

  const [browserUi, setBrowserUi] = useState<BrowserConfig>({ ...DEFAULT_BROWSER_CONFIG })

  const [shellUi, setShellUi] = useState<ShellConfig>({ ...DEFAULT_SHELL_CONFIG })

  const [shellTest, setShellTest] = useState<{ ok: boolean; text: string } | null>(null)

  const [shellTesting, setShellTesting] = useState(false)

  const [saving, setSaving] = useState(false)



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

      setMaxParallelChatSessions(cfg.maxParallelChatSessions ?? DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)

      setWikiUi(cfg.wiki ?? { ...DEFAULT_WIKI_CONFIG })

      setFeishuUi(cfg.feishu ?? { ...DEFAULT_FEISHU_CONFIG })

      setBrowserUi({ ...browserCfg, enabled: true, trustedDomains, allowedDomains: [] })

      setShellUi(cfg.shell ?? { ...DEFAULT_SHELL_CONFIG })

      setShellTest(null)



      const shellEnabledInit = !deniedTools.includes('run_shell')

      const llmState = initLlmServiceTabState(cfg.llmServices ?? [], cfg.activeLlmServiceId ?? '')

      const timer = window.setTimeout(() => {

        baselineRef.current = buildConfigModalSnapshotFromConfig(cfg, llmState, deniedTools, shellEnabledInit)

        closeBtnRef.current?.focus()

      }, 0)

      return () => window.clearTimeout(timer)

    }

    baselineRef.current = null

    return undefined

  }, [open, cfg, form])



  useEffect(() => {

    if (!open) return

    const prevOverflow = document.body.style.overflow

    document.body.style.overflow = 'hidden'

    return () => {

      document.body.style.overflow = prevOverflow

    }

  }, [open])



  const shellEnabled = !toolUi.deniedTools.includes('run_shell')



  const currentSnapshot = useMemo(() => {

    if (!open) return null

    return buildConfigModalSnapshot({

      workDir: resolveWorkDirForSnapshot(workDirWatch, form, cfg),

      thinkingEnabled: resolveThinkingEnabledForSnapshot(thinkingEnabledWatch, form, cfg),

      models,

      llmState: llmDrafts.state,

      toolUi,

      maxParallelChatSessions,

      wiki: wikiUi,

      feishu: feishuUi,

      browser: browserUi,

      shell: shellUi,

      shellEnabled

    })

  }, [

    open,

    cfg,

    form,

    workDirWatch,

    thinkingEnabledWatch,

    models,

    llmDrafts.state,

    toolUi,

    maxParallelChatSessions,

    wikiUi,

    feishuUi,

    browserUi,

    shellUi,

    shellEnabled

  ])



  const isDirty =

    open && baselineRef.current != null && currentSnapshot != null

      ? !configModalSnapshotsEqual(currentSnapshot, baselineRef.current)

      : false



  const attemptCloseRef = useRef<() => void>(() => {})



  const onShellEnabledChange = (enabled: boolean) => {

    setShellUi((s) => ({ ...s, enabled }))

    setToolUi((s) => ({

      ...s,

      deniedTools: enabled ? s.deniedTools.filter((x) => x !== 'run_shell') : [...s.deniedTools, 'run_shell']

    }))

  }



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



  const resetModels = () => {

    setModels(DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))

  }



  const persistSettings = async (closeAfterSave: boolean) => {

    const v = await form.validateFields()

    if (v.workDir) {

      const r = await window.api.configCheckWorkdirWritable(v.workDir)

      if (!r.writable) {

        setWorkDirError(`该目录不可写入：${r.error ?? '权限不足'}，请更换工作目录`)

        return false

      }

    }

    const enabledModels = models.filter((m) => m.enabled)

    if (enabledModels.length === 0) {

      message.warning('请至少启用一个模型')

      return false

    }

    const llmErr = validateLlmServiceDrafts(llmDrafts.state)

    if (llmErr) {

      message.warning(llmErr)

      return false

    }

    const llmPayload = buildLlmServicesSavePayload(llmDrafts.state)

    setSaving(true)

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

        maxParallelChatSessions,

        wiki: wikiUi,

        feishu: feishuUi,

        browser: { ...browserUi, enabled: true, allowedDomains: [] },

        shell: { ...shellUi, enabled: shellEnabled }

      })

    } catch (e) {

      message.error(e instanceof Error ? e.message : String(e))

      return false

    } finally {

      setSaving(false)

    }

    const next = await window.api.configGet()

    dispatch(setConfig(next))

    llmDrafts.resetFromConfig(next)

    baselineRef.current = buildConfigModalSnapshotFromConfig(

      next,

      initLlmServiceTabState(next.llmServices ?? [], next.activeLlmServiceId ?? ''),

      toolUi.deniedTools,

      shellEnabled

    )

    message.success('已保存')

    if (closeAfterSave) {

      dispatch(setSettingsOpen(false))

    }

    return true

  }



  const attemptClose = () => {

    if (!isDirty) {

      dispatch(setSettingsOpen(false))

      return

    }

    modal.confirm({

      title: '放弃未保存的更改？',

      content: '你在设置中所做的修改尚未保存。',

      okText: '放弃更改',

      okType: 'danger',

      cancelText: '继续编辑',

      onOk: () => dispatch(setSettingsOpen(false))

    })

  }



  attemptCloseRef.current = attemptClose



  useEffect(() => {

    if (!open) return

    const onKey = (e: KeyboardEvent) => {

      if (e.key === 'Escape') {

        e.preventDefault()

        attemptCloseRef.current()

      }

    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)

  }, [open])



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



  const testShell = async () => {

    setShellTesting(true)

    setShellTest(null)

    try {

      const r = await window.api.shellTestExecutable({

        executable: shellUi.executable,

        argsPrefix: shellUi.argsPrefix

      })

      if (r.ok) setShellTest({ ok: true, text: 'Shell 测试成功' })

      else setShellTest({ ok: false, text: r.error ?? '测试失败' })

    } finally {

      setShellTesting(false)

    }

  }



  const settingsTabKey = (normalizeSettingsTabKey(settingsActiveTab) ?? 'general') as SettingsSectionKey | 'tools'

  const toolsSection: ToolsSettingsSubTab =
    settingsToolsSubTab ??
    (settingsActiveTab === 'browser' ? 'browser' : DEFAULT_TOOLS_SETTINGS_SUB_TAB)

  const activeSectionLabel =
    settingsTabKey === 'tools'
      ? getToolsSettingsSectionLabel(toolsSection)
      : SETTINGS_SECTIONS.find((s) => s.key === settingsTabKey)?.label ?? '设置'



  if (!open) return null



  const renderSectionContent = () => {

    switch (settingsTabKey) {

      case 'general':

        return (

          <>

            <Form.Item label="工作目录（会话明文备份等）" required>

              <Space.Compact style={{ width: '100%' }}>

                <Form.Item name="workDir" noStyle preserve rules={[{ required: true }]}>

                  <Input onBlur={(e) => void checkWorkDir(e.target.value)} />

                </Form.Item>

                <Button

                  icon={<FolderOpenIcon />}

                  onClick={selectDirectory}

                  title="选择目录"

                  aria-label="选择目录"

                />

              </Space.Compact>

            </Form.Item>

            {workDirError ? (

              <Alert type="error" message={workDirError} showIcon className="config-alert-block--loose" />

            ) : null}

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

      case 'models':

        return (

          <ModelsSettingsTab

            draftsApi={llmDrafts}

            models={models}

            onModelsChange={setModels}

            onResetModels={resetModels}

          />

        )

      case 'tools':

        return (

          <ToolsSettingsTab

            section={toolsSection}

            toolUi={toolUi}

            setToolUi={setToolUi}

            browserUi={browserUi}

            setBrowserUi={setBrowserUi}

            shellUi={shellUi}

            setShellUi={setShellUi}

            onShellEnabledChange={onShellEnabledChange}

            onTestShell={() => void testShell()}

            shellTesting={shellTesting}

            shellTest={shellTest}

            models={models}

            pyTest={pyTest}

            pyTesting={pyTesting}

            onTestPython={() => void testPython()}

          />

        )

      case 'skills':

        return cfg ? (

          <SkillsTab

            active={settingsTabKey === 'skills'}

            config={cfg}

            onConfigSaved={refreshConfig}

            activationLog={skillActivationLog}

          />

        ) : null

      case 'wiki':

        return <WikiTab wiki={wikiUi} onChange={setWikiUi} />

      case 'feishu':

        return <FeishuSettingsTab feishu={feishuUi} onChange={setFeishuUi} models={models} />

      default:

        return null

    }

  }



  return (

    <div

      className="config-settings-page"

      role="dialog"

      aria-modal="true"

      aria-labelledby="config-settings-page-title"

    >

      <div className="config-settings-page__shell">

        <aside className="config-settings-page__nav" aria-label="设置分类">

          <div className="config-settings-page__nav-header">

            <button

              ref={closeBtnRef}

              type="button"

              className="config-settings-page__back"

              onClick={attemptClose}

              aria-label="返回工作台"

            >

              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />

              <span>返回</span>

            </button>

          </div>

          <div className="config-settings-page__nav-brand">设置</div>

          <nav className="config-settings-page__nav-list">

            {SETTINGS_SECTIONS.slice(0, 2).map((section) => (

              <button

                key={section.key}

                type="button"

                className={`config-settings-page__nav-item${settingsTabKey === section.key ? ' config-settings-page__nav-item--active' : ''}`}

                aria-current={settingsTabKey === section.key ? 'page' : undefined}

                onClick={() => dispatch(setSettingsActiveTab(section.key))}

              >

                {section.label}

              </button>

            ))}

            <div className="config-settings-page__nav-group" role="group" aria-label="工具">

              <div className="config-settings-page__nav-group-label">工具</div>

              {TOOLS_SETTINGS_NAV.map((item) => (

                <button

                  key={item.id}

                  type="button"

                  className={`config-settings-page__nav-item config-settings-page__nav-item--sub${settingsTabKey === 'tools' && toolsSection === item.id ? ' config-settings-page__nav-item--active' : ''}`}

                  aria-current={settingsTabKey === 'tools' && toolsSection === item.id ? 'page' : undefined}

                  onClick={() => dispatch(setSettingsToolsSubTab(item.id))}

                >

                  {item.label}

                </button>

              ))}

            </div>

            {SETTINGS_SECTIONS.slice(2).map((section) => (

              <button

                key={section.key}

                type="button"

                className={`config-settings-page__nav-item${settingsTabKey === section.key ? ' config-settings-page__nav-item--active' : ''}`}

                aria-current={settingsTabKey === section.key ? 'page' : undefined}

                onClick={() => dispatch(setSettingsActiveTab(section.key))}

              >

                {section.label}

              </button>

            ))}

          </nav>

        </aside>



        <div className="config-settings-page__main">

          <header className="config-settings-page__header">

            <h1 id="config-settings-page-title" className="config-settings-page__title">

              {activeSectionLabel}

            </h1>

            {isDirty ? (

              <span className="config-settings-page__dirty-hint">有未保存的更改</span>

            ) : (

              <span className="config-settings-page__dirty-hint config-settings-page__dirty-hint--hidden" />

            )}

          </header>



          <div className="config-settings-page__body">

            <div className="config-settings-page__content">

              <Form form={form} layout="vertical">

                {renderSectionContent()}

              </Form>

            </div>

          </div>



          <footer className="config-settings-page__footer">

            <Space>

              <Button onClick={attemptClose}>取消</Button>

              <Button loading={saving} disabled={!isDirty} onClick={() => void persistSettings(false)}>

                应用

              </Button>

              <Button type="primary" loading={saving} disabled={!isDirty} onClick={() => void persistSettings(true)}>

                保存并返回

              </Button>

            </Space>

          </footer>

        </div>

      </div>

    </div>

  )

}


