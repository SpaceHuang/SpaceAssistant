# 多语言国际化架构 — 需求规格

## 1. 概述

本文档定义 SpaceAssistant 的多语言国际化（i18n）架构需求。第一期目标：支持**中文（zh-CN）**与**英文（en-US）**两种语言，建立可扩展的国际化基础设施，为后续语言扩展奠定基础。

### 1.1 动机

- 当前项目界面文案**硬编码为中文**，扫描统计约 263 个文件（渲染进程 133 + 主进程 130）、约 1759 处硬编码中文文本，涵盖 UI 标签、工具提示、错误消息、确认文案、配置面板等
- PRODUCT.md 定义目标用户为「半技术用户」，但界面语言单一限制了非中文用户的使用
- 英文支持是国际化第一步，也是后续多语言扩展的基础

### 1.2 范围

| 维度 | 范围 |
|------|------|
| 首期语言 | zh-CN（中文简体）、en-US（英文） |
| 覆盖区域 | 渲染进程 UI（React 组件）、主进程用户可见文案（IPC 错误消息、通知） |
| 不覆盖 | Electron 原生菜单（初期保持跟随系统）、第三方库内部文案（Ant Design 已有国际化） |
| 切换方式 | 设置面板手动切换 + 首次启动跟随系统语言自动检测 |

---

## 2. 用户故事

### US-01：系统语言自动检测

> **作为** 首次使用 SpaceAssistant 的用户
> **我希望** 应用自动检测我的系统语言并显示对应界面
> **以便** 我不需要手动配置就能看到熟悉的语言

**验收标准：**
- 首次启动时读取 `app.getLocale()` 或 `navigator.language`
- 若系统语言为中文（zh / zh-CN / zh-TW 等），默认使用 zh-CN
- 其他语言默认使用 en-US
- 用户手动切换后，以用户选择为准，不再跟随系统

### US-02：手动切换语言

> **作为** SpaceAssistant 用户
> **我希望** 在设置面板中切换界面语言
> **以便** 我能根据偏好使用中文或英文界面

**验收标准：**
- 设置面板提供语言选择下拉框（中文 / English）
- 切换后即时生效，无需重启
- 选择持久化到配置中（`AppConfig.locale`）
- 切换语言不影响已有会话数据

### US-03：UI 文案全覆盖

> **作为** SpaceAssistant 用户
> **我希望** 界面中所有可见文本都随语言切换而改变
> **以便** 我能完全以所选语言使用应用

**验收标准：**
- 活动栏（Activity Bar）工具提示
- 会话列表（空态文案、操作菜单）
- 聊天区（消息时间戳、流式状态、思考/工具标签）
- 文件树（空态、右键菜单、删除确认弹窗）
- 搜索面板（搜索提示、结果文案）
- 配置面板（所有标签、描述、按钮）
- 确认卡片（写入确认、Shell 确认、浏览器确认）
- 错误消息与通知
- 飞书集成相关文案
- Wiki 面板文案

### US-04：主进程文案覆盖

> **作为** 开发者
> **我希望** 主进程返回给用户的错误消息和通知也支持多语言
> **以便** 用户在不同语言下都能理解系统状态

**验收标准：**
- IPC 错误返回中包含可本地化的错误码/key
- 渲染进程根据当前语言显示对应文案
- 通知（系统托盘、弹窗）文案跟随语言

---

## 3. 技术架构

### 3.1 方案选型

选用 **react-i18next**（基于 i18next 生态），理由：

| 维度 | react-i18next | react-intl | 自研 |
|------|--------------|------------|------|
| React 集成 | 原生 Hook + HOC | 原生 Hook | 需自建 |
| 生态成熟度 | 最广泛（i18next） | 成熟 | 无 |
| 命名空间/分包 | 原生支持 | 需手动拆分 | 需自建 |
| ICU/复数/插值 | 完整支持 | 完整支持 | 需实现 |
| TypeScript 类型安全 | 社区方案 | 较好 | 可控 |
| 包大小 | ~30KB gzip | ~25KB gzip | 0（但维护成本高） |
| 社区/文档 | 优秀 | 优秀 | 无 |

