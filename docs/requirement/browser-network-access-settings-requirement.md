# 工具 Tab · 网络访问设置精简与域名策略重构 — 需求规格

**版本：** 1.1  
**日期：** 2026-05-30  
**状态：** 已实现  
**关联文档：** [web-browser-tools-requirement.md](./web-browser-tools-requirement.md)、[tools-requirement.md](./tools-requirement.md)、[settings-ui-refinement-requirement.md](./settings-ui-refinement-requirement.md)、[browser-playwright-install-guide-requirement.md](./browser-playwright-install-guide-requirement.md)、[skills-requirement.md](./skills-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-30 | 汇总工具 Tab 重组、域名策略简化、网络访问子 Tab UI/文案/行为修正 |
| 1.1 | 2026-05-30 | 工具开关独立子 Tab 与说明文案；设置页视觉/组件统一；Skill「安装本地 Skill」命名；文件写入确认文案；Stagehand 下拉 12px 全局统一 |

---

## 目录

1. [概述](#1-概述)
2. [设置页结构变更](#2-设置页结构变更)
3. [内置工具开关精简](#3-内置工具开关精简)
4. [域名访问策略重构](#4-域名访问策略重构)
5. [网络访问子 Tab 配置项](#5-网络访问子-tab-配置项)
6. [操作引擎（Stagehand）分组](#6-操作引擎stagehand分组)
7. [运行时行为与超时](#7-运行时行为与超时)
8. [配置迁移与兼容](#8-配置迁移与兼容)
9. [设置界面视觉与组件统一](#9-设置界面视觉与组件统一)
10. [Skill Tab 安装按钮文案](#10-skill-tab-安装按钮文案)
11. [验收标准](#11-验收标准)
12. [相关文件](#12-相关文件)

---

## 1. 概述

### 1.1 背景

设置 → **工具** 与 **浏览器/网络访问** 存在以下问题：

| 问题 | 影响 |
|------|------|
| 「启用内置工具」「工具白名单」与顶部内置工具列表职责重复 | 用户困惑，同一能力两处配置 |
| 「预批准域名」与「可信域名」语义重叠 | 空预批准列表时 navigate 直接失败，**无确认卡片**，体验崩溃 |
| browser 开关与内置工具 `browser` 开关重复 | 设置不一致 |
| 网络访问 Tab 顶部 info Alert、独立「启用浏览器工具」冗余 | 视觉噪音 |
| Stagehand 相关选项分散，缺少分组与说明 | 非技术用户看不懂 |
| 「操作超时」UI 可选 120/180 秒，代码硬 cap 90 秒 | 设置不生效，信任受损 |

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 工具 Tab 内拆为子 Tab：**工具开关** / 文件操作 / 脚本执行 / 网络访问；内置工具列表迁入「工具开关」 |
| G2 | **去掉预批准域名**；仅保留可信域名 + 聊天确认 + 本会话记忆 |
| G3 | 网络访问子 Tab 文案自解释，关键默认值与设置项行为一致 |
| G4 | Stagehand 模型与推理配额归入 **「操作引擎（Stagehand）」** 分组 |
| G5 | `actionTimeoutSec` 等用户可配项**必须按设置值生效** |

### 1.3 非目标

- 不修改 Stagehand / Playwright 底层集成架构
- 不在本需求中重写 [web-browser-tools-requirement.md](./web-browser-tools-requirement.md) 全文（仅记录与本迭代相关的策略变更）
- 不新增「禁用操作」的说明文案（保留现有表单项，后续可补备注）

---

## 2. 设置页结构变更

### 2.1 主 Tab 调整

| 原结构 | 新结构 |
|--------|--------|
| 设置主 Tab 含独立「浏览器」 | **移除**独立「浏览器」主 Tab |
| 工具 Tab 仅文件/脚本相关 | 工具 Tab 内增加子 Tab：**工具开关** / **文件操作** / **脚本执行** / **网络访问** |

原「浏览器」Tab 内容（依赖检测、域名、Stagehand 等）全部并入 **工具 → 网络访问**。

### 2.2 子 Tab 命名与顺序

| 顺序 | key | 标签文案 |
|------|-----|----------|
| 1 | `switches` | **工具开关** |
| 2 | `file` | 文件操作 |
| 3 | `script` | 脚本执行 |
| 4 | `browser` | **网络访问**（原「浏览器与网络访问」） |

默认打开 **工具开关** 子 Tab（`initialSubTab` 未指定时 `switches`）。从聊天失败卡片等跳转仍可通过 `toolsSubTab: 'browser'` 直达网络访问。

### 2.3 跳转入口

聊天失败卡片、Redux `openSettings({ tab: 'tools', toolsSubTab: 'browser' })` 等入口，打开设置后应定位到 **工具 → 网络访问** 子 Tab。

### 2.4 运行环境检测

- 进入 **网络访问** 子 Tab 时才触发 browser 依赖 `detect`（`active={subTab === 'browser'}`）。
- 「运行环境检测」标题与 **重新检测** 图标按钮同一行（`refresh_2_line.svg`）。
- 依赖就绪时 `BrowserSetupGuide` 默认折叠为一行「网络访问功能正常」，可展开查看完整引导。
- **移除** 网络访问 Tab 顶部蓝色 info Alert。

### 2.5 共享 detect 状态

- Redux `browserDetectSlice` + `useBrowserDetect` 在设置页与聊天失败卡片间共享检测结果（含 30s 客户端缓存）。

---

## 3. 内置工具开关精简

### 3.1 移除的设置项

| 移除项 | 说明 |
|--------|------|
| 「仅允许选中的工具（白名单）」 | 与工具开关列表重复 |
| 「启用内置工具」总开关 | 改为仅用 `deniedTools` 控制 |
| 网络访问子 Tab 内「启用浏览器工具」 | 与工具开关中的 `browser` 开关重复 |

### 3.2 内置工具列表 UI（工具开关子 Tab）

- 位置：工具 Tab → **工具开关** 子 Tab（不再置于 Tab 顶部）。
- 顶部说明（一行）：`关闭某工具后，Agent 在对话中将无法调用它，相关任务可能失败或只能改用其它能力。`
- 每行：**Switch + 工具名 + 用途说明 + 关闭后果**。
  - **用途**（`summary`）：该工具能做什么，用户向一行文案。
  - **关闭后**（`disabledHint`）：关闭该工具对 Agent 的影响，前缀固定为 `关闭后：`。
- 关闭态行样式：`config-tool-row--off`，工具名与关闭后果弱化显示。
- 文案来源：`src/shared/builtinToolSettingsCopy.ts`（`BUILTIN_TOOL_SETTINGS_COPY`），每个 `ALL_BUILTIN_TOOL_NAMES` 均须有条目；测试 `assertBuiltinToolSettingsCopyComplete` 保证完整性。
- 持久化：保存时 `tools.enabled: true`、`tools.allowedTools: []`；以 `deniedTools` 为唯一禁用来源。
- `browser.enabled` 恒为 `true`；旧配置 `browser.enabled: false` 迁移为 `deniedTools` 含 `browser`。

### 3.3 文件操作子 Tab 文案

| 项 | 值 |
|----|-----|
| 文件写入确认模式 · diff 选项 | **展示文件修改内容**（原「diff 预览」） |
| 文件写入确认模式 · direct 选项 | 直接确认 |
| 行为 | 不变：`confirmMode: 'diff'` 时在确认卡片展示修改内容 |

---

## 4. 域名访问策略重构

### 4.1 问题与决策

**原策略：** `allowedDomains`（预批准）+ `trustedDomains`（免确认）+ 会话信任。

**问题：** 「预批准列表为空」与「不在预批准且不在可信」本质均为拒绝；后者在模型已发起 navigate 但用户尚未确认时直接报错，**不出现确认卡片**，用户无法操作。

**决策：** **只保留可信域名**；其余域名走 **聊天确认一次 + 本会话同站记忆**；**去掉预批准域名**及 UI。

### 4.2 新规则（`navigateRequiresConfirm === true` 时）

| 条件 | navigate 行为 |
|------|----------------|
| 命中 `trustedDomains` | 免确认，直接打开 |
| 用户已在确认卡片批准本次 navigate | 允许 |
| 本会话内曾批准过同站（`browserSessionTrust`） | 允许 |
| 以上皆否 | **需先弹确认卡片**；未确认前 executor 返回「该域名尚未授权，请先在确认卡片中批准访问」 |

`browserActionNeedsConfirmation` 在 executor 之前判定：非可信且非会话已信任 → `needsConfirm=true` → 渲染进程展示确认卡片 → 批准后带 `toolUserConfirmed` 执行。

**禁止：** 非可信域名在未确认时静默失败且无任何卡片。

### 4.3 `navigateRequiresConfirm === false`

仍允许任意公网 HTTPS 域名（仅受协议、IP、loopback 等硬安全规则限制）。

### 4.4 设置页 UI

| 项 | 说明 |
|----|------|
| **可信域名** | tags 输入；helper：`列表内免确认；其余首次聊天确认，同会话不再问。` |
| ~~预批准域名~~ | **移除** |

### 4.5 工具描述文案

`browser` 内置工具 description 由「仅允许白名单域名」改为：**未在可信域名中的 URL 需用户确认**。

### 4.6 错误文案

- URL 校验失败：`该域名尚未授权，请先在确认卡片中批准访问`
- 用户可见错误映射支持「尚未授权」；默认 navigate 失败提示中的「白名单」改为「域名授权」

---

## 5. 网络访问子 Tab 配置项

子 Tab 内配置项顺序（自上而下）：

1. 允许飞书远程会话使用
2. 运行环境检测（含 BrowserSetupGuide）
3. **操作引擎（Stagehand）**（分组，见 §6）
4. 可信域名
5. 允许 HTTP
6. 无头模式
7. 操作超时（秒）
8. 空闲自动关闭浏览器组件，释放内存（秒）
9. 禁用操作

### 5.1 允许 HTTP

| 项 | 值 |
|----|-----|
| 默认值 | **`true`（开启）** |
| 备注 | `关闭后只允许访问 https 链接。` |
| 行为 | `allowHttp=false` 时拒绝 `http://`；域名确认规则不受此项影响 |

### 5.2 无头模式

| 项 | 值 |
|----|-----|
| 默认值 | `true` |
| 备注（单行） | `开启不弹窗后台运行，关闭可见浏览器操作。` |

### 5.3 操作超时（秒）

| 项 | 值 |
|----|-----|
| 可选值 | 30、60、90、120、180 |
| 默认值 | 90 |
| 生效范围 | `navigate`（open）、`observe`、`extract`、`act` |
| 固定 30 秒 | `navigate` refresh/back/forward、`screenshot`（不受本项影响） |
| **必须** | 用户所选值完整生效，**不得**在代码中硬 cap 为 90 |

### 5.4 空闲自动关闭浏览器组件，释放内存（秒）

| 项 | 值 |
|----|-----|
| 标题 | **空闲自动关闭浏览器组件，释放内存（秒）** |
| 可选值 | 600、1200、1800、3600 |
| 默认值 | 1800（30 分钟） |
| 行为 | 每次 browser 操作成功后重置计时；超时无新操作则 `closeSession` 释放 Chromium |

### 5.5 禁用操作

保持现有多选：`navigate` / `observe` / `extract` / `act` / `screenshot` / `close`。选中项在 executor 层硬拒绝，返回 `{action} 已被禁用`。

---

## 6. 操作引擎（Stagehand）分组

### 6.1 分组标题

**操作引擎（Stagehand）**

Stagehand：基于 Playwright 的 AI 浏览器操作库，负责 `observe` / `extract` / `act` 等需 LLM 理解页面的动作；与主聊天模型分工（主模型规划调工具，Stagehand 在浏览器内执行）。

### 6.2 子项

#### 6.2.1 操作引擎使用的大模型

| 项 | 说明 |
|----|------|
| 原名称 | Stagehand 模型 |
| 留空 | 复用当前 LLM 模型（同一 API Key / baseUrl，自动转为 `provider/模型名`） |
| 下拉列表字体 | **12px**（与设置弹窗全局控件字号一致，选中态与下拉项一致） |
| 快速模型 | `isFast === true` 的模型显示 **「快速」** 胶囊标签（样式与「默认模型」下拉对齐，共用 `ConfigModelOptionContent`） |
| 排序 | **快速模型排在最前**，组内相对顺序不变 |
| popup 样式 | 与其它 Select 共用 `CONFIG_MODAL_SELECT_POPUP`（`config-modal-select-popup`）；Stagehand 专用类名 `config-stagehand-model-select` 保留 |

#### 6.2.2 单次请求最大推理次数

| 项 | 说明 |
|----|------|
| 可选值 | 2、4、6、8、12、16 |
| 默认值 | 8 |
| 计数 | 仅 `observe` + `extract` + `act` |
| 范围 | 单条用户消息触发的 tool chat 循环（`requestId`）；新用户消息清零 |
| 超限 | 报错「推理次数已达上限」 |

---

## 7. 运行时行为与超时

### 7.1 域名确认时序

```
模型调用 browser.navigate
  → browserActionNeedsConfirmation?
       可信域名 / 会话已信任 → 否 → 直接执行
       否则 → 是 → 聊天确认卡片
  → 用户批准 → toolUserConfirmed=true → validateUrl 通过 → page.goto
  → rememberBrowserSessionTrustedUrl（本会话同站免确认）
```

### 7.2 操作超时实现

```ts
const navTimeout = cfg.actionTimeoutSec * 1000
```

应用于 `page.goto`、`stagehand.observe/extract/act` 的外层 `withTimeout`。

---

## 8. 配置迁移与兼容

### 8.1 加载时（ConfigModal open）

```ts
trustedDomains = unique(trustedDomains ∪ allowedDomains)
allowedDomains = []
browser.enabled = true  // UI 与保存均不再暴露 browser 总开关
```

### 8.2 保存时

```ts
browser: { ...browserUi, enabled: true, allowedDomains: [] }
tools: { enabled: true, allowedTools: [], deniedTools, ... }
```

### 8.3 类型保留

`BrowserConfig.allowedDomains` 字段保留于 `domainTypes` 与 `mergeBrowserConfig`，用于读取旧配置并迁移，**不在 UI 暴露**。

### 8.4 旧 browser.enabled

`browser.enabled === false` 且 `browser` 不在 `deniedTools` 中时，加载时追加 `deniedTools += 'browser'`。

---

## 9. 设置界面视觉与组件统一

本迭代在工具/网络访问改动之外，对设置弹窗做了视觉与结构统一，避免各 Tab 样式割裂。

### 9.1 共享字段组件

新增 `ConfigField.tsx`，供网络访问、飞书、Wiki 等 Tab 复用：

| 组件 | 用途 |
|------|------|
| `ConfigField` | 标签 + 可选 hint + 控件区（`config-field__label` / `config-field__hint` / `config-field__control`） |
| `ConfigSwitchRow` | 标签与 Switch 同一行，下方可选 hint |
| `ConfigSettingsStack` | 垂直间距统一的字段栈（`config-settings-stack`） |

`BrowserSettingsTab` 已改用上述组件；可信域名、允许 HTTP、操作超时等项的 hint 通过 `hint` 属性展示。

### 9.2 设置弹窗字号与控件

| 范围 | 规则 |
|------|------|
| `.config-modal` 内表单、Select、Input、Table、Alert 等 | **12px** |
| 区块标题 `.config-section-title` | **13px** |
| 按钮 `.config-modal .ant-btn` | **12px** |
| Select 下拉 popup | 统一 `popupClassName={CONFIG_MODAL_SELECT_POPUP}`（`configModalUi.ts`） |

### 9.3 大模型服务 Tab 深色模式

`llm-service-card.css` 中服务卡片背景、边框、文字色改用 `--sa-*` 主题变量（如 `--sa-bg-elevated`、`--sa-border-strong`、`--sa-text`），修复深色模式下卡片仍显示为白底的问题。

### 9.4 Skill Tab 区头操作按钮

「Skill 管理」标题行右侧操作按钮与「默认模型」行一致：

- **仅图标** + `Tooltip` + `aria-label`（`size="small"`、`ant-btn-icon-only`）。
- 「打开目录」：`Tooltip title="打开目录"`。
- 本地安装见 [§10](#10-skill-tab-安装按钮文案)。

---

## 10. Skill Tab 安装按钮文案

与 [skills-requirement.md](./skills-requirement.md) §7.2.2 中「安装 Skill」图标的语义区分：

| 入口 | 文案 | 行为 |
|------|------|------|
| Skill 管理标题行 · 下载图标按钮 | **安装本地 Skill**（Tooltip + `aria-label`） | 系统目录选择器，安装用户选中的本地 Skill 目录 |
| 推荐列表 · 操作列按钮 | **安装** | 从推荐源（如 GitHub）拉取并安装 |

避免用户将「从推荐列表一键安装」与「从本机目录安装」混淆。

---

## 11. 验收标准

### 11.1 设置页

- [ ] 设置主 Tab 无独立「浏览器」；工具 Tab 含子 Tab「工具开关 / 文件操作 / 脚本执行 / 网络访问」
- [ ] 工具开关子 Tab：每工具含用途与「关闭后」说明；文案来自 `builtinToolSettingsCopy`
- [ ] 文件操作 · 文件写入确认模式 diff 选项文案为「展示文件修改内容」
- [ ] 网络访问 Tab 无顶部 info Alert；进入子 Tab 才 detect；检测标题行含刷新图标
- [ ] 无「预批准域名」；可信域名 helper 文案正确
- [ ] 「操作引擎（Stagehand）」分组含大模型选择与推理次数
- [ ] Stagehand 模型下拉：12px、快速标签、快速模型置顶；popup 使用 `CONFIG_MODAL_SELECT_POPUP`
- [ ] 允许 HTTP 默认开，备注正确；无头模式备注为一行
- [ ] 「空闲自动关闭浏览器组件，释放内存（秒）」标题正确
- [ ] 设置弹窗内 Input/Select/按钮等为 12px；大模型服务卡片深色模式背景正常
- [ ] Skill 管理区：标题行「安装本地 Skill」；推荐列表操作列仍为「安装」

### 11.2 域名策略

- [ ] 非可信域名首次 navigate 出现确认卡片，批准后打开
- [ ] 同会话同站第二次 navigate 不再确认
- [ ] 可信域名列表内 navigate 不弹确认
- [ ] 预批准域名不再参与校验；旧 `allowedDomains` 已合并进 `trustedDomains`

### 11.3 超时与配额

- [ ] `actionTimeoutSec=180` 时 navigate/observe/extract/act 可等待至 180 秒（无 90 硬顶）
- [ ] `maxInferencesPerRequest` 超限返回明确错误

### 11.4 测试

- [ ] `electron/browser/urlSecurity.test.ts` 覆盖新域名规则
- [ ] `electron/tools/browserExecutor.test.ts` 覆盖确认/禁用/超时相关路径
- [ ] `src/renderer/components/Config/ConfigModelOption.test.ts` 覆盖快速模型排序
- [ ] `src/shared/builtinToolSettingsCopy.test.ts` 覆盖工具说明文案完整性

---

## 12. 相关文件

| 区域 | 文件 |
|------|------|
| 工具 Tab 容器 | `src/renderer/components/Config/ToolsSettingsTab.tsx` |
| 网络访问设置 UI | `src/renderer/components/Config/BrowserSettingsTab.tsx` |
| 共享字段组件 | `src/renderer/components/Config/ConfigField.tsx` |
| Select popup 常量 | `src/renderer/components/Config/configModalUi.ts` |
| 设置弹窗 / 迁移 | `src/renderer/components/Config/ConfigModal.tsx` |
| 模型选项组件 | `src/renderer/components/Config/ConfigModelOption.tsx` |
| 大模型服务卡片样式 | `src/renderer/components/Config/llmServiceCard.css` |
| Skill 管理 UI | `src/renderer/components/Config/SkillsTab.tsx` |
| 内置工具设置文案 | `src/shared/builtinToolSettingsCopy.ts` |
| 样式 | `src/renderer/theme/layout.css` |
| 域名校验 | `electron/browser/urlSecurity.ts` |
| 确认策略 | `electron/browser/browserActionPolicy.ts` |
| 会话信任 | `electron/browser/browserSessionTrust.ts` |
| browser 执行 | `electron/tools/browserExecutor.ts` |
| 工具循环 | `electron/toolChatLoop.ts` |
| 默认配置 | `src/shared/domainTypes.ts` |
| 工具定义 | `src/shared/builtinToolDefinitions.ts` |
| detect 共享 | `src/renderer/store/browserDetectSlice.ts`、`src/renderer/hooks/useBrowserDetect.ts` |
| 安装引导 | `src/renderer/components/Browser/BrowserSetupGuide.tsx` |

---

**修订说明：** 本需求 supersede 原 [web-browser-tools-requirement.md](./web-browser-tools-requirement.md) 中关于 `allowedDomains` 空白名单禁止 navigate、预批准域名 UI 及 `actionTimeoutSec` 90 秒硬上限的描述；冲突时以本文为准。Skill 管理区「安装本地 Skill」文案以本文 §10 为准，与 [skills-requirement.md](./skills-requirement.md) §7.2.2 中「安装 Skill」指本地目录安装时以本文更新后的命名为准。
