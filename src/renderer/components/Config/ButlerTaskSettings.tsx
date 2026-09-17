import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Select, Switch, Tag, TimePicker } from 'antd'
import { Pencil, Plus, SquarePlay, Trash2 } from 'lucide-react'
import type { AutomationTask, AutomationDeliveryPref } from '../../../shared/automationTaskTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import dayjs from 'dayjs'
import { buildOnceDisabledConstraints, onceAtInFuture } from './onceAtConstraints'

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
  running: boolean
}

function scheduleTagText(task: AutomationTask, t: TaskActions['t']): string {
  if (task.schedule.kind === 'interval') return t('butler.schedule.interval', { minutes: task.schedule.intervalMinutes })
  if (task.schedule.kind === 'daily') return t('butler.schedule.daily', { time: task.schedule.time })
  return t('butler.schedule.once', { time: dayjs(task.schedule.at).format('YYYY-MM-DD HH:mm') })
}

function deliveryText(pref: AutomationDeliveryPref, t: TaskActions['t']): string {
  return t(`butler.delivery.${pref}` as 'butler.delivery.desktop')
}

function ButlerTaskCard({ task, actions }: { task: AutomationTask; actions: TaskActions }) {
  const { t, onRun, onEdit, onDelete, onToggle, running } = actions
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
        <SquarePlay size={13} aria-hidden className="butler-task-card__summary-icon" />
        <span className="butler-task-card__summary-text" title={task.prompt}>
          {task.prompt}
        </span>
        {task.lastRunAt ? (
          <span className="butler-task-card__summary-meta">
            {t('butler.lastRun', { time: dayjs(task.lastRunAt).format('YYYY-MM-DD HH:mm') })}
          </span>
        ) : null}
      </div>
      <div className="butler-task-card__footer">
        <Button size="small" type="primary" loading={running} disabled={!task.enabled} onClick={() => onRun(task)}>
          {t('butler.run')}
        </Button>
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
  const [form] = Form.useForm()
  const scheduleKind = Form.useWatch('scheduleKind', form)
  const onceConstraints = buildOnceDisabledConstraints()

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

  const openCreate = () => {
    setEditing(null)
    form.setFieldsValue({
      name: '',
      prompt: '',
      scheduleKind: 'interval',
      intervalMinutes: 30,
      dailyTime: dayjs('09:00', 'HH:mm'),
      onceAt: dayjs().add(1, 'hour'),
      deliveryPref: 'desktop'
    })
    setEditorOpen(true)
  }

  const openEdit = (task: AutomationTask) => {
    setEditing(task)
    form.setFieldsValue({
      name: task.name,
      prompt: task.prompt,
      scheduleKind: task.schedule.kind,
      intervalMinutes: task.schedule.kind === 'interval' ? task.schedule.intervalMinutes : 30,
      dailyTime: dayjs(task.schedule.kind === 'daily' ? task.schedule.time : '09:00', 'HH:mm'),
      onceAt: dayjs(task.schedule.kind === 'once' ? task.schedule.at : Date.now() + 3_600_000),
      deliveryPref: task.deliveryPref
    })
    setEditorOpen(true)
  }

  const submit = async () => {
    // 校验失败：antd 已在表单项上展示错误，reject 就地吸收，不产生 unhandled rejection
    const values = await form.validateFields().catch(() => null)
    if (!values) return
    setSubmitting(true)
    try {
      const schedule =
        values.scheduleKind === 'daily'
          ? { kind: 'daily' as const, time: (values.dailyTime as dayjs.Dayjs).format('HH:mm') }
          : values.scheduleKind === 'once'
            ? { kind: 'once' as const, at: (values.onceAt as dayjs.Dayjs).valueOf() }
            : { kind: 'interval' as const, intervalMinutes: Number(values.intervalMinutes) }
      if (editing) {
        await window.api.butlerUpdateTask({
          id: editing.id,
          patch: { name: values.name, prompt: values.prompt, schedule, deliveryPref: values.deliveryPref }
        })
        message.success(t('butler.updated'))
      } else {
        await window.api.butlerCreateTask({
          name: values.name,
          prompt: values.prompt,
          schedule,
          deliveryPref: values.deliveryPref
        })
        message.success(t('butler.created'))
      }
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
      await window.api.butlerUpdateTask({ id: task.id, patch: { enabled } })
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

  const actions: TaskActions = {
    t,
    onRun: (task) => void runNow(task),
    onEdit: openEdit,
    onDelete: (task) => void remove(task),
    onToggle: (task, enabled) => void toggleEnabled(task, enabled),
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
        title={editing ? t('butler.form.editTitle') : t('butler.form.createTitle')}
        open={editorOpen}
        onCancel={() => setEditorOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setEditorOpen(false)}>
            {t('butler.form.cancel')}
          </Button>,
          <Button key="save" type="primary" loading={submitting} onClick={() => void submit()}>
            {t('butler.form.save')}
          </Button>
        ]}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('butler.form.name')} rules={[{ required: true, message: t('butler.form.nameRequired') }]}>
            <Input />
          </Form.Item>
          <Form.Item name="prompt" label={t('butler.form.prompt')} rules={[{ required: true, message: t('butler.form.promptRequired') }]}>
            <Input.TextArea rows={4} />
          </Form.Item>
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
        </Form>
      </Modal>
    </div>
  )
}
