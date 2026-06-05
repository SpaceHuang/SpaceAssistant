---
name: SpaceAssistant
description: 热情、优雅的暖橙桌面 AI 协作工作台视觉系统
colors:
  primary: "#f06529"
  primary-hover: "#d94e1a"
  primary-subtle: "#fdf0eb"
  primary-muted: "#f5e6dc"
  accent: "#fa8c16"
  accent-subtle: "#fff3e6"
  bg-base: "#faf9f6"
  bg-elevated: "#fefdfb"
  bg-subtle: "#f5f3ef"
  bg-muted: "#eeebe5"
  border: "#e5e0d8"
  border-strong: "#dbd5cc"
  text: "#2d2a26"
  text-secondary: "#6b655e"
  text-tertiary: "#948e87"
  icon: "#857e77"
  icon-hover: "#524b44"
  list-selected-bg: "#f7f0eb"
  list-selected-fg: "#c45a2a"
  success: "#389e0d"
  warning: "#d48806"
  error: "#cf1322"
  code-bg: "#1e1e1e"
  code-text: "#d4d4d4"
  bubble-user: "#fef9f6"
  bubble-user-text: "#2d2a26"
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
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
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
    rounded: "{rounded.xs}"
    size: "22px"
  pane-header:
    backgroundColor: "{colors.bg-subtle}"
    textColor: "{colors.text}"
    typography: "{typography.title}"
    height: "{spacing.pane-header}"
    padding: "0 12px"
  confirm-action-allow-solid:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    size: "30px"
  confirm-action-deny:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.sm}"
    size: "30px"
  list-item-selected:
    backgroundColor: "{colors.list-selected-bg}"
    textColor: "{colors.list-selected-fg}"
    typography: "{typography.label}"
---

# Design System: SpaceAssistant

## 1. Overview

**Creative North Star: "The Warm Workbench"（温暖工作台）**

SpaceAssistant 的视觉系统服务于长时间桌面协作：用户与 Agent 对话、审阅工具调用、确认文件操作、对照项目文件与 Wiki。界面应像清晨有阳光的工作台：有温度、有秩序、不刺眼。精致感来自一致的 `--sa-*` token、紧凑但可读的信息密度，以及 VS Code 式三栏壳上的统一 panel 语言，而非 marketing 式装饰。

色彩策略为 **Committed-light（承诺型浅色）**：暖橙 `#f06529` 是品牌与行动信号，出现在主按钮、链接、Activity Bar 指示、流式状态；大面积 surface 仍是暖调中性底，列表选中与聊天气泡用轻量 tint，避免整屏饱和橙。当前仅 **浅色主题**；代码块与终端保持功能性深色 `#1e1e1e`。

明确拒绝 PRODUCT.md 中的反例：泛 SaaS 营销风、典型 AI 产品腔、冷灰 IDE 克隆、AI 默认暖纸底、信息过载式 badge 与装饰动画。

**Key Characteristics:**

- 三栏 IDE 式壳：48px 活动栏 + 328px 侧栏 + 主聊天区 + 240px 详情栏
- 暖橙 primary + 暖调 neutral（`#faf9f6` 底），非冷灰、非米黄 parchment
- 固定 rem 字号阶梯（11–15px），中文系统字体栈，无 display 字体
- 圆角 8/12/16/20px 阶梯；阴影轻量（`shadow-sm`），禁止 ghost-card
- 工具确认卡片为签名组件：intro → subject → footer，统一 `--sa-chat-*` 壳层
- 列表选中统一 `--sa-list-selected-*`；实心橙仅用于主操作
- 交互 150–250ms，`cubic-bezier(0.22, 1, 0.36, 1)`；所有动画需支持 reduced motion

## 2. Colors

暖橙工作台_palette：中性暖面占屏幕主体，品牌橙与语义色只在需要引导或传达状态时出现。

### Primary

- **Vitality Orange** (`#f06529` / hover `#d94e1a`): 主 CTA（Allow 实心、发送、Activity Bar 选中指示）、链接、流式 badge、focus ring。同一视图中大面积饱和橙底应稀少；列表与气泡不用满橙填充。
- **Orange Wash** (`#fdf0eb` / muted `#f5e6dc`): 选中行淡底、primary-subtle 背景、分段控件轨道 tint。

### Secondary

- **Warm Amber** (`#fa8c16`): 浏览器类确认 accent、次要强调。与 primary 分工：橙 = 默认品牌与主操作；琥珀 = 浏览器/外部上下文与 Shell 风险提示。

### Neutral

