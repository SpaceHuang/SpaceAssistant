const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const { createStaticServer, resolveStaticFile, killProcessTree } = require('./run-critical-user-flows.cjs')

test('static server serves built renderer and refuses paths outside its root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'critical-flow-static-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'index.html'), '<main>built renderer</main>')
  const server = await createStaticServer(root)
  t.after(() => server.close())

  const html = await fetch(server.url).then((response) => response.text())
  assert.match(html, /built renderer/)
  assert.equal(resolveStaticFile(root, '/../../etc/passwd'), null)
  assert.equal(resolveStaticFile(root, '/index.html'), path.join(root, 'index.html'))
})

test('static server reports failed assets so the launcher cannot pass a degraded renderer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'critical-flow-static-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  const server = await createStaticServer(root)
  t.after(() => server.close())

  const missing = await fetch(new URL('/missing.js', server.url))
  assert.equal(missing.status, 404)
  assert.equal(server.failures.length, 1)
  assert.equal(server.failures[0].statusCode, 404)
})

test('static server refuses a symlink that escapes the built renderer directory', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'critical-flow-symlink-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'renderer')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  await fs.writeFile(path.join(parent, 'secret.txt'), 'outside renderer')
  await fs.symlink(path.join(parent, 'secret.txt'), path.join(root, 'leak.txt'))
  const server = await createStaticServer(root)
  t.after(() => server.close())

  const response = await fetch(new URL('/leak.txt', server.url))
  assert.equal(response.status, 403)
  assert.equal(await response.text(), 'forbidden')
  assert.equal(server.failures[0].statusCode, 403)
})

test('static server binds only to loopback on an ephemeral port', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'critical-flow-static-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'index.html'), 'ok')
  const server = await createStaticServer(root)
  t.after(() => server.close())
  const address = server.address
  assert.equal(address.address, '127.0.0.1')
  assert.ok(address.port > 0)
})

test('restart harness waits until the killed Electron process has actually exited', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((resolve) => child.once('spawn', resolve))
  await killProcessTree(child, 'SIGKILL')
  assert.equal(child.signalCode, 'SIGKILL')
  assert.equal(child.exitCode, null)
})
