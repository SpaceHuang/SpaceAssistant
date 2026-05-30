import { useCallback, useEffect, useState } from 'react'
import { App, Badge, Button, Checkbox, Input, InputNumber, Radio, Select, Space, Switch } from 'antd'
import type { FeishuConfig, FeishuEventStatus } from '../../../shared/feishuTypes'
import { formatFeishuEventStatusText } from '../../../shared/feishuEventLabels'
import { FeishuAuditDrawer } from './FeishuAuditDrawer'
import type { ModelEntry } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'
import { CONFIG_MODAL_SELECT_POPUP } from './configModalUi'

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

  const patch = useCallback((p: Partial<FeishuConfig>) => onChange({ ...feishu, ...p }), [feishu, onChange])

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
      if (auth.authorized !== feishu.userAuthorized) {
        patch({ userAuthorized: auth.authorized })
      }
      if (feishu.remoteEnabled) {
        const es = await window.api.feishuEventStatus()
        setEventStatus(es ?? null)
      }
    } catch (e) {
      setCliStatus(e instanceof Error ? e.message : String(e))
    }
  }, [feishu.remoteEnabled, feishu.userAuthorized, patch])

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
        patch({ userAuthorized: true })
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
      <ConfigSettingsStack>
        <ConfigSwitchRow
          label="启用飞书集成"
          checked={feishu.enabled}
          onChange={(enabled) => patch({ enabled })}
        />

        <div className="config-field">
          <div className="config-field__label">CLI 状态</div>
          <div className="config-status-text">{cliStatus}</div>
          <Space wrap className="config-field__control">
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

        <div className="config-field">
          <Space wrap>
            <Button loading={configuringApp} disabled={configuringApp} onClick={() => void configInit()}>
              配置飞书应用
            </Button>
            <Switch checked={feishu.appConfigured} onChange={(appConfigured) => patch({ appConfigured })} />
            <span className="config-inline-label">应用已配置</span>
          </Space>
          {configStatus ? <div className="config-status-text">{configStatus}</div> : null}
        </div>

        <Space wrap>
          <Button loading={authLoggingIn} disabled={authLoggingIn} onClick={() => void authLogin()}>
            登录飞书账号
          </Button>
          <span className="config-status-text">{authStatus}</span>
        </Space>

        <Space wrap align="center">
          <Switch checked={feishu.remoteEnabled} onChange={(remoteEnabled) => patch({ remoteEnabled })} />
          <span className="config-inline-label">启用远程指令监听</span>
          {eventStatus && (
            <Badge
              status={
                eventStatus.state === 'connected' ? 'success' : eventStatus.state === 'error' ? 'error' : 'processing'
              }
              text={formatFeishuEventStatusText(eventStatus)}
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

        <ConfigField label="群聊触发">
          <Radio.Group value={feishu.remoteGroupTrigger} onChange={(e) => patch({ remoteGroupTrigger: e.target.value })}>
            <Radio value="mention">@Bot</Radio>
            <Radio value="prefix">前缀</Radio>
            <Radio value="both">两者</Radio>
          </Radio.Group>
          <Input
            style={{ marginTop: 8, maxWidth: 280 }}
            value={feishu.remoteCommandPrefix ?? '/sa '}
            onChange={(e) => patch({ remoteCommandPrefix: e.target.value })}
            placeholder="命令前缀"
          />
        </ConfigField>

        <ConfigField label="会话合并（分钟，0=每条新会话）">
          <InputNumber
            min={0}
            max={120}
            value={feishu.remoteSessionMergeMinutes ?? 0}
            onChange={(v) => patch({ remoteSessionMergeMinutes: v ?? 0 })}
          />
        </ConfigField>

        <ConfigField label="远程写确认策略">
          <Select
            style={{ maxWidth: 280 }}
            value={feishu.remoteConfirmPolicy}
            onChange={(remoteConfirmPolicy) => patch({ remoteConfirmPolicy })}
            popupClassName={CONFIG_MODAL_SELECT_POPUP}
            options={[
              { value: 'remote_read_only', label: '禁止远程写' },
              { value: 'feishu_confirm', label: '飞书内 Y/N 确认' },
              { value: 'always', label: '一律确认' },
              { value: 'inherit', label: '与工具设置一致' }
            ]}
          />
        </ConfigField>

        <Checkbox checked={feishu.remoteAllowLocalWrite} onChange={(e) => patch({ remoteAllowLocalWrite: e.target.checked })}>
          允许远程指令执行本地文件写操作
        </Checkbox>

        <ConfigField label="区域">
          <Radio.Group value={feishu.region} onChange={(e) => patch({ region: e.target.value })}>
            <Radio value="feishu">飞书国内</Radio>
            <Radio value="lark">Lark 国际</Radio>
          </Radio.Group>
        </ConfigField>

        <ConfigField label="远程默认模型">
          <Select
            allowClear
            style={{ maxWidth: 280 }}
            placeholder="与全局默认相同"
            value={feishu.remoteDefaultModelId}
            onChange={(remoteDefaultModelId) => patch({ remoteDefaultModelId })}
            popupClassName={CONFIG_MODAL_SELECT_POPUP}
            options={models.filter((m) => m.enabled).map((m) => ({ value: m.name, label: m.name }))}
          />
        </ConfigField>

        <ConfigField label="远程 Plan 模式">
          <Select
            style={{ maxWidth: 280 }}
            value={feishu.remotePlanMode}
            onChange={(remotePlanMode) => patch({ remotePlanMode })}
            popupClassName={CONFIG_MODAL_SELECT_POPUP}
            options={[
              { value: 'off', label: '关闭' },
              { value: 'auto', label: '关键词自动' },
              { value: 'always', label: '总是先 Plan' }
            ]}
          />
        </ConfigField>

        <ConfigField label="集成模式">
          <Select
            style={{ maxWidth: 280 }}
            value={feishu.integrationMode}
            onChange={(integrationMode) => patch({ integrationMode })}
            popupClassName={CONFIG_MODAL_SELECT_POPUP}
            options={[
              { value: 'cli', label: 'CLI（推荐）' },
              { value: 'mcp', label: 'MCP' },
              { value: 'both', label: '并存' }
            ]}
          />
          <p className="config-field__hint">若已配置 MCP 飞书工具，请在工具 Tab 避免重复启用冲突能力。</p>
        </ConfigField>

        <Button onClick={() => setAuditOpen(true)}>查看操作记录</Button>
      </ConfigSettingsStack>

      <FeishuAuditDrawer open={auditOpen} onClose={() => setAuditOpen(false)} />
    </>
  )
}