### 3.2 架构层次

```
┌─────────────────────────────────────────┐
│              React 组件层                │
│  useTranslation() Hook / <Trans> 组件    │
├─────────────────────────────────────────┤
│           i18next 核心引擎               │
│  语言检测 → 资源加载 → 插值 → 格式化     │
├──────────────┬──────────────────────────┤
│  翻译资源文件  │   主进程 IPC 适配层       │
│  zh-CN.json  │   错误码 → 文案映射       │
│  en-US.json  │                          │
└──────────────┴──────────────────────────┘
```

### 3.3 资源文件结构

```
src/renderer/i18n/
├── index.ts                  # i18next 初始化 + 配置
├── resources/
│   ├── zh-CN/
│   │   ├── common.json       # 通用 UI：按钮、标签、状态
│   │   ├── chat.json         # 聊天：消息、思考、工具调用
│   │   ├── fileTree.json     # 文件树：右键菜单、确认弹窗
│   │   ├── config.json       # 设置面板
│   │   ├── search.json       # 搜索面板
│   │   ├── feishu.json       # 飞书集成
│   │   ├── wiki.json         # Wiki 面板
│   │   └── errors.json       # 错误消息（主进程 + 渲染进程）
│   └── en-US/
│       ├── common.json
│       ├── chat.json
│       ├── ... (镜像结构)
├── types.ts                  # 翻译 key 的 TypeScript 类型定义
└── useTypedTranslation.ts    # 类型安全的 useTranslation 封装
```

### 3.4 命名空间设计

| 命名空间 | 职责 | 示例 Key |
|---------|------|---------|
| `common` | 通用按钮、标签、状态 | `cancel`, `confirm`, `save`, `delete`, `loading` |
| `chat` | 聊天界面全部文案 | `thinking.label`, `tool.allow`, `streaming.inProgress` |
| `fileTree` | 文件树与文件操作 | `contextMenu.open`, `deleteConfirm.title` |
| `config` | 设置面板 | `tabs.general`, `language.label`, `model.add` |
| `search` | 搜索面板 | `placeholder`, `noResults`, `resultCount` |
| `feishu` | 飞书集成 | `status.connected`, `audit.title` |
| `wiki` | Wiki 面板 | `emptyHint`, `import.title` |
| `errors` | 错误消息 | `fileNotFound`, `apiKeyInvalid`, `networkError` |

### 3.5 Key 命名规范

采用**点分命名空间**，遵循 `模块.组件.语义` 层级：

```json
// ✅ 推荐
{
  "chat": {
    "thinking": {
      "label": "思考",
      "expandHint": "展开思考过程",
      "collapseHint": "收起思考过程"
    },
    "tool": {
      "allow": "允许",
      "deny": "拒绝",
      "view": "查看",
      "cancel": "取消执行"
    }
  }
}

// ❌ 避免
{
  "chat_thinking_label": "思考",
  "chatToolAllow": "允许"
}
```

**命名规则：**
- Key 使用 `camelCase`
- 层级最多 4 层
- 复用性高的文案放 `common` 命名空间
- 错误消息 key 以 `error_` 开头

---

## 4. 功能需求

### FR-01：i18next 初始化与配置

**描述：** 应用启动时初始化 i18next 实例，加载对应语言的资源文件。

