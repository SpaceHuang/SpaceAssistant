# i18n 第四期：收尾与验证 — 设计文档

> 日期：2026-06-03
> 分支：`feat/i18n`（worktree：`.worktrees/feat-i18n`）
> 基线：`a5a3b8b`（第一～三期已完成，913/913 测试全绿）

## 1. 概述

本文档定义 i18n 第四期（收尾与验证）的详细设计方案。前三期已完成 8 个命名空间的全量翻译资源落地、52 个组件的 i18n 接入、16 个错误码的主进程适配。第四期聚焦遗留的代码改造、Electron 原生菜单、CI 集成与文档收尾。

## 2. 子阶段划分

### 2.1 子阶段 A：代码改造

#### 任务 A1：`formatChatTimestamp` 国际化

**文件：** `src/renderer/components/Chat/formatChatTimestamp.ts`

**当前问题：** 使用 `date.toLocaleString(undefined, opts)`，locale 跟随操作系统而非 i18next 语言设置。英文界面下仍可能显示中文日期格式。

**改造方案：** 将 `undefined` 替换为 `i18next.language`：

```typescript
// 改造后
import i18next from 'i18next'

export function formatChatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
  return date.toLocaleString(i18next.language, opts)
}
```

**测试增强：** 当前 `formatChatTimestamp.test.ts` 仅有 2 个弱断言（"含数字"）。改造后需：

1. 在测试中 mock `i18next.language`，分别设为 `'zh-CN'` 和 `'en-US'`
2. 验证中文 locale 输出格式（如 `6/3 14:30` 含 `/` 不含 AM/PM）
3. 验证英文 locale 输出格式（如 `6/3, 2:30 PM` 含 AM/PM）
4. 保持"当天仅显示时间"的行为验证

**影响面：** 仅 `ChatBubble.tsx` 一处调用方，无接口变化。

---

#### 任务 A2：`browserSetupGuideContent.ts` 工厂化 + `BrowserSetupGuide.tsx` 迁移

**文件：**
- `src/shared/browserSetupGuideContent.ts`（改造）
- `src/shared/browserSetupGuideContent.test.ts`（改造）
- `src/renderer/components/Browser/BrowserSetupGuide.tsx`（迁移 + 新增硬编码）
- `src/renderer/components/Browser/BrowserSetupGuide.test.tsx`（新增/改造）

**当前问题：**
1. `buildBrowserSetupGuideContent()` 返回约 15 处硬编码中文
2. `BrowserSetupGuide.tsx` 组件内还有约 20 处硬编码中文 JSX 文案

**改造方案：**

##### A2a：`buildBrowserSetupGuideContent` 工厂化

新增第三个参数 `t: (key: string, options?: Record<string, string>) => string`：

```typescript
export function buildBrowserSetupGuideContent(
  detect: BrowserDetectResult,
  platform: string,
  t: (key: string, options?: Record<string, string>) => string
): BrowserSetupGuideContent
```

所有中文文案替换为 `t('browser.setup.xxx')` 调用。`buildDiagnosticText()` 保持英文不变（技术诊断信息）。

##### A2b：新增翻译 key

在 `zh-CN/feishu.json` 和 `en-US/feishu.json` 中新增 `browser.setup` 命名空间分支：

```json
// zh-CN
"browser": {
  "setup": {
    "okTitle": "浏览器依赖已就绪",
    "fixTitle": "浏览器依赖修复",
    "okSummary": "Chromium 已就绪，可以使用浏览器工具。",
    "depNotReady": "浏览器依赖未就绪",
    "nodeTooLow": "应用内置 Node 版本过低，请升级 SpaceAssistant。",
    "terminalHintWin": "打开 Windows Terminal 或 PowerShell",
    "terminalHintMac": "打开「终端.app」",
    "terminalHintLinux": "打开终端",
    "cwdDescription": "请在下方目录打开终端（应用安装位置）",
    "troubleshootNetworkTitle": "网络",
    "troubleshootNetworkBody": "安装需联网下载约 150–200MB。若使用代理，请确保终端可访问 cdn.playwright.dev。",
    "troubleshootDiskTitle": "磁盘空间",
    "troubleshootDiskBody": "请至少预留 500MB 可用空间。",
    "troubleshootStillFailTitle": "仍失败",
    "troubleshootStillFailBody": "可点击「复制诊断信息」并将内容用于排查（不含 API Key）。",
    "troubleshootDefenderTitle": "Windows 杀毒",
    "troubleshootDefenderBody": "Windows Defender 可能隔离 %LOCALAPPDATA%\\ms-playwright 下的 chrome.exe，请添加排除项或允许运行后重试。",
    "troubleshootGatekeeperTitle": "macOS Gatekeeper",
    "troubleshootGatekeeperBody": "首次运行 Chromium 可能提示无法验证开发者。请到「系统设置 → 隐私与安全性」允许，或参考 Playwright 文档移除隔离属性。",
    "troubleshootCacheMacTitle": "缓存位置",
    "troubleshootCacheMacBody": "Playwright 默认将浏览器下载到 ~/Library/Caches/ms-playwright/",
    "troubleshootCacheLinuxTitle": "缓存位置",
    "troubleshootCacheLinuxBody": "Playwright 默认将浏览器下载到 ~/.cache/ms-playwright/"
  }
}
```

对应 en-US 翻译。

##### A2c：`BrowserSetupGuide.tsx` 组件迁移

