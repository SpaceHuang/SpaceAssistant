#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const https = require('node:https')
const { spawnSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const FLOWS = [
  'new-session', 'continue-session', 'tool-roundtrip', 'cancel-stale-response',
  'restart-recovery', 'settings-cross-tab-save'
]
const FLOW_TIMEOUT_MS = Number(process.env.CRITICAL_USER_FLOW_TIMEOUT_MS || 120_000)

function resolveStaticFile(root, pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const absolute = path.resolve(root, relative)
  const rel = path.relative(path.resolve(root), absolute)
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  return absolute
}

async function createStaticServer(root) {
  const absoluteRoot = path.resolve(root)
  const failures = []
  const server = http.createServer(async (request, response) => {
    const file = resolveStaticFile(absoluteRoot, new URL(request.url, 'http://127.0.0.1').pathname)
    if (!file) {
      failures.push({ statusCode: 403, path: request.url })
      response.writeHead(403).end('forbidden')
      return
    }
    try {
      const [rootRealPath, fileRealPath] = await Promise.all([fsp.realpath(absoluteRoot), fsp.realpath(file)])
      const realRelative = path.relative(rootRealPath, fileRealPath)
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        failures.push({ statusCode: 403, path: request.url })
        response.writeHead(403).end('forbidden')
        return
      }
      const stat = await fsp.stat(fileRealPath)
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' })
      const type = fileRealPath.endsWith('.js') ? 'text/javascript' : fileRealPath.endsWith('.css') ? 'text/css' : fileRealPath.endsWith('.svg') ? 'image/svg+xml' : fileRealPath.endsWith('.json') ? 'application/json' : 'text/html'
      response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
      fs.createReadStream(fileRealPath).pipe(response)
    } catch {
      failures.push({ statusCode: 404, path: request.url })
      response.writeHead(404).end('not found')
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}/`
  const probe = await fetch(url)
  if (!probe.ok) {
    await new Promise((resolve) => server.close(resolve))
    throw new Error(`renderer service did not become ready (${probe.status})`)
  }
  return {
    url,
    address,
    failures,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function createFakeAnthropicServer(certRoot) {
  const keyPath = path.join(certRoot, 'critical-flow.key')
  const certPath = path.join(certRoot, 'critical-flow.crt')
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'
  ], { encoding: 'utf8' })
  if (certificate.status !== 0) throw new Error(`could not create local model TLS certificate: ${certificate.stderr || certificate.error}`)
  const key = fs.readFileSync(keyPath)
  const cert = fs.readFileSync(certPath)
  const requests = []
  const actualRequestsByFlow = new Map()
  const toolResultSeenByFlow = new Map()
  const restartContextSeenByFlow = new Map()
  let activeFlow = null
  const pending = new Set()
  const server = https.createServer({ key, cert }, async (request, response) => {
    if (request.method === 'GET' && request.url === '/__critical/status') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ actualRequests: actualRequestsByFlow.get(activeFlow) || 0,
        toolResultSeen: toolResultSeenByFlow.get(activeFlow) === true,
        restartContextSeen: restartContextSeenByFlow.get(activeFlow) === true }))
      return
    }
    if (request.method !== 'POST' || !request.url.includes('/messages')) {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      response.writeHead(400).end('bad request')
      return
    }
    const flow = activeFlow
    const injectFault = process.env.CRITICAL_USER_FLOW_FAULT === flow
    if (injectFault) console.log(`CRITICAL_FLOW_FAULT_INJECTED ${JSON.stringify({ flow })}`)
    requests.push({ flow, body })
    console.log(`CRITICAL_MODEL_REQUEST ${JSON.stringify({ flow, request: requests.length, messageCount: body.messages?.length, toolCount: body.tools?.length || 0 })}`)
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0
    if (hasTools) actualRequestsByFlow.set(flow, (actualRequestsByFlow.get(flow) || 0) + 1)
    if (flow === 'tool-roundtrip' && !injectFault && JSON.stringify(body.messages).includes('critical-flow-tool-fixture')) toolResultSeenByFlow.set(flow, true)
    if (flow === 'restart-recovery' && !injectFault && JSON.stringify(body.messages).includes('critical-flow-interrupt-before-restart')) restartContextSeenByFlow.set(flow, true)
    const priorTurnRequests = requests.slice(0, -1).filter((item) => item.flow === flow && Array.isArray(item.body.tools) && item.body.tools.length > 0).length
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const sendFrames = async (frames) => {
      for (const [event, data] of frames) {
        if (response.destroyed || response.writableEnded) return
        send(event, data)
        console.log(`CRITICAL_MODEL_FRAME ${JSON.stringify({ flow, request: requests.length, event })}`)
        await new Promise((resolve) => setTimeout(resolve, 12))
      }
      if (!response.destroyed && !response.writableEnded) {
        response.end()
        console.log(`CRITICAL_MODEL_RESPONSE_END ${JSON.stringify({ flow, request: requests.length })}`)
      }
    }
    const sendMessageStart = () => send('message_start', { type: 'message_start', message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    const finish = async (text) => {
      if (response.destroyed || response.writableEnded) {
        console.log(`CRITICAL_MODEL_RESPONSE_SKIPPED ${JSON.stringify({ flow, request: requests.length, destroyed: response.destroyed, ended: response.writableEnded })}`)
        return
      }
      console.log(`CRITICAL_MODEL_RESPONSE_START ${JSON.stringify({ flow, request: requests.length })}`)
      await sendFrames([
        ['message_start', { type: 'message_start', message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    }
    const finishToolUse = async () => {
      if (response.destroyed || response.writableEnded) return
      await sendFrames([
        ['message_start', { type: 'message_start', message: { id: `msg-${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `critical-tool-${requests.length}`, name: 'read_file', input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'tool-fixture.txt' }) } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', { type: 'message_stop' }]
      ])
    }
    const index = requests.length
    let output
    if (flow === 'continue-session' && hasTools && priorTurnRequests === 1) {
      const userContent = body.messages.filter((message) => message.role === 'user').map((message) => JSON.stringify(message.content)).join('\n')
      const firstMarkerCount = (userContent.match(/critical-flow-first-history-marker/g) || []).length
      const hasSecondMarker = userContent.includes('critical-flow-second-history-marker')
      const correct = firstMarkerCount === 1 && hasSecondMarker
      console.log(`CRITICAL_HISTORY_CHECK ${JSON.stringify({ firstMarkerCount, hasSecondMarker, userMessageCount: body.messages.filter((message) => message.role === 'user').length })}`)
      output = correct ? '续聊历史验证成功' : `续聊历史验证失败: ${userContent}`
    } else if (flow === 'continue-session' && hasTools) {
      output = '固定模型回复 第一轮'
    } else if (flow === 'tool-roundtrip' && hasTools && priorTurnRequests === 0) {
      const timer = setTimeout(finishToolUse, 40)
      timer.unref()
      pending.add(response)
      response.once('close', () => { clearTimeout(timer); pending.delete(response) })
      return
    } else if (flow === 'tool-roundtrip' && hasTools) {
      output = '工具调用后的最终回复：critical-flow-tool-fixture'
    } else if (flow === 'restart-recovery' && hasTools && priorTurnRequests === 0) {
      output = '重启前已完成'
    } else if (flow === 'restart-recovery' && hasTools && priorTurnRequests === 1) {
      const timer = setTimeout(finish, 60_000, '重启前的迟到回复')
      timer.unref()
      pending.add(response)
      response.once('close', () => pending.delete(response))
      return
    } else if (flow === 'restart-recovery' && hasTools) {
      output = '固定模型回复 重启后继续'
    } else if (flow === 'continue-session' || flow === 'tool-roundtrip' || flow === 'restart-recovery') {
      output = '{"skills":[]}'
    } else {
      output = `固定模型回复 ${index + 1}`
    }
    if (injectFault && flow === 'new-session' && hasTools) output = '故障注入：新会话回复内容丢失'
    if (injectFault && flow === 'continue-session' && hasTools && priorTurnRequests === 1) output = '故障注入：续聊历史校验失败'
    const actualTurn = hasTools
    const delayMs = flow === 'cancel-stale-response' && actualTurn && !injectFault ? 5000 : 40
    const timer = setTimeout(() => finish(output), delayMs)
    console.log(`CRITICAL_MODEL_RESPONSE_SCHEDULED ${JSON.stringify({ flow, request: requests.length, actualTurn, delayMs })}`)
    timer.unref()
    pending.add(response)
    response.once('close', () => {
      if (flow !== 'cancel-stale-response' && flow !== 'restart-recovery') clearTimeout(timer)
      pending.delete(response)
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `https://127.0.0.1:${server.address().port}`,
      certPath,
      requests,
      setFlow: (flow) => { activeFlow = flow },
      close: () => new Promise((done) => {
        for (const response of pending) response.destroy()
        server.close(() => done())
      })
    }))
  })
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* already exited */ }
      }
    }, signal === 'SIGKILL' ? 3000 : 3000)
    child.once('exit', finish)
    child.once('error', finish)
    try { child.kill(signal) } catch { finish() }
  })
}

