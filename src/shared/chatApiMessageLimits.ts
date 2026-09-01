/** IPC / 工具会话发往 LLM 的 messages 数组上限（含 tool_result 展开的条目）。
 *  按消息条数裁剪的粗粒度阈值；仍低于 Anthropic 上游单请求 10 万条消息的上限。
 *  实际是否溢出模型上下文窗口主要由 token 级管理（contextUsageEstimate 等）负责，
 *  此处调高后 count 裁剪几乎不再先触发，历史保留更长、请求体更大。 */
export const MAX_CHAT_API_MESSAGES = 50000

/**
 * 单条 API 消息中 content 数组允许的最大内容块数量（客户端防御性上限）。
 *
 * 触发 `content.length > MAX_CHAT_API_CONTENT_BLOCKS` 时直接 `throw`，会在请求发出前就拒绝，
 * 因此一条历史里若存在超过该数量的块，会阻碍后续整个会话继续。为避免误伤合法的高并发
 * 工具轮次（模型可能一次返回大量 tool_use，且上游通常接受），此值曾在 80 被上调到 160。
 * 若后续确认到 Anthropic Messages API 的真实上限，请改回/对齐该真实值，并考虑改为「压缩合并
 * 后放行 + warn 日志」而不是直接 throw。
 */
export const MAX_CHAT_API_CONTENT_BLOCKS = 160