- **Warm Canvas** (`#faf9f6`): 应用底与主聊天区背景。色度极低，是暖白而非 cream 纸感。
- **Warm Elevated** (`#fefdfb`): 卡片、elevated panel、Ant Design `colorBgContainer`。
- **Warm Panel** (`#f5f3ef`): Activity Bar、侧栏/详情 panel 底、确认卡 intro 区。
- **Warm Muted** (`#eeebe5`): 分段轨道、section badge、inset surface。
- **Warm Hairline** (`#e5e0d8` / strong `#dbd5cc`): 面板分隔、卡片边框（`--sa-chat-card-border` 再加深一档以保证暖底可辨）。
- **Warm Ink** (`#2d2a26` / secondary `#6b655e` / tertiary `#948e87`): 正文、辅助说明、meta。
- **Warm Icon** (`#857e77` → hover `#524b44`): 工具栏与活动栏图标。

### Semantic

- **Allow Green** (`#389e0d`): diff 新增、成功态（非主 Allow 按钮；主 Allow 用 primary 实心橙）。
- **Risk Amber** (`#d48806`): Shell/高风险确认 accent（`--sa-confirm-risk-accent`）。
- **Deny Red** (`#cf1322`): diff 删除、错误、拒绝 hover 字色。
- **Code Void** (`#1e1e1e` / text `#d4d4d4`): Markdown、确认卡内代码块、终端。不受品牌化浅色影响。

### Named Rules

**The Orange-For-Action Rule.** 饱和暖橙 `#f06529` 实心底仅用于用户明确要触发的事：Allow、发送、打开终端等。导航列表、用户气泡、面板选中用 8–14% primary 的 color-mix tint，不用满橙块。

**The List-Selection Rule.** 会话列表、文件树、引用文件、搜索结果的选中态统一 `--sa-list-selected-bg`（8% primary mix）与 `--sa-list-selected-fg`（82% primary mix 文字），字重 500。禁止各面板各写一套 primary 600 + surface-highlight。

**The Warm-Not-Cream Rule.** 底色 `#faf9f6` 是低 chroma 暖白，不是 AI 默认 parchment/cream。若 surface 看起来像「米黄纸张」，说明 chroma 或 mix 比例错了。

## 3. Typography

**Body Font:** Segoe UI, PingFang SC, Microsoft YaHei, system-ui（系统栈，中文优先）
**Mono Font:** Cascadia Code, IBM Plex Mono, Consolas（路径、diff、代码块）

**Character:** 单一 sans 家族承担全部 UI；通过字重与 11–15px 固定阶梯建立层级。`:root` 启用 Segoe UI OpenType 特性 `cv01–cv03`。中文长文用 `text-wrap: pretty`；panel 标题 letter-spacing 轻微收紧（-0.01em）。

### Hierarchy

- **Title / Pane Header** (600, 13px, line-height 1): 侧栏顶栏、详情分区标题。出现在 40px 高的 header 行内。
- **Body / Chat** (400, 13px, line-height 1.55): 侧栏列表、聊天正文。详情栏 `--sa-detail-font-size: 12px` 为密度例外，line-height ≥1.45。
- **Prose / Assistant** (400, 14px, line-height 1.65): Markdown 正文（`.sa-prose`），assistant 最大宽约 760px。
- **Label** (500, 12px, line-height 1.45): 工具栏文字、列表选中项、表单标签。
- **Meta** (400–600, 10–11px): 消息时间、stat pill、section badge。
- **Mono** (400–500, 11–12px, line-height 1.6): 文件路径、diff、命令预览（`--sa-confirm-command-*`）。

### Named Rules

**The 13px Floor Rule.** 面向用户的可读 UI 字号不低于 13px（详情栏 12px 为密度例外，须保证 line-height ≥1.45）。

**The Single Family Rule.** UI 标签、按钮、数据、标题共用 sans 栈；mono 仅用于代码与路径， never 用于按钮 label。

## 4. Elevation

本系统 **默认扁平偏轻**。深度由暖调 surface 色差（base → subtle → elevated → inset）+ 1px 边框传达；阴影词汇精简。

- **Whisper** (`0 1px 3px rgba(0,0,0,0.07)`): assistant 气泡、聊天卡片（`--sa-chat-card-shadow`）。禁止与粗 border 并用形成 ghost-card。
- **Lift** (`0 4px 16px rgba(0,0,0,0.1)`):  reserved for dropdown/popover（Ant Design 层）。
- **Focus Glow** (`0 0 0 3px` primary 20% mix): focus-visible 辅助，与 2px outline 配合。

用户气泡为暖 tint 底 + 边框，无实心橙 shadow。Assistant 回复用 elevated 卡片壳 + 轻 shadow，不用侧条 accent 装饰。

### Named Rules

**The Flat-By-Default Rule.** 新建 surface rest 态无宽 box-shadow。Hover 仅允许 border-color 加深或 background 微调。

**The No Side-Stripe Rule.** 禁止在卡片、列表项、callout 上用 >1px 的 `border-left/right` 彩色竖条作装饰。选中态用整行 background tint。

## 5. Components

### Buttons

