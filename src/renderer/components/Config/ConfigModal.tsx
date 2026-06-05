import { useEffect, useMemo, useRef, useState } from 'react'

import { Alert, App, Button, Form, Input, InputNumber, Radio, Select, Space } from 'antd'

import { ArrowLeft } from 'lucide-react'

import { useTypedSelector, useAppDispatch } from '../../hooks'

import { setConfig, setSettingsActiveTab, setSettingsOpen, setSettingsToolsSubTab } from '../../store/configSlice'

import type { AppLocale, ModelEntry, WikiConfig } from '../../../shared/domainTypes'

import { DEFAULT_WIKI_CONFIG, DEFAULT_BROWSER_CONFIG, DEFAULT_SHELL_CONFIG } from '../../../shared/domainTypes'

import type { BrowserConfig, ShellConfig } from '../../../shared/domainTypes'

import { DEFAULT_FEISHU_CONFIG, type FeishuConfig, type WorkDirProfile } from '../../../shared/feishuTypes'

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
  getToolsSettingsNav,
  getToolsSettingsSectionLabel
} from './toolsSettingsNav'
import { WorkDirList, validateWorkDirProfiles } from './WorkDirList'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { changeAppLocale, persistLocaleToBackend } from '../../i18n/localeSync'

const SETTINGS_SECTION_KEYS = ['general', 'models', 'skills', 'wiki', 'feishu'] as const

type SettingsSectionKey = (typeof SETTINGS_SECTION_KEYS)[number]

