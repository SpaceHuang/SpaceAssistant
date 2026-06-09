# MarkItDown 文档导入 — 需求规格

**版本：** 1.2  
**日期：** 2026-06-08  
**状态：** 待评审  
**关联文档：** [MarkItDown集成指南.md](../references/MarkItDown集成指南.md)、[context-usage-ring-requirement.md](./context-usage-ring-requirement.md)、[wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md)、[browser-setup-skill-requirement.md](./browser-setup-skill-requirement.md)

**变更记录：**

| 版本 | 日期 | 说明 |
|------|------|------|
| 1.0 | 2026-06-08 | 初稿：聊天输入区「+」导入文件、方案 B 本地 HTTP 微服务、长耗时交互设计 |
| 1.1 | 2026-06-08 | 明确首版不修改 MarkItDown 源码；新增 `markitdown-setup-guide` 修复 Skill（仅出错时触发） |
| 1.2 | 2026-06-08 | **首版（M1）暂不支持图片与音频导入**；收敛支持格式与文件选择器白名单 |

---

## 目录

1. [概述](#1-概述)
2. [问题与目标](#2-问题与目标)
3. [用户故事](#3-用户故事)
4. [用户旅程](#4-用户旅程)
5. [功能范围](#5-功能范围)
6. [入口与界面规格](#6-入口与界面规格)
7. [长耗时交互设计](#7-长耗时交互设计)
8. [转换结果与会话上下文](#8-转换结果与会话上下文)
9. [架构设计（方案 B）](#9-架构设计方案-b)
10. [API 与 IPC 规格](#10-api-与-ipc-规格)
11. [安全要求](#11-安全要求)
12. [配置与依赖](#12-配置与依赖)
13. [依赖修复 Skill](#13-依赖修复-skill)
14. [错误与边界](#14-错误与边界)
15. [与现有能力的关系](#15-与现有能力的关系)
16. [发布计划](#16-发布计划)
17. [验收标准](#17-验收标准)
18. [待解决问题](#18-待解决问题)
19. [相关文件](#19-相关文件)

---

## 1. 概述

### 1.1 背景

SpaceAssistant 当前聊天能力以文本输入为主。用户经常需要基于 **PDF、Word、Excel、PPT** 等办公文档与 Agent 讨论内容，但应用尚不具备将这些格式统一转为 LLM 友好 Markdown 的本地能力。

**首版（M1）范围约定：** 仅支持 **结构化办公文档与文本类文件** 的导入；**图片、音频首版不做**（避免无多模态 / 云端 STT 带来的体验与隐私问题），留待后续版本评估。

[Microsoft MarkItDown](https://github.com/microsoft/markitdown) 可将多种文件格式转换为保留结构的 Markdown，适合作为本地文档解析引擎。集成指南对比了 CLI、HTTP 微服务、python-shell、嵌入式 Python 等方案；**本需求采用方案 B（本地 HTTP 微服务）** 作为运行时架构，并在产品交互、安全边界、长任务体验上按 SpaceAssistant 现状做独立设计，不照搬指南中的示例 UI（独立 DocumentConverter 页面）。

### 1.2 本需求要做什么

在 **消息输入框（composer）** 提供文档导入入口：用户点击模型名称前的 **「+」按钮** → 选择本地文件 → 后台通过 MarkItDown 转为 Markdown → 转换结果作为 **当前会话的可讨论上下文** 挂载，用户可在后续对话中向 Agent 提问、摘要、对比、改写等。

核心体验原则：

- **转换在后台进行**，不阻塞用户浏览历史、切换会话、编辑草稿（除明确互斥场景外）。
- **全程有可见反馈**，5–300 秒的等待必须让用户感知「正在进行」而非「卡死」。
- **渲染进程不直连 HTTP 微服务**，所有转换请求经 Electron 主进程代理，降低本地端口攻击面。

### 1.3 非目标（首版）

| 项 | 说明 |
|----|------|
| 批量多文件同时导入 | 首版一次仅处理一个文件；连续导入排队或拒绝见 §7.4 |
| 拖拽到输入框导入 | 可作为后续增强；首版仅「+」按钮 + 系统文件选择器 |
| YouTube URL / 远程 URL 转换 | MarkItDown 支持但安全风险高；首版仅本地文件 |
| Azure Document Intelligence 云增强 | 可选 Phase 2；首版纯本地转换 |
| 自动写入 Wiki / 工作区文件 | 与 [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md) 分离；用户可后续让 Agent `write_file` |
| 在聊天区渲染完整 Markdown 预览面板 | 首版以附件卡片 + 详情面板只读预览为主 |
| **修改 MarkItDown 源码** | **任何阶段均不考虑**；仅通过 pip 安装官方发行版 |
| 内置 Python / PyInstaller 打包（方案 D） | Phase 3 可选；首版依赖用户/开发环境 Python，缺依赖时走 §13 修复 Skill |
| 设置页长篇安装向导 UI | 首版不做分步静态表单；依赖未就绪时提供「在对话中修复」入口（见 §13） |
| **图片导入**（`.jpg` / `.png` 等） | **M1 不支持**；无 LLM 视觉时产出价值低，后续版本再开 |
| **音频导入**（`.mp3` / `.wav` 等） | **M1 不支持**；默认走 Google 云端 STT，与「本地优先」冲突，后续版本再评估方案 |

---

## 2. 问题与目标

### 2.1 现状缺口

| 用户意图 | 现状 | 缺口 |
|----------|------|------|
| 「帮我总结这份 PDF」 | 需手动复制粘贴或让 Agent 读二进制（不可靠） | 无统一文档解析管线 |
| 导入后接着聊 | 无会话级「已导入文档」概念 | 转换结果无处挂载 |
| 大文件等几分钟 | 无长任务 UI 范式 | 易误判为应用无响应 |
| 隐私敏感文档 | 仅能依赖云端模型自带文件能力 | 缺本地转换选项 |

### 2.2 目标

| ID | 目标 |
|----|------|
| G1 | **一步导入**：composer「+」→ 选文件 → 自动转换，无需离开聊天 |
| G2 | **可讨论**：转换后的 Markdown 进入当前会话上下文，后续用户消息可被 Agent 引用 |
| G3 | **不卡死**：5–300 s 转换全程有阶段反馈、可取消、主界面可交互 |
| G4 | **本地优先**：默认数据不出设备；转换经 127.0.0.1 回环，不触发防火墙弹窗 |
| G5 | **安全可控**：路径白名单、令牌认证、大小/超时限制（见 §11） |
| G6 | **可观测**：上下文环（Context Usage Ring）能反映导入内容对 token 占用的影响（见 §8.4） |
| G7 | **可修复**：依赖缺失或环境异常时，通过对话内 **`markitdown-setup-guide` Skill** 引导安装/修复，模式对齐网络访问与飞书修复（见 §13） |

---

## 3. 用户故事

### US-D01：从输入区导入文档

**作为** 用户，**当** 我在聊天输入框左下角看到模型名称前的「+」按钮，**我希望** 点击后弹出文件选择器并选中一份 Office/PDF 文档，**以便** 无需离开对话即可把资料交给 Agent。

### US-D02：转换过程中仍可操作

**作为** 用户，**当** 一份 80 页的 PDF 需要转换 2 分钟，**我希望** 看到明确的进度状态且仍能滚动查看历史消息、编辑输入框草稿，**以便** 我知道应用仍在工作。

### US-D03：转换完成后继续对话

**作为** 用户，**当** 转换成功，**我希望** 输入框上方出现附件条显示文件名，我发送「请总结第三章」时 Agent 能基于文档回答，**以便** 自然延续讨论。

### US-D04：取消长时间转换

**作为** 用户，**当** 我选错了文件或等待过久，**我希望** 能取消正在进行的转换，**以便** 尽快重新选择。

### US-D05：失败可理解

**作为** 用户，**当** MarkItDown 未安装、格式不支持或文件损坏，**我希望** 看到可操作的中文错误说明（而非静默失败），**以便** 知道如何修复。

### US-D06：移除已导入文档

**作为** 用户，**我希望** 在附件条上移除某份已导入文档，**以便** 释放上下文空间并避免 Agent 继续引用过时内容。

### US-D07：依赖异常时在对话中修复（继承 browser / 飞书模式）

**作为** 用户，**当** 文档转换因 Python 或 MarkItDown 未安装而失败，**我希望** 在当前对话（或设置页一键跳转的新对话）中由 Agent 一步步带我完成安装与复检，**以便** 我不必离开应用查阅 README 或自行排查环境。

---

## 4. 用户旅程

```
用户聚焦当前会话
    │
    ▼
点击 composer 左下角「+」（位于模型 chip 左侧）
    │
    ▼
系统文件选择器（Electron dialog.showOpenDialog）
    │  filters: 支持的扩展名；单选
    ▼
主进程校验路径/大小 → 创建转换任务（jobId）
    │
    ├─► UI：输入区上方出现「转换中」附件条（文件名 + 阶段动画 + 取消）
    │         聊天区顶部可选轻量 Toast：「正在解析 document.pdf…」
    │
    ▼
主进程 HTTP POST → MarkItDown 微服务（127.0.0.1 动态端口）
    │  阶段：排队 → 上传/读盘 → 解析 → 生成 Markdown
    │  耗时：约 5–300 s（视格式与体积）
    │
    ├─ 成功 ─► 附件条变为「已就绪」；Markdown 写入会话附件存储
    │          可选：自动在输入框填入引导语草稿（不自动发送）
    │
    ├─ 失败 ─► 附件条显示错误 + 「重试」「查看帮助」
    │
    └─ 取消 ─► 中止 HTTP 请求 / 通知服务丢弃任务；移除进行中 UI
    │
    ▼
用户输入问题并发送 → Agent 请求携带文档上下文（见 §8）
```

---

## 5. 功能范围

### 5.1 支持格式（M1 首版）

**M1 白名单**（文件选择器 filter、主进程校验与此一致；可在设置中只读展示）：

| 类别 | 扩展名 |
|------|--------|
| 文档 | `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.xls` |
| 网页/数据 | `.html`, `.htm`, `.csv`, `.json`, `.xml` |
| 电子书 | `.epub` |
| 压缩包 | `.zip`（仅一层；嵌套炸弹防护见 §11） |

> **说明：** `.doc`（旧版 Word）等 MarkItDown 不原生支持的格式，即使用户通过「所有文件」选到，也应在 **转换前** 校验扩展名并提示不支持，**不创建转换任务**。

#### 5.1.1 M1 明确不支持（后续版本）

| 类别 | 扩展名 | 延后原因（摘要） |
|------|--------|------------------|
| 图片 | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` 等 | 无多模态 / 无 OCR 配置时几乎无可用文本；需单独产品方案 |
| 音频 | `.mp3`, `.wav`, `.m4a` 等 | MarkItDown 默认依赖 Google 云端 STT，非纯本地；隐私与稳定性待设计 |

后续版本（M3+）再评估：本地 Whisper、用户自配 STT、或 MarkItDown `llm_client` 视觉描述等，**不在 M1 范围**。

### 5.2 文件限制

| 限制项 | 首版默认值 | 可配置 |
|--------|------------|--------|
| 单文件大小上限 | 100 MB | 是（设置 → 文档导入） |
| 单次转换超时 | 300 s | 是 |
| 转换结果 Markdown 最大字符 | 500,000 字符（约） | 是 |
| 单会话同时挂载附件数 | 3 份 | 是 |
| 单会话附件总字符上限 | 与上下文窗口联动，见 §8.4 | — |

### 5.3 服务生命周期

| 事件 | 行为 |
|------|------|
| 应用启动 | 尝试拉起 MarkItDown HTTP 微服务；失败则「+」按钮置灰并 tooltip 说明 |
| 首次转换前 | 健康检查 `/health`；未就绪则等待 ≤3 s 或提示重启 |
| 应用退出 | 优雅 `POST /shutdown` 后 SIGTERM；超时 SIGKILL |
| 服务崩溃 | 主进程检测退出码，最多自动重启 2 次/小时；仍失败则降级 |

---

## 6. 入口与界面规格

### 6.1 入口位置

在 `MessageInput` 的 `composer-footer` 左侧行，**模型 chip（`composer-model-chip`）之前** 增加「+」按钮：

```
composer-footer
├── 左侧行
│   ├── [+] 导入文档          ← 新增
│   ├── [model-chip] 模型名
│   └── hint / hint-trigger
└── 右侧行
    ├── ContextUsageRing
    └── 发送/停止
```

#### 6.1.1 「+」按钮样式

| 属性 | 规格 |
|------|------|
| 尺寸 | 28×28 px 圆形或圆角方，与 `composer-hint-trigger` 视觉权重一致 |
| 图标 | Lucide `Plus`，14px |
| 状态 | default / hover / disabled（服务不可用）/ active（选择器打开） |
| Tooltip | 中文：「导入文档」；disabled 时：「文档转换服务未就绪」 |
| 无障碍 | `aria-label="导入文档"` |

#### 6.1.2 点击行为

1. 调用 IPC `markitdown:pick-file` → 主进程 `dialog.showOpenDialog`。
2. 属性：`properties: ['openFile']`，`filters` **仅** 列出 §5.1 M1 白名单（不提供图片/音频分组）；可选保留「所有文件」，但选到非白名单扩展名时 **主进程前置拒绝**（见 §14）。
3. 默认打开目录：上次导入目录（`appConfig.documentImport.lastDirectory`）或 `app.getPath('documents')`。
4. 用户取消：无 toast，无状态变更。
5. 用户确认：进入 §7 长任务流程。

> **设计说明：** 不采用渲染进程 `<input type="file">`，以便统一路径校验、复用 Electron 原生对话框并与主进程安全策略一致。

### 6.2 附件条（Composer Attachments Strip）

在 `composer-box` 内、**TextArea 上方** 增加附件条（无附件时隐藏）：

```
┌─────────────────────────────────────────────┐
│ 📄 report.pdf  转换中 · 正在解析…  [×]      │  ← 进行中
│ 📄 notes.docx  已导入 · 12.4k 字   [×]      │  ← 已完成
├─────────────────────────────────────────────┤
│ [ TextArea 多行输入… ]                      │
└─────────────────────────────────────────────┘
```

#### 6.2.1 附件卡片字段

```typescript
interface SessionDocumentAttachment {
  id: string
  sessionId: string
  /** 原始文件名（不含路径） */
  fileName: string
  /** 原始绝对路径（仅主进程持久化；渲染进程可选脱敏显示） */
  sourcePath?: string
  /** 文件大小（字节） */
  fileSize: number
  /** 检测到的 MIME / 扩展名 */
  fileType: string
  status: 'queued' | 'uploading' | 'converting' | 'ready' | 'failed' | 'cancelled'
  /** 转换阶段文案 key，供 i18n */
  stageKey?: string
  /** 转换开始/结束时间 */
  startedAt?: number
  completedAt?: number
  /** 失败时的用户可见错误 */
  errorMessage?: string
  /** 转换后的 Markdown（ready 后才有；大文本可只存主进程/磁盘引用） */
  markdown?: string
  /** 若截断，记录原始字符数 */
  originalCharCount?: number
  truncated?: boolean
}
```

#### 6.2.2 卡片交互

| 状态 | 展示 | 操作 |
|------|------|------|
| queued / uploading / converting | 文件名 + 阶段文案 + 不确定进度条（indeterminate） | 「×」取消 |
| ready | 文件名 + 「已导入」+ 近似字数 | 「×」移除；点击文件名 → 详情面板打开 Markdown 预览 |
| failed | 文件名 + 错误摘要 | 「重试」；「×」关闭 |
| cancelled | （卡片移除，不保留） | — |

### 6.3 聊天区辅助反馈（可选但推荐）

在 `chat-message-list` 顶部插入 **非消息类** 的 `DocumentImportStatusBanner`（仅当存在进行中任务时显示）：

- 文案示例：「正在将 `annual-report.pdf` 转为可读文本，您可以继续浏览对话…」
- 右侧：「取消」链接
- 样式：低对比度信息条，不抢占消息流视觉重心
- **不**插入 `Message` 表（避免污染历史）

---

## 7. 长耗时交互设计

> **核心问题：** 转换耗时 5–300 s，若仅禁用「+」按钮或显示全屏 loading，用户会认为应用失去响应。以下为本需求的重点设计。

### 7.1 设计原则

| 原则 | 说明 |
|------|------|
| **非阻塞** | 转换在独立异步任务中执行；不阻塞 UI 线程；不锁死整个 composer（见 7.2） |
| **多重反馈** | 附件条 +（可选）顶部 banner + 主进程心跳阶段更新，任一层可见即可感知进度 |
| **可取消** | 用户可随时取消；取消后 3 s 内 UI 必须回到 idle |
| **诚实等待** | 无真实百分比时用语义化阶段代替假进度条 |
| **超时显式** | 接近 300 s 时提示「即将超时」；超时后给重试入口 |

### 7.2 Composer 可交互性矩阵

| 场景 | TextArea | 发送 | 「+」 | 切换会话 | 滚动历史 |
|------|----------|------|-------|----------|----------|
| 无转换 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 转换进行中 | ✅ 可编辑草稿 | ✅ 可发送（不含未完成附件） | ⚠️ 禁用或排队（见 7.4） | ✅ | ✅ |
| 存在 ready 附件 | ✅ | ✅ 发送时附带附件上下文 | ✅ | ✅（附件随会话） | ✅ |

**关键决策：** 转换进行中 **允许用户发送普通消息**，避免「等文件转完才能说话」。未完成转换的附件 **不会** 进入本次发送的上下文；发送后附件条仍继续转换。

### 7.3 语义化阶段（Indeterminate Progress）

MarkItDown 不提供细粒度进度回调。主进程按 **可观测节点** 推进 `stageKey`：

| 顺序 | stageKey | 用户可见文案（zh-CN） | 触发条件 |
|------|----------|----------------------|----------|
| 1 | `queued` | 排队中… | 任务创建 |
| 2 | `reading` | 正在读取文件… | 开始读盘/接收上传 |
| 3 | `converting` | 正在解析文档… | HTTP 请求已发出 |
| 4 | `finalizing` | 正在整理内容… | 收到响应、写入存储前 |
| 5 | `ready` / `failed` | 已导入 / 转换失败 | 结束 |

**心跳：** 若单一阶段停留 >15 s，UI 在文案后追加「已等待 N 秒」（每 15 s 更新），避免静止感。

**长任务提示阈值：**

- ≥30 s：附件卡片次要色文案「较大文件可能需要几分钟」
- ≥120 s：banner 文案升级为「仍在处理中，您可以先继续提问其他问题」

### 7.4 并发与排队

首版策略（二选一，实现时确认）：

- **推荐 A — 单任务：** 已有进行中任务时，「+」点击 toast「请等待当前文档转换完成」，避免压垮 Python 进程。
- **备选 B — 队列：** 允许排队最多 2 个，FIFO 执行；队列项在附件条显示「排队中」。

默认采用 **推荐 A**，与 MarkItDown 服务 `RATE_MAX_REQUESTS` 限流一致。

### 7.5 取消语义

1. 用户点「×」→ IPC `markitdown:cancel-job`。
2. 主进程 `AbortController` 中止进行中的 `fetch`。
3. 可选：向 Python 服务 `POST /jobs/{id}/cancel`（若实现任务 ID）；否则仅客户端放弃结果。
4. UI 移除附件卡片；若已写临时文件则删除。
5. **不**向聊天历史插入系统消息（减少噪音）；可选 debug 日志。

### 7.6 服务未响应时的降级

若 `/health` 连续 3 次失败（间隔 2 s）：

- 将进行中的任务标记 `failed`，`errorMessage`：「文档转换服务无响应，请重启应用」
- 尝试重启微服务一次；成功则允许用户「重试」

### 7.7 反模式（明确禁止）

| 反模式 | 原因 |
|--------|------|
| 全屏 Modal 阻塞 | 用户无法查看历史或取消 |
| 无超时无限等待 | 300 s 后必须失败 |
| 假 0–100% 进度条 | MarkItDown 无真实进度，误导用户 |
| 转换期间禁用整个 ChatView | 违反 G3 |
| 静默后台失败 | 违反 G3/G5 |

---

## 8. 转换结果与会话上下文

### 8.1 存储策略

转换得到的 Markdown **不默认作为一条用户消息** 展示在聊天气泡中（避免刷屏）。采用 **会话级附件** 模型：

1. **运行时：** Redux `chatSlice` 扩展 `sessionAttachments: Record<sessionId, SessionDocumentAttachment[]>`（或等价结构）。
2. **持久化：** 写入 `Session.metadata.documentAttachments`（仅存元数据 + 磁盘引用）；大文本存 `{userData}/document-imports/{sessionId}/{attachmentId}.md`。
3. **隐私：** 路径仅在主进程可读；渲染进程通过 IPC 按需拉取预览片段。

### 8.2 注入 Agent 上下文的方式

当用户发送消息且当前会话存在 `status === 'ready'` 的附件时，主进程在组装 API 请求前注入 **系统级或用户级前缀上下文**（实现细节二选一，优先 A）：

**方案 A — 追加 user 消息前缀（推荐）**

在真正用户文本前拼接结构化块（仅发给 API，UI 仍只显示用户原文）：

```xml
<attached_documents>
<document name="report.pdf" imported_at="2026-06-08T12:00:00Z">
... markdown content ...
</document>
</attached_documents>
```

**方案 B — 扩展 `system` 提示**

将附件 Markdown 并入 session system prompt 缓存。缺点：多附件时 system 膨胀难管理。

**首版采用方案 A**，并与 `buildClaudeToolChatMessages` 集成：在 `sendInternal` 路径由主进程或共享模块 `injectDocumentAttachments(messages, attachments)` 处理。

### 8.3 多附件顺序与选择

- 所有 `ready` 附件按 `completedAt` 升序注入。
- 用户移除附件后，后续发送不再包含。
- 单条消息发送时若附件总字符超过 §8.4 上限，按 **最近导入优先** 截断，并在附件条显示「部分内容未纳入上下文（已超过模型限制）」警告。

### 8.4 与上下文使用量环联动

| 项 | 行为 |
|----|------|
| 估算 | 对 `ready` 附件 Markdown 用与 `contextUsageEstimate` 一致的启发式估算 token |
| 展示 | Context Usage Ring 的 tooltip 增加一行「文档附件约 X tokens」 |
| 预警 | 附件估算 + 历史消息 > 80% `maximumContext` 时，附件条显示温和警告色 |

---

## 9. 架构设计（方案 B）

### 9.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 渲染进程 (React)                                             │
│  MessageInput [+] → AttachmentStrip → ChatView               │
│       │ IPC invoke/subscribe                                 │
├───────┼─────────────────────────────────────────────────────┤
│ 主进程 (Electron)                                            │
│  MarkItDownServiceManager  ─ spawn/kill/restart               │
│  MarkItDownClient (HTTP)   ─ 仅主进程 fetch 127.0.0.1        │
│  JobTracker                ─ jobId, AbortController, 阶段   │
│  AttachmentStore           ─ 磁盘 + Session.metadata        │
│       │ HTTP (loopback)                                      │
├───────┼─────────────────────────────────────────────────────┤
│ Python 微服务 (FastAPI + uvicorn)                            │
│  绑定 127.0.0.1:动态端口                                     │
│  MarkItDown.convert / convert_stream                         │
└─────────────────────────────────────────────────────────────┘
```

**与集成指南的差异：**

| 指南示例 | 本需求决策 | 理由 |
|----------|------------|------|
| 渲染进程 `fetch localhost` | **禁止**；仅主进程 HTTP | 减少 XSS 侧信道；令牌不出主进程 |
| 固定端口 19528 | **动态端口** + stdout 握手 | 避免多实例冲突 |
| `GET /convert?path=` | **首版优先 `POST /convert` multipart 上传** | 路径仅经用户对话框选择后由主进程读盘上传，减少路径遍历面；GET 可作为调试接口但不暴露给不可信输入 |
| stdlib `HTTPServer` | **FastAPI** | 异步超时、文件上传、中间件更清晰 |
| 指南独立 DocumentConverter 页 | **嵌入 composer 流程** | 符合产品入口要求 |

### 9.2 Python 服务进程握手

子进程启动后 **仅向 stdout 输出握手行**（顺序固定）：

```
PORT:54321
AUTH_TOKEN:xxxxxxxx
READY
```

主进程解析完毕后再发 `/health`。stderr 用于日志。

### 9.3 服务管理器职责

`electron/markitdown/serviceManager.ts`（示意）：

- `start()` / `stop()` / `restart()`
- `getBaseUrl()` / `getAuthHeaders()`
- 进程崩溃监听与退避重启
- 开发模式：`python3` + 仓库内 `python-service/markitdown_server.py`
- 打包模式（Phase 2）：`resources/markitdown-service.exe`

### 9.4 转换任务流水线

```
pickFile → validateMainProcess(path)
         → createJob(sessionId, path)
         → read file stream / stat size
         → POST /convert (multipart) with AbortSignal
         → normalize markdown (trim, charset)
         → truncate if > max chars
         → persist attachment + emit IPC event
         → renderer updates AttachmentStrip
```

---

## 10. API 与 IPC 规格

### 10.1 Python HTTP API（127.0.0.1）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | `{ status, version, markitdown_version }` |
| POST | `/convert` | `multipart/form-data` 字段 `file`；响应 `{ success, markdown, metadata?, error? }` |
| POST | `/shutdown` | 优雅关闭（需令牌） |

**请求头（必须）：**

- `X-Auth-Token: <SHARED_SECRET>`
- 禁止 `Origin` 头（中间件拒绝浏览器请求）

**响应超时：** 服务端 `asyncio.wait_for` 300 s；客户端 fetch 310 s。

### 10.2 Electron IPC

| 通道 | 方向 | 载荷 | 说明 |
|------|------|------|------|
| `markitdown:pick-and-convert` | renderer → main | `{ sessionId }` | 打开对话框并启动转换 |
| `markitdown:cancel-job` | renderer → main | `{ jobId }` | 取消任务 |
| `markitdown:remove-attachment` | renderer → main | `{ sessionId, attachmentId }` | 移除 ready 附件 |
| `markitdown:get-attachment-preview` | renderer → main | `{ attachmentId, maxChars? }` | 详情面板预览 |
| `markitdown:service-status` | renderer → main | — | `{ ready, error? }` |
| `markitdown:job-progress` | main → renderer | `SessionDocumentAttachment` 补丁 | 阶段更新 |
| `markitdown:job-done` | main → renderer | 完整 attachment | 成功/失败终态 |

`preload.ts` 通过 `contextBridge` 暴露 `window.api.markitdown.*`，**不**暴露裸 `fetch` 到微服务。

### 10.3 类型定义位置

- 共享类型：`src/shared/markitdownTypes.ts`
- API 扩展：`src/shared/api.ts` 增加 `markitdown` 命名空间

---

## 11. 安全要求

继承集成指南 §5.1.2 加固措施，**首版必须实现**：

| 优先级 | 措施 |
|--------|------|
| 🔴 必须 | 启动时生成 `AUTH_TOKEN`，经 stdout 传给主进程；所有 HTTP 请求带 `X-Auth-Token` |
| 🔴 必须 | 绑定 `127.0.0.1` + 动态端口 |
| 🔴 必须 | **POST 上传**为主路径；若保留 path 接口须白名单校验用户对话框返回的路径 |
| 🔴 必须 | 单文件 100 MB、超时 300 s |
| 🟡 强烈建议 | Python 子进程 **最小化 env**（禁止 `...process.env` 全量继承） |
| 🟡 强烈建议 | 拒绝带 `Origin` 的请求 |
| 🟢 建议 | 10 s 内最多 5 次转换请求（滑动窗口） |
| 🟢 建议 | 敏感路径黑名单（`.ssh`, `.aws` 等） |

**路径来源约束：** 渲染进程 **不得** 自行构造任意路径；仅主进程在 `showOpenDialog` 回调后持有 `filePaths[0]`。

---

## 12. 配置与依赖

### 12.1 应用配置扩展

```typescript
interface DocumentImportConfig {
  enabled: boolean                    // 默认 true
  maxFileSizeBytes: number            // 默认 100MB
  maxConversionTimeoutSec: number     // 默认 300
  maxAttachmentChars: number          // 默认 500_000
  maxAttachmentsPerSession: number    // 默认 3
  lastDirectory?: string
}
```

挂载于 `AppConfig.documentImport`（或等价字段）。

### 12.2 Python 环境（Phase 1）

| 环境 | 要求 |
|------|------|
| 开发 | 本机 Python 3.10+，`pip install 'markitdown[pdf,docx,pptx,xlsx]'` + `fastapi` `uvicorn`（**M1 无需** `audio-transcription` / 图片 LLM 相关 extra） |
| 用户文档 | README 增加「文档导入」章节（简要说明 + 指向对话内修复） |
| 检测 | 启动时 `import markitdown` 探针；失败则 UI 降级，**不阻塞应用其余功能** |
| 源码 | **不 fork、不 patch MarkItDown**；版本锁定在 `requirements` / 文档中的 PyPI 范围 |

### 12.3 打包（Phase 3，可选）

- PyInstaller 单文件 `markitdown-service` 放入 `extraResources`（**官方 wheel 打包，非改源码**）
- 附带 `THIRD_PARTY_LICENSES.md`（MIT + Apache 2.0 dwml 等，见集成指南 §13）

### 12.4 设置页（Phase 1.5）

「通用」或「文档导入」小节：

| 服务状态 | UI |
|----------|-----|
| 就绪 | 绿色摘要「文档转换服务正常」+ 大小/超时配置 |
| 未就绪 | 红色摘要 + 主按钮 **「在对话中修复」**（触发 §13.4 Chat Launch Intent） |

**不做** 长篇分步安装表单（与 [browser-setup-skill-requirement.md §8](./browser-setup-skill-requirement.md) 策略一致）。

---

## 13. 依赖修复 Skill

> **定位：** 参考 [browser-setup-skill-requirement.md](./browser-setup-skill-requirement.md)（网络访问 / Chromium）与飞书集成的修复路径，将 MarkItDown 环境安装与故障排除 **Skill 化**。Skill **仅在出错或用户主动求助时激活**，正常导入流程不加载、不占用 system prompt。

### 13.1 Skill 元信息

| 属性 | 值 |
|------|-----|
| 名称 | `markitdown-setup-guide` |
| 类型 | **产品内置 Skill**（写入 `PRODUCT_BUILTIN_SKILL_NAMES`，用户不可删） |
| 加载 | `electron/skills/bundled/markitdownSetupGuideSkill.ts` 或等价只读模板 |
| `triggers` | **`[]`（空）** — 关闭 LLM 关键词自动匹配，避免误激活 |
| 激活方式 | 仅：**依赖错误 Hook** / 设置页「在对话中修复」 / `/skill use markitdown-setup-guide` |

### 13.2 触发条件与结构化错误

主进程在以下场景产生 `MarkItDownDependencyError`（命名示意），供 Hook 与 Agent 使用：

```typescript
interface MarkItDownDependencyError {
  errorCode: MarkItDownDependencyFailureCode
  errorMessage: string           // 面向 Agent 的中文短句
  detectResult?: MarkItDownDetectResult
  suggestedInstallCommand?: string  // 如 pip install 命令（不含密钥）
  pythonPath?: string            // 检测到的 python 可执行文件（Agent 话术脱敏）
}

type MarkItDownDependencyFailureCode =
  | 'python_not_found'
  | 'python_version_low'        // < 3.10
  | 'markitdown_not_installed'
  | 'markitdown_import_error'   // 已安装但 import 失败（依赖残缺）
  | 'fastapi_uvicorn_missing'   // 微服务运行时缺包
  | 'service_start_failed'
  | 'service_crashed'
  | 'port_bind_failed'
```

| 触发点 | 是否激活 Skill | 说明 |
|--------|----------------|------|
| 应用启动时服务启动失败 | 否（仅设置页摘要 + 「+」disabled） | 避免无用户意图时污染会话 |
| 用户点击「+」导入，因依赖失败 | **是（当前会话）** | 附件条 `failed` + 自动激活 Skill |
| 转换中途服务崩溃 | **是（当前会话）** | `job-done` 含 `dependencyError` 时激活 |
| 设置 → 文档导入 →「在对话中修复」 | **是（新建会话）** | Chat Launch Intent，见 §13.4 |
| 用户文件损坏 / 格式不支持 | **否** | 非环境问题，走普通错误文案 |
| 打包版内置服务缺失（Phase 3） | **是**，但话术引导重装应用 | 对齐 `stagehand_missing` 策略，**禁止** pip 修打包缺陷 |

`resolveMarkItDownRecoverySkill(errorCode)` 映射表（示意）：

| errorCode | 返回 Skill |
|-----------|------------|
| `python_not_found` … `service_crashed` | `markitdown-setup-guide` |
| `port_bind_failed` | `markitdown-setup-guide`（引导重启应用） |
| （非依赖类业务错误） | `null` |

### 13.3 Agent 工具：`markitdown_detect`

封装主进程已有检测逻辑，供 Skill 剧本驱动复检（对齐 `browser_detect`）：

| 字段 | 说明 |
|------|------|
| 工具名 | `markitdown_detect` |
| 输入 | `{ force?: boolean }` |
| 输出 | `{ ready, primaryFailure?, pythonVersion?, markitdownVersion?, serviceHealthy?, hints[] }` |
| 注册 | 内置工具；**默认不在通用工具列表展示**，Skill 激活后随会话工具集注入或始终可用（实现时与 `browser_detect` 对齐） |

Skill 正文要求 Agent：**开场与用户声称「装好了」后必须调用 `markitdown_detect`**，根据 `primaryFailure` 分场景引导。

### 13.4 三条入口路径（对齐 browser-setup-guide）

| 路径 | 会话 | Skill 激活 | 首条消息 |
|------|------|------------|----------|
| **设置 → 在对话中修复** | **新建** | `manualActivated += markitdown-setup-guide` | 系统自动发送（用户可见） |
| **导入失败 / 服务异常** | **当前会话** | 同上 | 无；附件条精简提示 + Agent 在下一轮继续 |
| **`/skill use markitdown-setup-guide`** | 当前 | 手动激活 | 用户自行输入 |

**Chat Launch Intent**（设置入口）复用 browser 修复的编排模式：

```typescript
type MarkItDownRepairLaunchIntent = {
  type: 'markitdown-repair'
  skillName: 'markitdown-setup-guide'
  initialUserMessage: string  // i18n 固定文案，如「请帮我检查并修复文档转换服务」
}
```

### 13.5 Skill 剧本状态机（写入 SKILL.md）

| 阶段 | Agent 行为 |
|------|------------|
| **S0 开场** | 说明将修复「文档导入 / MarkItDown 转换服务」；**立即** `markitdown_detect` |
| **S1 解读** | 按 `primaryFailure` 中文解释缺什么（Python / pip 包 / 服务进程） |
| **S2 引导安装** | 分场景给出 **一条** 可执行建议；见 §13.6 |
| **S3 等待确认** | 用户完成或同意代执行后进入 S4 |
| **S4 复检** | 再次 `markitdown_detect`；必要时主进程 `restart` 微服务 |
| **S5 结束** | `ready === true` → 提示用户重新点击「+」导入；仍失败 → 故障排除（防火墙/杀毒/代理/磁盘） |

**约束（写入 Skill）：**

- 一次只推进一步；**禁止**粘贴完整堆栈、`pip` 缓存路径、用户主目录绝对路径。
- 代执行安装：**优先 `run_shell`**（用户确认卡片）；若工具开关未开启则口述命令或引导开启 `run_shell`（同 `browser-setup-guide`）。
- **禁止** 引导用户修改 MarkItDown 源码或从非 PyPI 源安装魔改包。
- 打包版（Phase 3）若检测到内置 `markitdown-service` 缺失：**建议重装应用**，禁止 `pip install` 修应用包。

### 13.6 分场景引导要点

| primaryFailure | Agent 引导要点 |
|----------------|----------------|
| `python_not_found` | 引导安装 Python 3.10+（Windows 商店 / python.org / Homebrew）；说明需勾选「Add to PATH」 |
| `python_version_low` | 升级 Python；不修改应用内置 Node 等无关环境 |
| `markitdown_not_installed` | `pip install 'markitdown[pdf,docx,pptx,xlsx]'`；可选镜像源说明；建议 `pip install fastapi uvicorn` |
| `markitdown_import_error` | 依赖残缺 → `pip install --upgrade markitdown` 或重装可选 extra |
| `fastapi_uvicorn_missing` | `pip install fastapi uvicorn` |
| `service_start_failed` / `service_crashed` | 完全退出应用重开 → 查看日志 → 杀毒软件放行 → 仍失败则收集 `detectResult` 反馈 |
| `port_bind_failed` | 关闭重复启动的应用实例；重启电脑；不涉及改端口给用户 |

### 13.7 UI 与 Hook 集成

| 位置 | 行为 |
|------|------|
| 附件条 `failed`（依赖类） | 摘要文案 + 链接「在对话中继续修复」；**不**嵌入完整安装向导组件 |
| 渲染进程 | 收到 `markitdown:job-done` 且含 `dependencyError` → `activateRecoverySkillInState('markitdown-setup-guide')`（复用 `browserRecoverySkillService` 模式） |
| `toolChatLoop` | 若未来有 `convert_document` 工具，失败路径同样返回 `dependencyRecovery`；MVP 以 IPC 导入路径为主 |
| i18n | `documentImport.repair.*` 与 `feishu` / `browser` 修复文案风格一致 |

### 13.8 非目标

- Skill **不会**在应用启动时自动激活或自动发送消息
- Skill **不会**静默执行 `pip install`（必须用户确认 `run_shell` 或自行终端执行）
- 首版 **不提供** 应用内嵌 Python 安装器（与方案 D 打包分列 Phase 3）

---

## 14. 错误与边界

| 场景 | 用户可见提示 | 系统行为 |
|------|--------------|----------|
| 未安装 Python / MarkItDown | 附件条/设置摘要失败 + **「在对话中修复」** | 「+」可点但导入必失败；或启动时 disabled + tooltip；激活 §13 Skill |
| 用户取消文件选择 | 无 | 无任务 |
| 文件超过大小限制 | 「文件超过 100MB 上限」 | 不创建任务 |
| 格式不支持（含图片/音频） | 「暂不支持此文件格式」；图片/音频可附 **「首版暂不支持，后续版本开放」** | 对话框确认后、创建任务 **前** 校验扩展名 |
| 转换超时 | 「转换超时，请尝试较小文件或稍后重试」 | `failed`；可重试 |
| 空 Markdown 结果 | 「未能从文件中提取有效文本」 | `failed` |
| 磁盘空间不足 | 「存储空间不足，无法保存转换结果」 | `failed` |
| 会话切换 | — | 附件随 `sessionId` 隔离；进行中任务继续，进度事件路由到正确会话 |
| 应用重启 | 进行中的任务丢失 | `metadata` 中 `ready` 附件可恢复；`converting` 标记为 `failed` 或清除 |

---

## 15. 与现有能力的关系

| 能力 | 关系 |
|------|------|
| [wiki-import-ingest-requirement.md](./wiki-import-ingest-requirement.md) | Wiki 收录面向知识库分层；本需求面向 **会话内讨论**，互补 |
| [file-content-viewer-requirement.md](./file-content-viewer-requirement.md) | 点击 ready 附件可在详情面板 Markdown 预览，复用查看器 |
| [context-usage-ring-requirement.md](./context-usage-ring-requirement.md) | 附件 token 纳入估算展示 |
| [referenced-files-requirement.md](./referenced-files-requirement.md) | 工具读写的项目文件 ≠ 导入附件；不自动进入引用列表 |
| [browser-setup-skill-requirement.md](./browser-setup-skill-requirement.md) | **修复 Skill 模式、Chat Launch Intent、`run_shell` 代执行** 的对齐参考 |
| Agent `read_file` | 导入不替代工作区读文件；用户仍可对 workDir 内原生文本文件使用既有工具 |

---

## 16. 发布计划

| 阶段 | 范围 |
|------|------|
| **M1 — 核心闭环** | 方案 B 服务管理器；「+」入口；**§5.1 办公/文本格式 only**；附件条；阶段反馈；取消；注入上下文；**`markitdown-setup-guide` Skill + `markitdown_detect` + 依赖错误 Hook** |
| **M2 — 体验打磨** | 详情面板预览；Context Ring 联动；设置页状态摘要 +「在对话中修复」；i18n；会话持久化恢复 |
| **M3 — 扩展格式（可选）** | 图片 / 音频导入方案设计与实现（含隐私披露、依赖选型） |
| **M4 — 分发（可选）** | PyInstaller 打包官方依赖；安装器内置服务；许可文件；可选 Azure/LLM 增强开关 |

---

## 17. 验收标准

### 17.1 功能

- [ ] composer 模型 chip 左侧显示「+」，点击弹出系统文件选择器
- [ ] 选择 `.pdf` / `.docx` 等 **M1 白名单** 格式后，TextArea 上方出现附件条并进入「转换中」
- [ ] 选择 `.jpg` / `.mp3` 等 **M1 不支持** 格式时，前置提示且不创建转换任务
- [ ] 转换成功后附件状态为「已导入」，用户发送消息后 Agent 能回答文档相关问题
- [ ] 转换失败显示明确中文错误，可关闭或重试
- [ ] 转换进行中可编辑输入框、滚动历史、发送不含附件的普通消息
- [ ] 点击取消后 3 s 内附件条清除且不再注入上下文
- [ ] 移除 ready 附件后，下一条消息不再包含该文档

### 17.2 长耗时体验

- [ ] 30 s 以上任务显示「已等待 N 秒」或等价心跳
- [ ] 全程无全屏阻塞 Modal
- [ ] 300 s 超时失败且有提示
- [ ] 服务崩溃后 UI 给出「服务未响应」而非无限 loading

### 17.3 安全

- [ ] 渲染进程无法直连微服务端口（DevTools 无令牌）
- [ ] 微服务仅监听 127.0.0.1
- [ ] 无令牌 HTTP 请求返回 403

### 17.4 依赖修复 Skill

- [ ] 内置 Skill `markitdown-setup-guide` 存在且 `triggers: []`
- [ ] 模拟 `python_not_found` 导入失败时，当前会话自动激活 Skill，Agent 可调用 `markitdown_detect`
- [ ] 设置页依赖未就绪时显示「在对话中修复」，点击后新建会话并自动发送首条引导消息
- [ ] 正常导入成功路径 **不** 激活 Skill、不增加 system prompt 体积
- [ ] Agent 经 `run_shell` 执行 pip 前出现用户确认卡片
- [ ] 复检通过后用户可再次「+」导入并成功

### 17.5 自动化测试（建议）

- [ ] 主进程：`serviceManager` 握手解析单元测试
- [ ] 主进程：路径/大小校验测试
- [ ] 主进程：`resolveMarkItDownRecoverySkill` 映射单元测试
- [ ] 渲染进程：AttachmentStrip 状态机快照测试
- [ ] 渲染进程：`markitdownRecoverySkillService` 激活逻辑测试（对齐 browser）
- [ ] 集成测试：mock Python 服务延迟 60 s，验证阶段事件与取消

---

## 18. 待解决问题

| ID | 问题 | 倾向 |
|----|------|------|
| OQ-1 | 图片/音频是否首版支持 | **已决：M1 不支持**；M3+ 再定方案（本地 STT / 视觉 API / 用户确认云端） |
| OQ-2 | 转换完成是否自动发送一条系统提示消息 | 否；仅附件条 + 可选草稿引导语 |
| OQ-3 | 附件 Markdown 是否进入 SQLite 消息表 | 否；独立文件 + metadata 引用 |
| OQ-4 | 进行中任务是否允许切换会话 | 允许；事件按 sessionId 路由 |
| OQ-5 | 是否与飞书附件读取 (`read_feishu_attachment`) 统一模型 | 后续统一 `SessionAttachment` 抽象 |
| OQ-6 | `markitdown_detect` 是否常驻工具列表 | 与 `browser_detect` 一致：Skill 场景可用，设置页不单独暴露 |
| OQ-7 | 多 Python 共存时 Skill 推荐哪一个 | `detect` 输出 `pythonPath`；优先 3.10+ 且已装 markitdown 的解释器 |

---

## 19. 相关文件

| 区域 | 预期路径 |
|------|----------|
| Python 服务 | `python-service/markitdown_server.py`（或 `markitdown_server_fastapi.py`） |
| 服务管理 | `electron/markitdown/serviceManager.ts` |
| HTTP 客户端 | `electron/markitdown/client.ts` |
| 依赖检测 / 错误码 | `electron/markitdown/dependencyRecovery.ts`、`src/shared/markitdownDependencyRecovery.ts` |
| 修复 Skill | `electron/skills/bundled/markitdownSetupGuideSkill.ts` |
| Skill 激活服务 | `src/renderer/services/markitdownRecoverySkillService.ts`（可复用 browser 模式） |
| 内置工具 | `electron/tools/markitdownDetectTool.ts` |
| IPC | `electron/appIpc.ts`、`electron/preload.ts` |
| 类型 | `src/shared/markitdownTypes.ts`、`src/shared/api.ts` |
| UI | `src/renderer/components/Chat/MessageInput.tsx`、`AttachmentStrip.tsx` |
| 设置页 | `src/renderer/components/Config/DocumentImportSettingsTab.tsx`（或并入通用设置） |
| 状态 | `src/renderer/store/chatSlice.ts` |
| 上下文注入 | `src/renderer/components/Chat/ChatView.tsx` 或 `electron/toolChatLoop.ts` |
| i18n | `src/renderer/i18n/resources/*/documentImport.json` |
| 样式 | `src/renderer/theme/layout.css`（`.composer-attach-*`） |
| 参考 | `docs/references/MarkItDown集成指南.md`、`docs/requirement/browser-setup-skill-requirement.md` |

---

*本文档描述产品与技术需求，实施时以代码评审与测试结果为准。*
