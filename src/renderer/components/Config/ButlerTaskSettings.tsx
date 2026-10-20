import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Alert, App, Button, Checkbox, Collapse, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Steps, Switch, Table, Tag, TimePicker, Typography } from 'antd'
import { Pencil, Plus, SquarePlay, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import { getDefaultAutomationOutputOrganization, getPreflightClarificationReasonMessageKey, getPreflightIssueMessageKey, type AutomationTask, type AutomationDeliveryPref, type AutomationOutputOrganization, type AutomationTaskPermission, type AutomationTaskRun, type AutomationTaskSchedule, type PreflightReport } from '../../../shared/automationTaskTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { buildOnceDisabledConstraints, onceAtInFuture } from './onceAtConstraints'

// 评审 P1-2：项目默认不注册 customParseFormat——dayjs(值, 格式) 会得到 Invalid Date，
// daily 默认时间提交后变成 'Invalid Date' 被主进程拒绝。显式注册（幂等，全局生效一次）。
dayjs.extend(customParseFormat)

/**
 * 设置弹窗「定时任务」Tab（P6）：任务列表、新建/编辑、启停、删除、立即运行。
 * 列表语言与设置页既有卡片行（mcp-server-card / llm-service-card）对齐：
 * header（标题 + 标签 + 启停 Switch）→ summary（提示词 + meta）→ footer 动作（运行/编辑/删除）。
 * 渲染进程只表达意图——准入、调度、会话创建、门控、投递全在主进程。
 */

type TaskActions = {
  t: ReturnType<typeof useTypedTranslation<'config'>>['t']
  onRun: (task: AutomationTask) => void
  onEdit: (task: AutomationTask) => void
  onDelete: (task: AutomationTask) => void
  onToggle: (task: AutomationTask, enabled: boolean) => void
  onHistory: (task: AutomationTask) => void
  running: boolean
}

const TASK_DRAFT_STORAGE_PREFIX = 'spaceassistant:butler-task-draft:v1:'

type StoredTaskDraft = {
  values: Record<string, unknown>
  authorizedDirs: string[]
  outputOrganizationTouched: boolean
}

function taskDraftStorageKey(taskId: string | null): string {
  return `${TASK_DRAFT_STORAGE_PREFIX}${taskId ? encodeURIComponent(taskId) : 'new'}`
}

function persistTaskDraft(key: string, values: Record<string, unknown>, authorizedDirs: string[], outputOrganizationTouched: boolean): void {
  try {
    const savedValues: Record<string, string | number> = {}
    for (const field of ['name', 'prompt', 'scheduleKind', 'deliveryPref', 'outputDir', 'outputOrganization', 'modelId', 'modelServiceId', 'modelOverride', 'modelPair', 'reasoningEffort']) {
      const value = values[field]
      if (typeof value === 'string') savedValues[field] = value
    }
    if (typeof values.intervalMinutes === 'number' && Number.isFinite(values.intervalMinutes)) savedValues.intervalMinutes = values.intervalMinutes
    if (dayjs.isDayjs(values.dailyTime) && values.dailyTime.isValid()) savedValues.dailyTime = values.dailyTime.format('HH:mm')
    if (typeof values.dailyTime === 'string') savedValues.dailyTime = values.dailyTime
    if (dayjs.isDayjs(values.onceAt) && values.onceAt.isValid()) savedValues.onceAt = values.onceAt.valueOf()
    if (typeof values.onceAt === 'number' && Number.isFinite(values.onceAt)) savedValues.onceAt = values.onceAt

    window.localStorage.setItem(key, JSON.stringify({
      version: 1,
      values: savedValues,
      authorizedDirs,
      outputOrganizationTouched
    }))
  } catch {
    // 浏览器存储不可用时仍允许当前表单继续预检与保存。
  }
}

function readTaskDraft(key: string): StoredTaskDraft | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { version?: unknown; values?: unknown; authorizedDirs?: unknown; outputOrganizationTouched?: unknown }
    if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== 'object' || Array.isArray(parsed.values) || !Array.isArray(parsed.authorizedDirs)) return null

    const savedValues = parsed.values as Record<string, unknown>
    const values: Record<string, unknown> = {}
    for (const field of ['name', 'prompt', 'deliveryPref', 'outputDir', 'modelId', 'modelServiceId', 'modelOverride', 'modelPair', 'reasoningEffort']) {
      if (typeof savedValues[field] === 'string') values[field] = savedValues[field]
    }
    if (savedValues.scheduleKind === 'interval' || savedValues.scheduleKind === 'daily' || savedValues.scheduleKind === 'once') values.scheduleKind = savedValues.scheduleKind
    if (savedValues.outputOrganization === 'direct' || savedValues.outputOrganization === 'daily' || savedValues.outputOrganization === 'hourly') values.outputOrganization = savedValues.outputOrganization
    if (typeof savedValues.intervalMinutes === 'number' && Number.isFinite(savedValues.intervalMinutes)) values.intervalMinutes = savedValues.intervalMinutes
    if (typeof savedValues.dailyTime === 'string') {
      const dailyTime = dayjs(savedValues.dailyTime, 'HH:mm', true)
      if (dailyTime.isValid()) values.dailyTime = dailyTime
    }
    if (typeof savedValues.onceAt === 'number' && Number.isFinite(savedValues.onceAt)) values.onceAt = dayjs(savedValues.onceAt)

    return {
      values,
      authorizedDirs: parsed.authorizedDirs.filter((path): path is string => typeof path === 'string'),
      outputOrganizationTouched: typeof parsed.outputOrganizationTouched === 'boolean' ? parsed.outputOrganizationTouched : false
    }
  } catch {
    return null
  }
}

function clearTaskDraft(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // 清理失败不影响已经完成的任务保存。
  }
}

function outputOrganizationText(value: AutomationOutputOrganization | null, t: TaskActions['t']): string {
  if (value === 'daily') return t('butler.form.outputOrganizationDailyShort')
  if (value === 'direct') return t('butler.form.outputOrganizationDirectShort')
  if (value === 'hourly') return t('butler.form.outputOrganizationHourlyShort')
  return t('butler.form.outputOrganizationLegacy')
}

function scheduleTagText(task: AutomationTask, t: TaskActions['t']): string {
  if (task.schedule.kind === 'interval') return t('butler.schedule.interval', { minutes: task.schedule.intervalMinutes })
  if (task.schedule.kind === 'daily') return t('butler.schedule.daily', { time: task.schedule.time })
  return t('butler.schedule.once', { time: dayjs(task.schedule.at).format('YYYY-MM-DD HH:mm') })
}

function deliveryText(pref: AutomationDeliveryPref, t: TaskActions['t']): string {
  return t(`butler.delivery.${pref}` as 'butler.delivery.desktop')
}

