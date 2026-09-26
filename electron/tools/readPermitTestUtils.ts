import os from 'os'
import path from 'path'
import { buildReadExecutionPermit } from '../confirmation/readExecutionPermit'
import { probeReadPathFact } from '../confirmation/extractors/readPathFacts'
import { extractPathField } from '../toolPathField'
import type { ToolExecutionContext } from './types'

/** Test adapter for direct executor unit tests; production still receives permits only from toolCallGate. */
export async function attachTestReadPermit(
  toolName: 'read_file' | 'grep' | 'list_directory',
  input: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<void> {
  const rawPath = extractPathField(input) ?? (toolName === 'list_directory' || toolName === 'grep' ? '.' : '')
  const fact = await probeReadPathFact({
    rawPath,
    workDir: ctx.workDir,
    userDataDir: ctx.userDataDir,
    homeDir: os.homedir(),
    customSensitivePrefixes: ctx.shellConfig?.customSensitivePrefixes ?? []
  })
  const targetKind = toolName === 'list_directory' && (fact.targetKind === 'directory' || fact.resolvedKind === 'directory')
    ? 'directory'
    : fact.targetKind
  const target = {
    factId: `test-fact-${fact.normalizedPath}`,
    decisionRuleId: 'test-read-permit',
    normalizedPath: fact.normalizedPath,
    zone: fact.zone,
    targetKind,
    ...(fact.resolvedKind ? { resolvedKind: fact.resolvedKind } : {}),
    ...(fact.identity ? { identity: fact.identity } : {}),
    ...(toolName === 'list_directory' ? { scope: 'direct-entries' as const } : {})
  }
  ctx.readExecutionPermit = buildReadExecutionPermit({
    requestId: ctx.requestId,
    toolUseId: ctx.toolUseId,
    toolName,
    input,
    facts: [target]
  })
}
