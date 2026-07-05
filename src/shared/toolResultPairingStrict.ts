/** 读取严格配对模式：环境变量 SPACEASSISTANT_STRICT_TOOL_PAIRING=1 */
export function getStrictToolResultPairing(): boolean {
  if (typeof process !== 'undefined' && process.env?.SPACEASSISTANT_STRICT_TOOL_PAIRING === '1') {
    return true
  }
  return false
}
