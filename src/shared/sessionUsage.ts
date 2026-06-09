/** API 返回的 usage 字段（按会话持久化，与 chatSlice.LastUsage 非 null 形态一致） */
export type SessionUsage = {
  input_tokens: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
