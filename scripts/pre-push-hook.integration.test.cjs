const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const hookPath = path.join(repoRoot, '.githooks')

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: options.cwd ?? repoRoot, encoding: 'utf8', ...options })
}

test('Git invokes the installed pre-push hook, honors explicit skip, and blocks on checker failure', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pre-push-hook-integration-'))
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const remote = path.join(tempRoot, 'remote.git')
  const seed = path.join(tempRoot, 'seed')
  const source = path.join(tempRoot, 'shallow-checkout')
  const init = git(['init', '--bare', remote])
  assert.equal(init.status, 0, init.stderr)

  const seedInit = git(['init', seed])
  assert.equal(seedInit.status, 0, seedInit.stderr)
  for (const [key, value] of [['user.name', 'CI fixture'], ['user.email', 'ci-fixture@example.invalid']]) {
    const configured = git(['-C', seed, 'config', key, value])
    assert.equal(configured.status, 0, configured.stderr)
  }
  await fs.writeFile(path.join(seed, 'history.txt'), 'first commit\n')
  for (const args of [['add', 'history.txt'], ['commit', '-m', 'first commit']]) {
    const result = git(['-C', seed, ...args])
    assert.equal(result.status, 0, result.stderr)
  }
  await fs.appendFile(path.join(seed, 'history.txt'), 'second commit\n')
  for (const args of [['add', 'history.txt'], ['commit', '-m', 'second commit']]) {
    const result = git(['-C', seed, ...args])
    assert.equal(result.status, 0, result.stderr)
  }
  const cloned = git(['clone', '--depth=1', pathToFileURL(seed).href, source])
  assert.equal(cloned.status, 0, cloned.stderr)
  await fs.access(path.join(source, '.git', 'shallow'))
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true })
  await fs.copyFile(path.join(repoRoot, 'scripts', 'check-pre-push.cjs'), path.join(source, 'scripts', 'check-pre-push.cjs'))
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ scripts: { 'check:pre-push': 'node scripts/check-pre-push.cjs' } }))
  const allowShallowUpdate = git(['--git-dir', remote, 'config', 'receive.shallowUpdate', 'true'])
  assert.equal(allowShallowUpdate.status, 0, allowShallowUpdate.stderr)

  const skipped = git(['-c', `core.hooksPath=${hookPath}`, 'push', remote, 'HEAD:refs/heads/skip-check'], {
    cwd: source,
    env: { ...process.env, SPACEASSISTANT_SKIP_PRE_PUSH: '1' }
  })
  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`)
  assert.match(`${skipped.stdout}\n${skipped.stderr}`, /Pre-push checks skipped by SPACEASSISTANT_SKIP_PRE_PUSH=1/)

  const fakeBin = path.join(tempRoot, 'fake-bin')
  await fs.mkdir(fakeBin)
  const fakeNpm = path.join(fakeBin, 'npm')
  await fs.writeFile(fakeNpm, '#!/bin/sh\nprintf "FAKE_NPM_CHECK_FAILED\\n"\nexit 23\n', { mode: 0o755 })
  const blocked = git(['-c', `core.hooksPath=${hookPath}`, 'push', remote, 'HEAD:refs/heads/block-check'], {
    cwd: source,
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SPACEASSISTANT_SKIP_PRE_PUSH: '' }
  })
  assert.notEqual(blocked.status, 0, 'push must be rejected when the local checker exits nonzero')
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /FAKE_NPM_CHECK_FAILED/)
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /failed to push some refs/)
  const rejectedRef = git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/block-check'])
  assert.notEqual(rejectedRef.status, 0, 'the rejected ref must not be created in the local bare remote')
})
