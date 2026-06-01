---
name: SpaceAssistant
description: 温和、专业的桌面 AI 协作工作台视觉系统
colors:
  primary: "#0a84ff"
  primary-hover: "#0066d6"
  primary-subtle: "#e6f2ff"
  accent: "#fa8c16"
  accent-subtle: "#fff3e6"
  bg-base: "#fafbfc"
  bg-elevated: "#ffffff"
  bg-subtle: "#f5f6f8"
  bg-muted: "#eef0f3"
  bg-panel: "#f5f6f8"
  border: "#e8eaed"
  border-strong: "#d9dde3"
  text: "#212121"
  text-secondary: "#737373"
  text-tertiary: "#a6a6a6"
  icon: "#8c8c8c"
  icon-hover: "#434343"
  success: "#389e0d"
  success-subtle: "#f6ffed"
  warning: "#d48806"
  warning-subtle: "#fffbe6"
  error: "#cf1322"
  error-subtle: "#fff1f0"
  code-bg: "#1e1e1e"
  code-text: "#d4d4d4"
  bubble-user: "#0a84ff"
  bubble-user-text: "#ffffff"
typography:
  body:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  body-prose:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.65
    letterSpacing: "normal"
  title:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
  label:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
  meta:
    fontFamily: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  mono:
    fontFamily: "'Cascadia Code', 'IBM Plex Mono', Consolas, 'Courier New', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pane-header: "40px"
  activity-bar: "48px"
  splitter: "4px"
components:
  icon-btn:
    backgroundColor: "transparent"
    textColor: "{colors.icon}"
    rounded: "{rounded.sm}"
    size: "28px"
  icon-btn-hover:
    backgroundColor: "rgba(128, 128, 128, 0.12)"
    textColor: "{colors.icon-hover}"
    rounded: "{rounded.sm}"
    size: "28px"
  icon-btn-xs:
    backgroundColor: "transparent"
    textColor: "{colors.icon}"
    rounded: "5px"
    size: "22px"
  pane-header:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text}"
    typography: "{typography.title}"
    height: "{spacing.pane-header}"
    padding: "0 12px"
  chat-bubble-user:
    backgroundColor: "{colors.bubble-user}"
    textColor: "{colors.bubble-user-text}"
    rounded: "{rounded.lg}"
    padding: "11px 15px"
  confirm-card:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "0"
  confirm-action-allow:
    backgroundColor: "{colors.success-subtle}"
    textColor: "{colors.success}"
    rounded: "{rounded.sm}"
    size: "30px"
  confirm-action-deny:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    size: "30px"
---

# Design System: SpaceAssistant

## 1. Overview

**Creative North Star: "The Patient Workbench"（温和工作台）**

SpaceAssistant 的视觉系统服务于长时间桌面协作：用户与 Agent 对话、审阅工具调用、确认文件操作、对照项目文件与 Wiki。界面应像一位坐在旁边的同事：动作可预期、层级清晰、不抢戏。精致感来自一致的 token、紧凑但可读的信息密度，以及 VS Code 式三栏壳上的统一 panel 语言，而非 marketing 式装饰。

系统采用 **Restrained（克制）** 色策略：冷灰中性面 + 单一品牌蓝 accent（`#0a84ff`）用于主操作、选中态与链接；语义色（绿/黄/红）仅用于 diff、确认与状态。层次靠 surface 色差（`bg-base` → `bg-subtle` → `bg-elevated`）与 1px 边框表达，阴影极少且仅用于必要反馈（用户气泡、分段选中项）。

明确拒绝 PRODUCT.md 中的反例：泛 SaaS 营销风、紫蓝渐变 Hero、玻璃拟态默认、Eyebrow 全大写分段、过度圆角卡片堆叠、与任务无关的装饰动画。

**Key Characteristics:**

- 三栏 IDE 式壳：48px 活动栏 + 328px 侧栏 + 主聊天区 + 240px 详情栏
- 固定 rem 字号阶梯（11–15px），中文系统字体栈，无 display 字体
- 扁平 surface + 边框分层；`shadow-sm` 仅点缀，禁止 ghost-card（边框 + 宽阴影并存）
- 工具确认卡片为签名组件：扁平 header、语义色操作按钮、等宽 diff 预览
- 浅色默认 + `[data-theme='dark']` 完整暗色 token 镜像
- 交互 150–250ms，`cubic-bezier(0.22, 1, 0.36, 1)`；所有新动画需支持 reduced motion

## 2. Colors

冷灰工作台_palette：中性面占 90%+ 屏幕，品牌蓝与语义色只在需要引导或传达状态时出现。

### Primary