function inspectProfileDatabase(profileDir) {
  const dbPath = path.join(profileDir, 'spaceassistant-data.db')
  if (!fs.existsSync(dbPath)) return { exists: false }
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return { turns: db.prepare('SELECT turn_id,state,outcome,error_json FROM turns ORDER BY created_at DESC LIMIT 5').all(),
        messages: db.prepare('SELECT role,status,substr(content,1,160) AS content FROM messages ORDER BY sequence DESC LIMIT 8').all(),
        checkpoints: db.prepare('SELECT session_id,version,last_turn_id,status FROM session_transcript_checkpoints').all(),
        transcriptEntries: db.prepare('SELECT session_id,turn_id,base_version,version,outcome FROM session_transcript_entries ORDER BY version DESC LIMIT 6').all(),
        configKeys: db.prepare('SELECT key FROM configs ORDER BY key').all().map(({ key }) => key),
        maxParallelChatSessions: db.prepare("SELECT value FROM configs WHERE key='config.maxParallelChatSessions'").get()?.value ?? null }
    } finally { db.close() }
  } catch (error) { return { error: error.message } }
}

function runElectronFlow({ flow, profileDir, rendererUrl, modelUrl, phase, onActualModelRequest }) {
  return new Promise((resolve, reject) => {
    const electronPath = require('electron')
    if (typeof electronPath !== 'string') return reject(new Error('electron executable path unavailable'))
    const child = spawn(electronPath, [path.join(__dirname, 'critical-user-flows.electron.cjs')], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        SPACEASSISTANT_DEV: '1',
        SPACEASSISTANT_DEV_USER_DATA_DIR: profileDir,
        ELECTRON_START_URL: rendererUrl,
        CRITICAL_USER_FLOW: flow,
        CRITICAL_USER_DATA_DIR: profileDir,
        CRITICAL_MODEL_URL: modelUrl,
        NODE_EXTRA_CA_CERTS: require('node:path').join(profileDir, '..', 'critical-flow.crt'),
        ...(phase ? { CRITICAL_USER_FLOW_PHASE: phase } : {}),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let result = null
    let settled = false
    const timeout = setTimeout(async () => {
      if (settled) return
      settled = true
      const database = inspectProfileDatabase(profileDir)
      await killProcessTree(child)
      reject(new Error(`${flow}: timeout after ${FLOW_TIMEOUT_MS}ms\nDATABASE ${JSON.stringify(database)}\n${stdout}\n${stderr}`))
    }, FLOW_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      const value = chunk.toString()
      stdout += value
      for (const line of value.split(/\r?\n/)) {
        if (line.startsWith('CRITICAL_FLOW_RESTART_READY ')) {
          let restart
          try { restart = JSON.parse(line.slice('CRITICAL_FLOW_RESTART_READY '.length)) } catch { restart = {} }
          if (flow === 'restart-recovery' && !phase && !settled) {
            settled = true
            clearTimeout(timeout)
            void killProcessTree(child, 'SIGKILL').then(() => resolve({ restartReady: true, ...restart }))
            return
          }
        }
        if (!line.startsWith('CRITICAL_FLOW_RESULT ')) continue
        try { result = JSON.parse(line.slice('CRITICAL_FLOW_RESULT '.length)) } catch { /* malformed result is caught at exit */ }
      }
      if (value.includes('CRITICAL_FLOW_ACTUAL_REQUEST_READY')) onActualModelRequest?.(child)
      process.stdout.write(value)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk) })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code !== 0 || !result?.ok) return reject(new Error(`${flow}: Electron exited ${code ?? signal} without successful result\n${stdout}\n${stderr}`))
      resolve(result)
    })
  })
}

