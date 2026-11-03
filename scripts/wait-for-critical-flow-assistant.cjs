'use strict'

async function waitForCriticalFlowAssistant({
  sessionId,
  text,
  stage,
  waitFor,
  assistantIsVisible,
  listActiveTurns,
  readMessages
}) {
  stage('wait-assistant-visible', { sessionId, text })
  await waitFor(`assistant result visible in renderer ${text}`, assistantIsVisible, 20_000)
  stage('assistant-visible', { sessionId, text })

  await waitFor('assistant turn terminal', async () => (await listActiveTurns()).length === 0)
  stage('assistant-turn-terminal', { sessionId, text })

  const all = await readMessages()
  const assistant = all.find((item) => item.role === 'assistant' && item.status === 'completed' && String(item.content || '').includes(text))
  if (!assistant) throw new Error(`completed assistant message was not committed: ${text}`)
  return { assistant, all }
}

module.exports = { waitForCriticalFlowAssistant }
