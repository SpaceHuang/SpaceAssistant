import { App, Button, Input, InputNumber, Space, Switch } from 'antd'
import type { WikiConfig } from '../../../shared/domainTypes'

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
    <>
      <div style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Space>
            <Switch
              checked={wiki.enabled}
              onChange={(enabled) => onChange({ ...wiki, enabled })}
            />
            <span>启用 LLM Wiki</span>
          </Space>
          <div>
            <div style={{ marginBottom: 4 }}>Wiki 根路径（相对工作目录）</div>
            <Input
              value={wiki.rootPath}
              onChange={(e) => onChange({ ...wiki, rootPath: e.target.value.trim() || 'llm-wiki' })}
              placeholder="llm-wiki"
            />
          </div>
          <Space>
            <Switch
              checked={wiki.hideWikiFromFileTree}
              onChange={(hideWikiFromFileTree) => onChange({ ...wiki, hideWikiFromFileTree })}
            />
            <span>从文件列表隐藏 Wiki 目录</span>
          </Space>
          <Space>
            <Switch
              checked={wiki.interactiveIngest}
              onChange={(interactiveIngest) => onChange({ ...wiki, interactiveIngest })}
            />
            <span>Ingest 前与用户交互确认要点</span>
          </Space>
          <div>
            <div style={{ marginBottom: 4 }}>批量 Ingest 单批上限</div>
            <InputNumber
              min={1}
              max={50}
              value={wiki.maxBatchIngest}
              onChange={(v) => onChange({ ...wiki, maxBatchIngest: v ?? 10 })}
              style={{ width: '100%' }}
            />
          </div>
          <Button type="primary" onClick={() => void initWiki()} disabled={!wiki.enabled}>
            初始化 Wiki
          </Button>
        </Space>
      </div>
    </>
  )
}
