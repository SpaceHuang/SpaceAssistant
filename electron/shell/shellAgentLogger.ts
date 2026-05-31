import { logAgentEvent } from '../agentLogger/agentLogger'
import { sanitizeForLog } from '../agentLogger/sanitize'
import type { AgentLogEventName, AgentLogFields, AgentLogLevel } from '../agentLogger/types'
import type { ShellSecurityHints } from '../../src/shared/domainTypes'
import { preprocessShellLogFields } from './shellLogFields'

export function logShellAgentEvent(
  level: AgentLogLevel,
  event: AgentLogEventName,
  fields: Record<string, unknown>
): void {
  logAgentEvent(level, event, sanitizeForLog(preprocessShellLogFields(fields)) as AgentLogFields)
}

export function logShellPrecheck(args: {
  requestId: string
  sessionId: string
  toolUseId: string
  loopRound: number
  command: string
  verdict: string
  skipConfirm: boolean
  hints?: ShellSecurityHints
}): void {
  logShellAgentEvent('info', 'shell.precheck', {
    requestId: args.requestId,
    sessionId: args.sessionId,
    toolUseId: args.toolUseId,
    loopRound: args.loopRound,
    command: args.command,
    verdict: args.verdict,
    skipConfirm: args.skipConfirm,
    requiresRiskAck: args.hints?.requiresRiskAck ?? false,
    outsideWorkDirRisk: args.hints?.outsideWorkDirRisk ?? false,
    warningsCount: args.hints?.warnings?.length ?? 0,
    violationCodes: args.hints?.violationCodes,
    scannedPathsCount: args.hints?.scannedPaths?.length ?? 0
  })
}

export function logShellConfirmOutcome(args: {
  requestId: string
  sessionId: string
  toolUseId: string
  loopRound: number
  command: string
  outcome: string
  skipConfirm?: boolean
  hints?: ShellSecurityHints
}): void {
  logShellAgentEvent('info', 'shell.confirm', {
    requestId: args.requestId,
    sessionId: args.sessionId,
    toolUseId: args.toolUseId,
    loopRound: args.loopRound,
    command: args.command,
    outcome: args.outcome,
    skipConfirm: args.skipConfirm ?? false,
    requiresRiskAck: args.hints?.requiresRiskAck ?? false,
    warningsCount: args.hints?.warnings?.length ?? 0
  })
}