- **Shape:** 小圆角（8px `--sa-radius-sm`）；图标按钮 22×22（xs）、24×24（sm）、28×28（md）、48×48（activity bar）。
- **Icon Default:** 透明底 + `#857e77` 图标；hover `--sa-list-hover-bg` 或 `rgba(128,128,128,0.12)` + `#524b44`；focus `2px solid primary` + glow。
- **Confirm Allow (solid):** 30px 高，8px 圆角，`--sa-primary` 底 + 白字；hover `--sa-primary-hover`。用于写入/Shell/浏览器等主确认。
- **Confirm Deny:** 透明底 + 暖灰边；hover `--sa-list-hover-bg`，危险语境下字色趋 `--sa-error`。

### Chips / Badges

- **Streaming pill:** 11px/500，`--sa-primary` 字色，无大面积橙底。
- **Search type tag:** 10px/500，细边框；session 带 primary tint，file 带 success tint。
- **Section badge:** 10px/600，muted 底 + secondary 字色。

### Cards / Containers

- **Tool Confirm Card:** 12px 圆角，`--sa-chat-card-border` + `--sa-chat-card-shadow`；结构 intro（说明）→ subject（URL/命令/diff）→ footer（Deny + Allow）。内层禁止再嵌套双框；subject 区用 `--sa-chat-inset-bg`。
- **Chat User Bubble:** 暖 tint 底（9% primary mix）+ 暖边框，文字 `--sa-text`；非满橙填充。
- **Chat Assistant / Tool rows:** 统一 `--sa-chat-inset-bg` 壳层；展开区与卡片外轮廓共用 border token。

### Inputs / Fields

- Ant Design 5，`colorPrimary: #f06529`，`borderRadius: 10`，暖底 `--sa-bg-elevated` / `--sa-bg-base`。
- Focus：2px primary outline 或 `--sa-shadow-glow`。
- Composer focus 边框与 glow 走 primary 橙。

### Navigation

- **Activity Bar:** 48px 宽 `--sa-bg-subtle`；选中 primary 色 + 左侧 2px primary 指示条（wayfinding，非装饰 side-stripe）。
- **Pane Header:** 40px 高，split-pane 底，底 border；标题 `--sa-pane-header-title` mix。
- **Segment Control:** inset 轨道（`--sa-surface-inset`），选中项 `--sa-list-selected-*`；禁止 Ant Segmented 滑动 thumb 与自定义选中叠用。
- **File Tree / Session List:** hover `--sa-list-hover-bg`；选中 `--sa-list-selected-bg` + fg，字重 500。

### Signature: Tool Confirm Card

写入/Shell/浏览器/Lark 确认的统一模式：`ConfirmCardDecision` 提供 intro + footer actions；subject 由子组件注入。浏览器 URL 可点击在查看器打开。Allow 实心橙；diff 预览 max-height 240px，新增/删除行用 `--sa-diff-add/remove-*`。

## 6. Do's and Don'ts

### Do:

- **Do** 使用 `--sa-*` token；新样式先查 `tokens.css`，再写组件 CSS。
- **Do** 保持 panel header 40px、activity bar 48px、icon-btn-xs 22px 与现有密度一致。
- **Do** 列表选中、文件树、引用文件、搜索项共用 `--sa-list-selected-*`。
- **Do** 实心橙仅用于主操作；面板 tint 用 color-mix，不用 `#f06529` 满铺列表行。
- **Do** 确认卡遵循 intro → subject → footer，壳层用 `--sa-chat-card-border` / `--sa-chat-inset-bg`。
- **Do** 为所有交互元素提供 `:focus-visible`（2px primary + glow）。
- **Do** 新动画 150–250ms + `--sa-ease-out`，并提供 `prefers-reduced-motion: reduce` 降级。

### Don't:

- **Don't** 使用泛 SaaS 营销风：紫蓝渐变、Hero 大数字、三列同质功能卡片、Eyebrow 全大写分段标题。
- **Don't** 使用典型 AI 产品腔视觉：玻璃拟态默认、标题区渐变、过度圆角（卡片 >20px）堆叠。
- **Don't** 退回冷灰 IDE 克隆（信号蓝 primary、冷灰 `#fafbfc` 底）或 AI 默认 cream/parchment 大面积底。
- **Don't** 在列表/卡片上用 colored side-stripe（>1px 左/右边框）作选中装饰。
- **Don't** 对 Ant Segmented 只改 thumb 颜色却保留滑动层（会产生「色块滑过再消失」的伪影）。
- **Don't** 在 inactive 态使用高饱和 accent 或无关装饰动画。
- **Don't** 新建 ghost-card（1px border + 宽阴影）或卡片内再套一圈 inset 框（双框）。
- **Don't** 用 display 字体、fluid clamp 标题或 >3 套 font-family。
- **Don't** 在 dropdown 容器内用 `overflow: hidden` 裁剪 popover；用 portal/fixed/dialog。
