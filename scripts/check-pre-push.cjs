#!/usr/bin/env node
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ZERO_SHA = /^0+$/
const REPO_ROOT = path.resolve(__dirname, '..')

function parsePushInput(input) {
  return input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/)
    if (!localRef || !localSha || !remoteRef || !remoteSha) throw new Error(`Invalid pre-push ref line: ${line}`)
    return { localRef, localSha, remoteRef, remoteSha }
  }).filter(({ localSha }) => !ZERO_SHA.test(localSha))
}

function isRelatedTestPath(file) {
  return /^(electron|packages|src)\//.test(file) && /\.[cm]?[jt]sx?$/i.test(file)
}

function buildCheckCommands(changedFiles) {
  const uniqueFiles = [...new Set(changedFiles)].sort()
  const commands = [
    { label: 'check:no-nul', args: ['run', 'check:no-nul'] },
    { label: 'check:treesitter-wasm', args: ['run', 'check:treesitter-wasm'] },
    { label: 'check:agent-sdk', args: ['run', 'check:agent-sdk'] },
    { label: 'typecheck:shared', args: ['run', 'typecheck:shared'] }
  ]
  if (uniqueFiles.some((file) => /^(src\/renderer|src\/shared)\//.test(file))) {
    commands.push({ label: 'typecheck:renderer', args: ['run', 'typecheck:renderer'] })
  }
  if (uniqueFiles.some((file) => file.startsWith('packages/agent-sdk/'))) {
    commands.push({ label: 'typecheck:agent-sdk', args: ['run', 'typecheck:agent-sdk'] })
  }
  const testFiles = uniqueFiles.filter(isRelatedTestPath)
  if (testFiles.length) commands.push({ label: 'test:related', args: ['run', 'test:related', '--', ...testFiles] })
  return commands
}

function shouldSkip(env) {
  return env.SPACEASSISTANT_SKIP_PRE_PUSH === '1'
}

function runCommands(commands, spawn) {
  for (const command of commands) {
    const result = spawn('npm', command.args)
    const status = result.status ?? (result.error ? 1 : 0)
    if (status !== 0) return { status, failedCommand: command.label }
  }
  return { status: 0 }
}

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'buffer' })
}

function changedFilesFromRange(base, head) {
  const result = git(['diff', '--name-only', '-z', `${base}...${head}`])
  if (result.status !== 0) throw new Error(`Could not read files changed between ${base} and ${head}: ${result.stderr?.toString() || 'git diff failed'}`)
  return result.stdout.toString('utf8').split('\0').filter(Boolean)
}

function findMainBase(head) {
  const result = git(['merge-base', head, 'refs/remotes/origin/main'])
  return result.status === 0 ? result.stdout.toString('utf8').trim() : undefined
}

function discoverChangedFiles(pushInput) {
  const refs = parsePushInput(pushInput)
  if (!refs.length) {
    const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const head = 'HEAD'
    if (upstream.status === 0) {
      const upstreamRef = upstream.stdout.toString('utf8').trim()
      const base = git(['merge-base', head, upstreamRef])
      if (base.status === 0) return changedFilesFromRange(base.stdout.toString('utf8').trim(), head)
    }
    const mainBase = findMainBase(head)
    if (mainBase) return changedFilesFromRange(mainBase, head)
    const workingTree = git(['diff', '--name-only', '-z', 'HEAD'])
    if (workingTree.status !== 0) throw new Error('Could not discover local changes for check:pre-push')
    console.warn('No upstream or origin/main found; related tests cover only uncommitted changes.')
    return workingTree.stdout.toString('utf8').split('\0').filter(Boolean)
  }

  const changed = new Set()
  for (const ref of refs) {
    let base = ref.remoteSha
    if (ZERO_SHA.test(base)) {
      base = findMainBase(ref.localSha)
      if (!base) {
        console.warn(`No origin/main found for new remote branch ${ref.remoteRef}; related tests are skipped for this ref.`)
        continue
      }
    }
    for (const file of changedFilesFromRange(base, ref.localSha)) changed.add(file)
  }
  return [...changed]
}

function run() {
  if (shouldSkip(process.env)) {
    console.warn('Pre-push checks skipped by SPACEASSISTANT_SKIP_PRE_PUSH=1; GitHub required CI still applies.')
    return 0
  }
  const npmExecPath = process.env.npm_execpath
  if (!npmExecPath || !fs.existsSync(npmExecPath)) {
    console.error('Run this check with `npm run check:pre-push` so it can invoke the repository npm scripts safely.')
    return 1
  }
  const changedFiles = discoverChangedFiles(fs.readFileSync(0, 'utf8'))
  console.log(`Pre-push checks for ${changedFiles.length} changed paths.`)
  const commands = buildCheckCommands(changedFiles)
  const result = runCommands(commands, (_npm, args) => spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit'
  }))
  if (result.status !== 0) {
    console.error(`Pre-push check failed: ${result.failedCommand} (exit ${result.status}).`)
    return result.status
  }
  console.log('Pre-push checks passed.')
  return 0
}

if (require.main === module) {
  try { process.exitCode = run() } catch (error) {
    console.error(error.stack || error)
    process.exitCode = 1
  }
}

module.exports = { parsePushInput, isRelatedTestPath, buildCheckCommands, shouldSkip, runCommands, changedFilesFromRange, discoverChangedFiles }