type PermissionTableDetail = { label: string; value: ReactNode }
type PermissionTableRow = { key: string; permissionType: string; object: ReactNode; details: PermissionTableDetail[] }

function permissionTableRows(permissions: AutomationTaskPermission[], t: TaskActions['t']): PermissionTableRow[] {
  const code = (value: string) => <Typography.Text code className="butler-permission-table__code">{value}</Typography.Text>
  const pathList = (paths: string[]) => paths.length
    ? <div className="butler-permission-table__path-list">{paths.map((path, index) => <Typography.Text key={`${index}-${path}`} code className="butler-permission-table__code">{path}</Typography.Text>)}</div>
    : <Typography.Text type="secondary">{t('butler.form.permissionNoDirectoryScope')}</Typography.Text>
  const detail = (label: string, value: ReactNode): PermissionTableDetail => ({ label, value })

  return permissions.map((permission, index) => {
    switch (permission.kind) {
      case 'directory-read-write':
        return {
          key: `${index}-directory-read-write`,
          permissionType: t('butler.form.permissionTypeDirectoryReadWrite'),
          object: code(permission.path),
          details: [detail(t('butler.form.permissionDetailAccess'), t('butler.form.permissionDetailReadWrite'))]
        }
      case 'result-write':
        return {
          key: `${index}-result-write`,
          permissionType: t('butler.form.permissionTypeResultWrite'),
          object: code(permission.outputDirectory),
          details: [detail(t('butler.form.permissionDetailArchive'), outputOrganizationText(permission.organization, t))]
        }
      case 'local-shell':
        return {
          key: `${index}-local-shell`,
          permissionType: t('butler.form.permissionTypeLocalShell'),
          object: (
            <div className="butler-permission-table__command-list">
              {permission.commands.map((command, commandIndex) => (
                <div className="butler-permission-table__command" key={`${commandIndex}-${command.workingDirectory}`}>
                  <div className="butler-permission-table__detail-line">
                    <span className="butler-permission-table__detail-label">{t('butler.form.permissionDetailCommand')}</span>
                    {code(command.command)}
                  </div>
                  <div className="butler-permission-table__detail-line">
                    <span className="butler-permission-table__detail-label">{t('butler.form.permissionDetailWorkingDirectory')}</span>
                    {code(command.workingDirectory)}
                  </div>
                </div>
              ))}
            </div>
          ),
          details: [
            detail(t('butler.form.permissionDetailPathScope'), pathList(permission.scopeRoots)),
            detail(t('butler.form.permissionDetailTimeout'), t('butler.form.permissionDetailTimeoutValue'))
          ]
        }
      case 'grep':
        return {
          key: `${index}-grep`,
          permissionType: t('butler.form.permissionTypeGrep'),
          object: pathList(permission.scopeRoots),
          details: [detail(t('butler.form.permissionDetailAccess'), t('butler.form.permissionDetailGrep'))]
        }
      case 'run-script':
        return {
          key: `${index}-run-script`,
          permissionType: t('butler.form.permissionTypeRunScript'),
          object: pathList(permission.scopeRoots),
          details: [detail(t('butler.form.permissionDetailScriptReview'), t('butler.form.permissionDetailScriptHash'))]
        }
      case 'mcp-tool':
        return {
          key: `${index}-mcp-tool`,
          permissionType: t('butler.form.permissionTypeMcpTool'),
          object: (
            <div className="butler-permission-table__mcp-object">
              {code(permission.serverName)}
              <span aria-hidden="true">/</span>
              {code(permission.toolName)}
            </div>
          ),
          details: [
            detail(t('butler.form.permissionDetailToolDescription'), permission.description || t('butler.form.permissionMcpNoDescription')),
            detail(t('butler.form.permissionDetailPurpose'), permission.purpose),
            detail(t('butler.form.permissionDetailParameters'), permission.parameters.length
              ? <div className="butler-permission-table__parameters">{permission.parameters.map(({ name, required }) => <span key={name}>{code(name)}{required ? `（${t('butler.form.permissionMcpRequired')}）` : `（${t('butler.form.permissionMcpOptional')}）`}</span>)}</div>
              : t('butler.form.permissionMcpNoParameters')),
            detail(t('butler.form.permissionDetailBinding'), t('butler.form.permissionDetailMcpBinding'))
          ]
        }
      case 'deliver-result':
        return {
          key: `${index}-deliver-result`,
          permissionType: t('butler.form.permissionTypeDeliverResult'),
          object: (
            <div className="butler-permission-table__delivery-object">
              <Typography.Text strong>{deliveryText(permission.delivery, t)}</Typography.Text>
              {permission.target ? <Typography.Text>{permission.target}</Typography.Text> : null}
            </div>
          ),
          details: [detail(t('butler.form.permissionDetailAccess'), t('butler.form.permissionDetailDeliverResult'))]
        }
    }
  })
}

function PermissionReviewTable({ permissions, t }: { permissions: AutomationTaskPermission[]; t: TaskActions['t'] }) {
  const rows = permissionTableRows(permissions, t)
  return (
    <Table<PermissionTableRow>
      className="butler-permission-review__table"
      size="small"
      pagination={false}
      rowKey="key"
      dataSource={rows}
      scroll={{ x: 720 }}
      columns={[
        {
          title: t('butler.form.permissionTableType'),
          dataIndex: 'permissionType',
          key: 'permissionType',
          width: 132,
          render: (value: string) => <Typography.Text strong>{value}</Typography.Text>
        },
        {
          title: t('butler.form.permissionTableObject'),
          dataIndex: 'object',
          key: 'object',
          width: 300
        },
        {
          title: t('butler.form.permissionTableDetails'),
          dataIndex: 'details',
          key: 'details',
          render: (details: PermissionTableDetail[]) => (
            <div className="butler-permission-table__details">
              {details.map(({ label, value }, index) => (
                <div className="butler-permission-table__detail-line" key={`${label}-${index}`}>
                  <span className="butler-permission-table__detail-label">{label}</span>
                  <div className="butler-permission-table__detail-value">{value}</div>
                </div>
              ))}
            </div>
          )
        }
      ]}
    />
  )
}

function runStatusText(status: AutomationTaskRun['status'], t: TaskActions['t']): string {
  const key = {
    queued: 'butler.runStatus.queued', running: 'butler.runStatus.running', completed: 'butler.runStatus.completed',
    failed: 'butler.runStatus.failed', skipped: 'butler.runStatus.skipped', interrupted: 'butler.runStatus.interrupted'
  }[status] as 'butler.runStatus.queued'
  return t(key)
}

