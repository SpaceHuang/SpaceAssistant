# 设置页 UI 精简与交互优化 — 需求规格

**版本：** 1.0  
**日期：** 2026-05-30  
**状态：** 已实现  
**关联文档：** [settings-requirement.md](./settings-requirement.md)、[llm-service-profiles-requirement.md](./llm-service-profiles-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-05-30 | 汇总默认大模型设置、大模型服务、Skill Tab 的本轮交互与配置精简 |

---

## 目录

1. [概述](#1-概述)
2. [默认大模型设置 Tab](#2-默认大模型设置-tab)
3. [大模型服务 Tab](#3-大模型服务-tab)
4. [Skill Tab](#4-skill-tab)
5. [配置与常量变更](#5-配置与常量变更)
6. [数据迁移与兼容](#6-数据迁移与兼容)
7. [验收标准](#7-验收标准)
8. [相关文件](#8-相关文件)

---

## 1. 概述

### 1.1 背景

设置页中「默认大模型设置」「大模型服务」「Skill」三个 Tab 存在以下问题：

- 默认模型以多行列表 + 多项开关/复选框呈现，操作路径长，与「选一个默认模型」的实际诉求不匹配。
- Temperature、全局 max tokens 兜底等配置与「按模型条目管理参数」职责重叠，且 Temperature 不宜作为全局统一值。
- 大模型服务卡片中 API Key 输入框后缀图标换行，视觉错位。
- Skill Tab 中「全局禁用」与列表内启用开关重复；产品内置 Skill 暴露给用户无管理必要；「扫描 Skill」按钮与进入 Tab 自动扫描重复。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 将默认模型选择简化为**单个下拉框**，选中项即默认模型 |
| G2 | 移除用户可配的全局 Temperature 与 max tokens 兜底，改为**代码级默认常量** + **模型条目级参数** |
| G3 | 优化默认模型下拉框、快速标签、添加模型弹窗的**视觉与文案** |
| G4 | 修复大模型服务 Tab API Key 输入框后缀布局 |
| G5 | 精简 Skill Tab：隐藏产品内置 Skill、去掉全局禁用与手动扫描按钮 |

### 1.3 非目标

- 不改变 Skill 路由、匹配、安装/删除的后端逻辑（仅调整设置页展示与入口）
- 不为每套大模型服务维护独立模型列表
- 不在本需求中修改 Wiki Tab 或工具 Tab

---

## 2. 默认大模型设置 Tab

### 2.1 默认模型选择（原「模型列表」）

#### 2.1.1 交互变更

| 原行为 | 新行为 |
|--------|--------|
| 多行列表：启用开关、默认/快速复选框、删除按钮 | **单个 Select 下拉框** |
| 通过复选框指定默认模型 | **下拉框当前选中项 = 默认模型**（`isDefault: true`） |
| 区块标题「模型列表」 | 区块标题 **「默认模型」** |

#### 2.1.2 下拉项展示

每个选项（含收起态选中标签）包含：

| 元素 | 说明 |
|------|------|
| 模型名称 | 主标题，加粗，过长省略 |
| 上下文 / 输出 Tokens | 副文案，如 `上下文 1M · 输出 384K` |
| 「快速」标签 | 仅 `isFast === true` 时显示；胶囊形态 + 闪电图标 + 主题色 |

#### 2.1.3 下拉框布局

| 需求点 | 描述 |
|--------|------|
| 收起高度 | `min-height: 54px`，上下内边距 8px，两行信息不拥挤 |
| 垂直对齐 | 选中内容（`ant-select-selection-item`）与下拉箭头均在框内**垂直居中** |
| 标题行 | 「默认模型」标签与 **恢复默认**、**添加** 按钮同一行，按钮**右对齐** |
| 与下方间距 | 默认模型区块与「默认开启 Thinking」之间 `margin-bottom: 40px` |

#### 2.1.4 保留操作

| 按钮 | 行为 |
|------|------|
| 恢复默认 | 将模型列表重置为内置 `DEFAULT_MODELS` |
| 添加（+） | 打开 Popover，添加自定义模型（见 §2.3） |

#### 2.1.5 移除的列表能力

以下能力从列表 UI 中移除（数据字段仍保留在 `ModelEntry` 中，供运行时解析）：

- 单行启用/禁用 Switch
- 行内「默认」「快速」复选框
- 行内删除按钮

### 2.2 内置默认模型

恢复默认或首次使用时，**默认选中模型**为 `deepseek-v4-pro`（原 `glm-5.1`）。

完整预置列表仍以 `src/shared/domainTypes.ts` 中 `DEFAULT_MODELS` 为准；仅 `isDefault` 标记变更。

### 2.3 添加模型 Popover

| 字段 | 要求 |
|------|------|
| **模型名称** | 有字段标题；placeholder：`（按照您的服务商提供的模型名称填写）` |
| **最大上下文** | 有字段标题；可留空，留空时默认 **200K**（`200_000`） |
| **最大输出** | 有字段标题；可留空，留空时默认 **64K**（`64_000`） |
| **说明文案** | 两数值输入框下方：`用于帮助 Agent 更好的管理上下文。若您不确定，可以留空。` |
| **快速模型** | 复选框文案：`标注为快速模型（用于处理低成本简单任务）`；不再有「默认」勾选项（默认模型由下拉框决定） |
| **布局** | Popover 宽度约 300px，字段纵向排列，数值两列并排 |

### 2.4 生成参数区精简

#### 2.4.1 移除 Temperature 设置

| 需求点 | 描述 |
|--------|------|
| UI | 移除「Temperature」输入项 |
| 配置存储 | 从 `AppConfig` 与 `config:get` / `config:set` 中移除 `temperature` |
| 运行时 | 各场景按自身规则设置 temperature；未指定时使用常量 **`DEFAULT_LLM_TEMPERATURE = 0.7`** |

说明：主聊天工具循环走 Thinking 模式，通常不传 temperature；Skill 路由、标题生成等场景使用 `temperature: 0` 等专用值。

#### 2.4.2 移除「最大输出 tokens（兜底）」

| 需求点 | 描述 |
|--------|------|
| UI | 移除该表单项 |
| 配置存储 | 从 `AppConfig` 与 `config:get` / `config:set` 中移除 `maxTokens` |
| 运行时解析 | `resolveEffectiveOutputMaxTokens(modelName, models)`：优先匹配模型条目的 `maxTokens`；未匹配时使用 **`DEFAULT_MODEL_MAX_TOKENS = 64_000`** |

#### 2.4.3 表单项顺序

移除上述两项后，Tab 内保留顺序为：

1. 默认模型（下拉 + 恢复默认 / 添加）
2. **默认开启 Thinking**（Switch）
3. （无其他生成参数表单项）

---

## 3. 大模型服务 Tab

### 3.1 API Key 输入框后缀对齐

| 需求点 | 描述 |
|--------|------|
| 问题 | `Input.Password` 的 `ant-input-suffix`（显示/隐藏密码图标）单独占一行 |
| 修复 | `ant-input-affix-wrapper` 使用 `inline-flex` + `align-items: center`；后缀 `position: absolute` + 垂直居中 |
| 范围 | 作用于 `.llm-service-list` 内密码输入框 |

---

## 4. Skill Tab

### 4.1 隐藏产品内置 Skill

| 需求点 | 描述 |
|--------|------|
| 定义 | 产品内置 Skill 名单：`PRODUCT_BUILTIN_SKILL_NAMES = ['llm-wiki']` |
| 判断 | `isProductBuiltinSkill(name)` |
| 隐藏范围 | Skill 管理表格、「始终加载」多选下拉 |
| 运行时 | 内置 Skill 仍由应用自动安装与管理（如 Wiki 初始化），不影响加载与路由 |

### 4.2 移除「全局禁用」

| 原行为 | 新行为 |
|--------|--------|
| 「始终加载」+「全局禁用」两个多选 + 列表内启用 Switch | 仅保留 **「始终加载」** 与列表内 **启用 Switch** |
| 两处均写入 `skills.disabled` | 仅列表 Switch 通过 `skill:toggle-disable` 更新 `skills.disabled` |

### 4.3 移除「扫描 Skill」按钮

| 需求点 | 描述 |
|--------|------|
| UI | 移除「扫描 Skill」按钮 |
| 自动扫描 | 每次**进入 Skill Tab**（含从其他 Tab 切回、重新打开设置后进入）自动执行：清缓存 + `skill:list` 刷新列表 |
| 其他刷新时机 | 安装 Skill、删除 Skill 成功后仍自动刷新列表 |
| 保留按钮 | 「安装 Skill」「打开目录」 |

实现：`SkillsTab` 接收 `active={open && settingsActiveTab === 'skills'}`，`active` 为 true 时触发 `loadSkills()`。

---

## 5. 配置与常量变更

### 5.1 新增共享常量（`src/shared/domainTypes.ts`）

| 常量 | 值 | 用途 |
|------|-----|------|
| `DEFAULT_LLM_TEMPERATURE` | `0.7` | 未单独指定 temperature 的场景 |
| `DEFAULT_MODEL_MAX_CONTEXT` | `200_000` | 添加模型留空时的默认上下文 |
| `DEFAULT_MODEL_MAX_TOKENS` | `64_000` | 添加模型留空时的默认输出；模型列表未匹配时的输出兜底 |
| `PRODUCT_BUILTIN_SKILL_NAMES` | `['llm-wiki']` | 设置页隐藏的 product builtin Skill |

### 5.2 AppConfig 字段变更

| 字段 | 变更 |
|------|------|
| `temperature` | **移除**（不再暴露给 UI 与 config API） |
| `maxTokens` | **移除**（同上） |
| `models` | 保留 |
| `thinkingEnabled` | 保留 |

### 5.3 API 签名变更

```typescript
// resolveEffectiveOutputMaxTokens — 移除第三参数 configMaxTokens
resolveEffectiveOutputMaxTokens(modelName: string, models: ModelEntry[] | undefined): number
```

---

## 6. 数据迁移与兼容

| 场景 | 行为 |
|------|------|
| 已有 `config.temperature` | 不再读取；运行时走 `DEFAULT_LLM_TEMPERATURE` 或场景专用值 |
| 已有 `config.maxTokens` | 不再读取；运行时走模型条目或 `DEFAULT_MODEL_MAX_TOKENS` |
| 已有 `config.models` 且默认仍为 glm-5.1 | **不自动迁移**；用户可点「恢复默认」或在下拉框手动选择 `deepseek-v4-pro` |
| `skills.disabled` | 配置项保留；仅移除全局禁用 UI，列表 Switch 行为不变 |

---

## 7. 验收标准

### 7.1 默认大模型设置

- [ ] 默认模型以单下拉展示；切换选项后保存，`isDefault` 与 `config.defaultModel` 同步更新
- [ ] 下拉收起/展开态均显示名称、Tokens、快速标签（若适用）
- [ ] 下拉内容与箭头垂直居中；与 Thinking 开关间距明显
- [ ] 恢复默认后默认模型为 `deepseek-v4-pro`
- [ ] 添加模型：仅填名称留空数值时，上下文 200K、输出 64K
- [ ] 设置页无 Temperature、无「最大输出 tokens（兜底）」
- [ ] 「默认开启 Thinking」位于默认模型区块下方

### 7.2 大模型服务

- [ ] API Key 密码框右侧眼睛图标与输入内容同一行、右对齐

### 7.3 Skill

- [ ] 列表与「始终加载」中不出现 `llm-wiki`
- [ ] 无「全局禁用」多选；列表 Switch 可禁用/启用 Skill
- [ ] 无「扫描 Skill」按钮；进入 Tab 时列表自动加载
- [ ] 安装/删除 Skill 后列表自动更新

---

## 8. 相关文件

| 文件 | 变更摘要 |
|------|----------|
| `src/renderer/components/Config/ConfigModal.tsx` | 默认模型 UI、移除 Temperature/maxTokens 表单项、SkillsTab `active` 传参 |
| `src/renderer/components/Config/SkillsTab.tsx` | 隐藏内置 Skill、移除全局禁用与扫描按钮、Tab 激活时加载 |
| `src/renderer/components/Config/llmServiceCard.css` | API Key 后缀 flex 布局 |
| `src/renderer/theme/layout.css` | 默认模型下拉、快速标签、添加模型 Popover 样式 |
| `src/shared/domainTypes.ts` | 默认模型、常量、AppConfig 字段 |
| `src/shared/llm/outputMaxTokens.ts` | 输出 tokens 解析逻辑 |
| `electron/appIpc.ts` | config get/set 移除 temperature、maxTokens |
| `electron/database.ts` | 会话创建默认 temperature 使用 `DEFAULT_LLM_TEMPERATURE` |

---

*本文档描述 2026-05-30 设置页交互精简的实现规格，后续若 `settings-requirement.md` 与本文冲突，以本文及当前代码为准。*
