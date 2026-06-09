/** read_file 单文件最大字符数（与执行器截断一致） */
export const READ_FILE_MAX_CHARS = 2 * 1024 * 1024

/** read_file 单次按行读取的最大行数 */
export const READ_FILE_MAX_LINE_LIMIT = 2000

/** tool_result / API 消息块最大字符数（与最大工具输出对齐） */
export const MAX_TOOL_RESULT_CONTENT_CHARS = READ_FILE_MAX_CHARS

/** IPC 校验：user/assistant 文本与 content block 上限 */
export const MAX_API_MESSAGE_TEXT_CHARS = READ_FILE_MAX_CHARS
