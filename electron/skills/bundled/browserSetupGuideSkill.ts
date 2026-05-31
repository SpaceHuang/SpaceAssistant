import type { SkillDefinition } from '../../../src/shared/domainTypes'
import { parseFrontMatter, validateSkillMeta } from '../skillParser'

export const BROWSER_SETUP_GUIDE_SKILL_NAME = 'browser-setup-guide'

export const BUNDLED_BROWSER_SETUP_GUIDE_SKILL_MD = `---
name: browser-setup-guide
description: "引导用户安装并验证 Playwright Chromium，修复网络访问（browser 工具）依赖。"
triggers: []
version: "1.1.0"
author: "SpaceAssistant"
---

# 网络访问依赖修复 Skill

你正在协助用户修复 SpaceAssistant **网络访问**（内置 \`browser\` 工具）所需的依赖：Stagehand、Playwright npm 包与 Chromium 浏览器二进制。

## 可用工具

- \`browser_detect\`：检测依赖是否就绪（**必须**在开场与用户表示「装好了」后调用；复检时传 \`force: true\`）
- \`run_shell\`：在会话工作目录下执行 shell 命令（Chromium 安装**优先**使用；执行前弹出确认卡片）。**仅当系统注入的「当前可用工具」列表中包含 \`run_shell\` 时才可调用**；与 \`run_script\`（Python）完全不同，**禁止**用 \`run_script\` 替代
- 若 \`run_shell\` 不在可用工具列表中：说明用户尚未在 **设置 → 工具 → 工具开关** 中开启 \`run_shell\`；立即走 fallback（口述安装步骤，或引导用户点击 UI「在终端中打开」），并简要说明可在工具开关中开启以便下次代为安装
- 不要向用户展示 API Key、完整 node_modules 路径或堆栈信息

## 状态机（严格按序，一次只推进一步）

### S0 开场

简短说明将要修复什么，然后**立即调用** \`browser_detect\`。

### S1 解读结果

根据 \`primaryFailure\` 用中文、非技术优先向用户解释缺什么（**不要**根据 \`installContext\` 分叉话术；开发与打包版对用户呈现一致）。

### S2 分场景引导

| primaryFailure | 引导要点 |
|----------------|----------|
| chromium_missing / chromium_headless_only / chromium_path_unresolved | 说明需下载 Chromium（约 150–200MB，需联网）；**优先用 \`run_shell\` 代为安装**（见下方「Chromium 安装命令」）；仅当 \`run_shell\` 不可用（工具开关未开启）或用户拒绝确认时，才 fallback 到 UI「在终端中打开」或口述手动步骤 |
| stagehand_missing / playwright_missing | **安装包组件缺失**：引导用户重新安装 SpaceAssistant 或联系支持，**禁止**引导 \`npm install\` |
| node_version_low | 引导升级 SpaceAssistant 应用，**不要**引导升级系统 Node |
| init_probe_failed | 完全退出重试 → 强制重装 Chromium（经 \`run_shell\` 执行 \`npx playwright install --force chromium\`）→ 检查安全软件 / Gatekeeper |

#### Chromium 安装命令（经 \`run_shell\`）

从 \`browser_detect\` 返回的 \`recommendedCwd\` 构造命令（**不要**在对话中朗读绝对路径）：

- Windows：\`cd /d <recommendedCwd> && npx playwright install chromium\`（路径含空格时可加引号；执行器会自动在正确目录运行 \`npx\`，勿使用 PowerShell 的 \`Set-Location\`）
- macOS / Linux：\`cd "<recommendedCwd>" && npx playwright install chromium\`

\`run_shell\` 参数建议：

- \`description\`：简短中文，如「下载 Playwright Chromium 浏览器」
- \`timeout\`：**1800** 或更长（下载可能需数分钟，慢网络建议 30 分钟以上）

用户会在确认卡片中看到完整命令；你只需说明将要代为下载，并请用户点「确认执行」。

故障排除（按需口述，不要大段粘贴）：网络需联网；Windows 注意杀毒/Defender；macOS 注意 Gatekeeper；磁盘至少 500MB。

### S3 等待安装完成

- 若已调用 \`run_shell\`：等待工具返回（成功或失败），根据 stdout/stderr 向用户解释结果
- 若用户选择手动终端：等待用户确认已执行完毕

### S4 复检

用户表示完成或 \`run_shell\` 退出码为 0 → 再次 \`browser_detect\`（\`force: true\`）。

### S5 结束

- \`canInitialize === true\`：祝贺并提示「请重新发送你的请求，或告诉我继续刚才的任务」
- 仍失败：回到 S2 或故障排除，不要一次给出所有步骤

## 约束

- 一次只推进一步，等待用户确认
- Chromium 安装**必须**经 \`run_shell\` 确认卡片执行，**禁止**静默执行；也**禁止**默认让用户自行开终端复制命令（除非 \`run_shell\` 不可用或用户明确拒绝）
- 修复完成后**不要**自动重试原 browser 调用，请用户手动重试
`

let cachedBundledSkill: SkillDefinition | null = null

export function getBundledBrowserSetupGuideSkill(): SkillDefinition {
  if (cachedBundledSkill) return cachedBundledSkill

  const { frontMatter, content } = parseFrontMatter(BUNDLED_BROWSER_SETUP_GUIDE_SKILL_MD)
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
