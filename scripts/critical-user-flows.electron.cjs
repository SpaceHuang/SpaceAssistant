'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { setTimeout: delay } = require('node:timers/promises')
const { app, BrowserWindow } = require('electron')
const { configureCriticalFlowLocale } = require('./critical-user-flow-environment.cjs')
const { waitForCriticalFlowAssistant } = require('./wait-for-critical-flow-assistant.cjs')
const {
  waitForCriticalFlowReadConfirmation,
  waitForCriticalFlowToolApprovalAccepted
} = require('./wait-for-critical-flow-confirmation.cjs')

// Must run before app.whenReady(): i18next reads navigator.language during renderer startup.
configureCriticalFlowLocale(app)

const FLOW = process.env.CRITICAL_USER_FLOW
const DATA_DIR = process.env.CRITICAL_USER_DATA_DIR
const FLOW_TIMEOUT_MS = Number(process.env.CRITICAL_USER_FLOW_TIMEOUT_MS || 90_000)

function stage(name, details = {}) {
  console.log(`CRITICAL_FLOW_STAGE ${JSON.stringify({ flow: FLOW, stage: name, ...details })}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(description, check, timeoutMs = FLOW_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`timeout waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`)
}

async function waitForActualModelRequest(minimum = 1) {
  const url = new URL('/__critical/status', process.env.CRITICAL_MODEL_URL)
  const status = await waitFor('real tool-enabled model request accepted by local provider', async () => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`model status returned ${response.status}`)
    const status = await response.json()
    return status.actualRequests >= minimum ? status : false
  }, 20_000)
  console.log(`CRITICAL_FLOW_ACTUAL_REQUEST_READY ${JSON.stringify(status)}`)
}

async function execute(win, source) {
  return win.webContents.executeJavaScript(source, true)
}

async function clickButton(win, label, exact = true) {
  const encoded = JSON.stringify(label)
  const found = await execute(win, `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim()
    const target = ${encoded}
    const nodes = [...document.querySelectorAll('button,[role="tab"],[role="button"]')]
    const el = nodes.find((node) => {
      const name = norm(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText)
      return ${exact ? 'name === target' : 'name.includes(target)'}
    })
    if (!el || el.disabled) return false
    el.click()
    return true
  })()`)
  if (!found && FLOW === 'settings-cross-tab-save') {
    stage('settings-button-debug', await execute(win, `({buttons:[...document.querySelectorAll('button')].map((node)=>({name:(node.getAttribute('aria-label')||node.getAttribute('title')||node.innerText).replace(/\\s+/g,' ').trim(),disabled:node.disabled})).filter((node)=>node.name.includes('保存')),text:document.body.innerText.slice(-800)})`))
  }
  assert(found, `accessible button not found or disabled: ${label}`)
}

async function sendMessage(win, content) {
  try {
    await waitFor('idle composer and accessible send control', () => execute(win, `Boolean([...document.querySelectorAll('textarea')].find((node) => node.placeholder === '输入消息…' && !node.disabled) && [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '发送消息'))`), 15_000)
  } catch (error) {
    const controls = await execute(win, `({buttons:[...document.querySelectorAll('button')].map((node)=>({name:node.getAttribute('aria-label')||node.innerText.trim(),disabled:node.disabled})).filter((node)=>node.name),inputs:[...document.querySelectorAll('textarea')].map((node)=>({placeholder:node.placeholder,disabled:node.disabled})),text:document.body.innerText.slice(-600)})`)
    stage('composer-controls-unavailable', controls)
    throw error
  }
  const value = JSON.stringify(content)
  const result = await execute(win, `(() => {
    const input = [...document.querySelectorAll('textarea')].find((node) => node.placeholder === '输入消息…')
    if (!input) return 'missing-composer'
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(input, ${value})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const button = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '发送消息' && !node.disabled)
    if (!button) return 'missing-send-button'
    button.click()
    return 'submitted'
  })()`)
  assert(result === 'submitted', `could not submit message through accessible composer: ${result}`)
}

async function waitForWindow() {
  stage('wait-main-window')
  const expectedUrl = process.env.ELECTRON_START_URL
  const win = await waitFor('main BrowserWindow loading the built renderer', () => BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().startsWith(expectedUrl)))
  win.webContents.on('did-fail-load', (_event, code, description, url) => stage('renderer-load-failed', { code, description, url }))
  win.webContents.on('render-process-gone', (_event, details) => stage('renderer-process-gone', details))
  win.__criticalFirstPaint = false
  win.webContents.on('console-message', (event, _level, legacyMessage) => {
    const line = String(legacyMessage ?? event?.message ?? '')
    if (line.includes('renderer.start-to-first-paint')) win.__criticalFirstPaint = true
  })
  stage('window-observed', { url: win.webContents.getURL(), loading: win.webContents.isLoading() })
  stage('wait-renderer-and-preload')
  const loaded = await waitFor('renderer did finish loading with root and real preload API', async () => {
    const snapshot = await execute(win, `({rootChildren:document.querySelector('#root')?.children.length, apiPresent:Boolean(window.api), methods:{sessionList:typeof window.api?.sessionList,chatGetMessages:typeof window.api?.chatGetMessages,configGet:typeof window.api?.configGet}, ready:document.readyState, language:navigator.language})`)
    if (snapshot.rootChildren && snapshot.methods.sessionList === 'function' && snapshot.methods.chatGetMessages === 'function' && snapshot.methods.configGet === 'function') return snapshot
    return false
  })
  stage('renderer-ready', loaded)
  await waitFor('renderer startup first-paint barrier', () => win.__criticalFirstPaint, 15_000)
  stage('renderer-first-paint')
  return win
}

async function configureFakeModel(win) {
  stage('configure-local-model')
  const workDir = path.join(DATA_DIR, 'workspace')
  fs.mkdirSync(workDir, { recursive: true })
  const result = await execute(win, `window.api.configGet().then(async (config) => {
    const model = config.models?.find((item) => item.enabled) || config.models?.[0] || {
      id: 'critical-flow-model-id', name: 'claude-haiku-4-5', maximumContext: 200000,
      maxTokens: 4096, isDefault: false, isFast: false, isVision: false, enabled: true
    }
    const models = config.models?.length ? config.models : [model]
    const serviceId = 'critical-flow-local-model'
    await window.api.configSet({
      models,
      llmServices: [{ id: serviceId, name: 'Critical flow local model', baseUrl: ${JSON.stringify(process.env.CRITICAL_MODEL_URL)}, apiKeyPresent: false, supportedModelIds: [model.id] }],
      llmServiceKeys: { [serviceId]: 'critical-flow-fake-key' },
      activeLlmServiceIds: [serviceId],
      preferredLanguageModelId: model.id,
      workDir: ${JSON.stringify(workDir)}
    })
    return { model: model.name, modelId: model.id, serviceId }
  })`)
  assert(result?.model && result?.serviceId, 'could not configure local Anthropic-compatible service via config IPC')
  stage('local-model-configured', { model: result.model })
  return result
}

async function sessionList(win) { return execute(win, 'window.api.sessionList()') }
async function messages(win, sessionId) { return execute(win, `window.api.chatGetMessages({sessionId:${JSON.stringify(sessionId)}})`) }

async function createSessionThroughUi(win) {
  stage('session-list-before-create')
  const before = await sessionList(win)
  stage('session-list-before-create-ready', { existingSessions: before.length })
  stage('create-session-click', { existingSessions: before.length })
  await clickButton(win, '新会话')
  return waitFor('session created by UI', async () => {
    const current = await sessionList(win)
    const created = current.find((item) => !before.some((old) => old.id === item.id))
    if (!created) return false
    stage('session-list-updated', { sessionId: created.id })
    const initialPage = await execute(win, `window.api.chatGetMessagePage({sessionId:${JSON.stringify(created.id)},limit:60})`)
    if (initialPage.entries.length !== 0) throw new Error(`new session unexpectedly has persisted messages: ${created.id}`)
    await execute(win, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await waitFor('new session composer selected and enabled', () => execute(win, `Boolean([...document.querySelectorAll('textarea')].find((node) => node.placeholder === '输入消息…' && !node.disabled))`), 15_000)
    stage('new-session-composer-ready', { sessionId: created.id })
    return created
  }, 20_000)
}

async function waitForAssistant(win, sessionId, text) {
  try {
    return await waitForCriticalFlowAssistant({
      sessionId,
      text,
      stage,
      waitFor,
      assistantIsVisible: () => execute(win, `document.body.innerText.includes(${JSON.stringify(text)})`),
      listActiveTurns: () => execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(sessionId)}})`),
      readMessages: () => messages(win, sessionId)
    })
  } catch (error) {
    const facts = inspectDatabase(sessionId)
    const terminals = await Promise.all(facts.turns.map(async (turn) => ({ turnId: turn.turn_id,
      terminal: await execute(win, `window.api.chatGetTurnTerminal(${JSON.stringify(turn.turn_id)})`) })))
    stage('assistant-persist-timeout-diagnostics', { turns: facts.turns, terminals,
      messages: facts.messages.map((item) => ({ role: item.role, status: item.status, content: item.content?.slice(0, 180) })) })
    const diagnostics = await execute(win, `({currentSessionId:window.__store?.getState?.().chat?.currentSessionId, body:document.body.innerText.slice(-1800), messages:[...document.querySelectorAll('[data-message-id],.message-item,.chat-message')].slice(-8).map((node)=>({id:node.getAttribute('data-message-id'),text:node.innerText.slice(0,240),className:node.className}))})`)
    stage('assistant-not-visible-diagnostics', diagnostics)
    throw error
  }
}

