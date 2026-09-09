const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { _electron: electron } = require('playwright')

const root = path.resolve(__dirname, '..')
const renderer = spawn('npm', ['run', 'dev:renderer'], { cwd: root, stdio: 'ignore', env: { ...process.env, FORCE_COLOR: '0' } })

function waitForRenderer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000
    const poll = () => {
      const request = http.get('http://127.0.0.1:9240/', (response) => {
        response.resume()
        if (response.statusCode && response.statusCode < 500) return resolve()
        retry()
      })
      request.on('error', retry)
      request.setTimeout(500, () => { request.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error('renderer did not become ready'))
      setTimeout(poll, 100)
    }
    poll()
  })
}

async function main() {
  let app
  const userDataDir = fs.mkdtempSync('/tmp/spaceassistant-dom-probe-')
  try {
    await waitForRenderer()
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, path.join(root, 'dist-electron/electron/main.js')],
      cwd: root,
      env: { ...process.env, SPACEASSISTANT_DEV: '1', FORCE_COLOR: '0' }
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByText('会话', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
    const sessionId = await page.evaluate(async () => {
      const sessions = await window.api.sessionList()
      if (sessions[0]?.id) return sessions[0].id
      const created = await window.api.sessionCreate({ name: 'DOM projection probe' })
      if (!created?.id) throw new Error('session:create did not return a session')
      return created.id
    })
    const content = `dom-probe-${Date.now()}`
    const prepared = await page.evaluate(async ({ sessionId, content }) => window.api.chatPrepareTurn({
      mode: 'create-user',
      requestId: `dom-request-${Date.now()}`,
      sessionId,
      input: { text: content },
      config: {}
    }), { sessionId, content })
    if (!prepared?.assistantMessage?.id) throw new Error('chat:prepare-turn did not return assistant snapshot')
    await page.reload()
    await page.getByText('会话', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
    await page.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    const recoveredActiveTurn = await page.evaluate(async ({ sessionId, turnId }) => {
      const activeTurns = await window.api.chatListActiveTurns({ sessionId })
      return activeTurns.find((turn) => turn.turnId === turnId) ?? null
    }, { sessionId, turnId: prepared.turnId })
    if (!recoveredActiveTurn || recoveredActiveTurn.assistantMessage.id !== prepared.assistantMessage.id) {
      throw new Error('reload did not recover the prepared active turn snapshot')
    }
    const oldPage = page
    await oldPage.evaluate(() => window.close())
    await app.evaluate(async (_electron, mainPath) => {
      const createRequire = process.getBuiltinModule('module').createRequire
      const main = createRequire(mainPath)(mainPath)
      await main.createMainWindow()
    }, path.join(root, 'dist-electron/electron/main.js'))
    const reconnectedPage = await app.firstWindow()
    await reconnectedPage.waitForLoadState('domcontentloaded')
    await reconnectedPage.getByText('会话', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 })
    const reconnectedActiveTurn = await reconnectedPage.evaluate(async ({ sessionId, turnId }) => {
      const activeTurns = await window.api.chatListActiveTurns({ sessionId })
      return activeTurns.find((turn) => turn.turnId === turnId) ?? null
    }, { sessionId, turnId: prepared.turnId })
    if (!reconnectedActiveTurn || reconnectedActiveTurn.assistantMessage.id !== prepared.assistantMessage.id) {
      throw new Error('reconnected window did not recover the prepared active turn snapshot')
    }
    await reconnectedPage.getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
    const sentAt = Date.now()
    await app.evaluate(({ BrowserWindow }, payload) => {
      const window = BrowserWindow.getAllWindows()[0]
      window?.webContents.send('chat:turn-projection', payload)
    }, {
      turn: {
        turnId: `dom-turn-${Date.now()}`,
        requestId: `dom-request-${Date.now()}`,
        sessionId,
        version: 1,
        assistantMessage: {
          id: prepared.assistantMessage.id,
          sessionId,
          role: 'assistant',
          content,
          timestamp: Date.now(),
          status: 'streaming',
          schemaVersion: 1
        }
      },
      event: { type: 'content-delta' }
    })
    await reconnectedPage.getByLabel('助手回复').getByText(content, { exact: true }).waitFor({ state: 'visible', timeout: 5_000 })
    const thinking = `dom-thinking-${Date.now()}`
    const toolName = `dom-tool-${Date.now()}`
    const assistant = {
      ...prepared.assistantMessage,
      content,
      thinking: { content: thinking, isVisible: true, startTime: Date.now() },
      toolCalls: [{ id: toolName, toolName: 'run_shell', input: { command: 'echo probe' }, status: 'completed', riskLevel: 'low', result: { success: true, data: 'probe-result' } }]
    }
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('chat:turn-projection', payload), {
      turn: { turnId: prepared.turnId, requestId: prepared.requestId, sessionId, version: 2, assistantMessage: assistant }, event: { type: 'thinking-delta' }
    })
    await reconnectedPage.locator('.tool-row__main').last().click()
    const thinkingToggle = reconnectedPage.getByRole('button', { name: '展开思考过程' }).last()
    if (await thinkingToggle.count()) {
      await thinkingToggle.click()
    } else {
      const thinkingText = reconnectedPage.getByText('展开思考过程', { exact: true }).last()
      if (await thinkingText.count()) await thinkingText.click()
    }
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('chat:turn-projection', payload), {
      turn: { turnId: prepared.turnId, requestId: prepared.requestId, sessionId, version: 3, assistantMessage: assistant }, event: { type: 'tool-result' }
    })
    await reconnectedPage.waitForTimeout(100)
    await app.evaluate(({ BrowserWindow }, payload) => BrowserWindow.getAllWindows()[0]?.webContents.send('chat:turn-projection', payload), {
      turn: { turnId: prepared.turnId, requestId: prepared.requestId, sessionId, version: 4, assistantMessage: { ...assistant, status: 'completed' } },
      event: { type: 'source-completed' }
    })
    await reconnectedPage.waitForTimeout(100)
    const result = await reconnectedPage.evaluate(({ sentAt, content, thinking, reloadRecoveredActiveTurn }) => ({
      title: document.title,
      messageCount: document.querySelectorAll('[data-message-id], [class*="message"]').length,
      hasComposer: Boolean(document.querySelector('textarea, input[placeholder*="输入消息"]')),
      hasModelSelector: Boolean(document.querySelector('[aria-label*="模型"], [title*="模型"]')),
      bodyTextLength: document.body.innerText.length,
      projectedContentVisible: document.body.innerText.includes(content),
      projectionToDomMs: Date.now() - sentAt,
      thinkingVisible: document.body.innerText.includes(thinking),
      toolResultVisible: document.body.innerText.includes('probe-result'),
      reloadRecoveredActiveTurn,
      windowReconnectedActiveTurn: true,
      terminalProjectionApplied: !document.body.innerText.includes('执行中')
    }), { sentAt, content, thinking, reloadRecoveredActiveTurn: Boolean(recoveredActiveTurn) })
    console.log(`[chat-renderer-dom] ${JSON.stringify(result)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    renderer.kill('SIGTERM')
  }
}

main().catch((error) => {
  console.error('[chat-renderer-dom] failed:', error)
  process.exitCode = 1
})
