import { MAX_FILE_READ_SIZE } from './fileTypes'

/** 聊天图片附件单文件上限；与 read_file 限额对齐 */
export const MAX_CHAT_IMAGE_ATTACHMENT_BYTES = MAX_FILE_READ_SIZE

export const MAX_CHAT_IMAGE_ATTACHMENTS = 4

/** 历史气泡 / read IPC 默认返回上限（缩略图量级） */
export const DEFAULT_STAGED_IMAGE_READ_MAX_BYTES = 512 * 1024

/** API image block base64 字符上限（约 5MB 原始数据的 base64） */
export const MAX_IMAGE_BASE64_CHARS = 7_000_000
