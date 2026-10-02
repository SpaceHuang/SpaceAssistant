# `codex/failed-turn-continuation-experience-tdd` 重审（第四轮）

结论：**请求修改，仍有 1 项必须修复的问题**。第三轮的内部状态码外露已修复：主进程返回 `continuation-started` 类型，Renderer 使用本地化文案并显示状态行。

## 必须修复

1. **同一续接请求重发会重复写入状态行。** `electron/outbound/outboundAcceptor.ts:344-345` 对已受理的同一 request ID 再次返回 `continuation-started`；`src/renderer/components/Chat/ChatView.tsx:588-590` 每次收到它都调用 `persistSkillHintSystemMessage`。该函数在 `:472-477` 每次生成新的随机消息 ID，再调用 `messageAppendNonTurn`；`src/shared/skillHintRecords.ts:16-25` 也为 status hint 生成随机 ID。因此 IPC 响应丢失后用同一 request ID 重发、或同一请求被重复提交，会在消息列表留下多条“正在继续上次执行”，与本功能的幂等受理及可审计操作记录不符。请把可见状态消息与 request ID/continuation ID 建立稳定映射，并在主进程受理事务中创建或幂等获取；返回其消息 ID/sequence 供 Renderer 展示。补同一 request ID 重发仅有一条状态行的集成测试。

## 验证

- 定向测试：3 个文件、64 项通过。
- `npm run typecheck:renderer`、`npm run typecheck:shared`：通过。
- 本轮未重复运行全量测试。
