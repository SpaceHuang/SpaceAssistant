import type { SkillDefinition } from '../../../src/shared/domainTypes'
import { parseFrontMatter, validateSkillMeta } from '../skillParser'

export const LLM_WIKI_SKILL_NAME = 'llm-wiki'

export const BUNDLED_LLM_WIKI_SKILL_MD = `---
name: llm-wiki
description: "把内容存入/查询共享知识库（Wiki）：提及存入 wiki、llm-wiki、知识库时使用。直接读写 \`llm-wiki/\` 前缀路径即可，勿在文件系统搜索 wiki 目录"
triggers: [存入wiki, 存入 wiki, 存到wiki, 存到知识库, 写入知识库, 收藏到知识库, 录入知识库, 知识库, llm-wiki, llm wiki]
version: "1.0.0"
author: "SpaceAssistant"
---

# 共享知识库（llm-wiki）读写

## 核心约定（先读这里）

- 共享知识库的**唯一接口是 \`llm-wiki/\` 路径前缀**（词汇前缀固定为 \`llm-wiki/\`，不随设置或存储位置变化；设置页管理的是物理存储位置，不影响词汇路径）：
  - 写入：\`write_file { path: "llm-wiki/<分类>/<标题>.md", content: ... }\`
  - 读取：\`read_file { path: "llm-wiki/..." }\`；检索：\`grep\` 带 \`llm-wiki/\` 前缀路径
- 工具层会自动把 \`llm-wiki/...\` 挂载到共享知识库的实际存储位置（应用数据目录）。
  **物理目录不在工作目录下，禁止用 \`list_directory\` / \`run_shell\` / \`grep\` 在文件系统里搜索 wiki 目录**——搜不到，也不需要。
- \`llm-wiki/\` 下既有内容的路径就是知识库的「词汇路径」，直接读写即可。

## 流程

### 写入（存入 wiki / 存入知识库）
1. 先 \`read_file\` 或 \`grep\` 检查目标主题是否已有条目，避免重复建页。
2. 确定词汇路径：\`llm-wiki/<分类目录>/<标题>.md\`；分类沿用已有目录习惯（可先 \`list_directory { path: "llm-wiki" }\` 看顶层结构）。
3. \`write_file\` 写入 Markdown；内容较长时组织好小节结构。
4. 回执用户时给出**词汇路径**（如 \`llm-wiki/技术笔记/xxx.md\`），不要给出物理绝对路径。

### 查询 / 整理
1. \`list_directory { path: "llm-wiki" }\` 或 \`grep\`（路径 \`llm-wiki\`）定位条目。
2. \`read_file\` 读取后按用户要求总结、改写或重组；整理结果同样以 \`write_file\` 写回 \`llm-wiki/\`。

### 异常处理（fail-closed，不要绕行）
- 报「只读别名 / wiki-readonly-alias」：该路径是迁移保留的旧别名，改写到 \`llm-wiki/\` 下对应新路径（报错信息里已给出目标位置）。
- 提示知识库未启用：告知用户在 设置 → Wiki 中开启后重试；不要把内容写到 workDir 其他位置冒充知识库。
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