组件内约 20 处硬编码中文，使用 `useTypedTranslation('feishu')` 替换。涉及：
- "网络访问功能正常" → `t('browser.setup.xxx')`（新增 key 或复用）
- "收起" → 复用 `chat.confirm.collapsible.collapse`
- "安装步骤"、"复制目录"、"执行安装命令"、"完成后点击「重新检测」" 等
- "在终端中打开"、"重新检测"、"复制全部步骤"、"复制诊断信息"
- "覆盖损坏安装（进阶）"、"安装很慢 / 失败？查看故障排除"
- 状态文案："已安装"、"未安装"、"已就绪"、"（应用内置）✓"

其中状态文案（"已安装"/"未安装"/"已就绪"）属于通用组件状态，考虑放到 `common` 或 `feishu.browser` 下。

##### A2d：调用方适配

| 调用方 | 翻译函数来源 |
|--------|------------|
| `BrowserSetupGuide.tsx` | `useTypedTranslation('feishu')` 的 `t` |
| `browserSetupGuideContent.test.ts` | mock `t = (k) => k`（返回 key 本身即可验证结构） |

---

### 2.2 子阶段 B：Electron 原生菜单

**文件：**
- `electron/menu.ts`（改造）
- `src/shared/menuLabels.ts`（新增）

**方案：** 主进程无法使用 react-i18next，采用标签映射表方案。

1. 新增 `src/shared/menuLabels.ts`：

```typescript
export type MenuLocale = 'zh-CN' | 'en-US'

export const MENU_LABELS: Record<MenuLocale, {
  file: string
  view: string
  help: string
  closeWindow: string
  quit: string
  devTools: string
  settings: string
  about: string
  docs: string
}> = {
  'zh-CN': {
    file: '文件',
    view: '查看',
    help: '帮助',
    closeWindow: '关闭窗口',
    quit: '退出',
    devTools: '开发者工具',
    settings: '设置',
    about: '关于',
    docs: '文档'
  },
  'en-US': {
    file: 'File',
    view: 'View',
    help: 'Help',
    closeWindow: 'Close Window',
    quit: 'Quit',
    devTools: 'Developer Tools',
    settings: 'Settings',
    about: 'About',
    docs: 'Documentation'
  }
}
```

2. `electron/menu.ts` 改造：
   - `setupAppMenu()` 接收 `locale: MenuLocale` 参数
   - 根据 locale 从 `MENU_LABELS` 取标签
   - 暴露 `rebuildMenu(locale)` 函数供 IPC 调用

3. 语言切换时触发菜单重建：
   - 渲染进程切换语言 → IPC `config:set` → 主进程 `rebuildMenu(locale)`
   - 或在 `appIpc.ts` 的 `config:set` handler 中自动调用

**注意：** macOS 的 `app.name` 和 `role` 菜单项（`about`、`services`、`hide` 等）由系统自动本地化，无需手动翻译。

---

### 2.3 子阶段 C：收尾验证

#### 任务 C1：`i18n:check` strict 模式

**当前状态：** `scripts/i18n-check.ts` 已支持 `--strict-hardcoded` flag，当前 509 warn。

**动作：**
1. 任务 A2 完成后，`browserSetupGuideContent.ts` 中文移除，预计 warn 降至 ~470
2. 在 `package.json` 新增 script：`"i18n:check:strict": "tsx scripts/i18n-check.ts --strict-hardcoded"`
3. 第四期不要求 0 warn（测试 fixture 中文、注释中文等合法存在），但需确认剩余 warn 均为可接受类别
4. 对剩余 warn 做分类审计：测试 fixture / 注释 / 真正遗漏，输出审计报告

#### 任务 C2：英文校对

**范围：** 8 个 en-US JSON 文件（common、chat、config、errors、fileTree、search、feishu、wiki）

**校对维度：**
- 术语一致性（如 Session/Conversation、Tool Call/Tool Invocation 统一）
- 语法正确性
- 自然度（非机翻感）
- 与术语表（附录 A）对齐

**方式：** 逐文件 Review，修正不自然或错误的翻译。

#### 任务 C3：CI 接入

在 `.github/workflows/` 中新增或修改现有 CI 配置：

```yaml
- name: i18n checks
  run: |
    npm run i18n:check
    npm test
```

#### 任务 C4：文档更新

在 `CLAUDE.md` 中补充 i18n 开发规范：
- 新增 UI 文案必须通过 `t()` 使用
- 翻译 key 命名规范（`模块.组件.语义`）
- `zh-CN` 是翻译 key 的真实来源
- `npm run i18n:generate-types` 自动生成类型
- `npm run i18n:check` 检查对齐

---

## 3. 实施顺序

```
A1: formatChatTimestamp 改造 + 测试增强
  ↓
A2: browserSetupGuideContent 工厂化 + BrowserSetupGuide 迁移
  ↓
B:  Electron 原生菜单国际化
  ↓
C1: i18n:check strict 模式启用 + 审计报告
C2: 英文校对（与 C1 可并行）
C3: CI 接入
C4: 文档更新
```

A1 → A2 → B 有依赖关系（逐层递进），C1～C4 之间无强依赖可灵活安排。

## 4. 风险

| 风险 | 缓解 |
|------|------|
| `browserSetupGuideContent` 重构影响主进程调用方 | 当前仅渲染进程调用；主进程调用路径已确认不存在 |
| 菜单重建在 macOS 下行为异常 | macOS `role` 菜单项由系统管理，仅自定义 label 需翻译 |
| 英文校对耗时 | 优先校对高频可见区域（common、chat、config），errors/fileTree/search/feishu/wiki 次之 |
| strict 模式 break CI | 先用 `i18n:check:strict` 独立 script，待稳定后再接入 CI |
