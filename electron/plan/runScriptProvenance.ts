import { createHash } from 'crypto'

/** 单次 Worker run 内 run_script 来源上下文 */
export interface RunScriptProvenanceContext {
  requestId: string
  /** read_file 读到的外部文件内容 hash → 路径 */
  externalScriptHashes: Map<string, string>
  /** 本轮 Agent write_file/edit_file 写入/修改的脚本内容 hash */
  agentScriptHashes: Set<string>
}

const provenanceByRequest = new Map<string, RunScriptProvenanceContext>()

export function getOrCreateProvenanceContext(requestId: string): RunScriptProvenanceContext {
  let ctx = provenanceByRequest.get(requestId)
  if (!ctx) {
    ctx = {
      requestId,
      externalScriptHashes: new Map(),
      agentScriptHashes: new Set()
    }
    provenanceByRequest.set(requestId, ctx)
  }
  return ctx
}

export function clearProvenanceContext(requestId: string): void {
  provenanceByRequest.delete(requestId)
}

/** 测试用 */
export function clearAllProvenanceContexts(): void {
  provenanceByRequest.clear()
}

/** 归一化：统一换行符为 \n，去掉首尾空白，去掉 shebang 行 */
export function normalizeScriptBody(code: string): string {
  let s = code.replace(/\r\n/g, '\n').trim()
  if (s.startsWith('#!')) {
    const nl = s.indexOf('\n')
    s = nl >= 0 ? s.slice(nl + 1).trim() : ''
  }
  return s
}

export function hashScript(code: string): string {
  const normalized = normalizeScriptBody(code)
  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16)
}

function isScriptPath(relPath: string): boolean {
  return /\.(py|sh|js|ts|bash)$/i.test(relPath)
}

export function recordReadFileForProvenance(
  ctx: RunScriptProvenanceContext,
  relPath: string,
  content: string
): void {
  if (!isScriptPath(relPath)) return
  const h = hashScript(content)
  ctx.externalScriptHashes.set(h, relPath)
}

export function recordWriteFileForProvenance(
  ctx: RunScriptProvenanceContext,
  relPath: string,
  content: string
): void {
  if (!isScriptPath(relPath)) return
  const h = hashScript(content)
  ctx.agentScriptHashes.add(h)
  ctx.externalScriptHashes.delete(h)
}

export function isAgentGeneratedRunScript(code: unknown, ctx: RunScriptProvenanceContext): boolean {
  if (typeof code !== 'string' || !code.trim()) return false
  const h = hashScript(code)
  if (ctx.externalScriptHashes.has(h)) return false
  if (ctx.agentScriptHashes.has(h)) return true
  // 内联生成：不在 external 集合即视为 Agent 当场编写
  return true
}