function inspectDatabase(sessionId) {
  const dbPath = path.join(DATA_DIR, 'spaceassistant-data.db')
  assert(fs.existsSync(dbPath), `SQLite database missing: ${dbPath}`)
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)
    const turns = db.prepare('SELECT turn_id, assistant_message_id, state, outcome, error_json FROM turns WHERE session_id = ? ORDER BY created_at DESC').all(sessionId)
    const persistedMessages = db.prepare('SELECT role, content, status FROM messages WHERE session_id = ? ORDER BY sequence').all(sessionId)
    const checkpoints = db.prepare('SELECT version,last_turn_id,status FROM session_transcript_checkpoints WHERE session_id = ?').all(sessionId)
    const receipts = db.prepare('SELECT turn_id,base_version,next_version,outcome,event_start,event_end FROM session_turn_commit_receipts WHERE session_id = ? ORDER BY next_version').all(sessionId)
    const terminalHistory = db.prepare(`SELECT session_id,turn_id,kind,payload_json FROM agent_history_events
      WHERE kind IN ('invocation-interrupted','invocation-completed','invocation-failed') ORDER BY session_seq DESC LIMIT 12`).all()
    const allSessionEvents = db.prepare('SELECT session_id,turn_id,invocation_id,sequence,kind FROM agent_history_events ORDER BY session_seq DESC LIMIT 20').all()
    return { session, turns, messages: persistedMessages, checkpoints, receipts, terminalHistory, allSessionEvents }
  } finally { db.close() }
}