- **Signal Blue** (`#0a84ff` / hover `#0066d6`): 主 CTA、链接、Activity Bar 选中指示、树节点选中文字、focus ring、流式状态 badge。稀有而明确：同一视图中 accent 面积应 ≤10%。
- **Signal Blue Wash** (`rgba(10, 132, 255, 0.12)`): 选中行背景、splitter hover、streaming 状态 pill 背景。

### Secondary

- **Warm Amber** (`#fa8c16`): 浏览器类确认卡片 accent、次要强调（非主 CTA）。与主蓝分工：蓝 = 默认工具/导航；琥珀 = 浏览器/外部上下文。

### Neutral

- **Canvas** (`#fafbfc`): 应用底与主聊天区背景。
- **Surface** (`#ffffff`): 侧栏内容区、详情栏、卡片、elevated panel。
- **Panel Tint** (`#f5f6f8`): Activity Bar、详情 panel 底、确认卡片 header（`--sa-confirm-header-bg`）。
- **Muted Fill** (`#eef0f3`): 分段控件轨道、inline code 背景、section badge。
- **Hairline** (`#e8eaed` / strong `#d9dde3`): 面板分隔、卡片边框、树 hover 前的默认边。
- **Ink Primary** (`rgba(0,0,0,0.88)` ≈ `#212121`): 正文与标题。
- **Ink Secondary** (`rgba(0,0,0,0.55)` ≈ `#737373`): 辅助说明、空态、deny 按钮默认字色。
- **Ink Tertiary** (`rgba(0,0,0,0.35)` ≈ `#a6a6a6`): 消息 meta、时间戳。
- **Icon Default** (`#8c8c8c` → hover `#434343`): 工具栏与活动栏图标。

### Semantic

- **Allow Green** (`#389e0d` / bg `#f6ffed`): diff 新增行、允许写入/执行按钮。
- **Deny Red** (`#cf1322` / bg `#fff1f0`): diff 删除行、拒绝/错误态。
- **Risk Amber** (`#d48806`): Shell/高风险确认 accent。
- **Code Void** (`#1e1e1e` / text `#d4d4d4`): Markdown 与确认卡片内代码块。

### Named Rules

**The One Voice Rule.** 品牌蓝是界面唯一的冷色 accent。除语义色（成功/警告/错误/浏览器琥珀）外，禁止引入第二套装饰色或渐变。

**The Flat Header Rule.** 确认卡片、panel header 使用 `--sa-bg-subtle` 纯色底，禁止标题区渐变或 glass blur。

## 3. Typography

**Body Font:** Segoe UI, PingFang SC, Microsoft YaHei, system-ui（系统栈，中文优先）
**Label/Mono Font:** Cascadia Code, IBM Plex Mono, Consolas（路径、diff、代码块）

**Character:** 单一 sans 家族承担全部 UI；通过字重与 11–15px 固定阶梯建立层级，不用 display 字体。中文长文用 `text-wrap: pretty`；panel 标题 letter-spacing 轻微收紧（-0.01em），禁止 display 级负 tracking。

### Hierarchy

- **Title / Pane Header** (600, 13px, line-height 1): 侧栏顶栏、详情分区标题、确认卡片文件名。出现在 40px 高的 header 行内。
- **Body / Chat** (400, 13px, line-height 1.55): 用户气泡、侧栏列表、详情栏继承 `--sa-detail-font-size: 12px` 时略紧凑。
- **Prose / Assistant** (400, 14px, line-height 1.65): Markdown 正文（`.sa-prose`），最大阅读宽度跟随气泡列（assistant max ~760px）。
- **Label** (500, 12px, line-height 1.45): 工具栏文字按钮、表单标签（设置弹窗 `--sa-config-font: 13px`）。
- **Meta** (400–600, 10–11px): 消息时间、stat pill、section badge。Badge 可用 600 + tabular-nums。
- **Mono** (400–500, 11–12px, line-height 1.6): 文件路径、diff 行号、Shiki 块。

### Named Rules

**The 13px Floor Rule.** 面向用户的可读 UI 字号不低于 13px（详情栏 12px 为密度例外，须保证 line-height ≥1.45）。禁止 11px 及以下承载句子级正文。

**The Single Family Rule.** UI 标签、按钮、数据、标题共用 sans 栈；mono 仅用于代码与路径， never 用于按钮 label。

## 4. Elevation

本系统 **默认扁平**。深度由三层 surface 色（base / subtle / elevated）+ 1px 边框传达，而非阴影堆叠。

阴影词汇极简：

- **Whisper** (`0 1px 2px rgba(0,0,0,0.06)`): 用户聊天气泡、分段控件选中项。blur ≤2px，禁止与 1px 装饰边框并用形成 ghost-card。
- **Lift** (`0 4px 12px rgba(0,0,0,0.08)`):  reserved for dropdown/popover（Ant Design 层），自定义卡片 rest 态 **无 shadow**。