function ButlerTaskCard({ task, actions }: { task: AutomationTask; actions: TaskActions }) {
  const { t, onRun, onEdit, onDelete, onToggle, running } = actions
  const authorizedDirs = task.authorizedDirs ?? task.workDirs ?? []
  return (
    <div className={`butler-task-card${task.enabled ? '' : ' butler-task-card--disabled'}`}>
      <div className="butler-task-card__header">
        <span className="butler-task-card__title" title={task.name}>
          {task.name}
        </span>
        <Tag className="butler-task-card__tag">{scheduleTagText(task, t)}</Tag>
        <Tag className="butler-task-card__tag butler-task-card__tag--delivery">{deliveryText(task.deliveryPref, t)}</Tag>
        {!task.enabled ? <Tag className="butler-task-card__tag butler-task-card__tag--disabled">{t('butler.form.taskDisabled')}</Tag> : null}
        <div className="butler-task-card__header-actions">
          <Switch
            size="small"
            aria-label={t('butler.toggleAria', { name: task.name })}
            checked={task.enabled}
            onChange={(checked) => onToggle(task, checked)}
          />
        </div>
      </div>
      <div className="butler-task-card__summary">
        <div className="butler-task-card__summary-prompt">
          <SquarePlay size={13} aria-hidden className="butler-task-card__summary-icon" />
          <span className="butler-task-card__summary-text" title={task.prompt}>{task.prompt}</span>
        </div>
        <div className="butler-task-card__summary-details">
          <span className="butler-task-card__output-dir" title={task.outputDir ?? undefined}>
            {t('butler.form.outputDir')}: {task.outputDir || t('butler.form.outputDirLegacyShort')}
          </span>
          <span className="butler-task-card__output-organization">
            {t('butler.form.outputOrganization')}: {outputOrganizationText(task.outputOrganization, t)}
          </span>
          <span className="butler-task-card__authorized-dirs" title={authorizedDirs.join('\n')}>
            {t('butler.form.authorizedDirs')}: {authorizedDirs.length ? authorizedDirs.join(', ') : t('butler.form.authorizedDirsEmpty')}
          </span>
          <span className="butler-task-card__access-permissions">
            {t('butler.form.permissionCount', { count: task.accessPermissions?.authorizationRecord?.permissions.length ?? 0 })}
          </span>
          {task.lastRunAt ? <span className="butler-task-card__summary-meta">{t('butler.lastRun', { time: dayjs(task.lastRunAt).format('YYYY-MM-DD HH:mm') })}</span> : null}
        </div>
      </div>
      <div className="butler-task-card__footer">
        <Button size="small" type="primary" loading={running} disabled={!task.enabled} onClick={() => onRun(task)}>
          {t('butler.run')}
        </Button>
        <Button size="small" onClick={() => actions.onHistory(task)}>{t('butler.history')}</Button>
        <Button size="small" icon={<Pencil size={13} aria-hidden />} onClick={() => onEdit(task)}>
          {t('butler.edit')}
        </Button>
        <Popconfirm title={t('butler.deleteConfirm', { name: task.name })} onConfirm={() => onDelete(task)}>
          <Button
            size="small"
            danger
            icon={<Trash2 size={13} aria-hidden />}
            aria-label={t('butler.deleteAria', { name: task.name })}
          />
        </Popconfirm>
      </div>
    </div>
  )
}

