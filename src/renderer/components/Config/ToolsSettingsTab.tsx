import { Alert, Button, Form, Input, InputNumber, Radio, Space, Switch } from 'antd'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import { getBuiltinToolSettingsCopy } from '../../../shared/builtinToolSettingsCopy'
import type { BrowserConfig, ModelEntry, ShellConfig } from '../../../shared/domainTypes'
import type { ToolsSettingsSubTab } from '../../store/configSlice'
import { BrowserSettingsTab } from './BrowserSettingsTab'
import { ShellSettingsTab } from './ShellSettingsTab'
import { getToolsSettingsSectionHint } from './toolsSettingsNav'

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
  section: ToolsSettingsSubTab
  toolUi: ToolsSettingsUi
  setToolUi: React.Dispatch<React.SetStateAction<ToolsSettingsUi>>
  browserUi: BrowserConfig
  setBrowserUi: React.Dispatch<React.SetStateAction<BrowserConfig>>
  shellUi: ShellConfig
  setShellUi: React.Dispatch<React.SetStateAction<ShellConfig>>
  onShellEnabledChange: (enabled: boolean) => void
  onTestShell?: () => void
  shellTesting?: boolean
  shellTest?: { ok: boolean; text: string } | null
  models: ModelEntry[]
  pyTest: { ok: boolean; text: string } | null
  pyTesting: boolean
  onTestPython: () => void
}

function BuiltinToolSwitchList({
  toolUi,
  setToolUi,
  onShellEnabledChange
}: {
  toolUi: ToolsSettingsUi
  setToolUi: React.Dispatch<React.SetStateAction<ToolsSettingsUi>>
  onShellEnabledChange?: (enabled: boolean) => void
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
                  if (def.name === 'run_shell' && onShellEnabledChange) {
                    onShellEnabledChange(checked)
                    return
                  }
                  setToolUi((s) => ({
                    ...s,
                    deniedTools: checked
                      ? s.deniedTools.filter((x) => x !== def.name)
                      : [...s.deniedTools, def.name]
                  }))
                }}
              />
              <div className="config-tool-row__body">
                <span className="config-tool-row__name">{copy.displayName}</span>
                <code className="config-tool-row__id">{def.name}</code>
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
  section,
  toolUi,
  setToolUi,
  browserUi,
  setBrowserUi,
  shellUi,
  setShellUi,
  onShellEnabledChange,
  onTestShell,
  shellTesting,
  shellTest,
  models,
  pyTest,
  pyTesting,
  onTestPython
}: Props) {
  const hint = getToolsSettingsSectionHint(section)

  const renderSection = () => {
    switch (section) {
      case 'switches':
        return (
          <BuiltinToolSwitchList
            toolUi={toolUi}
            setToolUi={setToolUi}
            onShellEnabledChange={onShellEnabledChange}
          />
        )
      case 'file':
        return (
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
      case 'script':
        return (
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
              <Alert type={pyTest.ok ? 'success' : 'error'} message={pyTest.text} showIcon className="config-alert-block" />
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
      case 'shell':
        return (
          <ShellSettingsTab
            shell={shellUi}
            onChange={setShellUi}
            onTestShell={onTestShell}
            shellTesting={shellTesting}
            shellTest={shellTest}
          />
        )
      case 'browser':
        return <BrowserSettingsTab active browser={browserUi} onChange={setBrowserUi} models={models} />
      default:
        return null
    }
  }

  return (
    <div className="config-tools-panel">
      {hint ? <p className="config-tools-panel__intro">{hint}</p> : null}
      {renderSection()}
    </div>
  )
}
