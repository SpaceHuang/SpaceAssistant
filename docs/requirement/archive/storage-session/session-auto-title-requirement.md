# 会话自动生成标题需求文档

## 1. 概述

当会话累计的可见 `user` + `assistant` 消息达到 **3 条**后，由 LLM 根据当前对话内容生成简短主题，并更新会话在侧栏显示的标题（`Session.name`）。此外，对从未自动生成过标题且已有足够历史的老会话，在用户打开该会话时补尝试摘要。上述流程须与主对话循环解耦，失败不影响主流程。

---

## 2. 期望行为

| 序号 | 需求点 | 说明 |
|------|--------|------|
| 1 | 触发时机 | 累计可见 `user` + `assistant` 消息数**≥ 3** 时调度摘要；每次 `runToolChatSession` 至多调度一次，且 `titleGenerated` 防止成功后再次生成。历史已达 3 条的会话在下一次 invocation 开始时补触发。 |
| 2 | 摘要输入 | 使用当前会话相同的 LLM 服务（`model`、`baseUrl`、API Key）。发送精简系统提示 + **对话纯文本摘要**：从 API 消息序列头部开始，仅保留 `user` / `assistant` 的可见 text 内容，不包含工具细节；最多包含前 3 条 user/assistant 消息。 |
| 3 | 摘要输出 | 模型输出经归一化后作为会话标题：不超过 **15** 个 Unicode 字符（汉字按字计数）；可去除首尾空白、常见尾标点及简单序号前缀。 |
| 4 | 持久化与通知 | 摘要成功后：更新数据库中的会话 `name` 与 `metadata`；通过 IPC 事件 **`session:title-generated`** 将更新后的 `Session` 推送给渲染进程。 |
| 5 | 渲染进程 | 订阅上述事件，使用 Redux `upsertSession` 更新列表中的对应会话，侧栏标题立即刷新。 |
| 6 | 失败策略 | 网络错误、超时、空结果等一律 **静默忽略**，不改变现有标题，不阻断主会话。建议请求层带超时（如 AbortController）。 |
| 7 | 老会话打开补全 | 若未生成、非用户自定义、没有补全请求进行中，且库中已完成的 user/assistant 消息数**≥ 3**并能拼出摘要，则异步调用相同摘要逻辑。`titleOpenBackfillAttempted` 只在成功生成后保留；API Key 缺失、网络错误、超时、空结果等失败时清除该标记，允许之后重试。 |

---

## 3. 摘要提示词

系统侧（或等价的系统消息）固定为：

```text
你是一个对话主题提炼助手。请根据以下对话内容，用不超过15个汉字概括本次对话的核心主题。
只输出主题文字，不要加任何标点、序号或解释。
```

用户侧消息体为：

```text
对话内容：
{前3轮 user/assistant 消息的纯文本摘要}
```

其中 `{前3轮 user/assistant 消息的纯文本摘要}` 为第 2 节所述由 API 消息列表生成的纯文本（实现中可对每段加注「用户：」「助手：」前缀以便模型区分角色）。

---

## 4. 触发条件与元数据约定

| 条件 | 说明 |
|------|------|
| 触发时机 | `user + assistant` 消息总数 `≥ 3`；单次 `runToolChatSession` **最多调用一次** `scheduleSessionTitleSuggestion`。 |
| 打开补全触发 | 渲染进程在切换当前会话后防抖调用 **`session:backfill-auto-title-if-needed`**；主进程按第 2 节「老会话打开补全」规则处理，返回更新后的 `Session`（含写入 `titleOpenBackfillAttempted` 时）供 Redux 合并。 |
| 仅触发一次 | 会话 `metadata.titleGenerated === true` 时不再调度；可用内存中的「进行中」集合防止同一 `sessionId` 并发重复请求。 |
| 不阻塞主循环 | 摘要逻辑在独立异步任务中执行，主 Agent 循环不等待其完成。 |
| 不覆盖用户自定义标题 | 会话 `metadata.titleUserCustom === true` 时跳过自动生成。当用户通过 **`session:update` 且 `payload.name` 有值** 修改标题时，主进程应将 `titleUserCustom` 写入 `metadata`（并与已有 `metadata` 合并，避免覆盖其它键）。 |
| 打开补全重试 | `metadata.titleOpenBackfillAttempted === true` 仅代表补全成功完成；失败不留下该标记，因此后续打开可再次调度。in-flight 集合阻止并发重复请求。 |

### 4.1 元数据键名（约定）

| 键名 | 类型 | 含义 |
|------|------|------|
| `titleGenerated` | boolean | 已成功写入过自动生成标题（或等价「已完成一次生成流程」语义，以实现「只触发一次」）。 |
| `titleUserCustom` | boolean | 用户曾显式修改会话名称，禁止自动生成覆盖。 |
| `titleOpenBackfillAttempted` | boolean | 老会话打开补全成功完成；失败时移除，供后续重试。 |

---

## 5. IPC 与 API 约定

| 项目 | 约定 |
|------|------|
| 主进程 → 渲染进程 | `webContents.send('session:title-generated', { session: Session })`。 |
| 渲染 → 主进程 | `ipcMain.handle('session:backfill-auto-title-if-needed', …)`：`invoke` 返回 `Session \| undefined`（写入 `titleOpenBackfillAttempted` 等 metadata 后用于 `upsertSession`）。 |
| 预加载 | 暴露 `sessionOnTitleGenerated`；以及 `sessionBackfillAutoTitleIfNeeded(payload)` 对应上述 invoke。 |
| 类型 | `SpaceAssistantApi` 中声明 `sessionOnTitleGenerated`、`sessionBackfillAutoTitleIfNeeded`。 |

---

## 6. 实现参考（便于联调）

以下为实现该需求时涉及的主要模块，非需求正文变更依据：

- 调度与循环：`electron/toolChatLoop.ts`（累计可见 user/assistant 消息数 `≥ 3` 后调用 `scheduleSessionTitleSuggestion`）。
- 摘要与落库：`electron/sessionTitleSuggest.ts`。
- 注入数据库：`electron/claudeStreamHandlers.ts` 的 `ClaudeStreamDeps.getAppDatabase`，`electron/main.ts` 注册时传入。
- 用户改名标记：`electron/appIpc.ts` 的 `session:update`、`session:backfill-auto-title-if-needed`。
- 渲染订阅：`electron/preload.ts`、`src/renderer/App.tsx`；打开补全调用：`src/renderer/components/Chat/ChatView.tsx`（切换 `sessionId` 防抖）。

---

## 7. 验收要点

1. user + assistant 消息总数达到 3 后应调度标题生成。
2. 历史消息总数已达 3 且从未写入 `titleGenerated`，下一次 invocation 应补触发一次标题生成。
3. 同一会话在 `titleGenerated` 已为真后，再次发起对话不应再次自动生成标题。
4. 用户通过 `session:update` 修改 `name` 后，`titleUserCustom` 为真，即使累计 user/assistant 消息数达到 3 也不应覆盖名称。
5. 摘要失败时 UI 与主对话无报错、无卡顿，标题保持原样。
6. 老会话已有 ≥3 条已完成 user/assistant、从未 `titleGenerated`、未 `titleUserCustom`，打开后在后台补全；失败时清除 `titleOpenBackfillAttempted`，再次打开允许重试，成功后不再请求。
