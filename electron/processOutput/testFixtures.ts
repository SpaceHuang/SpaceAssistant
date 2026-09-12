/** §11 字节级 fixture：全部内联 hex，不新增二进制文件。 */
export const ACCIDENT_TEXT =
  'Windows PowerShell 内部错误。加载托管的 Windows PowerShell 失败，返回错误 8009001d。\r\n'

export const ACCIDENT_HEX =
  '570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000' +
  '8551e8901995ef8b0230a0527d8f5862a17b84762000' +
  '570069006e0064006f0077007300200050006f007700650072005300680065006c006c002000' +
  '3159258d0cffd48fde561995ef8b20003800300030003900300030003100640002300d000a00'

export const ACCIDENT_BYTES = Buffer.from(ACCIDENT_HEX, 'hex')

/** 无 prelude 的 PS 输出：「中文测试\r\n」按 OEM CP 936] 编码。 */
export const GBK_ZH_TEST_HEX = 'd6d0cec4b2e2cad40d0a'
/** 与 GBK_ZH_TEST_HEX 等价但无换行，用于切分用例。 */
export const GBK_ZH_TEST_BARE_HEX = 'd6d0cec4b2e2cad4'

export const UTF8_ZH_TEST_HEX = 'e4b8ade69687e6b58be8af950d0a'
export const UTF8_ZH_TEST_BOM_HEX = 'efbbbfe4b8ade69687e6b58be8af950d0a'

/** UTF-16BE 带 BOM：BOM + 「中文」×5（22 字节）。 */
export const UTF16BE_BOM_HEX = 'feff' + '4e2d6587'.repeat(5)
/** UTF-16BE 无 BOM 纯 CJK，20 字节（T5b）。 */
export const UTF16BE_PURE_CJK_HEX = '4e2d6587'.repeat(5)
/** UTF-16BE 无 BOM 纯 CJK，12 字节（T5c：样本不足，不猜）。 */
export const UTF16BE_PURE_CJK_SHORT_HEX = '4e2d6587'.repeat(3)
