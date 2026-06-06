import { App, Button, Form, Input, InputNumber, Radio, Space, Switch } from 'antd'
import type { FileConfirmMode } from '../../../shared/domainTypes'
import { BUILTIN_TOOL_DEFINITIONS } from '../../../shared/builtinToolDefinitions'
import { getBuiltinToolI18nKeys } from '../../../shared/builtinToolSettingsCopy'
import type { BrowserConfig, ModelEntry, ShellConfig } from '../../../shared/domainTypes'
import type { ToolsSettingsSubTab } from '../../store/configSlice'
import { BrowserSettingsTab } from './BrowserSettingsTab'
import { ConfigResultAlert } from './ConfigResultAlert'
import { ConfigSwitchRow } from './ConfigField'
import { ShellSettingsTab } from './ShellSettingsTab'
import { getToolsSettingsSectionHint } from './toolsSettingsNav'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

export type ToolsSettingsUi = {
  confirmMode: FileConfirmMode
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
  const { t } = useTypedTranslation('config')

  return (
    <Space direction="vertical" className="config-settings-stack" size="middle" style={{ width: '100%' }}>
      <p className="config-field__hint config-tool-list-intro">{t('tools.listIntro')}</p>
      <div className="config-tool-list">
        {BUILTIN_TOOL_DEFINITIONS.map((def) => {
          const on = !toolUi.deniedTools.includes(def.name)
          const keys = getBuiltinToolI18nKeys(def.name)
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
                <span className="config-tool-row__name">{t(keys.displayName)}</span>
                <code className="config-tool-row__id">{def.name}</code>
                <span className="config-tool-row__summary">{t(keys.summary)}</span>
                <span className="config-tool-row__disabled-hint">
                  {t('tools.disabledHintPrefix')}
                  {t(keys.disabledHint)}
                </span>
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
  const { modal } = App.useApp()
  const { t } = useTypedTranslation('config')
  const hint = getToolsSettingsSectionHint(section, t)

  const patchShellUi = (partial: Partial<ShellConfig>) => setShellUi((s) => ({ ...s, ...partial }))

  const handleAutoAllowScriptChange = (enabled: boolean) => {
    if (enabled) {
      modal.confirm({
        title: t('shell.autoAllow.confirmTitle'),
        content: (
          <div>
            <p>{t('shell.autoAllow.confirmMessage')}</p>
            <p>{t('shell.autoAllow.confirmWarning')}</p>
          </div>
        ),
        okText: t('shell.autoAllow.confirmOk'),
        cancelText: t('shell.autoAllow.confirmCancel'),
        onOk: () => patchShellUi({ autoAllowScriptExecution: true })
      })
      return
    }
    patchShellUi({ autoAllowScriptExecution: false })
  }

  const handleConfirmModeChange = (next: FileConfirmMode) => {
    if (next === 'auto' && toolUi.confirmMode !== 'auto') {
      modal.confirm({
        title: t('tools.file.autoApprove.confirmTitle'),
        content: (
          <div>
            <p>{t('tools.file.autoApprove.confirmMessage')}</p>
            <p>{t('tools.file.autoApprove.confirmWarning')}</p>
          </div>
        ),
        okText: t('tools.file.autoApprove.confirmOk'),
        cancelText: t('tools.file.autoApprove.confirmCancel'),
        onOk: () => setToolUi((s) => ({ ...s, confirmMode: 'auto' }))
      })
      return
    }
    setToolUi((s) => ({ ...s, confirmMode: next }))
  }

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
          <div className="config-form-stack">
            <div className="config-form-group">
              <Form.Item label={t('tools.file.confirmModeLabel')}>
                <Radio.Group value={toolUi.confirmMode} onChange={(e) => handleConfirmModeChange(e.target.value)}>
                  <Space direction="vertical">
                    <Radio value="diff">{t('tools.file.confirmDiff')}</Radio>
                    <Radio value="direct">{t('tools.file.confirmDirect')}</Radio>
                    <Radio value="auto">{t('tools.file.confirmAuto')}</Radio>
                  </Space>
                </Radio.Group>
              </Form.Item>
              {toolUi.confirmMode === 'auto' ? (
                <div className="config-field__hint">
                  <p>{t('tools.file.autoApprove.description')}</p>
                  <ul>
                    <li>{t('tools.file.autoApprove.conditionInWorkDir')}</li>
                    <li>{t('tools.file.autoApprove.conditionNotSensitive')}</li>
                    <li>{t('tools.file.autoApprove.conditionMaxBytes', { size: '256 KB' })}</li>
                  </ul>
                  <p>{t('tools.file.autoApprove.fallbackHint')}</p>
                </div>
              ) : null}
            </div>
            <Form.Item label={t('tools.file.checkpointLabel')} className="config-form-item-inline">
              <Switch
                checked={toolUi.fileCheckpointingEnabled}
                onChange={(c) => setToolUi((s) => ({ ...s, fileCheckpointingEnabled: c }))}
              />
            </Form.Item>
            <Form.Item label={t('tools.file.maxSnapshotsLabel')}>
              <InputNumber
                min={1}
                max={500}
                value={toolUi.maxFileSnapshots}
                onChange={(v) => setToolUi((s) => ({ ...s, maxFileSnapshots: v ?? 100 }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </div>
        )
      case 'script':
        return (
          <div className="config-form-stack">
            <ConfigSwitchRow
              label={t('shell.autoAllow.title')}
              hint={t('shell.autoAllow.description')}
              checked={shellUi.autoAllowScriptExecution ?? false}
              onChange={handleAutoAllowScriptChange}
            />
            <Form.Item label={t('tools.script.pythonPathLabel')}>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  value={toolUi.pythonPath}
                  onChange={(e) => setToolUi((s) => ({ ...s, pythonPath: e.target.value }))}
                  placeholder={t('tools.script.pythonPathPlaceholder')}
                />
                <Button loading={pyTesting} onClick={onTestPython}>
                  {t('tools.script.test')}
                </Button>
              </Space.Compact>
            </Form.Item>
            {pyTest ? <ConfigResultAlert ok={pyTest.ok} message={pyTest.text} /> : null}
            <Form.Item label={t('tools.script.timeoutLabel')}>
              <InputNumber
                min={10}
                max={86400}
                value={toolUi.scriptTimeout}
                onChange={(v) => setToolUi((s) => ({ ...s, scriptTimeout: v ?? 300 }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
            <Form.Item label={t('tools.script.grepTimeoutLabel')}>
              <InputNumber
                min={5}
                max={600}
                value={toolUi.grepTimeoutSec}
                onChange={(v) => setToolUi((s) => ({ ...s, grepTimeoutSec: v ?? 60 }))}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </div>
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