async function runNewSession(win) {
  stage('new-session-create')
  const session = await createSessionThroughUi(win)
  stage('new-session-created', { sessionId: session.id })
  await waitFor('new session composer selected', () => execute(win, `Boolean([...document.querySelectorAll('textarea')].find((node) => node.placeholder === '输入消息…' && !node.disabled))`))
  await sendMessage(win, 'critical-flow-new-session')
  stage('new-session-sent')
  await waitFor('new user message persisted through submit IPC', async () => {
    const all = await messages(win, session.id)
    const user = all.find((item) => item.role === 'user' && item.content?.includes('critical-flow-new-session'))
    if (user) { stage('new-user-message-persisted', { status: user.status }); return user }
    return false
  }, 10_000)
  const { assistant } = await waitForAssistant(win, session.id, '固定模型回复')
  assert(assistant.status === 'completed', `new session assistant status was ${assistant.status}`)
  await waitFor('new session active turn cleared', async () => (await execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(session.id)}})`)).length === 0)
  const facts = inspectDatabase(session.id)
  assert(facts.session && facts.turns.length > 0, 'new session and turn were not persisted in SQLite')
  assert(facts.turns[0].state === 'terminal' && facts.turns[0].outcome === 'completed', `persisted new turn was not completed: ${JSON.stringify(facts.turns[0])}`)
  assert(facts.messages.some((item) => item.role === 'assistant' && item.status === 'completed'), 'successful assistant message missing from SQLite')
  return { summary: 'UI send → real IPC/Hosted/SQLite completed', sessionId: session.id }
}

async function runContinueSession(win) {
  const session = await createSessionThroughUi(win)
  stage('continue-session-created', { sessionId: session.id })
  await sendMessage(win, 'critical-flow-first-history-marker')
  await waitForAssistant(win, session.id, '固定模型回复')
  await sendMessage(win, 'critical-flow-second-history-marker')
  const data = await waitForAssistant(win, session.id, '续聊历史验证成功')
  const userMessages = data.all.filter((item) => item.role === 'user').map((item) => item.content)
  assert(userMessages.filter((value) => value.includes('critical-flow-first-history-marker')).length === 1, 'first user turn was not preserved exactly once')
  assert(userMessages.filter((value) => value.includes('critical-flow-second-history-marker')).length === 1, 'second user turn was not persisted exactly once')
  return { summary: 'continuation preserved canonical history and rendered response', sessionId: session.id }
}

async function runToolRoundtrip(win) {
  const fixture = path.join(DATA_DIR, 'workspace', 'tool-fixture.txt')
  fs.writeFileSync(fixture, 'critical-flow-tool-fixture')
  const session = await createSessionThroughUi(win)
  await sendMessage(win, '请读取 tool-fixture.txt 并告诉我文件中的固定内容。')
  const listActiveTurns = () => execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(session.id)}})`)
  const confirmation = await waitForCriticalFlowReadConfirmation({
    sessionId: session.id,
    toolName: 'read_file',
    waitFor,
    listActiveTurns,
    readConfirmation: (payload) => execute(win, `window.api.chatGetPendingConfirmation(${JSON.stringify(payload)})`)
  })
  stage('read-confirmation-host-ready', confirmation)
  const approval = await waitFor('enabled user-visible read approval', () => execute(win, `(() => { const button=[...document.querySelectorAll('button')].find((node)=>(node.getAttribute('aria-label')||node.innerText.trim())==='允许读取'); if(!button || button.disabled) return false; button.click(); return true })()`), 20_000).catch(async (error) => {
    const controls = await execute(win, `({buttons:[...document.querySelectorAll('button')].map((node)=>({name:node.getAttribute('aria-label')||node.innerText.trim(),disabled:node.disabled})).filter((node)=>node.name),body:document.body.innerText.slice(-1000)})`)
    stage('read-approval-unavailable', controls)
    throw error
  })
  assert(approval, 'read approval was not accepted through the UI')
  stage('read-approved-through-ui')
  await waitForCriticalFlowToolApprovalAccepted({
    sessionId: session.id,
    turnId: confirmation.turnId,
    toolCallId: confirmation.toolCallId,
    waitFor,
    listActiveTurns
  })
  stage('read-approval-accepted-by-host', confirmation)
  const data = await waitForAssistant(win, session.id, '工具调用后的最终回复')
  stage('tool-roundtrip-message-facts', { messages: data.all.map((item) => ({ role: item.role, content: item.content?.slice(0, 120), status: item.status, toolCalls: item.toolCalls?.map((tool) => ({ toolName: tool.toolName, status: tool.status })), toolUse: item.toolUse?.slice?.(0, 120) })) })
  assert(data.all.some((item) => item.role === 'assistant' && item.content?.includes('critical-flow-tool-fixture')), 'real tool result was not returned to the model')
  const modelStatus = await fetch(new URL('/__critical/status', process.env.CRITICAL_MODEL_URL)).then((response) => response.json())
  assert(modelStatus.toolResultSeen, 'real tool result was not included in the follow-up provider request')
  await waitFor('tool turn terminal state committed and active turn cleared', async () =>
    (await execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(session.id)}})`)).length === 0)
  const facts = inspectDatabase(session.id)
  assert(facts.turns.some((item) => item.state === 'terminal' && item.outcome === 'completed'), 'tool turn did not finish in SQLite')
  return { summary: 'real read_file dispatch and model roundtrip completed', sessionId: session.id }
}

async function runCancel(win) {
  const session = await createSessionThroughUi(win)
  await sendMessage(win, 'critical-flow-cancel-me')
  await waitForActualModelRequest()
  await waitFor('abort control visible while provider is blocked', () => execute(win, `Boolean([...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '中止生成'))`))
  await clickButton(win, '中止生成')
  const persisted = await waitFor('cancelled terminal turn committed', async () => {
    const facts = inspectDatabase(session.id)
    return facts.turns.find((item) => item.state === 'terminal')
  })
  assert(persisted.outcome === 'cancelled', `cancel produced ${persisted.outcome} terminal outcome`)
  await delay(1800)
  const afterLateResponseWindow = inspectDatabase(session.id)
  assert(afterLateResponseWindow.turns.some((item) => item.turn_id === persisted.turn_id && item.state === 'terminal' && item.outcome === 'cancelled'), 'late provider response changed cancelled terminal state')
  assert(!(await execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(session.id)}})`)).length, 'cancelled turn remained active')
  return { summary: 'cancelled state persisted and remained terminal after late response attempt', sessionId: session.id }
}

