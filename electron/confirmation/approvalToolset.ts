/**
 * 审批执行链的封闭只读工具集（P7 数据化实例）：白名单内容不变，
 * 从 approvalAgent.ts 平移为独立数据声明（宿主从 profile.tools.trim 引用）。
 */
export const APPROVAL_READONLY_TOOLS: readonly string[] = [
  'read_file',
  'list_directory',
  'grep',
  'list_work_dirs',
  'history.read',
  'skills.read'
]
