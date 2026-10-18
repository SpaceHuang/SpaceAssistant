import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, App, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Switch, Tag, TimePicker, Space, Typography } from 'antd'
import { Pencil, Plus, SquarePlay, Trash2, X } from 'lucide-react'
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

function permissionDescription(permission: AutomationTaskPermission, t: TaskActions['t']): string {
  switch (permission.kind) {
    case 'directory-read-write': return t('butler.form.permissionDirectoryReadWrite', { path: permission.path })
    case 'result-write': return t('butler.form.permissionResultWrite', { path: permission.outputDirectory, organization: outputOrganizationText(permission.organization, t) })
    case 'local-shell': return t('butler.form.permissionLocalShell', { scope: permission.scopeRoots.length ? permission.scopeRoots.join('、') : t('butler.form.permissionNoDirectoryScope') })
    case 'deliver-result': return permission.target
      ? t('butler.form.permissionDeliverResultTo', { delivery: deliveryText(permission.delivery, t), target: permission.target })
      : t('butler.form.permissionDeliverResult', { delivery: deliveryText(permission.delivery, t) })
  }
}

function runStatusText(status: AutomationTaskRun['status'], t: TaskActions['t']): string {
  const key = {
    queued: 'butler.runStatus.queued', running: 'butler.runStatus.running', completed: 'butler.runStatus.completed',
    failed: 'butler.runStatus.failed', skipped: 'butler.runStatus.skipped', interrupted: 'butler.runStatus.interrupted'
  }[status] as 'butler.runStatus.queued'
  return t(key)
}

