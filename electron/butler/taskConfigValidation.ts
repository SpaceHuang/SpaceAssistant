import { constants } from 'node:fs'
import { access, lstat, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve } from 'node:path'
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
    await access(canonical, constants.R_OK | constants.X_OK)
    return { ok: true, workDir: canonical }
  } catch {
    return { ok: false, error: '任务工作目录不存在或不可访问' }
  }
}

export async function validateTaskWorkDirs(value: unknown): Promise<{ ok: true; workDirs: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: '任务工作目录不能为空' }
  const validated = await Promise.all(value.map((root) => validateTaskWorkDir(root)))
  const invalid = validated.find((result) => !result.ok)
  if (invalid && !invalid.ok) return invalid
  const workDirs = [...new Set(validated.flatMap((result) => result.ok ? [result.workDir] : []))].sort()
  if (workDirs.length === 0) return { ok: false, error: '任务工作目录不能为空' }
  return { ok: true, workDirs }
}

/** New task contract: material authorization may be empty; each selected root is still canonicalized. */
export async function validateTaskAuthorizedDirs(value: unknown): Promise<{ ok: true; authorizedDirs: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(value)) return { ok: false, error: '授权读写目录列表无效' }
  if (value.length === 0) return { ok: true, authorizedDirs: [] }
  const validated = await Promise.all(value.map((root) => validateTaskWorkDir(root)))
  const invalid = validated.find((result) => !result.ok)
  if (invalid && !invalid.ok) return invalid
  return { ok: true, authorizedDirs: [...new Set(validated.flatMap((result) => result.ok ? [result.workDir] : []))].sort() }
}

/** Compare resolved run roots to the immutable canonical roots approved with the task snapshot. */
export function taskAuthorizedRootSetMatchesSnapshot(roots: unknown, approvedRoots: unknown): boolean {
  const canonicalSet = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value) || !value.every((root) => typeof root === 'string' && isAbsolute(root) && normalize(root) === root)) return undefined
    return [...new Set(value as string[])].sort()
  }
  const actual = canonicalSet(roots)
  const approved = canonicalSet(approvedRoots)
  return actual !== undefined && approved !== undefined && actual.length === approved.length && actual.every((root, index) => root === approved[index])
}

/** Final-check for an unattended run: canonicalize current roots, then reject any drift from the approved snapshot. */
export async function validateTaskAuthorizedDirsForRun(value: unknown, approvedRoots: unknown): Promise<{ ok: true; authorizedDirs: string[] } | { ok: false; error: string }> {
  const validated = await validateTaskAuthorizedDirs(value)
  if (!validated.ok || !taskAuthorizedRootSetMatchesSnapshot(validated.authorizedDirs, approvedRoots)) {
    return { ok: false, error: 'TASK_AUTHORIZED_ROOT_DRIFT' }
  }
  return validated
}

export async function validateTaskOutputDir(value: unknown): Promise<{ ok: true; outputDir: string } | { ok: false; error: string }> {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: '结果输出目录不能为空' }
  if (!isAbsolute(value)) return { ok: false, error: '结果输出目录必须是绝对路径' }
  try {
    const requested = resolve(value)
    const canonical = await realpath(requested)
    const info = await lstat(canonical)
    if (info.isSymbolicLink() || !info.isDirectory()) return { ok: false, error: '结果输出目录必须是实际目录' }
    await access(canonical, constants.W_OK | constants.X_OK)
    return { ok: true, outputDir: canonical }
  } catch {
    return { ok: false, error: '结果输出目录不存在或不可写' }
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