async function runSettings(win) {
  stage('settings-refresh-config-start')
  const reloaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve))
  win.reload()
  await reloaded
  await waitFor('renderer ready after persisted test-model configuration', () => win.__criticalFirstPaint, 15_000)
  stage('settings-refresh-config-ready')
  stage('settings-open-start')
  await clickButton(win, '设置')
  stage('settings-open-clicked')
  await waitFor('settings page visible', () => execute(win, `Boolean(document.querySelector('[aria-label="设置分类"]'))`))
  stage('settings-open-ready')
  await clickButton(win, '通用')
  stage('settings-general-clicked')
  await waitFor('general settings input visible', () => execute(win, `Boolean([...document.querySelectorAll('.ant-form-item')].find((item) => item.innerText.includes('并行会话上限') && item.querySelector('input')))`))
  const changed = await execute(win, `(() => {
    const item = [...document.querySelectorAll('.ant-form-item')].find((node) => node.innerText.includes('并行会话上限'))
    const input = item?.querySelector('input')
    if (!input) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '4')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(changed, 'parallel session limit input not found')
  stage('settings-value-edited')
  await clickButton(win, '大模型服务')
  stage('settings-models-clicked')
  await waitFor('models tab selected', () => execute(win, `Boolean([...document.querySelectorAll('button')].find((node) => node.innerText.trim() === '大模型服务' && node.getAttribute('aria-current') === 'page'))`))
  await clickButton(win, '通用')
  stage('settings-general-restored')
  if (process.env.CRITICAL_USER_FLOW_FAULT === FLOW) {
    console.log(`CRITICAL_FLOW_FAULT_INJECTED ${JSON.stringify({ flow: FLOW })}`)
    const injected = await execute(win, `(() => {
      const item = [...document.querySelectorAll('.ant-form-item')].find((node) => node.innerText.includes('并行会话上限'))
      const input = item?.querySelector('input')
      if (!input) return false
      input.remove()
      return true
    })()`)
    assert(injected, 'settings control could not be removed for the lost-value fault injection')
  }
  await waitFor('general tab restored with entered value', () => execute(win, `(() => { const item=[...document.querySelectorAll('.ant-form-item')].find((node)=>node.innerText.includes('并行会话上限')); return item?.querySelector('input')?.value === '4' })()`))
  const saveDispatch = execute(win, `(() => { const button=[...document.querySelectorAll('button')].find((node)=>(node.getAttribute('aria-label')||node.innerText.trim())==='保存并返回'); if(!button || button.disabled) return false; button.click(); return true })()`).catch(() => 'page-transition')
  const dispatched = await Promise.race([saveDispatch, delay(300).then(() => 'page-transition')])
  assert(dispatched === true || dispatched === 'page-transition', 'settings save action was not dispatched')
  stage('settings-save-dispatched', { evaluate: dispatched })
  try {
    await waitFor('config save committed by IPC', async () => (await execute(win, 'window.api.configGet()')).maxParallelChatSessions === 4, 8_000)
  } catch (error) {
    stage('settings-save-diagnostics', await execute(win, `(async()=>({config:await window.api.configGet(),notices:[...document.querySelectorAll('.ant-message-notice-content,.ant-notification-notice-description,.ant-form-item-explain-error')].map((node)=>node.innerText),body:document.body.innerText.slice(-1200)}))()`))
    throw error
  }
  return { summary: 'general setting survived tab unmount, saved by IPC and reread', value: 4 }
}

async function runRestartSetup(win) {
  const session = await createSessionThroughUi(win)
  await sendMessage(win, 'critical-flow-restart-seed')
  await waitForAssistant(win, session.id, '重启前已完成')
  await sendMessage(win, 'critical-flow-interrupt-before-restart')
  await waitForActualModelRequest(2)
  stage('restart-provider-request-observed')
  console.log(`CRITICAL_FLOW_RESTART_READY ${JSON.stringify({ sessionId: session.id })}`)
  await new Promise(() => {})
}

async function runRestartResume(win) {
  const sessions = await sessionList(win)
  stage('restart-resume-session-list', { sessionCount: sessions.length })
  const sessionId = process.env.CRITICAL_FLOW_SESSION_ID
  const session = sessions.find((item) => item.id === sessionId)
  assert(session, `session from pre-restart profile is missing: ${sessionId || 'session id unavailable'}`)
  const expectedName = session.name || ''
  const selected = await waitFor('pre-restart conversation rendered and selectable in the session list', () => execute(win, `(() => { const row=[...document.querySelectorAll('.session-item-select')].find((button)=>button.querySelector('.session-item-name')?.innerText.replace(/\\s+/g,' ').trim()===${JSON.stringify(expectedName)}); if(!row || row.disabled) return false; row.click(); return true })()`), 15_000).catch(async (error) => {
    stage('restart-session-list-diagnostics', {
      expectedSessionId: sessionId,
      expectedSessionName: expectedName,
      renderedSessionNames: await execute(win, `[...document.querySelectorAll('.session-item-name')].map((node)=>node.innerText.replace(/\\s+/g,' ').trim())`),
      sessionListCount: sessions.length
    })
    throw error
  })
  assert(selected, 'pre-restart conversation could not be reopened from the real session list')
  await waitFor('restarted session list selection committed in the renderer', () => execute(win, `Boolean([...document.querySelectorAll('.session-item-select[aria-current="true"]')].find((button)=>button.querySelector('.session-item-name')?.innerText.trim()===${JSON.stringify(session.name)}))`))
  await execute(win, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  await waitFor('reopened conversation composer ready', () => execute(win, `Boolean([...document.querySelectorAll('textarea')].find((node) => node.placeholder === '输入消息…' && !node.disabled))`))
  stage('restart-session-reopened-through-ui', { sessionName: session.name })
  const readActiveTurns = () => execute(win, `window.api.chatListActiveTurns({sessionId:${JSON.stringify(session.id)}})`)
  await waitFor('restarted application has settled orphan turn', async () => (await readActiveTurns()).length === 0, 25_000).catch(async (error) => {
    const diagnostics = { active: await readActiveTurns(), messages: (await messages(win, session.id)).map((item) => ({ role: item.role, status: item.status, content: item.content?.slice(0, 120) })) }
    stage('restart-recovery-not-settled', diagnostics)
    throw error
  })
  stage('restart-recovery-settled', { sessionId: session.id })
  const prior = await messages(win, session.id)
  assert(prior.some((item) => item.role === 'user' && item.content?.includes('critical-flow-interrupt-before-restart')), 'pre-restart user request did not survive in storage')
  assert(prior.some((item) => item.role === 'assistant' && item.content?.includes('重启前已完成') && item.status === 'completed'), 'completed pre-restart history did not survive storage recovery')
  await sendMessage(win, 'critical-flow-continue-after-restart')
  stage('restart-resume-message-submitted')
  const resumedUserMessage = await waitFor('continuation request persisted after restart', async () => {
    const all = await messages(win, session.id)
    return all.find((item) => item.role === 'user' && item.content?.includes('critical-flow-continue-after-restart')) || false
  }, 10_000)
  stage('restart-resume-user-persisted', { status: resumedUserMessage.status })
  await waitFor('second real provider request after restart', async () => {
    const response = await fetch(new URL('/__critical/status', process.env.CRITICAL_MODEL_URL))
    if (!response.ok) return false
    const status = await response.json()
    return status.actualRequests >= 3 && status.restartContextSeen
  }, 20_000).catch(async (error) => {
    const facts = inspectDatabase(session.id)
    const terminals = await Promise.all(facts.turns.map(async (turn) => ({ turnId: turn.turn_id, terminal: await execute(win, `window.api.chatGetTurnTerminal(${JSON.stringify(turn.turn_id)})`) })))
    const diagnostics = { active: await readActiveTurns(), turns: facts.turns, checkpoints: facts.checkpoints, receipts: facts.receipts, terminalHistory: facts.terminalHistory, allSessionEvents: facts.allSessionEvents, terminals, messages: (await messages(win, session.id)).map((item) => ({ role: item.role, status: item.status, content: item.content?.slice(0, 160) })), body: await execute(win, 'document.body.innerText.slice(-1000)') }
    stage('restart-resume-provider-not-reached', diagnostics)
    throw error
  })
  const data = await waitForAssistant(win, session.id, '固定模型回复')
  assert(data.all.some((item) => item.role === 'user' && item.content?.includes('critical-flow-continue-after-restart')), 'user could not continue recovered conversation')
  return { summary: 'process restarted, orphan state settled, same conversation continued', sessionId: session.id }
}

async function run() {
  assert(FLOW && DATA_DIR, 'flow and isolated userData must be provided')
  require(path.resolve(__dirname, '..', 'dist-electron', 'electron', 'main.js'))
  const win = await waitForWindow()
  await configureFakeModel(win)
  let result
  if (FLOW === 'new-session') result = await runNewSession(win)
  else if (FLOW === 'continue-session') result = await runContinueSession(win)
  else if (FLOW === 'tool-roundtrip') result = await runToolRoundtrip(win)
  else if (FLOW === 'cancel-stale-response') result = await runCancel(win)
  else if (FLOW === 'restart-recovery' && process.env.CRITICAL_USER_FLOW_PHASE === 'resume') result = await runRestartResume(win)
  else if (FLOW === 'restart-recovery') await runRestartSetup(win)
  else if (FLOW === 'settings-cross-tab-save') result = await runSettings(win)
  else throw new Error(`unknown flow: ${FLOW}`)
  console.log(`CRITICAL_FLOW_RESULT ${JSON.stringify({ ok: true, flow: FLOW, ...result })}`)
  app.exit(0)
}

app.on('window-all-closed', () => { /* keep harness alive until its bounded flow finishes */ })
app.whenReady().then(() => run()).catch((error) => {
  console.error(`CRITICAL_FLOW_FAILURE ${FLOW}: ${error.stack || error}`)
  try { app.exit(1) } catch { process.exitCode = 1 }
})

