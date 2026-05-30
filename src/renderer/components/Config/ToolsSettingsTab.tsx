import { useEffect, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Radio, Space, Switch, Tabs } from 'antd'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import { getBuiltinToolSettingsCopy } from '../../../shared/builtinToolSettingsCopy'
import type { BrowserConfig, ModelEntry } from '../../../shared/domainTypes'
import type { ToolsSettingsSubTab } from '../../store/configSlice'
import { BrowserSettingsTab } from './BrowserSettingsTab'

export type ToolsSettingsUi = {
  confirmMode: 'diff' | 'direct'
  deniedTools: string[]
  pythonPath: string
  scriptTimeout: number
  fileCheckpointingEnabled: boolean
  maxFileSnapshots: number
  grepTimeoutSec: number
}

type Props = {
  toolUi: ToolsSettingsUi
  setToolUi: React.Dispatch<React.SetStateAction<ToolsSettingsUi>>
  browserUi: BrowserConfig
  setBrowserUi: React.Dispatch<React.SetStateAction<BrowserConfig>>
  models: ModelEntry[]
  pyTest: { ok: boolean; text: string } | null
  pyTesting: boolean
  onTestPython: () => void
  /** 从聊天卡片等跳转时，指定打开的 tools 子 Tab */
  initialSubTab?: ToolsSettingsSubTab
}

function BuiltinToolSwitchList({
  toolUi,
  setToolUi
}: {
  toolUi: ToolsSettingsUi
  setToolUi: React.Dispatch<React.SetStateAction<ToolsSettingsUi>>
}) {
  return (
    <Space direction="vertical" className="config-settings-stack" size="middle" style={{ width: '100%' }}>
      <p className="config-field__hint config-tool-list-intro">
        关闭某工具后，Agent 在对话中将无法调用它，相关任务可能失败或只能改用其它能力。
      </p>
      <div className="config-tool-list">
        {BUILTIN_TOOL_DEFINITIONS.map((def) => {
          const on = !toolUi.deniedTools.includes(def.name)
          const copy = getBuiltinToolSettingsCopy(def.name)
          return (
            <div key={def.name} className={`config-tool-row${on ? '' : ' config-tool-row--off'}`}>
              <Switch
                size="small"
                className="config-tool-row__switch"
                checked={on}
                onChange={(checked) => {
                  setToolUi((s) => ({
                    ...s,
                    deniedTools: checked
                      ? s.deniedTools.filter((x) => x !== def.name)
                      : [...s.deniedTools, def.name]
                  }))
                }}
              />
              <div className="config-tool-row__body">
                <span className="config-tool-row__name">{def.name}</span>
                <span className="config-tool-row__summary">{copy.summary}</span>
                <span className="config-tool-row__disabled-hint">关闭后：{copy.disabledHint}</span>
              </div>
            </div>
          )
        })}
      </div>
    </Space>
  )
}

export function ToolsSettingsTab({
  toolUi,
  setToolUi,
  browserUi,
  setBrowserUi,
  models,
  pyTest,
  pyTesting,
  onTestPython,
  initialSubTab
}: Props) {
  const [subTab, setSubTab] = useState<ToolsSettingsSubTab>(initialSubTab ?? 'switches')

  useEffect(() => {
    if (initialSubTab) setSubTab(initialSubTab)
  }, [initialSubTab])

  return (
    <Tabs
      className="config-tools-subtabs"
      activeKey={subTab}
      onChange={(key) => setSubTab(key as ToolsSettingsSubTab)}
      items={[
        {
          key: 'switches',
          label: '工具开关',
          children: <BuiltinToolSwitchList toolUi={toolUi} setToolUi={setToolUi} />
        },
        {
          key: 'file',
          label: '文件操作',
          children: (
            <>
              <Form.Item label="文件写入确认模式">
                <Radio.Group
                  value={toolUi.confirmMode}
                  onChange={(e) => setToolUi((s) => ({ ...s, confirmMode: e.target.value }))}
                >
                  <Radio value="diff">展示文件修改内容</Radio>
                  <Radio value="direct">直接确认</Radio>
                </Radio.Group>
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
            </>
          )
        },
        {
          key: 'script',
          label: '脚本执行',
          children: (
            <>
              <Form.Item label="Python 路径">
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={toolUi.pythonPath}
                    onChange={(e) => setToolUi((s) => ({ ...s, pythonPath: e.target.value }))}
                    placeholder="python 或绝对路径"
                  />
                  <Button loading={pyTesting} onClick={onTestPython}>
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
            </>
          )
        },
        {
          key: 'browser',
          label: '网络访问',
          children: (
            <BrowserSettingsTab
              active={subTab === 'browser'}
              browser={browserUi}
              onChange={setBrowserUi}
              models={models}
            />
          )
        }
      ]}
    />
  )
}
