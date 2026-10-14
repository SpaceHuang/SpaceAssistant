# 无会话状态输入与自动创建会话需求文档

## 1. 概述

### 1.1 功能定位

当前版本在无活动会话时（`sessionId === null`），聊天输入框被禁用，用户无法直接输入内容。新需求移除该限制，允许用户在无会话状态下输入消息，并在点击发送时自动创建一个新会话来处理后续聊天流程。

### 1.2 目标

| # | 目标 |
|---|------|
| G1 | 无会话时，输入框保持可用状态，用户可正常输入文字 |
| G2 | 无会话时点击发送，自动创建新会话并在其中发送消息 |
| G3 | 新会话创建后，界面应切换到该会话并正常展示聊天消息 |
| G4 | 自动创建会话时，沿用当前配置中的模型设置（`cfg.model`） |

### 1.3 非目标

- 不改变会话列表为空时侧边栏的默认行为
- 不自动将会话保存到侧边栏列表（仍需用户手动触发或满足自动保存条件）
- 不影响现有会话切换、删除、创建等逻辑

---

## 2. 现状分析

### 2.1 当前行为

| 场景 | 当前行为 |
|------|---------|
| 无会话时输入框 | `disabled={!sessionId}`，输入框被禁用 |
| 无会话时点击发送 | `sendInternal` 开头检查 `if (!sessionId \|\| !cfg)` 并弹出警告「请先选择一个会话」 |
| 空会话状态提示 | 显示「选择一个会话开始对话」的空状态 UI |

### 2.2 相关代码位置

| 文件 | 行号 | 说明 |
|------|------|------|
| `src/renderer/components/Chat/ChatView.tsx` | 975 | `<MessageInput disabled={!sessionId} ...>` |
| `src/renderer/components/Chat/ChatView.tsx` | 300-301 | `sendInternal` 入口检查 `if (!sessionId \|\| !cfg)` |
| `src/renderer/components/Chat/MessageInput.tsx` | 38 | 按钮 `disabled={running ? false : disabled \|\| !text.trim()}` |

---

## 3. 功能需求

### 3.1 输入框可用性

**需求：** 移除 `MessageInput` 的 `disabled={!sessionId}` 条件。

**实现方式：**
- 将 `disabled` 属性从「无会话时禁用」改为「仅在执行中（`running`）或明确传递 `disabled` 时禁用」
- `MessageInput` 的 `disabled` 仅影响 TextArea 和发送按钮的 `disabled` 状态
- 按钮自身的 `disabled` 逻辑保持不变：`disabled={running ? false : disabled || !text.trim()}`

**变更点：**

| 文件 | 行号 | 变更内容 |
|------|------|---------|
| `ChatView.tsx` | 975 | 移除 `disabled={!sessionId}` prop |

### 3.2 自动创建会话

**需求：** 当用户点击发送且 `sessionId === null` 时，自动创建一个新会话。

**实现方式：**
- 在 `send` 回调或 `sendInternal` 入口处增加会话创建逻辑
- 调用 `window.api.sessionCreate()` 创建新会话
- 创建成功后更新 Redux 状态 `setCurrentSessionId`
- 后续逻辑沿用已有流程

**流程描述：**

```
用户点击发送
    ↓
text.trim() 为空？ → 是 → 直接返回，不处理
    ↓ 否
sessionId === null？ → 是 → 创建新会话 → 更新 currentSessionId
    ↓
调用 sendInternal(text)
```

**变更点：**

| 文件 | 行号 | 变更内容 |
|------|------|---------|
| `ChatView.tsx` | 774-779 | `send` 回调增加自动创建会话逻辑 |
| `ChatView.tsx` | 300-301 | 移除 `sendInternal` 入口的 `!sessionId` 检查（因已在 `send` 层处理） |

### 3.3 新会话初始化参数

自动创建会话时，使用当前配置中的默认参数：

| 参数 | 来源 |
|------|------|
| `model` | `cfg.model`（当前选中的模型） |
| `temperature` | `cfg.temperature`（当前配置的 temperature） |
| `maxTokens` | 使用模型默认值 |
| `name` | 空字符串或「新的对话」，后续由自动标题机制更新 |
| `skillsState` | `DEFAULT_SESSION_SKILLS_STATE` |

---

## 4. 交互规格

### 4.1 无会话状态下的 UI 表现

| 元素 | 行为 |
|------|------|
| 输入框 | 保持可用，可输入文字 |
| placeholder | 保持现有文案 `t('input.placeholder')` |
| 发送按钮 | 根据输入框是否有内容决定 enabled/disabled |
| 空状态区域 | 保持现有「选择一个会话开始对话」的展示 |

### 4.2 点击发送后的行为序列

1. 用户在输入框输入文字并点击发送
2. 系统检测到 `sessionId === null`
3. 调用 `window.api.sessionCreate(...)` 创建新会话
4. 更新 Redux `currentSessionId` 为新会话 ID
5. 清空输入框
6. 正常调用 `sendInternal` 发送消息
7. 界面切换到新会话的聊天视图

### 4.3 快捷键行为

- `Ctrl+Enter` / `Cmd+Enter`：无会话时同样触发自动创建会话流程

---

## 5. 技术方案

### 5.1 核心改动

**ChatView.tsx 第 774-779 行（`send` 回调）：**

```typescript
const send = useCallback(
  async (text: string) => {
    // 无会话时自动创建
    if (!sessionId && cfg) {
      const newSession = await window.api.sessionCreate({
        model: cfg.model,
        temperature: cfg.temperature ?? 1,
        name: '',
        metadata: {}
      })
      if (newSession) {
        dispatch(setCurrentSessionId(newSession.id))
        dispatch(upsertSession(newSession))
      } else {
        return // 创建失败，终止发送
      }
    }
    await sendInternal(text)
  },
  [sessionId, cfg, sendInternal, dispatch]
)
```

**ChatView.tsx 第 975 行（MessageInput）：**

```diff
- disabled={!sessionId}
+ disabled={false}  // 输入框始终可用，由按钮自己的 disabled 逻辑控制
```

**ChatView.tsx 第 300-301 行（sendInternal 入口）：**

```diff
- if (!sessionId || !cfg) {
-   message.warning(t('chatView.warnings.selectSession'))
-   return
- }
+ if (!cfg) {
+   message.warning(t('chatView.warnings.selectSession'))
+   return
+ }
```

### 5.2 Redux Action

需要确保 `setCurrentSessionId` action 已存在（预计在 `chatSlice` 中）。

### 5.3 副作用处理

- 创建会话后，ChatView 的 `useEffect` 会自动加载该会话的消息（初始为空）
- 自动标题机制会在第三条 assistant 消息后自动更新会话标题

---

## 6. 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| AC1 | 启动后无会话时，输入框可正常聚焦并输入文字 | 手动测试 |
| AC2 | 无会话时输入文字，发送按钮变为可用状态 | 手动测试 |
| AC3 | 无会话时点击发送，自动创建新会话并发送消息 | 手动测试 |
| AC4 | 新会话创建后，聊天区域正常展示消息 | 手动测试 |
| AC5 | 使用快捷键 `Ctrl+Enter` 发送同样触发自动创建 | 手动测试 |
| AC6 | 有会话时行为保持不变 | 回归测试 |

---

## 7. 国际化

无需新增翻译 key，现有 `input.placeholder` 已适用于无会话状态。
