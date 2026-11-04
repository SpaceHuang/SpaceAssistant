'use strict'

async function waitForCriticalFlowReadConfirmation({
  sessionId,
  toolName,
  waitFor,
  listActiveTurns,
  readConfirmation,
  timeoutMs = 20_000
}) {
  return waitFor('authoritative read-confirmation snapshot ready', async () => {
    const turn = (await listActiveTurns()).find((candidate) => candidate.sessionId === sessionId)
    const tool = turn?.assistantMessage?.toolCalls?.find((candidate) => candidate.toolName === toolName && candidate.status === 'confirming')
    if (!turn || !tool) return false

    const snapshot = await readConfirmation({
      sessionId,
      turnId: turn.turnId,
      requestId: turn.requestId,
      turnVersion: turn.version,
      toolCallId: tool.id
    })
    if (snapshot?.toolCallId !== tool.id || snapshot.confirmation?.complete !== true) return false
    return { turnId: turn.turnId, toolCallId: tool.id }
  }, timeoutMs)
}

async function waitForCriticalFlowToolApprovalAccepted({
  sessionId,
  turnId,
  toolCallId,
  waitFor,
  listActiveTurns,
  timeoutMs = 20_000
}) {
  return waitFor('host to accept read approval and start the tool', async () => {
    const turn = (await listActiveTurns()).find((candidate) => candidate.sessionId === sessionId && candidate.turnId === turnId)
    const tool = turn?.assistantMessage?.toolCalls?.find((candidate) => candidate.id === toolCallId)
    return tool && tool.status !== 'confirming' ? tool.status : false
  }, timeoutMs)
}

module.exports = { waitForCriticalFlowReadConfirmation, waitForCriticalFlowToolApprovalAccepted }
