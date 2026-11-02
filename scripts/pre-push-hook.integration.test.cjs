const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repoRoot = path.resolve(__dirname, '..')
const hookPath = path.join(repoRoot, '.githooks')

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', ...options })
}

test('Git invokes the installed pre-push hook, honors explicit skip, and blocks on checker failure', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pre-push-hook-integration-'))
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }))
  const remote = path.join(tempRoot, 'remote.git')
  const init = git(['init', '--bare', remote])
  assert.equal(init.status, 0, init.stderr)

  const skipped = git(['-c', `core.hooksPath=${hookPath}`, 'push', remote, 'HEAD:refs/heads/skip-check'], {
    env: { ...process.env, SPACEASSISTANT_SKIP_PRE_PUSH: '1' }
  })
  assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`)
  assert.match(`${skipped.stdout}\n${skipped.stderr}`, /Pre-push checks skipped by SPACEASSISTANT_SKIP_PRE_PUSH=1/)

  const fakeBin = path.join(tempRoot, 'fake-bin')
  await fs.mkdir(fakeBin)
  const fakeNpm = path.join(fakeBin, 'npm')
  await fs.writeFile(fakeNpm, '#!/bin/sh\nprintf "FAKE_NPM_CHECK_FAILED\\n"\nexit 23\n', { mode: 0o755 })
  const blocked = git(['-c', `core.hooksPath=${hookPath}`, 'push', remote, 'HEAD:refs/heads/block-check'], {
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, SPACEASSISTANT_SKIP_PRE_PUSH: '' }
  })
  assert.notEqual(blocked.status, 0, 'push must be rejected when the local checker exits nonzero')
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /FAKE_NPM_CHECK_FAILED/)
  assert.match(`${blocked.stdout}\n${blocked.stderr}`, /failed to push some refs/)
  const rejectedRef = git(['--git-dir', remote, 'show-ref', '--verify', '--quiet', 'refs/heads/block-check'])
  assert.notEqual(rejectedRef.status, 0, 'the rejected ref must not be created in the local bare remote')
})