function AuthorizedDirList({ value = [], onChange, t }: { value: string[]; onChange: (paths: string[]) => void; t: TaskActions['t'] }) {
  const pathsRef = useRef(value)
  pathsRef.current = value
  const setPaths = (paths: string[]) => { pathsRef.current = paths; onChange(paths) }
  const browse = async () => {
    const result = await window.api.butlerChooseWorkDir()
    const current = pathsRef.current
    if (!result.cancelled && result.path && !current.includes(result.path)) {
      const next = [...current, result.path]
      setPaths(next)
    }
  }
  return (
    <div className="butler-authorized-dirs">
      {value.map((workDir) => (
        <div className="butler-authorized-dirs__row" key={workDir}>
          <Typography.Text className="butler-authorized-dirs__path" title={workDir}>{workDir}</Typography.Text>
          <Button size="small" type="text" icon={<X size={14} aria-hidden />} aria-label={t('butler.form.removeWorkDirAria', { path: workDir })} onClick={() => {
            const next = value.filter((candidate) => candidate !== workDir)
            setPaths(next)
          }} />
        </div>
      ))}
      <Space wrap>
        <Button onClick={() => void browse()}>{t('butler.form.addWorkDir')}</Button>
        <Button type="link" onClick={() => void browse()}>{t('butler.form.browseWorkDir')}</Button>
      </Space>
    </div>
  )
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
  const [authorizationReview, setAuthorizationReview] = useState<{ reviewId: string; permissions: AutomationTaskPermission[] } | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)
  const [authorizedDirs, setAuthorizedDirs] = useState<string[]>([])
  const outputOrganizationTouched = useRef(false)
  const authorizationDraftRevision = useRef(0)
  const [form] = Form.useForm()
  const scheduleKind = Form.useWatch('scheduleKind', form) as AutomationTaskSchedule['kind'] | undefined
  const outputDir = Form.useWatch('outputDir', form) as string | undefined
  const [modelCandidates, setModelCandidates] = useState<Array<{ modelId: string; providerModelName: string; serviceId: string; serviceName: string; supportsThinking: boolean }>>([])
  const selectedModelId = Form.useWatch('modelId', form)
  const selectedServiceId = Form.useWatch('modelServiceId', form)
  const selectedCandidate = modelCandidates.find((candidate) => candidate.modelId === selectedModelId && candidate.serviceId === selectedServiceId)
  const onceConstraints = buildOnceDisabledConstraints()

  const invalidateAuthorizationReview = () => {
    authorizationDraftRevision.current += 1
    setAuthorizationReview(null)
    setPreflightReport(null)
    setWriteError(null)
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
    outputOrganizationTouched.current = false
    const [defaults, candidates] = await Promise.all([window.api.butlerGetTaskDefaults(), window.api.butlerGetModelCandidates()])
    setModelCandidates(candidates)
    setAuthorizedDirs([])
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
        : defaults.reasoningEffort ?? 'off'
    })
    setPreflightReport(null)
    setAuthorizationReview(null)
    setWriteError(null)
    setEditorOpen(true)
  }

  const openEdit = (task: AutomationTask) => {
    authorizationDraftRevision.current += 1
    setEditing(task)
    outputOrganizationTouched.current = true
    const roots = task.authorizedDirs ?? task.workDirs ?? []
    setAuthorizedDirs(roots)
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
      reasoningEffort: task.reasoningEffort ?? 'off'
    })
    setPreflightReport(null)
    setAuthorizationReview(null)
    setWriteError(null)
    setEditorOpen(true)
  }

  const browseOutputDir = async () => {
    try {
      const result = await window.api.butlerChooseOutputDir()
      if (!result.cancelled && result.path) {
        form.setFieldValue('outputDir', result.path)
        invalidateAuthorizationReview()
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
    // 校验失败：antd 已在表单项上展示错误，reject 就地吸收，不产生 unhandled rejection
    const values = await form.validateFields().catch(() => null)
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
            modelId: values.modelId,
            modelServiceId: values.modelServiceId,
            modelOverride: chosen?.providerModelName,
            reasoningEffort: values.reasoningEffort
          })
      if (requestDraftRevision !== undefined && requestDraftRevision !== authorizationDraftRevision.current) {
        setAuthorizationReview(null)
        setPreflightReport(null)
        setWriteError(t('butler.form.preflightDraftChanged'))
        return
      }
      if (!res.ok) {
        if (res.kind === 'authorization-review-required') {
          setPreflightReport(res.report)
          setAuthorizationReview({ reviewId: res.reviewId, permissions: res.permissions })
          setWriteError(null)
          return
        }
        if (res.kind === 'preflight-blocked') {
          setPreflightReport(res.report)
          setAuthorizationReview(null)
          setWriteError(null)
        } else {
          setAuthorizationReview(null)
          const errorMessage = res.kind === 'preflight-unavailable'
            ? t(getPreflightIssueMessageKey(res.error) as Parameters<TaskActions['t']>[0])
            : res.error
          setWriteError(errorMessage)
          message.error(t('butler.form.saveFailedWithError', { error: errorMessage }))
        }
        return
      }
      setPreflightReport(null)
      setAuthorizationReview(null)
      message.success(editing ? t('butler.updated') : t('butler.created'))
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
          setAuthorizationReview({ reviewId: result.reviewId, permissions: result.permissions })
          return
        }
        if (result.kind === 'preflight-blocked') {
          await openEdit(task)
          setPreflightReport(result.report)
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
        width="min(920px, calc(100vw - 32px))"
        title={editing ? t('butler.form.editTitle') : t('butler.form.createTitle')}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setEditorOpen(false)}>
            {t('butler.form.cancel')}
          </Button>,
          <Button key="save" type="primary" loading={submitting} onClick={() => void submit()}>
            {authorizationReview ? t('butler.form.permissionReviewConfirm') : t('butler.form.permissionReviewStart')}
          </Button>
        ]}
      >
        <Form
          form={form}
          layout="vertical"
          className="butler-task-editor"
          onValuesChange={(changedValues) => {
            if (Object.prototype.hasOwnProperty.call(changedValues, 'outputOrganization')) outputOrganizationTouched.current = true
            invalidateAuthorizationReview()
          }}
        >
          {editing && !editing.outputDir ? <Alert className="butler-task-editor__wide" type="info" showIcon message={t('butler.form.outputDirLegacy')} /> : null}
          {authorizationReview ? (
            <Alert
              className="butler-permission-review"
              type="warning"
              showIcon
              message={t('butler.form.permissionReviewTitle')}
              description={(
                <div>
                  <Typography.Paragraph>{t('butler.form.permissionReviewIntro')}</Typography.Paragraph>
                  <ul className="butler-permission-review__list">
                    {authorizationReview.permissions.map((permission, index) => (
                      <li key={`${permission.kind}-${index}`}>{permissionDescription(permission, t)}</li>
                    ))}
                  </ul>
                </div>
              )}
            />
          ) : null}
          {preflightReport && preflightReport.status !== 'passed' ? (
            <Alert className="butler-preflight-report" type={preflightReport.status === 'blocked' ? 'warning' : 'info'} showIcon message={t('butler.form.preflightTitle')} description={(
              <div className="butler-preflight-report__content">
                {preflightReport.blockers.map((item, index) => {
                  const hasTargetIssue = ['TARGET_UNCLEAR', 'TARGET_AMBIGUOUS', 'TARGET_NOT_FOUND', 'TARGET_OUTSIDE_ROOTS'].includes(item.code)
                  const candidates = item.candidates ?? []
                  return (
                    <div key={`${item.code}-${index}`} className="butler-preflight-report__issue">
                      <Typography.Text className="butler-preflight-report__blocker">{t(getPreflightIssueMessageKey(item.code) as Parameters<TaskActions['t']>[0], item.messageParams)}</Typography.Text>
                      {item.reasonCode ? <Typography.Text type="secondary">{t(getPreflightClarificationReasonMessageKey(item.reasonCode) as Parameters<TaskActions['t']>[0])}</Typography.Text> : null}
                      {item.reference ? <Typography.Text type="secondary">{t('butler.form.preflightReference', { reference: item.reference })}</Typography.Text> : null}
                      {candidates.length ? (
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
                })}
                {preflightReport.suggestedDirectories.length ? <div className="butler-preflight-report__candidates">
                  <Typography.Text strong>{t('butler.form.suggestedDirectories')}</Typography.Text>
                  {preflightReport.suggestedDirectories.map((candidate) => (
                    <Checkbox
                      key={candidate.path}
                      checked={authorizedDirs.includes(candidate.path)}
                      disabled={candidate.validationStatus !== 'valid'}
                      aria-label={t('butler.form.suggestedDirectoryAria', { path: candidate.path, purpose: candidate.purpose })}
                      onChange={(event) => {
                        setAuthorizedDirs(event.target.checked ? [...new Set([...authorizedDirs, candidate.path])] : authorizedDirs.filter((root) => root !== candidate.path))
                        invalidateAuthorizationReview()
                      }}
                    >
                      <span className="butler-preflight-report__candidate-path">{candidate.path}</span>
                      <span className="butler-preflight-report__candidate-purpose">{candidate.purpose}</span>
                    </Checkbox>
                  ))}
                </div> : null}
              </div>
            )} />
          ) : null}
          {writeError ? <Alert className="butler-preflight-report" type="error" showIcon message={t('butler.form.saveFailedWithError', { error: writeError })} /> : null}
          <div className="butler-task-editor__grid">
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

            <section className="butler-task-editor__section" aria-labelledby="butler-task-section-execution">
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

            <section className="butler-task-editor__section" aria-labelledby="butler-task-section-access">
              <Typography.Title id="butler-task-section-access" className="butler-task-editor__section-title" level={5}>{t('butler.form.sectionAccess')}</Typography.Title>
              <div className="butler-task-editor__section-grid">
                <Form.Item className="butler-task-editor__wide" label={t('butler.form.authorizedDirs')} extra={t('butler.form.authorizedDirsHint')}>
                  <AuthorizedDirList t={t} value={authorizedDirs} onChange={(directories) => { setAuthorizedDirs(directories); invalidateAuthorizationReview() }} />
                </Form.Item>
                <Typography.Paragraph className="butler-task-editor__wide" type="secondary">
                  {t('butler.form.permissionReviewHelp')}
                </Typography.Paragraph>
              </div>
            </section>
          </div>
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
