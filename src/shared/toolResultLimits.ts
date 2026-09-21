/** read_file 单文件最大字符数（与执行器截断一致） */
export const READ_FILE_MAX_CHARS = 2 * 1024 * 1024

/** read_file 单次按行读取的最大行数 */
export const READ_FILE_MAX_LINE_LIMIT = 2000

/** tool_result 压缩上限（tokens 口径，P1-4）：对齐 Codex 的 tool_output_token_limit 默认 10,000。
 *  旧值 2 MiB ≈ 572k tokens，实际等于不设限。 */
export const TOOL_RESULT_MAX_TOKENS = 10_000

/** tool_result / API 消息块最大字符数（P1-4：由 TOOL_RESULT_MAX_TOKENS 派生，系数与
 *  estimateTokensFromUtf8Text 的 len/3.5 反推一致）。
 *  注意与 READ_FILE_MAX_CHARS 分离：执行器单次仍可读 2 MiB，超出压缩上限的部分由
 *  compactOversizedToolResultContent 中段截断（保留头尾），模型可再用 offset/limit 定位。 */
export const MAX_TOOL_RESULT_CONTENT_CHARS = Math.ceil(TOOL_RESULT_MAX_TOKENS * 3.5)

/** IPC 校验：user/assistant 文本与 content block 上限（与工具结果压缩上限独立：
 *  它是请求体防御性上限，不随 P1-4 的上下文体积治理下调——§5.4.4 影响面评估结论） */
export const MAX_API_MESSAGE_TEXT_CHARS = READ_FILE_MAX_CHARS

// ---- edit_file 匹配失败诊断（docs/develop/edit-file-match-failure-diagnosis-and-improvement-plan.md §5）----
// 两个「数量」阈值用途不同，勿混：MAX_CANDIDATES 判「候选是否多到应当放弃」（→ ambiguous-candidate）；
// MAX_LCS_WINDOWS 限「进入 LCS 精算的窗口数」（控计算成本）。

/** edit_file 诊断：old_string 超过该行数时不做块级诊断（block-too-large 降级） */
export const MAX_DIAGNOSIS_BLOCK_LINES = 20

/** edit_file 诊断：suggestedOldString 超过该字符数时抑制下发（too-long 降级）。
 * 必须小于 MAX_LCS_INPUT_CHARS：候选块先经精算守卫（≤ 4096）再过建议长度检查（≤ 4000），
 * 两阈值之间的区间才是 too-long 的可达范围；若反超则 too-long 永不触发（§7.1 #8 失效）。 */
export const MAX_SUGGESTED_OLD_STRING_CHARS = 4000

/** edit_file 诊断：进入 LCS 精算的候选块 / old_string 单侧最大字符数，超限降级 block-too-large */
export const MAX_LCS_INPUT_CHARS = 4096

/** edit_file 诊断：粗筛后进入 LCS 精算的窗口数上限（控成本，LCS 只对短名单计算） */
export const MAX_LCS_WINDOWS = 5

/** edit_file 诊断：合格候选数超过该值视为歧义（ambiguous-candidate），不下发建议 */
export const MAX_CANDIDATES = 5

/** edit_file 诊断：top1 与 top2 相似度差小于该值视为歧义，不下发建议 */
export const MIN_SIM_GAP = 0.05
