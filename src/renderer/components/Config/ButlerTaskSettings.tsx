import { useCallback, useEffect, useState } from 'react'
import { App, Button, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Select, Switch, Tag, TimePicker, Alert } from 'antd'
import type { AutomationTask, AutomationDeliveryPref } from '../../../shared/automationTaskTypes'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import dayjs from 'dayjs'

/**
 * 设置弹窗「定时任务」Tab（P6）：任务列表、新建/编辑、启停、删除、立即运行。
 * 渲染进程只表达意图——准入、调度、会话创建、门控、投递全在主进程。
 */
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
      deliveryPref: task.deliveryPref
    })
    setEditorOpen(true)
  }

  const submit = async () => {
    const values = await form.validateFields()
    setSubmitting(true)
    try {
      const schedule =
        values.scheduleKind === 'daily'
          ? { kind: 'daily' as const, time: (values.dailyTime as dayjs.Dayjs).format('HH:mm') }
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
    await window.api.butlerUpdateTask({ id: task.id, patch: { enabled } })
    await refresh()
  }

  const remove = async (task: AutomationTask) => {
    await window.api.butlerDeleteTask({ id: task.id })
    message.success(t('butler.deleted'))
    await refresh()
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

  const scheduleText = (task: AutomationTask): string =>
    task.schedule.kind === 'interval'
      ? t('butler.schedule.interval', { minutes: task.schedule.intervalMinutes })
      : t('butler.schedule.daily', { time: task.schedule.time })

  const deliveryText = (pref: AutomationDeliveryPref): string =>
    t(`butler.delivery.${pref}` as 'butler.delivery.desktop')

  return (
    <div>
      {!trayEnabled ? <Alert type="warning" role="alert" showIcon message={t('butler.trayHint')} className="config-alert-block--loose" /> : null}
      <div className="config-butler-toolbar">
        <Button type="primary" onClick={() => void openCreate()}>
          {t('butler.create')}
        </Button>
      </div>
      <List
        dataSource={tasks}
        locale={{ emptyText: <Empty description={t('butler.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
        renderItem={(task) => (
          <List.Item
            actions={[
              <Button key="run" size="small" loading={runningIds.has(task.id)} onClick={() => void runNow(task)}>
                {t('butler.run')}
              </Button>,
              <Button key="edit" size="small" onClick={() => openEdit(task)}>
                {t('butler.edit')}
              </Button>,
              <Popconfirm key="del" title={t('butler.deleteConfirm', { name: task.name })} onConfirm={() => void remove(task)}>
                <Button size="small" danger aria-label={t('butler.deleteAria', { name: task.name })}>
                  {t('butler.delete')}
                </Button>
              </Popconfirm>
            ]}
          >
            <List.Item.Meta
              title={
                <span>
                  {task.name} <Tag>{scheduleText(task)}</Tag> <Tag>{deliveryText(task.deliveryPref)}</Tag>
                </span>
              }
              description={task.prompt}
            />
            <Switch
              aria-label={t('butler.toggleAria', { name: task.name })}
              checked={task.enabled}
              onChange={(checked) => void toggleEnabled(task, checked)}
            />
          </List.Item>
        )}
      />
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
                { value: 'daily', label: t('butler.form.daily') }
              ]}
            />
          </Form.Item>
          {scheduleKind === 'daily' ? (
            <Form.Item name="dailyTime" label={t('butler.form.time')} rules={[{ required: true }]}>
              <TimePicker format="HH:mm" />
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