**规格：**
- 使用 `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- 检测顺序：localStorage 用户选择 → `navigator.language` → 默认 `zh-CN`
- 回退语言：`zh-CN`（当翻译 key 在目标语言缺失时）
- 调试模式：开发环境 `debug: true`，生产环境 `debug: false`
- 支持命名空间懒加载（按需加载非首屏命名空间）

### FR-02：类型安全的翻译 Hook

**描述：** 封装 `useTranslation` 以提供 TypeScript 类型检查。

**规格：**
- 从 `resources/zh-CN/` 自动生成翻译 key 的联合类型
- `useTypedTranslation()` 返回的 `t` 函数仅接受合法的 key
- 插值参数也需类型检查
- 支持 IDE 自动补全翻译 key

```typescript
// 使用示例
const { t } = useTypedTranslation('chat');
t('thinking.label');           // ✅ 类型安全
t('thinking.unknownKey');      // ❌ TypeScript 编译错误
t('thinking.label', { count: 3 }); // ✅ 插值
```

### FR-03：语言切换机制

**描述：** 用户在设置面板切换语言后，界面即时更新。

**规格：**
- 调用 `i18next.changeLanguage(locale)`
- 持久化到 Redux store + localStorage + 主进程配置
- 切换时保留当前页面状态，不触发重新挂载（React `key` 不变）
- 日期/时间格式化同步切换（`Intl.DateTimeFormat` locale 更新）
- Ant Design 的 `ConfigProvider` locale 同步更新

### FR-04：设置面板语言选项

**描述：** 在设置弹窗中添加语言选择控件。

**规格：**
- 位置：「通用」标签页（或新建「外观」标签页）
- 控件类型：Select 下拉框
- 选项：
  - 「中文」(`zh-CN`)
  - 「English」(`en-US`)
- 当前语言高亮
- 切换后立即生效

### FR-05：文案迁移策略

**描述：** 将现有硬编码中文逐步迁移到翻译资源文件。

**规格：**
- **阶段一：提取所有硬编码文案** → 按命名空间归类到 JSON 资源文件
- **阶段二：替换组件中的硬编码文案** → 使用 `t()` 函数或 `<Trans>` 组件
- **阶段三：英文翻译** → 逐命名空间完成英文翻译
- **迁移顺序：** common → chat → config → fileTree → search → feishu → wiki → errors

**文案提取原则：**
- 已使用变量的模板字符串：`\`删除「${name}」?\`` → `t('fileTree.deleteConfirm.title', { name })`
- 带复数/数量的文案：使用 i18next 复数规则 `t('search.resultCount', { count })`
- 组件 props 中的文案：提取到组件顶部或独立常量
- CSS `content` 属性中的文案：迁移到 JSX 中

### FR-06：日期/时间/数字格式化

**描述：** 日期时间和数字格式跟随当前语言。

**规格：**
- 日期时间使用 `Intl.DateTimeFormat`，locale 跟随当前语言
- 中文：`2026年6月2日 14:30` 格式
- 英文：`Jun 2, 2026, 2:30 PM` 格式
- 消息时间戳（列表中的简短格式）也需本地化
- 数字千分位分隔符跟随语言

### FR-07：主进程文案适配

**描述：** 主进程中的用户可见文案支持多语言。

**规格：**
- 主进程不直接引用 i18next（避免 Node.js 端依赖）
- 采用**错误码模式**：主进程返回标准错误码，渲染进程查表显示文案
- 错误响应格式：
  ```typescript
  interface IpcError {
    code: string;       // e.g. 'FILE_NOT_FOUND', 'API_KEY_INVALID'
    params?: Record<string, string | number>; // 插值参数
  }
  ```
- 渲染进程 `errors.json` 维护 `code → 各语言文案` 映射
- 系统通知（Notification API）文案由渲染进程控制

### FR-08：第三方组件库国际化

**描述：** Ant Design 组件的内置文案跟随应用语言。

**规格：**
- 使用 `antd/es/locale/zh_CN` 和 `antd/es/locale/en_US`
- 通过 `ConfigProvider` 的 `locale` prop 注入
- 与应用语言切换联动

**当前状态：** `src/renderer/theme/ThemeProvider.tsx` 已固定引入 `antd/locale/zh_CN` 并传入 `ConfigProvider`。改造时需将其替换为根据当前语言动态选择 locale。

### FR-09：shared 目录文案处理

**描述：** `src/shared/` 目录中包含主进程和渲染进程共享的硬编码中文文案，需特殊处理。

**涉及文件：**
- `src/shared/appMeta.ts`：`APP_TAGLINE`、`APP_DESCRIPTION`
- `src/shared/browserRemotePolicy.ts`：飞书远程策略提示文案
- `src/shared/browserSetupGuideContent.ts`：浏览器安装引导的全部步骤文案（~30 处）
- `src/shared/builtinToolDefinitions.ts`：工具定义的 `description` 字段（发给 LLM，不面向用户，可暂不翻译）