export function ButlerTaskSettings() {
  const { t } = useTypedTranslation('config')
  const { message } = App.useApp()
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [trayEnabled, setTrayEnabled] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<AutomationTask | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [historyTask, setHistoryTask] = useState<AutomationTask | null>(null)
  const [historyRuns, setHistoryRuns] = useState<AutomationTaskRun[]>([])
  const [preflightReport, setPreflightReport] = useState<PreflightReport | null>(null)
  const [authorizationReview, setAuthorizationReview] = useState<{ reviewId: string; permissions: AutomationTaskPermission[]; preflightCoverage?: 'partial' } | null>(null)
  const [authorizeAllPermissions, setAuthorizeAllPermissions] = useState(false)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [wizardStep, setWizardStep] = useState<0 | 1 | 2>(0)
  const [enableOnSave, setEnableOnSave] = useState(false)
  const [advancedSettingsExpanded, setAdvancedSettingsExpanded] = useState(false)
  const authorizationReviewRef = useRef<HTMLDivElement>(null)
  const preflightReportRef = useRef<HTMLDivElement>(null)
  const writeErrorRef = useRef<HTMLDivElement>(null)
  const [authorizedDirs, setAuthorizedDirs] = useState<string[]>([])
  const outputOrganizationTouched = useRef(false)
  const activeTaskDraftKey = useRef<string | null>(null)
  const authorizationDraftRevision = useRef(0)
  const [form] = Form.useForm()
  const scheduleKind = Form.useWatch('scheduleKind', form) as AutomationTaskSchedule['kind'] | undefined
  const outputDir = Form.useWatch('outputDir', form) as string | undefined
  const outputOrganization = Form.useWatch('outputOrganization', form) as AutomationOutputOrganization | undefined
  const deliveryPref = Form.useWatch('deliveryPref', form) as AutomationDeliveryPref | undefined
  const [modelCandidates, setModelCandidates] = useState<Array<{ modelId: string; providerModelName: string; serviceId: string; serviceName: string; supportsThinking: boolean }>>([])
  const selectedModelId = Form.useWatch('modelId', form)
  const selectedServiceId = Form.useWatch('modelServiceId', form)
  const selectedCandidate = modelCandidates.find((candidate) => candidate.modelId === selectedModelId && candidate.serviceId === selectedServiceId)
  const onceConstraints = buildOnceDisabledConstraints()

  useEffect(() => {
    const target = authorizationReview
      ? authorizationReviewRef.current
      : preflightReport && preflightReport.status !== 'passed'
        ? preflightReportRef.current
        : writeError
          ? writeErrorRef.current
          : null
    if (!target) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    target.scrollIntoView?.({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' })
    target.focus({ preventScroll: true })
  }, [authorizationReview, preflightReport, writeError])

  const invalidateAuthorizationReview = () => {
    authorizationDraftRevision.current += 1
    setAuthorizationReview(null)
    setAuthorizeAllPermissions(false)
    setPreflightReport(null)
    setWriteError(null)
  }

  const persistActiveTaskDraft = (directories = authorizedDirs) => {
    if (activeTaskDraftKey.current) {
      persistTaskDraft(activeTaskDraftKey.current, form.getFieldsValue(true), directories, outputOrganizationTouched.current)
    }
  }

  useEffect(() => {
    if (editing || outputOrganizationTouched.current || !scheduleKind) return
    form.setFieldValue('outputOrganization', getDefaultAutomationOutputOrganization({ kind: scheduleKind }))
  }, [editing, form, scheduleKind])

  const refresh = useCallback(async () => {
    try {
      setTasks(await window.api.butlerListTasks())
    } catch {
      message.error(t('butler.loadFailed'))
    }
  }, [t, message])

  useEffect(() => {
    void refresh()
    void window.api
      .appGetTrayEnabled()
      .then(setTrayEnabled)
      .catch(() => setTrayEnabled(false))
    // 仅挂载时加载一次；刷新由各操作后显式触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openCreate = async () => {
    authorizationDraftRevision.current += 1
    setEditing(null)
    setWizardStep(0)
    setEnableOnSave(true)
    setAdvancedSettingsExpanded(false)
    const draftKey = taskDraftStorageKey(null)
    const savedDraft = readTaskDraft(draftKey)
    activeTaskDraftKey.current = savedDraft ? draftKey : null
    outputOrganizationTouched.current = savedDraft?.outputOrganizationTouched ?? false
    const [defaults, candidates] = await Promise.all([window.api.butlerGetTaskDefaults(), window.api.butlerGetModelCandidates()])
    setModelCandidates(candidates)
    setAuthorizedDirs(savedDraft?.authorizedDirs ?? [])
    form.setFieldsValue({
      name: '',
      prompt: '',
      scheduleKind: 'interval',
      intervalMinutes: 30,
      dailyTime: dayjs('09:00', 'HH:mm'),
      onceAt: dayjs().add(1, 'hour'),
      deliveryPref: 'desktop',
      outputDir: undefined,
      outputOrganization: 'hourly',
      workDirs: [],
      modelId: defaults.modelId,
      modelServiceId: defaults.modelServiceId,
      modelOverride: defaults.modelOverride,
      modelPair: defaults.modelId && defaults.modelServiceId ? `${defaults.modelId}::${defaults.modelServiceId}` : undefined,
      reasoningEffort: candidates.find((candidate) => candidate.modelId === defaults.modelId && candidate.serviceId === defaults.modelServiceId)?.supportsThinking === false
        ? 'off'
        : defaults.reasoningEffort ?? 'off',
      ...savedDraft?.values
    })
    setPreflightReport(null)
    setAuthorizationReview(null)
    setAuthorizeAllPermissions(false)
    setWriteError(null)
    setEditorOpen(true)
  }

  const openEdit = (task: AutomationTask) => {
    authorizationDraftRevision.current += 1
    setEditing(task)
    setWizardStep(0)
    setEnableOnSave(task.enabled)
    setAdvancedSettingsExpanded(false)
    const draftKey = taskDraftStorageKey(task.id)
    const savedDraft = readTaskDraft(draftKey)
    activeTaskDraftKey.current = savedDraft ? draftKey : null
    outputOrganizationTouched.current = savedDraft?.outputOrganizationTouched ?? true
    const roots = task.authorizedDirs ?? task.workDirs ?? []
    setAuthorizedDirs(savedDraft?.authorizedDirs ?? roots)
    void window.api.butlerGetModelCandidates().then(setModelCandidates)
    form.setFieldsValue({
      name: task.name,
      prompt: task.prompt,
      scheduleKind: task.schedule.kind,
      intervalMinutes: task.schedule.kind === 'interval' ? task.schedule.intervalMinutes : 30,
      dailyTime: dayjs(task.schedule.kind === 'daily' ? task.schedule.time : '09:00', 'HH:mm'),
      onceAt: dayjs(task.schedule.kind === 'once' ? task.schedule.at : Date.now() + 3_600_000),
      deliveryPref: task.deliveryPref,
      outputDir: task.outputDir ?? undefined,
      outputOrganization: task.outputOrganization ?? getDefaultAutomationOutputOrganization(task.schedule),
      workDirs: roots,
      modelId: task.modelId,
      modelServiceId: task.modelServiceId,
      modelOverride: task.modelOverride,
      modelPair: task.modelId && task.modelServiceId ? `${task.modelId}::${task.modelServiceId}` : undefined,
      reasoningEffort: task.reasoningEffort ?? 'off',
      ...savedDraft?.values
    })
    setPreflightReport(null)
    setAuthorizationReview(null)
    setAuthorizeAllPermissions(false)
    setWriteError(null)
    setEditorOpen(true)
  }

  const browseOutputDir = async () => {
    try {
      const result = await window.api.butlerChooseOutputDir()
      if (!result.cancelled && result.path) {
        form.setFieldValue('outputDir', result.path)
        invalidateAuthorizationReview()
        persistActiveTaskDraft()
        void form.validateFields(['outputDir']).catch(() => undefined)
      } else if (!result.cancelled && result.error) {
        setWriteError(result.error)
      }
    } catch {
      setWriteError(t('butler.form.outputDirPickFailed'))
    }
  }

  const submit = async () => {
    if (submitting) return
    if (wizardStep === 1) {
      if (!authorizationReview) return
      // 点击“同意全部权限并继续”是对整张权限清单的明示授权；最终保存时才提交授权票据。
      setAuthorizeAllPermissions(true)
      setWriteError(null)
      setWizardStep(2)
      return
    }
    if (wizardStep === 0 && authorizationReview) {
      setWizardStep(1)
      return
    }
    if (wizardStep === 2 && !authorizationReview) return
    if (wizardStep === 2 && !authorizeAllPermissions) return
    const draftKey = activeTaskDraftKey.current ?? taskDraftStorageKey(editing?.id ?? null)
    activeTaskDraftKey.current = draftKey
    if (wizardStep === 0) {
      // 点击预检的同步阶段先保存草稿，即使表单校验或后续模型调用失败也不丢用户输入。
      persistTaskDraft(draftKey, form.getFieldsValue(true), authorizedDirs, outputOrganizationTouched.current)
    }
    // 第三步只确认已经审核的权限票据，不再重跑表单校验或预检。
    const values = wizardStep === 2
      ? form.getFieldsValue(true)
      // 校验失败：antd 已在表单项上展示错误，reject 就地吸收，不产生 unhandled rejection
      : await form.validateFields().catch((error: { errorFields?: Array<{ name?: unknown }> }) => {
        const firstInvalidField = error.errorFields?.[0]?.name
        if (Array.isArray(firstInvalidField)) {
          const advancedSettingsInvalid = error.errorFields?.some((field) => {
            const fieldName = Array.isArray(field.name) ? field.name[0] : undefined
            return fieldName === 'modelPair' || fieldName === 'reasoningEffort' || fieldName === 'outputOrganization'
          })
          if (advancedSettingsInvalid) setAdvancedSettingsExpanded(true)
          const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
          const scrollToInvalidField = () => form.scrollToField(firstInvalidField as (string | number)[], {
            block: 'center',
            behavior: reduceMotion ? 'auto' : 'smooth',
            focus: true
          })
          if (advancedSettingsInvalid) window.setTimeout(scrollToInvalidField, 0)
          else scrollToInvalidField()
        }
        return null
      })
    if (!values) return
    const requestDraftRevision = authorizationReview ? undefined : authorizationDraftRevision.current
    setSubmitting(true)
    setWriteError(null)
    try {
      const schedule =
        values.scheduleKind === 'daily'
          ? { kind: 'daily' as const, time: (values.dailyTime as dayjs.Dayjs).format('HH:mm') }
          : values.scheduleKind === 'once'
            ? { kind: 'once' as const, at: (values.onceAt as dayjs.Dayjs).valueOf() }
            : { kind: 'interval' as const, intervalMinutes: Number(values.intervalMinutes) }
      const chosen = modelCandidates.find((candidate) => candidate.modelId === values.modelId && candidate.serviceId === values.modelServiceId)
      // 评审 P1-2：主进程校验失败返回 {ok:false}（resolve 而非 reject）——不检查会假成功。
      // 失败时保留弹窗与已填内容，展示主进程给出的原因。
      const res = authorizationReview
        ? await window.api.butlerConfirmTaskAuthorization({ reviewId: authorizationReview.reviewId })
        : editing
        ? await window.api.butlerUpdateTask({
            id: editing.id,
            patch: {
              expectedTaskRevision: editing.taskRevision ?? 0,
              name: values.name, prompt: values.prompt, schedule, deliveryPref: values.deliveryPref,
              authorizedDirs,
              workDirs: authorizedDirs,
              outputDir: values.outputDir,
              outputOrganization: values.outputOrganization,
              ...(chosen ? {
                modelId: chosen.modelId, modelServiceId: chosen.serviceId,
                modelOverride: chosen.providerModelName, reasoningEffort: values.reasoningEffort
              } : {})
            }
          })
        : await window.api.butlerCreateTask({
            name: values.name,
            prompt: values.prompt,
            schedule,
            deliveryPref: values.deliveryPref,
            authorizedDirs,
            workDirs: authorizedDirs,
            outputDir: values.outputDir,
            outputOrganization: values.outputOrganization,
            // Permission review commits a paused task. The final activation choice is applied
            // afterward through the independent task-state update path.
            enabled: false,
            modelId: values.modelId,
            modelServiceId: values.modelServiceId,
            modelOverride: chosen?.providerModelName,
            reasoningEffort: values.reasoningEffort
          })
      if (requestDraftRevision !== undefined && requestDraftRevision !== authorizationDraftRevision.current) {
        setAuthorizationReview(null)
        setAuthorizeAllPermissions(false)
        setPreflightReport(null)
        setWriteError(t('butler.form.preflightDraftChanged'))
        setWizardStep(1)
        return
      }
      if (!res.ok) {
        if (res.kind === 'authorization-review-required') {
          setPreflightReport(res.report)
          setAuthorizationReview({ reviewId: res.reviewId, permissions: res.permissions, ...(res.report.preflightCoverage ? { preflightCoverage: res.report.preflightCoverage } : {}) })
          setAuthorizeAllPermissions(false)
          setWriteError(null)
          setWizardStep(1)
          return
        }
        if (res.kind === 'preflight-blocked') {
          setPreflightReport(res.report)
          setAuthorizationReview(null)
          setAuthorizeAllPermissions(false)
          setWriteError(null)
          setWizardStep(1)
        } else {
          setAuthorizationReview(null)
          setAuthorizeAllPermissions(false)
          const errorMessage = res.kind === 'preflight-unavailable'
            ? t(getPreflightIssueMessageKey(res.error) as Parameters<TaskActions['t']>[0])
            : res.error
          setWriteError(errorMessage)
          setWizardStep(1)
          message.error(t('butler.form.saveFailedWithError', { error: errorMessage }))
        }
        return
      }
      const taskId = res.id
      const committedEnabled = res.task?.enabled ?? editing?.enabled ?? false
      let activationUpdateFailed = false
      if (committedEnabled !== enableOnSave) {
        try {
          const statusResult = await window.api.butlerUpdateTask({
            id: taskId,
            patch: {
              enabled: enableOnSave,
              ...(res.task?.taskRevision !== undefined ? { expectedTaskRevision: res.task.taskRevision } : {})
            }
          })
          activationUpdateFailed = !statusResult.ok
        } catch {
          activationUpdateFailed = true
        }
      }
      setPreflightReport(null)
      setAuthorizationReview(null)
      setAuthorizeAllPermissions(false)
      setWizardStep(0)
      setEnableOnSave(false)
      clearTaskDraft(draftKey)
      activeTaskDraftKey.current = null
      if (activationUpdateFailed) message.warning(t('butler.form.savedButActivationFailed'))
      else message.success(editing ? t('butler.updated') : t('butler.created'))
      setEditorOpen(false)
      await refresh()
    } catch {
      message.error(t('butler.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  const toggleEnabled = async (task: AutomationTask, enabled: boolean) => {
    try {
      const result = await window.api.butlerUpdateTask({ id: task.id, patch: { enabled, expectedTaskRevision: task.taskRevision ?? 0 } })
      if (!result.ok) {
        if (result.kind === 'authorization-review-required') {
          await openEdit(task)
          setPreflightReport(result.report)
          setAuthorizationReview({ reviewId: result.reviewId, permissions: result.permissions, ...(result.report.preflightCoverage ? { preflightCoverage: result.report.preflightCoverage } : {}) })
          setAuthorizeAllPermissions(false)
          setEnableOnSave(enabled)
          setWizardStep(1)
          return
        }
        if (result.kind === 'preflight-blocked') {
          await openEdit(task)
          setPreflightReport(result.report)
          setEnableOnSave(enabled)
          setWizardStep(1)
          return
        }
        message.error(t('butler.form.saveFailedWithError', { error: result.error }))
        return
      }
      await refresh()
    } catch {
      message.error(t('butler.saveFailed'))
    }
  }

  const remove = async (task: AutomationTask) => {
    try {
      await window.api.butlerDeleteTask({ id: task.id })
      clearTaskDraft(taskDraftStorageKey(task.id))
      message.success(t('butler.deleted'))
      await refresh()
    } catch {
      message.error(t('butler.loadFailed'))
    }
  }

  const runNow = async (task: AutomationTask) => {
    setRunningIds((prev) => new Set(prev).add(task.id))
    try {
      const result = await window.api.butlerRunTask({ taskId: task.id })
      if (result.ok) message.success(t('butler.runSuccess', { summary: result.summary ?? '' }))
      else message.error(t('butler.runFailed', { error: result.error ?? '' }))
    } catch {
      message.error(t('butler.runFailed', { error: '' }))
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    }
  }

  const showHistory = async (task: AutomationTask) => {
    setHistoryTask(task)
    try { setHistoryRuns(await window.api.butlerListTaskRuns({ taskId: task.id })) }
    catch { message.error(t('butler.loadFailed')) }
  }

  const actions: TaskActions = {
    t,
    onRun: (task) => void runNow(task),
    onEdit: openEdit,
    onDelete: (task) => void remove(task),
    onToggle: (task, enabled) => void toggleEnabled(task, enabled),
    onHistory: (task) => void showHistory(task),
    running: false
  }

  const renderPreflightIssues = (report: PreflightReport, insidePermissionReview = false) => report.blockers.map((item, index) => {
    const hasTargetIssue = ['TARGET_UNCLEAR', 'TARGET_AMBIGUOUS', 'TARGET_NOT_FOUND', 'TARGET_OUTSIDE_ROOTS'].includes(item.code)
    const outputRootAuthorizationIssue = item.code === 'TOOL_PERMISSION_REQUIRED' && item.reasonCode === 'output_root_not_read_authorized'
    const candidates = item.candidates ?? []
    return (
      <div key={`${item.code}-${index}`} className="butler-preflight-report__issue">
        <Typography.Text className="butler-preflight-report__blocker">{t((outputRootAuthorizationIssue ? getPreflightClarificationReasonMessageKey(item.reasonCode!) : getPreflightIssueMessageKey(item.code)) as Parameters<TaskActions['t']>[0], outputRootAuthorizationIssue ? undefined : item.messageParams)}</Typography.Text>
        {item.reasonCode && !outputRootAuthorizationIssue && item.code !== 'TOOL_PERMISSION_DETAILS_MISSING' ? <Typography.Text type="secondary">{t(getPreflightClarificationReasonMessageKey(item.reasonCode) as Parameters<TaskActions['t']>[0])}</Typography.Text> : null}
        {item.reference && !(insidePermissionReview && outputRootAuthorizationIssue) ? <Typography.Text type="secondary">{t('butler.form.preflightReference', { reference: item.reference })}</Typography.Text> : null}
        {candidates.length && !(insidePermissionReview && outputRootAuthorizationIssue) ? (
          <div className="butler-preflight-report__issue-candidates">
            <Typography.Text strong>{t('butler.form.preflightCandidates')}</Typography.Text>
            <ul>
              {candidates.map((candidate) => <li key={candidate}><Typography.Text code>{candidate}</Typography.Text></li>)}
            </ul>
            {typeof item.candidateCount === 'number' && item.candidateCount > candidates.length ? <Typography.Text type="secondary">{t('butler.form.preflightCandidateOverflow', { total: item.candidateCount, shown: candidates.length })}</Typography.Text> : null}
          </div>
        ) : null}
        {hasTargetIssue ? <Typography.Text type="secondary">{t('butler.form.preflightClarifyHint')}</Typography.Text> : null}
      </div>
    )
  })

  const wizardValues = form.getFieldsValue(true) as {
    name?: string
    scheduleKind?: AutomationTaskSchedule['kind']
    dailyTime?: dayjs.Dayjs
    onceAt?: dayjs.Dayjs
    intervalMinutes?: number
    outputDir?: string
    outputOrganization?: AutomationOutputOrganization
  }
  const finalActionKey = enableOnSave
    ? editing?.enabled ? 'butler.form.wizardSaveChanges' : 'butler.form.wizardSaveAndEnable'
    : 'butler.form.wizardSaveKeepDisabled'
  const summaryScheduleKind = wizardValues.scheduleKind ?? 'interval'
  const summarySchedule = summaryScheduleKind === 'daily'
    ? t('butler.schedule.daily', { time: wizardValues.dailyTime?.format('HH:mm') ?? '' })
    : summaryScheduleKind === 'once'
      ? t('butler.schedule.once', { time: wizardValues.onceAt?.format('YYYY-MM-DD HH:mm') ?? '' })
      : t('butler.schedule.interval', { minutes: wizardValues.intervalMinutes ?? 0 })

  return (
    <div className="butler-settings-tab">
      {!trayEnabled ? <Alert type="warning" role="alert" showIcon message={t('butler.trayHint')} className="config-alert-block--loose" /> : null}
      <div className="butler-settings-tab__header">
        <div className="butler-settings-tab__heading">
          <h2 className="butler-settings-tab__title">{t('butler.tabTitle')}</h2>
          <p className="butler-settings-tab__intro">{t('butler.tabIntro')}</p>
        </div>
        <Button type="dashed" icon={<Plus size={14} aria-hidden />} onClick={() => void openCreate()}>
          {t('butler.create')}
        </Button>
      </div>
      {tasks.length === 0 ? (
        <div className="butler-settings-empty">
          <Button type="primary" size="large" icon={<Plus size={16} aria-hidden />} onClick={() => void openCreate()}>
            {t('butler.create')}
          </Button>
        </div>
      ) : (
        <div className="butler-task-list" role="list">
          {tasks.map((task) => (
            <ButlerTaskCard key={task.id} task={task} actions={{ ...actions, running: runningIds.has(task.id) }} />
          ))}
        </div>
      )}
      <Modal
        className="butler-editor-modal"
        style={{ top: 32 }}
        width="min(920px, calc(100vw - 32px))"
        title={editing ? t('butler.form.editTitle') : t('butler.form.createTitle')}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setEditorOpen(false)}>
            {t('butler.form.cancel')}
          </Button>,
          wizardStep > 0 ? (
            <Button key="back" onClick={() => { setWriteError(null); setWizardStep(wizardStep === 2 ? 1 : 0) }}>
              {wizardStep === 2 ? t('butler.form.wizardBackToPermissions') : t('butler.form.wizardBackToTask')}
            </Button>
          ) : null,
          wizardStep === 0 ? (
            <Button key="preflight" type="primary" loading={submitting} onClick={() => void submit()}>
              {authorizationReview ? t('butler.form.wizardReturnToPermissions') : t('butler.form.permissionReviewStart')}
            </Button>
          ) : wizardStep === 1 ? (
            authorizationReview ? (
              <Button key="next" type="primary" onClick={() => void submit()}>
                {t('butler.form.wizardNextToSave')}
              </Button>
            ) : null
          ) : (
            <Button key="save" type="primary" loading={submitting} disabled={!authorizationReview || !authorizeAllPermissions} onClick={() => void submit()}>
              {t(finalActionKey)}
            </Button>
          )
        ]}
      >
        <Form
          form={form}
          layout="vertical"
          className="butler-task-editor"
          onValuesChange={(changedValues) => {
            if (Object.prototype.hasOwnProperty.call(changedValues, 'outputOrganization')) outputOrganizationTouched.current = true
            invalidateAuthorizationReview()
            persistActiveTaskDraft()
          }}
        >
          {wizardStep === 0 && editing && !outputDir ? <Alert className="butler-task-editor__wide" type="info" showIcon message={t('butler.form.outputDirLegacy')} /> : null}
          <Steps
            className="butler-task-editor__steps"
            size="small"
            current={wizardStep}
            items={[
              { title: t('butler.form.wizardStepTask') },
              { title: t('butler.form.wizardStepPermissions') },
              { title: t('butler.form.wizardStepFinal') }
            ]}
          />
          {wizardStep === 1 && authorizationReview ? (
            <div ref={authorizationReviewRef} className="butler-task-editor__result-focus" role="region" aria-label={t('butler.form.permissionReviewTitle')} tabIndex={-1}>
              <div className="butler-permission-review" aria-labelledby="butler-permission-review-title">
                <Typography.Title id="butler-permission-review-title" className="butler-permission-review__title" level={4}>
                  {t('butler.form.permissionReviewTitle')}
                </Typography.Title>
                {preflightReport && preflightReport.status !== 'passed' ? (
                  <div className="butler-permission-review__preflight-context">
                    <Typography.Text strong>{t('butler.form.permissionReviewPreflightTitle')}</Typography.Text>
                    <div className="butler-preflight-report__content">{renderPreflightIssues(preflightReport, true)}</div>
                  </div>
                ) : null}
                <PermissionReviewTable permissions={authorizationReview.permissions} t={t} />
                <Typography.Paragraph>{t('butler.form.permissionReviewIntro')}</Typography.Paragraph>
                {authorizationReview.preflightCoverage === 'partial' ? <Typography.Paragraph type="secondary">{t('butler.form.permissionReviewPartialCoverage')}</Typography.Paragraph> : null}
              </div>
            </div>
          ) : null}
          {wizardStep === 1 && preflightReport && preflightReport.status !== 'passed' && !authorizationReview ? (
            <section ref={preflightReportRef} className="butler-task-editor__result-focus butler-preflight-result" role="region" aria-labelledby="butler-preflight-result-title" tabIndex={-1}>
              <Typography.Title id="butler-preflight-result-title" className="butler-preflight-result__title" level={4}>
                {t('butler.form.preflightTitle')}
              </Typography.Title>
              <div className="butler-preflight-report__content">
                {renderPreflightIssues(preflightReport)}
                {preflightReport.permissionNeeds?.length ? (
                  <div className="butler-preflight-report__permissions">
                    <Typography.Text strong>{t('butler.form.preflightPermissionNeedsTitle')}</Typography.Text>
                    <PermissionReviewTable permissions={preflightReport.permissionNeeds} t={t} />
                    <Typography.Text type="secondary">{t('butler.form.preflightPermissionNeedsNote')}</Typography.Text>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
          {wizardStep === 1 && writeError ? <div ref={writeErrorRef} className="butler-task-editor__result-focus" role="region" aria-label={t('butler.form.saveFailedWithError', { error: writeError })} tabIndex={-1}><Alert className="butler-preflight-report" type="error" showIcon message={t('butler.form.saveFailedWithError', { error: writeError })} /></div> : null}
          {wizardStep === 0 ? <div className="butler-task-editor__grid">
            <section className="butler-task-editor__section" aria-labelledby="butler-task-section-content">
              <Typography.Title id="butler-task-section-content" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionTask')}</Typography.Title>
              <div className="butler-task-editor__section-grid">
                <Form.Item name="name" label={t('butler.form.name')} rules={[{ required: true, message: t('butler.form.nameRequired') }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="prompt" className="butler-task-editor__wide" label={t('butler.form.prompt')} rules={[{ required: true, message: t('butler.form.promptRequired') }]}>
                  <Input.TextArea rows={4} />
                </Form.Item>
              </div>
            </section>

            <section className="butler-task-editor__section butler-task-editor__section--execution" aria-labelledby="butler-task-section-execution">
              <Typography.Title id="butler-task-section-execution" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionExecution')}</Typography.Title>
              <div className="butler-task-editor__section-grid">
                <Form.Item name="scheduleKind" label={t('butler.form.scheduleKind')}>
                  <Select
                    options={[
                      { value: 'interval', label: t('butler.form.interval') },
                      { value: 'daily', label: t('butler.form.daily') },
                      { value: 'once', label: t('butler.form.once') }
                    ]}
                  />
                </Form.Item>
                {scheduleKind === 'daily' ? (
                  <Form.Item name="dailyTime" label={t('butler.form.time')} rules={[{ required: true }]}>
                    <TimePicker format="HH:mm" />
                  </Form.Item>
                ) : scheduleKind === 'once' ? (
                  <Form.Item
                    name="onceAt"
                    label={t('butler.form.onceAt')}
                    rules={[
                      { required: true, message: t('butler.form.onceAtRequired') },
                      // 提交兜底：面板禁用挡不住手动键入的过去时间（约束详见 onceAtConstraints.ts）
                      {
                        validator: (_rule, value: dayjs.Dayjs | undefined) =>
                          onceAtInFuture(value) ? Promise.resolve() : Promise.reject(new Error(t('butler.form.onceAtPast')))
                      }
                    ]}
                    extra={t('butler.form.onceHint')}
                  >
                    <DatePicker showTime format="YYYY-MM-DD HH:mm" {...onceConstraints} />
                  </Form.Item>
                ) : (
                  <Form.Item name="intervalMinutes" label={t('butler.form.intervalMinutes')} rules={[{ required: true }]}>
                    <InputNumber min={5} max={10080} style={{ width: '100%' }} />
                  </Form.Item>
                )}
              </div>
            </section>

            <section className="butler-task-editor__section" aria-labelledby="butler-task-section-output">
              <Typography.Title id="butler-task-section-output" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionOutput')}</Typography.Title>
              <div className="butler-task-editor__section-grid">
                <Form.Item
                  name="outputDir"
                  className="butler-task-editor__wide"
                  label={t('butler.form.outputDir')}
                  rules={[{ required: true, message: t('butler.form.outputDirRequired') }]}
                  extra={t('butler.form.outputDirectoryHint')}
                >
                  <Input
                    className="butler-output-dir-picker"
                    readOnly
                    title={outputDir}
                    placeholder={t('butler.form.outputDirPlaceholder')}
                    suffix={<Button type="link" onClick={() => void browseOutputDir()}>{t('butler.form.chooseOutputDir')}</Button>}
                  />
                </Form.Item>
              </div>
            </section>

            <Collapse
              className="butler-task-editor__advanced butler-task-editor__wide"
              bordered={false}
              activeKey={advancedSettingsExpanded ? ['advanced-settings'] : []}
              onChange={(keys) => setAdvancedSettingsExpanded(Array.isArray(keys) ? keys.includes('advanced-settings') : keys === 'advanced-settings')}
              items={[{
                key: 'advanced-settings',
                label: (
                  <span className="butler-task-editor__advanced-label">
                    <span>{t('butler.form.advancedSettings')}</span>
                    <Typography.Text type="secondary">{t('butler.form.advancedSettingsSummary', {
                      model: selectedCandidate ? `${selectedCandidate.providerModelName} · ${selectedCandidate.serviceName}` : t('butler.form.modelRequired'),
                      delivery: deliveryText(deliveryPref ?? 'desktop', t),
                      archive: outputOrganizationText(outputOrganization ?? null, t)
                    })}</Typography.Text>
                  </span>
                ),
                forceRender: true,
                children: (
                  <>
                    <section className="butler-task-editor__section" aria-labelledby="butler-task-section-model">
                      <Typography.Title id="butler-task-section-model" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionModelService')}</Typography.Title>
                      <div className="butler-task-editor__section-grid">
                        <Form.Item name="modelPair" label={t('butler.form.model')} rules={!editing ? [{ required: true, message: t('butler.form.modelRequired') }] : []}>
                          <Select options={modelCandidates.map((candidate) => ({ value: `${candidate.modelId}::${candidate.serviceId}`, label: `${candidate.providerModelName} · ${candidate.serviceName}` }))} onChange={(pair: string) => { const candidate = modelCandidates.find((item) => `${item.modelId}::${item.serviceId}` === pair); if (candidate) { form.setFieldsValue({ modelId: candidate.modelId, modelServiceId: candidate.serviceId, modelOverride: candidate.providerModelName }); if (!candidate.supportsThinking) form.setFieldValue('reasoningEffort', 'off') } }} />
                        </Form.Item>
                        <Form.Item name="reasoningEffort" label={t('butler.form.reasoningEffort')} extra={selectedCandidate?.supportsThinking === false ? t('butler.form.reasoningUnsupported') : undefined}>
                          <Select disabled={selectedCandidate?.supportsThinking === false} options={(['off', 'low', 'medium', 'high', 'max'] as const).map((effort) => ({ value: effort, label: t(`butler.form.reasoning${effort[0]!.toUpperCase()}${effort.slice(1)}` as 'butler.form.reasoningOff') }))} />
                        </Form.Item>
                        <Form.Item name="modelServiceId" hidden><Input /></Form.Item>
                        <Form.Item name="modelId" hidden><Input /></Form.Item>
                      </div>
                    </section>
                    <section className="butler-task-editor__section" aria-labelledby="butler-task-section-delivery">
                      <Typography.Title id="butler-task-section-delivery" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionDelivery')}</Typography.Title>
                      <div className="butler-task-editor__section-grid">
                        <Form.Item name="deliveryPref" label={t('butler.form.deliveryPref')}>
                          <Select
                            options={[
                              { value: 'desktop', label: t('butler.delivery.desktop') },
                              { value: 'feishu', label: t('butler.delivery.feishu') },
                              { value: 'wechat', label: t('butler.delivery.wechat') },
                              { value: 'none', label: t('butler.delivery.none') }
                            ]}
                          />
                        </Form.Item>
                      </div>
                    </section>
                    <section className="butler-task-editor__section" aria-labelledby="butler-task-section-archive">
                      <Typography.Title id="butler-task-section-archive" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionArchive')}</Typography.Title>
                      <div className="butler-task-editor__section-grid">
                        <Form.Item
                          name="outputOrganization"
                          label={t('butler.form.outputOrganization')}
                          rules={[{ required: true, message: t('butler.form.outputOrganizationRequired') }]}
                        >
                          <Select
                            options={[
                              { value: 'direct', label: t('butler.form.outputOrganizationDirect') },
                              { value: 'daily', label: t('butler.form.outputOrganizationDaily') },
                              { value: 'hourly', label: t('butler.form.outputOrganizationHourly') }
                            ]}
                          />
                        </Form.Item>
                      </div>
                    </section>
                  </>
                )
              }]}
            />

          </div> : null}
          {wizardStep === 2 && authorizationReview ? (
            <section className="butler-task-editor__final-review" aria-labelledby="butler-task-final-review-title">
              <Typography.Title id="butler-task-final-review-title" level={4}>{t('butler.form.wizardFinalTitle')}</Typography.Title>
              <Typography.Paragraph type="secondary">{t('butler.form.wizardFinalIntro')}</Typography.Paragraph>
              <dl className="butler-task-editor__summary-list">
                <div>
                  <dt>{t('butler.form.name')}</dt>
                  <dd>{wizardValues.name}</dd>
                </div>
                <div>
                  <dt>{t('butler.form.scheduleKind')}</dt>
                  <dd>{summarySchedule}</dd>
                </div>
                <div>
                  <dt>{t('butler.form.outputDir')}</dt>
                  <dd><Typography.Text code>{wizardValues.outputDir}</Typography.Text><Typography.Text type="secondary"> · {outputOrganizationText(wizardValues.outputOrganization ?? null, t)}</Typography.Text></dd>
                </div>
                <div>
                  <dt>{t('butler.form.permissionReviewTitle')}</dt>
                  <dd>{t('butler.form.permissionCount', { count: authorizationReview.permissions.length })}</dd>
                </div>
              </dl>
              <div className="butler-task-editor__activation-choice">
                <div className="butler-task-editor__activation-copy">
                  <Typography.Text id="butler-task-enable-label" strong>{t('butler.form.wizardEnableLabel')}</Typography.Text>
                  <Typography.Text id="butler-task-enable-hint" type="secondary">{t('butler.form.wizardEnableHint')}</Typography.Text>
                </div>
                <Switch
                  checked={enableOnSave}
                  onChange={setEnableOnSave}
                  aria-labelledby="butler-task-enable-label"
                  aria-describedby="butler-task-enable-hint"
                />
              </div>
            </section>
          ) : null}
        </Form>
      </Modal>
      <Modal title={t('butler.historyTitle')} open={Boolean(historyTask)} onCancel={() => setHistoryTask(null)} footer={null}>
        {historyRuns.length === 0 ? <Typography.Text type="secondary">{t('butler.historyEmpty')}</Typography.Text> : historyRuns.map((run) => (
          <div key={run.id} className={`butler-history-run butler-history-run--${run.status}`}>
            <Typography.Text>{dayjs(run.createdAt).format('YYYY-MM-DD HH:mm:ss')} · {runStatusText(run.status, t)}</Typography.Text>
            {run.configSnapshot ? <div>
              <Typography.Text strong>{t('butler.runConfig')}</Typography.Text>
              <Typography.Paragraph copyable={{ text: run.configSnapshot.workDir ?? '' }} style={{ marginBottom: 4 }}>{run.configSnapshot.workDir}</Typography.Paragraph>
              <Typography.Text>{run.configSnapshot.providerModelName} · {run.configSnapshot.serviceId} · {run.configSnapshot.requestedEffort} → {run.configSnapshot.effectiveEffort}</Typography.Text>
            </div> : <Typography.Text type="secondary">{t('butler.legacyNoSnapshot')}</Typography.Text>}
            {run.error ? <Typography.Paragraph type={run.status === 'skipped' ? 'secondary' : 'danger'}><Typography.Text strong>{run.status === 'skipped' ? t('butler.form.runReason') : t('butler.runError')}</Typography.Text> {run.status === 'skipped' && run.error === 'missed-window' ? t('butler.runReasonMissedWindow') : run.error}</Typography.Paragraph> : null}
          </div>
        ))}
      </Modal>
    </div>
  )
}
