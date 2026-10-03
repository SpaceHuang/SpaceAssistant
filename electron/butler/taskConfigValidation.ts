import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { AgentReasoningEffort } from '../../src/shared/agent/invocation'
import type { AppDatabase } from '../database'
import { resolveLlmCredentialsForPair } from '../llmServiceResolver'

const EFFORTS: readonly AgentReasoningEffort[] = ['off', 'low', 'medium', 'high', 'max']

export async function validateTaskWorkDir(value: unknown): Promise<{ ok: true; workDir: string } | { ok: false; error: string }> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: '任务工作目录不能为空' }
  if (!isAbsolute(value)) return { ok: false, error: '任务工作目录必须是绝对路径' }
  try {
    const canonical = await realpath(resolve(value))
    const info = await stat(canonical)
    if (!info.isDirectory()) return { ok: false, error: '任务工作目录必须是目录' }
    await access(canonical)
    return { ok: true, workDir: canonical }
  } catch {
    return { ok: false, error: '任务工作目录不存在或不可访问' }
  }
}

export async function validateTaskModelConfig(db: AppDatabase, input: {
  modelId: unknown
  modelServiceId: unknown
  modelOverride: unknown
  reasoningEffort: unknown
}): Promise<{ ok: true; modelId: string; modelServiceId: string; modelOverride: string; reasoningEffort: AgentReasoningEffort } | { ok: false; error: string }> {
  if (typeof input.modelId !== 'string' || !input.modelId || typeof input.modelServiceId !== 'string' || !input.modelServiceId) {
    return { ok: false, error: '任务必须指定模型目录 ID 和模型服务' }
  }
  if (typeof input.reasoningEffort !== 'string' || !EFFORTS.includes(input.reasoningEffort as AgentReasoningEffort)) {
    return { ok: false, error: '思维强度无效' }
  }
  const resolved = await resolveLlmCredentialsForPair(db, input.modelId, input.modelServiceId)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  if (input.modelOverride !== resolved.providerModelName) return { ok: false, error: 'provider 模型名称与所选模型目录不一致' }
  if (resolved.model.supportsThinking === false && input.reasoningEffort !== 'off') return { ok: false, error: '所选模型不支持思维强度' }
  return { ok: true, modelId: input.modelId, modelServiceId: input.modelServiceId, modelOverride: resolved.providerModelName, reasoningEffort: input.reasoningEffort as AgentReasoningEffort }
}
