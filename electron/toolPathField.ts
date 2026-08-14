/**
 * 工具 path 字段别名归一化共享 helper。
 *
 * 用于 read_file / edit_file / write_file / list_directory / grep 这 5 个文件类工具，
 * 把模型误写的 `filePath` / `file_path` 等别名归一到统一的 path 提取入口。
 *
 * 适用范围：仅用于上述 5 个文件类工具的 path 提取。wechat_reply / wechat_send 的
 * filePath / imagePath 是「待发送文件/图片路径」的合法语义字段，与本函数的「path 别名」
 * 语义不同，**严禁**用于 wechat 工具入参，以免污染其合法字段。
 */

/** 已知的「路径字段名」别名，按优先级排序。 */
export const PATH_FIELD_ALIASES = ['path', 'filePath', 'file_path'] as const

/**
 * 从工具入参中提取路径字段值。
 *
 * 按 path -> filePath -> file_path 顺序取第一个「非空字符串」。
 * 全部缺失或为空串/纯空白时返回 undefined（供调用方区分「缺参」与「显式空」）。
 *
 * 语义约定：
 * - `path` 存在即优先返回（即使别名同时存在）；
 * - 值非字符串（如 number）跳过该别名，继续看下一个；全无效返回 undefined；
 * - 空串或纯空白视为缺失（返回 undefined），避免重演「空路径 = workDir」的 bug；
 * - 不做 trim 返回，原样返回字符串（trim 仅用于判空）。
 */
export function extractPathField(input: Record<string, unknown>): string | undefined {
  for (const alias of PATH_FIELD_ALIASES) {
    const v = input[alias]
    if (typeof v === 'string' && v.trim().length > 0) {
      return v
    }
  }
  return undefined
}
