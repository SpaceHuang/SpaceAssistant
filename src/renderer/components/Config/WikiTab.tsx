import { App, Button, Input, InputNumber, Space, Switch } from 'antd'
import type { WikiConfig } from '../../../shared/domainTypes'
import { ConfigField, ConfigSettingsStack, ConfigSwitchRow } from './ConfigField'

type Props = {
  wiki: WikiConfig
  onChange: (next: WikiConfig) => void
}

export function WikiTab({ wiki, onChange }: Props) {
  const { message } = App.useApp()

  const initWiki = async () => {
    const result = await window.api.wikiInit({ installSkill: true })
    if (!result.ok) {
      message.error(result.error)
      return
    }
    message.success(`Wiki 已初始化：${result.rootPath}${result.skillInstalled ? '（已安装 llm-wiki Skill）' : ''}`)
    await window.api.skillInvalidateCache()
  }

  return (
    <ConfigSettingsStack>
      <ConfigSwitchRow
        label="启用 LLM Wiki"
        checked={wiki.enabled}
        onChange={(enabled) => onChange({ ...wiki, enabled })}
      />
      <ConfigField label="Wiki 根路径（相对工作目录）">
        <Input
          value={wiki.rootPath}
          onChange={(e) => onChange({ ...wiki, rootPath: e.target.value.trim() || 'llm-wiki' })}
          placeholder="llm-wiki"
        />
      </ConfigField>
      <ConfigSwitchRow
        label="从文件列表隐藏 Wiki 目录"
        checked={wiki.hideWikiFromFileTree}
        onChange={(hideWikiFromFileTree) => onChange({ ...wiki, hideWikiFromFileTree })}
      />
      <ConfigSwitchRow
        label="Ingest 前与用户交互确认要点"
        checked={wiki.interactiveIngest}
        onChange={(interactiveIngest) => onChange({ ...wiki, interactiveIngest })}
      />
      <ConfigField label="批量 Ingest 单批上限">
        <InputNumber
          min={1}
          max={50}
          value={wiki.maxBatchIngest}
          onChange={(v) => onChange({ ...wiki, maxBatchIngest: v ?? 10 })}
          style={{ width: '100%' }}
        />
      </ConfigField>
      <Button type="primary" onClick={() => void initWiki()} disabled={!wiki.enabled}>
        初始化 Wiki
      </Button>
    </ConfigSettingsStack>
  )
}