**策略：**
- `appMeta.ts` 文案迁移到 i18n 资源文件
- `browserSetupGuideContent.ts` 重构为接收翻译函数参数
- `builtinToolDefinitions.ts` 的工具描述是发给 LLM 的 prompt，保持英文（LLM 通用语言）

---

## 5. 非功能需求

### NFR-01：性能

| 指标 | 目标 |
|------|------|
| 语言切换响应时间 | < 200ms（不含资源文件首次加载） |
| 资源文件大小（单语言全部命名空间） | < 50KB（未压缩） |
| 首屏加载额外开销 | < 10KB gzip（i18next 核心 + react-i18next） |
| 翻译函数调用开销 | < 0.1ms / 次（可忽略） |

### NFR-02：可维护性

- 翻译 key 缺失时，开发环境 console.warn 提示
- 提供 `npm run i18n:check` 脚本检查：
  - 各语言翻译 key 是否对齐
  - 是否存在未使用的 key
  - 是否存在硬编码中文残留
- 翻译资源文件使用 Prettier 格式化，保持排序一致性

### NFR-03：可扩展性

- 新增语言仅需添加一个资源目录（如 `resources/ja/`），复制 `en-US/` 结构翻译即可
- 命名空间支持按需拆分（如未来新增 `browser` 命名空间）
- 翻译 key 的 TypeScript 类型从 `zh-CN/` 自动推导，新增 key 自动获得类型支持

### NFR-04：兼容性

- 旧会话数据不依赖界面语言，迁移不影响已有数据
- 主进程错误码向后兼容：新增错误码不影响旧版渲染进程（回退到默认文案）
- localStorage 中语言设置 key 使用命名空间前缀避免冲突（`sa_locale`）

---

## 6. 界面规格

### 6.1 设置面板 — 语言选择

| 属性 | 规格 |
|------|------|
| 位置 | 设置弹窗 → 「通用」标签页 → 新增「界面语言」区域 |
| 控件 | Ant Design `Select`，宽度 200px |
| 选项 | `中文` / `English`（以当前语言显示选项名称） |
| 标签 | 「界面语言」/「Interface Language」 |
| 提示 | 「切换后立即生效」/「Takes effect immediately」 |

### 6.2 语言敏感组件的适配要求

| 组件 | 注意事项 |
|------|---------|
| `ChatBubble` | 时间戳格式、流式状态文案、「思考」标签、「生成中」/「失败」状态 |
| `ToolCallCard` | 工具标签文案（`formatToolLabel` 函数需传入 locale） |
| `WriteConfirmCard` | 「允许」「拒绝」按钮 title、「查看」按钮 |
| `PendingConfirmBanner` | 横幅标题、工具标签 |
| `DeleteConfirmModal` | 标题、内容、按钮 |
| `FileTreeContextMenu` | 所有右键菜单项 |
| `SearchPanel` | 搜索框 placeholder、结果统计 |
| `ConfigModal` | 所有标签页、表单标签、描述、验证消息 |
| `SessionListPane` | 空态文案、操作菜单 |
| `SkillHintBubble` | 系统提示文案 |
| `MessageInput` | placeholder、发送提示、中止提示 |

---

## 7. 数据模型

### 7.1 配置扩展

在 `AppConfig` 中新增：

```typescript
interface AppConfig {
  // ...现有字段
  /** 界面语言，遵循 BCP 47 标签 */
  locale: 'zh-CN' | 'en-US';
}
```

- 默认值：首次启动时根据系统语言自动检测
- 持久化位置：数据库 JSON 文件 + localStorage（双写）
- localStorage key：`sa_locale`

### 7.2 语言检测逻辑

```
启动时：
  if (AppConfig.locale 存在且有效):
    使用 AppConfig.locale
  else:
    systemLocale = navigator.language || 'zh-CN'
    if (systemLocale.startsWith('zh')):
      locale = 'zh-CN'
    else:
      locale = 'en-US'
    写入 AppConfig.locale
```

---

## 8. 实施分期

### 第一期：基础设施（预计 3–5 天）