Assistant 回复无卡片阴影；左侧 2px accent 竖线（`--sa-chat-assistant-accent`）承担线程视觉锚点（功能性，非装饰 side-stripe）。

Dark 模式 shadow 加深（`0 1px 2px rgba(0,0,0,0.4)`）以保持分隔可读性。

### Named Rules

**The Flat-By-Default Rule.** 新建 surface rest 态无 box-shadow。Hover 仅允许 border-color 加深或 background 微调，禁止 hover 时追加宽阴影。

**The No Ghost-Card Rule.** 禁止在同一元素上同时使用 `border: 1px solid` 与 blur ≥16px 的宽 drop shadow。

## 5. Components

### Buttons

- **Shape:** 小圆角（6px `--sa-radius-sm`）；图标按钮 22×22（xs）、24×24（sm）、28×28（md）、48×48（activity bar）。
- **Icon Primary:** 透明底 + `#8c8c8c` 图标；hover `rgba(128,128,128,0.12)` 底 + `#434343` 图标；active `scale(0.94–0.96)`；focus `2px solid primary` outline-offset 2px。
- **Text Link:** 12px/500 primary 色，hover underline（详情工具栏）。
- **Confirm Allow/Deny:** 30×30 方形按钮，6px 圆角；Allow 绿底绿边；Deny 默认 neutral 边，hover 转红系语义底。

### Chips / Badges

- **Streaming pill:** 10px/600，primary 字色 + primary-subtle 背景，全圆角。
- **Section badge:** 10px/600，muted 底 + secondary 字色，tabular-nums。

### Cards / Containers

- **Confirm Card:** 12px 圆角，1px border，**无 rest shadow**；header 40px 高 subtle 底；现有 3px 左 accent 仅用于工具类型标识（legacy）；新组件禁止添加装饰性 side-stripe。
- **Chat User Bubble:** 12px 圆角（不对称：右下 6px），primary 填充，轻 whisper shadow。
- **Chat Assistant:** 无卡片容器；左 2px accent 边 + 透明底。

### Inputs / Fields

- 基于 Ant Design 5，继承侧栏 12–13px 字号。
- Focus：2px primary outline（自定义按钮）或 Ant Design 默认 focus ring。
- 设置弹窗控件最小高度 32px（`--sa-config-control-min-height`）。

### Navigation

- **Activity Bar:** 48px 宽 subtle 底；图标 24px；选中 primary 色 + 左侧 2px primary 指示条（功能性 wayfinding，非 card accent）。
- **Pane Header:** 40px 高，elevated 底，底 border；标题 13px/600。
- **Segment Control:** muted 轨道 28px 高，选中项 elevated 底 + whisper shadow。
- **File Tree:** 行 hover 8% 灰底；选中 primary-subtle 底 + primary 字色/600。

### Signature: Tool Confirm Card

写入/Shell/浏览器确认的统一模式：header（图标 badge + 文件名 mono + stat pills + allow/deny）+ 可滚动 diff body（max-height 240px，底部 fade gradient）。浏览器变体用 accent 琥珀色；Shell 风险用 warning 色。

## 6. Do's and Don'ts

### Do:

- **Do** 使用 `--sa-*` token；新样式先查 `tokens.css`，再写组件 CSS。
- **Do** 保持 panel header 40px、activity bar 48px、icon-btn-xs 22px 与现有密度一致。
- **Do** 用语义色表达 allow/deny/diff/risk，按钮 label 用动词+对象（「允许写入」「拒绝」）。
- **Do** 为所有交互元素提供 `:focus-visible` 2px primary outline。
- **Do** 新动画使用 150–250ms + `--sa-ease-out`，并提供 `@media (prefers-reduced-motion: reduce)` 降级。

### Don't:

- **Don't** 使用泛 SaaS 营销风：紫蓝渐变、Hero 大数字、三列同质功能卡片、Eyebrow 全大写分段标题（PRODUCT.md 反例）。
- **Don't** 使用典型 AI 产品腔视觉：空洞 buzzword 排版、过度圆角（卡片 >16px）、标题区渐变、玻璃拟态默认。
- **Don't** 在 inactive 态使用高饱和 accent 或大面积装饰色。
- **Don't** 新建 ghost-card（1px border + 宽阴影）或 32px+ 卡片圆角。
- **Don't** 用 display 字体、fluid clamp 标题或 >3 套 font-family。
- **Don't** 添加与状态无关的装饰动画、过多 badge 或信息过载式视觉噪音。
- **Don't** 在 dropdown 容器内用 `overflow: hidden` 裁剪 popover；用 portal/fixed/dialog。
