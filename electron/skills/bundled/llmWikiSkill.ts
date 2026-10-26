import type { SkillDefinition } from '../../../src/shared/domainTypes'
import { parseFrontMatter, validateSkillMeta } from '../skillParser'

export const LLM_WIKI_SKILL_NAME = 'llm-wiki'

export const BUNDLED_LLM_WIKI_SKILL_MD = `---
name: llm-wiki
description: "把内容存入/查询共享知识库（Wiki）：通过 memory.wiki_* 专属能力查找、读取、导入和保存知识"
triggers: [存入wiki, 存入 wiki, 存到wiki, 存到知识库, 写入知识库, 收藏到知识库, 录入知识库, 知识库, llm-wiki, llm wiki]
version: "1.0.0"
author: "SpaceAssistant"
---

# 共享知识库（Wiki）领域操作

## 核心约定（先读这里）

- 共享知识库通过 \`memory\` 发现入口提供 \`memory.wiki_*\` 领域操作。先按查询词发现需要的工具，再调用其完整 schema。
- Wiki 工具参数和结果使用 pageId、sourceId 等领域标识；不得提供或推导 Wiki 文件路径。
- 工具发现只披露 schema，不授予额外访问权限；每次操作仍经过当前会话的授权和确认规则。

## 流程

### 写入（存入 wiki / 存入知识库）
1. 使用 \`memory.wiki_get_schema\` 获取有效分类与规则。
2. 使用 \`memory.wiki_search\` 查重，并读取候选页面。
3. 使用 \`memory.wiki_save_page\` 创建或更新知识页面。
4. 新资料先通过 \`memory.wiki_import_source\` 取得应用绑定的 \`sourceId\`，再用 \`memory.wiki_read_source\` 读取。
5. 页面正文由 Agent 撰写；index、log 与 raw 内容由 Wiki 服务管理。

### 查询 / 整理
1. 使用 \`memory.wiki_search\` 定位条目。
2. 用 \`memory.wiki_open_page\` 固定页面版本，再用 \`memory.wiki_read_page\` 读取有界片段。
3. 用户要求改写时，用 \`memory.wiki_save_page\` 保存并提交当前 schemaVersion 与 expectedRevision。

### 异常处理（fail-closed，不要绕行）
- 来源导入使用应用绑定的 sourceRef；拒绝模型提供的任意路径。
- SCHEMA 更新先提案，再由用户通过现有确认界面批准；不得在普通页面保存中修改 SCHEMA。
- 页面历史恢复先列出版本、完整展示最终页面，再请求用户确认；automation lane 拒绝恢复。
- Wiki 服务未就绪、身份冲突或版本冲突时停止并报告，不得改用通用文件工具绕过。
`

let cachedBundledSkill: SkillDefinition | null = null

export function getBundledLlmWikiSkill(): SkillDefinition {
  if (cachedBundledSkill) return cachedBundledSkill

  const { frontMatter, content } = parseFrontMatter(BUNDLED_LLM_WIKI_SKILL_MD)
  const validated = validateSkillMeta(frontMatter)
  if (!validated.ok) throw new Error(validated.error)

  cachedBundledSkill = {
    meta: validated.meta,
    content: content.trim(),
    scope: 'builtin',
    directoryPath: '',
    filePath: '',
    lastModified: 0
  }
  return cachedBundledSkill
}
