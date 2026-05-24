# 上下文使用量展示器 — 设计文档

**日期：** 2026-05-24
**状态：** 已确认
**关联需求：** `docs/requirement/context-usage-ring-requirement.md`

---

## 1. 方案选择

采用**方案 A**：Redux 存储原始 API usage 数据，ContextUsageRing 组件内计算环形比例。

## 2. 文件改动

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/renderer/store/chatSlice.ts` | 修改 | 新增 `lastUsage` + `setLastUsage`；`setSession`/`resetChatUi` 中重置 |
| `src/renderer/components/Chat/ContextUsageRing.tsx` | 新建 | SVG 环形组件 + Tooltip |
| `src/renderer/components/Chat/MessageInput.tsx` | 修改 | composer-footer 中嵌入组件 |
| `src/renderer/components/Chat/ChatView.tsx` | 修改 | API 返回后 dispatch usage |
| `electron/claudeStreamHandlers.ts` | 修改 | `claude-chat-done` 追加 usage |
| `src/shared/api.ts` | 修改 | `claudeChatOnDone` 类型追加 usage |
| `src/renderer/store/chatSlice.test.ts` | 新建 | reducer 单元测试 |
| `src/renderer/components/Chat/ContextUsageRing.test.tsx` | 新建 | 组件测试 + 集成测试 |

## 3. Redux 状态扩展

```typescript
// chatSlice ChatState 新增字段
lastUsage: {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
} | null

// 新增 action
setLastUsage(state, action: PayloadAction<typeof state.lastUsage>) {
  state.lastUsage = action.payload
}
```

重置：`setSession` 和 `resetChatUi` 中均设置 `state.lastUsage = null`。

## 4. 数据流

三条路径均通过 `dispatch(setLastUsage(usage))` 传入 Redux：

1. **工具模式**：`sendInternal` 中 `createWithTools` 成功后取 `res.usage`
2. **Plan 模式**：`runPlanWorkerWithoutNewUser` 同上
3. **流式模式**：`runSendStream` 扩展 `claude-chat-done` 事件携带 usage → `onDone` 回调中 dispatch

## 5. ContextUsageRing 组件

- **数据来源**：Redux `chatSlice.lastUsage`、`configSlice`（模型 `maximumContext`、`maxTokens`）
- **SVG 三层环**：外层亮色（`var(--sa-primary)`，已用输入）、中层深灰（`#666`，输出预留）、内层浅灰（`#ddd`，剩余）
- **边界保护**：`input_tokens + maxTokens > maximumContext` 时按比例压缩，不溢出
- **无数据**：单层浅灰底色环，tooltip 显示"暂无上下文用量数据"
- **尺寸**：28×28px，与发送按钮对齐
- **Tooltip**：中文标签，缓存字段仅 >0 展示，底部汇总行

## 6. 测试

### 单元测试（chatSlice.test.ts）
- setLastUsage 设置/清空
- setSession 重置 lastUsage
- resetChatUi 重置 lastUsage

### 组件测试（ContextUsageRing.test.tsx）
- 无数据 → 浅灰底色环
- 有数据 → 三层环
- 边界保护 → 超 100% 不外溢
- Tooltip 无数据/有数据/缓存条件显示
- 模型列表为空不崩溃

### 集成测试（ContextUsageRing.test.tsx）
- dispatch setLastUsage → 组件更新
- 切换会话 → 组件重置

测试框架：vitest + @testing-library/react + jsdom。