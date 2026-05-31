import type { SkillDefinition } from '../../../src/shared/domainTypes'
import { parseFrontMatter, validateSkillMeta } from '../skillParser'

export const SHELL_SETUP_GUIDE_SKILL_NAME = 'shell-setup-guide'

export const BUNDLED_SHELL_SETUP_GUIDE_SKILL_MD = `---
name: shell-setup-guide
description: "指导 Agent 使用 run_shell 安装依赖与运行构建命令。"
triggers: []
version: "1.0.0"
author: "SpaceAssistant"
---

# Shell 命令使用指南

## 工具分工

- \`run_shell\`：npm、git、构建/测试等 CLI 命令（需用户确认）
- \`run_script\`：Python 代码片段
- \`run_lark_cli\`：飞书操作

## 依赖安装建议

- 工作目录存在 \`package.json\` 且缺少 node_modules 时，可建议 \`npm install\`（经 run_shell）
- 存在 \`pyproject.toml\` 或 \`requirements.txt\` 时，可建议 \`pip install\` 相关命令
- 浏览器依赖修复（\`browser-setup-guide\` Skill）中，Chromium 安装**应**经 \`run_shell\` 执行 \`npx playwright install chromium\`（带确认），勿让用户手动开终端

## 约束

- 一次一条命令，等待用户确认
- 禁止 sudo、重定向、命令替换
- **避免**交互式全屏 TUI：\`less\`、\`more\`、\`top\`、\`htop\`、\`vim\`、\`nano\`、交互式 \`npm init\`、\`git rebase -i\` 等；优先 \`git --no-pager log\`、\`npm init -y\` 等非交互替代
- 若必须使用分页器或编辑器，提示用户在工作目录打开外部终端执行
`

let cached: SkillDefinition | null = null

export function getBundledShellSetupGuideSkill(): SkillDefinition {
  if (cached) return cached
  const { frontMatter, content } = parseFrontMatter(BUNDLED_SHELL_SETUP_GUIDE_SKILL_MD)
  const validated = validateSkillMeta(frontMatter)
  if (!validated.ok) throw new Error(validated.error)
  cached = {
    meta: validated.meta,
    content: content.trim(),
    scope: 'builtin',
    directoryPath: '',
    filePath: '',
    lastModified: 0
  }
  return cached
}