/** 表单项随 Tab 卸载时 useWatch 会变为 undefined，脏检查须回退到 form / cfg */
function resolveLocaleForSnapshot(
  watch: unknown,
  form: ReturnType<typeof Form.useForm>[0],
  cfg: { locale: AppLocale } | null
): AppLocale {
  if (watch === 'zh-CN' || watch === 'en-US') return watch
  const fromForm = form.getFieldValue('locale')
  if (fromForm === 'zh-CN' || fromForm === 'en-US') return fromForm
  return cfg?.locale ?? 'zh-CN'
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

/** @deprecated 使用 ConfigSettingsPage；保留别名以兼容现有 import */

export const ConfigModal = ConfigSettingsPage



export function ConfigSettingsPage() {

  const { message, modal } = App.useApp()
  const { t: tCommon } = useTypedTranslation('common')
  const { t: tConfig } = useTypedTranslation('config')

  const open = useTypedSelector((s) => s.config.settingsOpen)

  const settingsActiveTab = useTypedSelector((s) => s.config.settingsActiveTab)

  const settingsToolsSubTab = useTypedSelector((s) => s.config.settingsToolsSubTab)

  const cfg = useTypedSelector((s) => s.config.config)

  const currentSessionId = useTypedSelector((s) => s.chat.currentSessionId)

  const sessions = useTypedSelector((s) => s.session.list)

  const dispatch = useAppDispatch()

  const [form] = Form.useForm()

  const localeWatch = Form.useWatch('locale', form)

  const thinkingEnabledWatch = Form.useWatch('thinkingEnabled', form)

  const llmDrafts = useLlmServiceDrafts(open, cfg)

  const baselineRef = useRef<string | null>(null)

  const closeBtnRef = useRef<HTMLButtonElement>(null)

  const [workDirProfiles, setWorkDirProfiles] = useState<WorkDirProfile[]>([])

  const [workDirSaveError, setWorkDirSaveError] = useState<string | null>(null)

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



  const settingsSections = useMemo(() => {
    const labels: Record<SettingsSectionKey, string> = {
      general: tCommon('settings.general'),
      models: tCommon('settings.models'),
      skills: tCommon('settings.skills'),
      wiki: tCommon('settings.wiki'),
      feishu: tCommon('settings.feishu')
    }
    return SETTINGS_SECTION_KEYS.map((key) => ({ key, label: labels[key] }))
  }, [tCommon])

  const toolsSettingsNav = useMemo(() => getToolsSettingsNav(tConfig), [tConfig])



  useEffect(() => {

    if (open && cfg) {

      form.setFieldsValue({

        locale: cfg.locale,

        thinkingEnabled: cfg.thinkingEnabled

      })

      setWorkDirProfiles(cfg.workDirProfiles ?? [])

      setModels(cfg.models.length > 0 ? cfg.models : DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))

      setWorkDirSaveError(null)

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

      workDirProfiles,

      locale: resolveLocaleForSnapshot(localeWatch, form, cfg),

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

    workDirProfiles,

    localeWatch,

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



  const handleLocaleChange = async (locale: AppLocale) => {
    form.setFieldValue('locale', locale)
    await changeAppLocale(locale)
    await persistLocaleToBackend(locale)
    if (cfg) {
      const nextCfg = { ...cfg, locale }
      dispatch(setConfig(nextCfg))
      if (open) {
        baselineRef.current = buildConfigModalSnapshotFromConfig(
          nextCfg,
          llmDrafts.state,
          toolUi.deniedTools,
          shellEnabled
        )
      }
    }
  }

  const resetModels = () => {

    setModels(DEFAULT_MODELS.map((m, i) => ({ id: String(i + 1), ...m })))

  }



  const persistSettings = async (closeAfterSave: boolean) => {

    const v = await form.validateFields()

    const profileErr = validateWorkDirProfiles(workDirProfiles, tConfig)
    if (profileErr) {
      setWorkDirSaveError(profileErr)
      message.warning(profileErr)
      return false
    }

    for (const p of workDirProfiles) {
      const r = await window.api.workdirCheckWritable(p.path)
      if (!r.ok) {
        const err = tConfig('workDir.validation.dirNotWritable', { error: r.error ?? tConfig('workDir.validation.dirNotWritableFallback') })
        setWorkDirSaveError(err)
        message.warning(err)
        return false
      }
    }
    setWorkDirSaveError(null)

    const activeProfile = workDirProfiles.find((p) => p.isDefault) ?? workDirProfiles[0]

    const enabledModels = models.filter((m) => m.enabled)

    if (enabledModels.length === 0) {

      message.warning(tConfig('messages.enableAtLeastOneModel'))

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

        workDir: activeProfile?.path,

        workDirProfiles,

        activeWorkDirProfileId: activeProfile?.id ?? '',

        locale: v.locale,

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

    message.success(tConfig('messages.saved'))

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

      title: tConfig('discardChanges.title'),

      content: tConfig('discardChanges.content'),

      okText: tConfig('discardChanges.ok'),

      okType: 'danger',

      cancelText: tConfig('discardChanges.cancel'),

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

      if (r.ok) setShellTest({ ok: true, text: tConfig('messages.shellTestSuccess') })

      else setShellTest({ ok: false, text: r.error ?? tConfig('messages.shellTestFailed') })

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
      ? getToolsSettingsSectionLabel(toolsSection, tConfig)
      : settingsSections.find((s) => s.key === settingsTabKey)?.label ?? tCommon('settings.title')



  if (!open) return null



  const renderSectionContent = () => {

    switch (settingsTabKey) {

      case 'general':

        return (

          <>

            <WorkDirList profiles={workDirProfiles} onChange={setWorkDirProfiles} />

            {workDirSaveError ? (

              <Alert type="error" message={workDirSaveError} showIcon className="config-alert-block--loose" />

            ) : null}

            <Form.Item label={tConfig('language.label')} extra={tConfig('language.hint')}>

              <Form.Item name="locale" noStyle preserve>

                <Select
                  style={{ width: 200 }}
                  options={[
                    { value: 'zh-CN', label: tCommon('language.zhCN') },
                    { value: 'en-US', label: tCommon('language.enUS') }
                  ]}
                  onChange={(value: AppLocale) => void handleLocaleChange(value)}
                />

              </Form.Item>

            </Form.Item>

            <Form.Item label={tConfig('parallelSessions.label')} extra={tConfig('parallelSessions.hint')}>

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

        <aside className="config-settings-page__nav" aria-label={tConfig('navigation.categoriesAria')}>

          <div className="config-settings-page__nav-header">

            <button

              ref={closeBtnRef}

              type="button"

              className="config-settings-page__back"

              onClick={attemptClose}

              aria-label={tConfig('navigation.backToWorkbench')}

            >

              <ArrowLeft size={16} strokeWidth={1.75} aria-hidden />

              <span>{tCommon('back')}</span>

            </button>

          </div>

          <div className="config-settings-page__nav-brand">{tCommon('settings.title')}</div>

          <nav className="config-settings-page__nav-list">

            {settingsSections.slice(0, 2).map((section) => (

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

            <div className="config-settings-page__nav-group" role="group" aria-label={tCommon('settings.tools')}>

              <div className="config-settings-page__nav-group-label">{tCommon('settings.tools')}</div>

              {toolsSettingsNav.map((item) => (

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

            {settingsSections.slice(2).map((section) => (

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

              <span className="config-settings-page__dirty-hint">{tCommon('unsavedChanges')}</span>

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

              <Button onClick={attemptClose}>{tCommon('cancel')}</Button>

              <Button loading={saving} disabled={!isDirty} onClick={() => void persistSettings(false)}>

                {tCommon('apply')}

              </Button>

              <Button type="primary" loading={saving} disabled={!isDirty} onClick={() => void persistSettings(true)}>

                {tCommon('saveAndReturn')}

              </Button>

            </Space>

          </footer>

        </div>

      </div>

    </div>

  )

}