1. 安装 `i18next`、`react-i18next`、`i18next-browser-languagedetector`
2. 创建 `src/renderer/i18n/` 目录结构与初始化代码
3. 实现 `useTypedTranslation` 类型安全封装
4. 创建 `zh-CN/common.json` 和 `en-US/common.json`（通用 UI 文案）
5. 在设置面板添加语言选择控件
6. 在 `AppConfig` 中新增 `locale` 字段
7. 实现语言检测与切换逻辑
8. 对接 Ant Design `ConfigProvider` locale

### 第二期：核心模块迁移（预计 5–8 天）

1. `common` 命名空间 — 全项目通用文案替换
2. `chat` 命名空间 — 聊天界面全部文案
3. `config` 命名空间 — 设置面板全部文案
4. `errors` 命名空间 — 错误消息体系 + 主进程错误码适配

### 第三期：扩展模块迁移（预计 3–5 天）

1. `fileTree` 命名空间 — 文件树与文件操作
2. `search` 命名空间 — 搜索面板
3. `feishu` 命名空间 — 飞书集成
4. `wiki` 命名空间 — Wiki 面板

### 第四期：收尾与验证（预计 2–3 天）

1. 英文翻译校对（建议由英语母语者 Review）
2. `npm run i18n:check` 脚本实现
3. 日期/时间/数字格式化适配
4. 全量回归测试
5. 更新 CLAUDE.md 和开发文档

---

## 9. 风险与约束

### 风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 硬编码中文遗漏 | 部分 UI 在英文模式下仍显示中文 | `i18n:check` 脚本 + CI 检查 + 人工走查 |
| 英文翻译质量不佳 | 英文用户体验下降 | 英语母语者 Review + 翻译术语表 |
| 文案长度变化导致布局溢出 | 英文通常比中文长 30–50% | 关键区域做溢出测试 + flex 弹性布局 |
| i18next 包体积增加 | 首屏加载变慢 | 命名空间懒加载 + Tree shaking |

### 约束

- 翻译 key 命名必须遵循 `模块.组件.语义` 层级
- 所有新增 UI 文案**必须**通过 `t()` 使用，禁止硬编码
- 翻译资源文件的 key 结构必须在各语言间保持一致
- `zh-CN` 是**翻译 key 的真实来源**（TypeScript 类型从它推导）

---

## 10. 验收检查清单

- [ ] 应用首次启动能自动检测系统语言
- [ ] 设置面板可切换语言，切换后即时生效
- [ ] 中文界面所有文案正确显示（与迁移前一致）
- [ ] 英文界面所有文案为正确英文（无中文残留）
- [ ] Ant Design 组件文案跟随应用语言
- [ ] 日期时间格式随语言变化
- [ ] 语言选择持久化（重启后保持）
- [ ] 所有组件在两种语言下无布局溢出
- [ ] 错误消息在两种语言下正确显示
- [ ] `npm run i18n:check` 通过（key 对齐、无硬编码残留）
- [ ] 现有测试全部通过
- [ ] 新增 i18n 相关单元测试覆盖

---

## 11. 附录

### A. 翻译术语表（节选）

| 中文 | English |
|------|---------|
| 会话 | Session |
| 消息 | Message |
| 思考 | Thinking |
| 工具调用 | Tool Call |
| 允许 | Allow |
| 拒绝 | Deny |
| 查看 | View |
| 取消 | Cancel |
| 确认 | Confirm |
| 保存 | Save |
| 删除 | Delete |
| 搜索 | Search |
| 文件树 | File Tree |
| 设置 | Settings |
| 飞书 | Feishu (Lark) |
| 工作区 | Workspace |
| 发送 | Send |
| 中止 | Abort |
| 生成中 | Generating… |
| 失败 | Failed |
| 已拒绝 | Declined |
| 待确认 | Pending Confirmation |

### B. 参考

- [i18next 官方文档](https://www.i18next.com/)
- [react-i18next 文档](https://react.i18next.com/)
- [Ant Design 国际化](https://ant.design/docs/react/i18n)
- [BCP 47 语言标签规范](https://tools.ietf.org/html/bcp47)
- 现有需求文档：[聊天消息 UI 需求](./chat-message-ui-requirement.md)、[设置面板需求](./settings-requirement.md)
