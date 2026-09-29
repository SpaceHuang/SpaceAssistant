import type { AgentTurnPorts } from '../../packages/agent-sdk/src/turn'
import { buildOutputRecoveryMessage, buildTruncatedToolResults, MAX_OUTPUT_RECOVERIES } from '../outputRecovery'

/** Reuses the Desktop's bounded max-output recovery prompt for Hosted SDK turns. */
export function createAgentSdkOutputRecovery(input?: { location?: { workDir: string; sessionId: string; createdAt: number }; turnId?: string; stepId?: string }): NonNullable<AgentTurnPorts['recoverOutputLimit']> {
  return async ({ invocationId, modelTurn, attempt, hadVisibleText, toolCalls }) => {
    const toolCallErrorContent = buildTruncatedToolResults([{ id: 'host-output-recovery' }])[0]?.content
    const continuation = attempt > MAX_OUTPUT_RECOVERIES ? undefined : buildOutputRecoveryMessage({
        attempt,
        causeRequestId: `${invocationId}:round:${modelTurn}`,
        hadVisibleText,
        hadToolUse: toolCalls.length > 0
      })
    const requestId = `${invocationId}:round:${modelTurn}`
    return {
      ...(continuation ? { continuation: { role: 'user' as const, content: continuation.content } } : {}),
      ...(continuation && input?.location ? {
        retryLocation: input.location,
        retryTurnId: input.turnId ?? invocationId,
        retryStepId: input.stepId ?? invocationId
      } : {}),
      ...(toolCallErrorContent ? { toolCallErrorContent } : {})
    }
  }
}
