import { createHash } from 'crypto'

/** 将内部事实标识转换为可关联、但不暴露路径的审计标识。 */
export function auditFactId(factId: string): string {
  return `fact-${createHash('sha256').update(factId).digest('hex').slice(0, 24)}`
}
