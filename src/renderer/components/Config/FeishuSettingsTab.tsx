import { useCallback, useEffect, useState } from 'react'
import { App, Badge, Button, Checkbox, Drawer, Input, InputNumber, Radio, Select, Space, Switch, Table } from 'antd'
import type { FeishuAuditEvent, FeishuConfig, FeishuEventStatus } from '../../../shared/feishuTypes'
import type { ModelEntry } from '../../../shared/domainTypes'

type Props = {
  feishu: FeishuConfig
  onChange: (next: FeishuConfig) => void
  models?: ModelEntry[]
}

export function FeishuSettingsTab({ feishu, onChange, models = [] }: Props) {
  const { message } = App.useApp()
  const [cliStatus, setCliStatus] = useState<string>('检测中…')
  const [eventStatus, setEventStatus] = useState<FeishuEventStatus | null>(null)
  const [authStatus, setAuthStatus] = useState<string>('')
  const [auditOpen, setAuditOpen] = useState(false)
  const [installingCli, setInstallingCli] = useState(false)
  const [configuringApp, setConfiguringApp] = useState(false)
  const [configStatus, setConfigStatus] = useState('')
  const [authLoggingIn, setAuthLoggingIn] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const detect = await window.api.feishuDetectCli()
      setCliStatus(
        detect.installed
          ? `已安装 ${detect.version ?? ''} ${detect.path ? `(${detect.path})` : ''}`
          : `未检测到（Node: ${detect.nodeAvailable ? '✓' : '✗'} npm: ${detect.npmAvailable ? '✓' : '✗'}）`
      )
      const auth = await window.api.feishuAuthStatus()
      setAuthStatus(
        auth.authorized ? '已授权' : auth.stderr?.trim() ? `未登录（${auth.stderr.trim().slice(-200)}）` : '未登录'
      )
      if (feishu.remoteEnabled) {
        const es = await window.api.feishuEventStatus()
        setEventStatus(es ?? null)
      }
    } catch (e) {
      setCliStatus(e instanceof Error ? e.message : String(e))
    }
  }, [feishu.remoteEnabled])

  useEffect(() => {
    if (feishu.enabled) void refreshStatus()
  }, [feishu.enabled, refreshStatus])

  useEffect(() => {
    if (!feishu.remoteEnabled) return
    const t = setInterval(() => {
      void window.api.feishuEventStatus().then(setEventStatus)
    }, 5000)
    return () => clearInterval(t)
  }, [feishu.remoteEnabled])

  const installCli = async () => {
    if (typeof window.api.feishuInstallCli !== 'function') {
      message.error('当前应用版本未包含飞书 IPC，请从 feature/feishu-integration 分支启动并重新构建主进程')
      return
    }
    setInstallingCli(true)
    setCliStatus('正在安装 @larksuite/cli（全局 npm，可能需要 1–3 分钟）…')
    try {
      const r = await window.api.feishuInstallCli()
      if (r.success) {
        message.success('lark-cli 安装成功')
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || '未知错误').trim().slice(-800)
        message.error(r.timedOut ? '安装超时，请检查网络或在终端手动运行 npm install -g @larksuite/cli' : `安装失败：${detail}`)
        setCliStatus(`安装失败${r.timedOut ? '（超时）' : ''}`)
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      message.error(`安装 CLI 失败：${err}`)
      setCliStatus(`安装失败：${err}`)
    } finally {
      setInstallingCli(false)
    }
  }

  const patch = (p: Partial<FeishuConfig>) => onChange({ ...feishu, ...p })

  const configInit = async () => {
    if (typeof window.api.feishuConfigInit !== 'function') {
      message.error('当前应用版本未包含飞书 IPC，请重新构建主进程')
      return
    }
    setConfiguringApp(true)
    setConfigStatus('正在初始化飞书应用，等待配置链接（约 10–30 秒）…')
    const unsub =
      typeof window.api.feishuOnConfigInitProgress === 'function'
        ? window.api.feishuOnConfigInitProgress(({ line }) => {
            if (/https?:\/\//.test(line)) {
              setConfigStatus('已在浏览器打开配置页，请完成扫码/登录后等待…')
            } else if (line) {
              setConfigStatus(line.slice(-120))
            }
          })
        : undefined
    try {
      const r = await window.api.feishuConfigInit()
      if (r.success) {
        message.success('飞书应用配置完成')
        patch({ appConfigured: true })
        setConfigStatus('配置完成')
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || '未知错误').trim().slice(-800)
        message.error(
          r.timedOut
            ? '配置超时：若已在浏览器完成设置，请点「重新检测」或手动开启「应用已配置」'
            : `配置失败：${detail}`
        )
        if (r.authUrl) {
          message.info('若浏览器未自动打开，请手动访问配置链接（见 CLI 输出）')
        }
        setConfigStatus(`配置失败${r.timedOut ? '（超时）' : ''}`)
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      message.error(`配置飞书应用失败：${err}`)
      setConfigStatus(`配置失败：${err}`)
    } finally {
      unsub?.()
      setConfiguringApp(false)
    }
  }

  const authLogin = async () => {
    if (typeof window.api.feishuAuthLogin !== 'function') {
      message.error('当前应用版本未包含飞书 IPC，请重新构建主进程')
      return
    }
    setAuthLoggingIn(true)
    try {
      const r = await window.api.feishuAuthLogin()
      if (r.success) {
        message.success('飞书账号登录成功')
        await refreshStatus()
      } else {
        const detail = (r.stderr || r.stdout || '未知错误').trim().slice(-800)
        message.error(r.timedOut ? '登录超时，请在浏览器完成授权后重试' : `登录失败：${detail}`)
      }
      if (r.authUrl) message.info('已在浏览器打开登录页，请完成授权')
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e))
    } finally {
      setAuthLoggingIn(false)
    }
  }

  return (
    <>
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <Space>
          <Switch checked={feishu.enabled} onChange={(enabled) => patch({ enabled })} />
          <span>启用飞书集成</span>
        </Space>

        <div>
          <div style={{ marginBottom: 8, fontWeight: 500 }}>CLI 状态</div>
          <div style={{ marginBottom: 8 }}>{cliStatus}</div>
          <Space wrap>
            <Button loading={installingCli} disabled={installingCli} onClick={() => void installCli()}>
              安装 CLI
            </Button>
            <Button onClick={refreshStatus}>重新检测</Button>
            <Input
              style={{ width: 280 }}
              placeholder="自定义 cliPath（可选）"
              value={feishu.cliPath ?? ''}
              onChange={(e) => patch({ cliPath: e.target.value || undefined })}
            />
          </Space>
        </div>

        <Space direction="vertical" size={4}>
          <Space wrap>
            <Button loading={configuringApp} disabled={configuringApp} onClick={() => void configInit()}>
              配置飞书应用
            </Button>
            <Switch checked={feishu.appConfigured} onChange={(appConfigured) => patch({ appConfigured })} />
            <span>应用已配置</span>
          </Space>
          {configStatus ? <div style={{ color: 'var(--ant-color-text-secondary)', fontSize: 12 }}>{configStatus}</div> : null}
        </Space>

        <Space>
          <Button loading={authLoggingIn} disabled={authLoggingIn} onClick={() => void authLogin()}>
            登录飞书账号
          </Button>
          <span>{authStatus}</span>
        </Space>

        <Space>
          <Switch checked={feishu.remoteEnabled} onChange={(remoteEnabled) => patch({ remoteEnabled })} />
          <span>启用远程指令监听</span>
          {eventStatus && (
            <Badge
              status={
                eventStatus.state === 'connected' ? 'success' : eventStatus.state === 'error' ? 'error' : 'processing'
              }
              text={`${eventStatus.state} · 已处理 ${eventStatus.processedCount}`}
            />
          )}
          <Button size="small" onClick={() => void window.api.feishuEventStart().then(setEventStatus)}>
            启动
          </Button>
          <Button size="small" onClick={() => void window.api.feishuEventStop().then(setEventStatus)}>
            停止
          </Button>
        </Space>

        <Checkbox checked={feishu.remoteNotifyOnReceive} onChange={(e) => patch({ remoteNotifyOnReceive: e.target.checked })}>
          收到指令时发送系统通知
        </Checkbox>

        <div>
          <div style={{ marginBottom: 4 }}>群聊触发</div>
          <Radio.Group value={feishu.remoteGroupTrigger} onChange={(e) => patch({ remoteGroupTrigger: e.target.value })}>
            <Radio value="mention">@Bot</Radio>
            <Radio value="prefix">前缀</Radio>
            <Radio value="both">两者</Radio>
          </Radio.Group>
          <Input
            style={{ marginTop: 8, width: 200 }}
            value={feishu.remoteCommandPrefix ?? '/sa '}
            onChange={(e) => patch({ remoteCommandPrefix: e.target.value })}
            placeholder="命令前缀"
          />
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>会话合并（分钟，0=每条新会话）</div>
          <InputNumber
            min={0}
            max={120}
            value={feishu.remoteSessionMergeMinutes ?? 0}
            onChange={(v) => patch({ remoteSessionMergeMinutes: v ?? 0 })}
          />
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>远程写确认策略</div>
          <Select
            style={{ width: 280 }}
            value={feishu.remoteConfirmPolicy}
            onChange={(remoteConfirmPolicy) => patch({ remoteConfirmPolicy })}
            options={[
              { value: 'remote_read_only', label: '禁止远程写' },
              { value: 'feishu_confirm', label: '飞书内 Y/N 确认' },
              { value: 'always', label: '一律确认' },
              { value: 'inherit', label: '与工具设置一致' }
            ]}
          />
        </div>

        <Checkbox checked={feishu.remoteAllowLocalWrite} onChange={(e) => patch({ remoteAllowLocalWrite: e.target.checked })}>
          允许远程指令执行本地文件写操作
        </Checkbox>

        <div>
          <div style={{ marginBottom: 4 }}>区域</div>
          <Radio.Group value={feishu.region} onChange={(e) => patch({ region: e.target.value })}>
            <Radio value="feishu">飞书国内</Radio>
            <Radio value="lark">Lark 国际</Radio>
          </Radio.Group>
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>远程默认模型</div>
          <Select
            allowClear
            style={{ width: 280 }}
            placeholder="与全局默认相同"
            value={feishu.remoteDefaultModelId}
            onChange={(remoteDefaultModelId) => patch({ remoteDefaultModelId })}
            options={models.filter((m) => m.enabled).map((m) => ({ value: m.name, label: m.name }))}
          />
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>远程 Plan 模式</div>
          <Select
            style={{ width: 200 }}
            value={feishu.remotePlanMode}
            onChange={(remotePlanMode) => patch({ remotePlanMode })}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'auto', label: '关键词自动' },
              { value: 'always', label: '总是先 Plan' }
            ]}
          />
        </div>

        <div>
          <div style={{ marginBottom: 4 }}>集成模式</div>
          <Select
            style={{ width: 200 }}
            value={feishu.integrationMode}
            onChange={(integrationMode) => patch({ integrationMode })}
            options={[
              { value: 'cli', label: 'CLI（推荐）' },
              { value: 'mcp', label: 'MCP' },
              { value: 'both', label: '并存' }
            ]}
          />
          <div style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 12 }}>
            若已配置 MCP 飞书工具，请在工具 Tab 避免重复启用冲突能力。
          </div>
        </div>

        <Button onClick={() => setAuditOpen(true)}>查看操作记录</Button>
      </Space>

      <FeishuAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}

function FeishuAuditDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<FeishuAuditEvent[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await window.api.feishuAuditQuery({ limit: 200 })
      setRows(r.entries)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) void load()
  }, [open])

  return (
    <Drawer title="飞书操作记录" width={720} open={open} onClose={onClose} extra={<Button onClick={() => void load()}>刷新</Button>}>
      <Table
        size="small"
        loading={loading}
        rowKey={(r) => `${r.type}-${r.ts}`}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        columns={[
          { title: '时间', dataIndex: 'ts', render: (ts: number) => new Date(ts).toLocaleString('zh-CN') },
          { title: '类型', dataIndex: 'type' },
          {
            title: '详情',
            render: (_: unknown, r: FeishuAuditEvent) => {
              if (r.type === 'inbound') return `${r.accepted ? '✓' : '✗'} ${r.reason ?? ''}`
              if (r.type === 'lark_cli') return `${r.success ? '✓' : '✗'} ${r.args.slice(0, 3).join(' ')}`
              if (r.type === 'confirm_request') return r.decision ?? 'pending'
              return JSON.stringify(r).slice(0, 80)
            }
          }
        ]}
      />
    </Drawer>
  )
}