async function run() {
  const rendererRoot = path.resolve(__dirname, '..', 'dist', 'renderer')
  if (!fs.existsSync(path.join(rendererRoot, 'index.html'))) throw new Error(`renderer build missing: ${rendererRoot}`)
  if (!fs.existsSync(path.resolve(__dirname, '..', 'dist-electron', 'electron', 'main.js'))) throw new Error('Electron build missing; run verify:critical-user-flows')
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'spaceassistant-critical-flows-'))
  const renderer = await createStaticServer(rendererRoot)
  const model = await createFakeAnthropicServer(tempRoot)
  const results = []
  try {
    const selectedFlows = process.env.CRITICAL_USER_FLOWS_ONLY ? [process.env.CRITICAL_USER_FLOWS_ONLY] : FLOWS
    if (selectedFlows.some((flow) => !FLOWS.includes(flow))) throw new Error('CRITICAL_USER_FLOWS_ONLY contains an unknown flow')
    for (const flow of selectedFlows) {
      model.setFlow(flow)
      const profileDir = path.join(tempRoot, flow)
      await fsp.mkdir(profileDir, { recursive: true })
      let result
      if (flow === 'restart-recovery') {
        const setup = await runElectronFlow({ flow, profileDir, rendererUrl: renderer.url, modelUrl: model.url })
        if (!setup.restartReady || !setup.sessionId) throw new Error('restart setup did not reach an in-flight persisted session')
        result = await runElectronFlow({ flow, profileDir, rendererUrl: renderer.url, modelUrl: model.url, phase: 'resume' })
      } else {
        result = await runElectronFlow({ flow, profileDir, rendererUrl: renderer.url, modelUrl: model.url })
      }
      results.push(result)
      console.log(`PASS ${flow}: ${result.summary}`)
      if (renderer.failures.length) throw new Error(`renderer static server saw failed resource requests: ${JSON.stringify(renderer.failures)}`)
    }
    if (results.length !== selectedFlows.length) throw new Error(`only ${results.length}/${selectedFlows.length} selected flows reported success`)
    console.log(`Critical user flows: ${results.length}/${selectedFlows.length} selected flows passed`)
  } finally {
    await Promise.allSettled([renderer.close(), model.close()])
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
}

if (require.main === module) run().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })

module.exports = { createStaticServer, resolveStaticFile, createFakeAnthropicServer, killProcessTree, FLOWS }
