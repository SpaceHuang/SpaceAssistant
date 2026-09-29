#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'))
const appPackage = readJson('package.json')
const lock = readJson('package-lock.json')
const providerPackage = readJson('packages/agent-provider-pi-ai/package.json')
const failures = []

if (providerPackage.main !== 'dist/index.js') {
  failures.push('Electron runtime 的 provider package main 必须指向编译后的 dist/index.js')
}
if (!appPackage.scripts?.['build:agent-provider-pi-ai'] || !appPackage.scripts?.['build:electron']?.includes('build:agent-provider-pi-ai')) {
  failures.push('Electron build 必须先构建独立 pi-ai provider package')
}

const sdkPackage = readJson('packages/agent-sdk/package.json')
if (sdkPackage.exports?.['./model']?.default !== './src/model.ts') {
  failures.push('Agent SDK 必须为 provider 暴露稳定的 ./model 契约入口')
}
const providerSourceRoot = path.join(root, 'packages/agent-provider-pi-ai/src')
for (const fileName of readdirSync(providerSourceRoot, { withFileTypes: true })) {
  if (!fileName.isFile() || !/\.tsx?$/.test(fileName.name)) continue
  const source = readFileSync(path.join(providerSourceRoot, fileName.name), 'utf8')
  if (/from\s*['"][^'"\n]*agent-sdk\/src\//.test(source)) {
    failures.push(`agent-provider-pi-ai/src/${fileName.name} 必须依赖 Agent SDK public model entry，不能导入 src 内部路径`)
  }
}

const providerRelativePath = 'packages/agent-provider-pi-ai'
const productionProvider = appPackage.dependencies?.[providerPackage.name]
if (productionProvider !== `file:${providerRelativePath}`) {
  failures.push(`根 production dependencies 必须包含 ${providerPackage.name}: file:${providerRelativePath}`)
}
if (!appPackage.workspaces?.includes(providerRelativePath)) {
  failures.push(`${providerRelativePath} 必须是 npm workspace`)
}
const piAiVersion = providerPackage.dependencies?.['@earendil-works/pi-ai']
if (!piAiVersion || piAiVersion.startsWith('^') || piAiVersion.startsWith('~')) {
  failures.push('pi-ai provider 必须精确锁定 @earendil-works/pi-ai 版本')
}
if (lock.packages?.['']?.dependencies?.[providerPackage.name] !== productionProvider) {
  failures.push(`package-lock 根依赖未同步 ${providerPackage.name}`)
}
if (lock.packages?.['node_modules/@earendil-works/pi-ai']?.version !== piAiVersion) {
  failures.push(`package-lock 未锁定 pi-ai ${piAiVersion ?? '(missing)'}`)
}
if (!appPackage.build?.files?.some((entry) => entry === 'dist-electron/**/*')) {
  failures.push('electron-builder 必须打包 dist-electron 中的 production provider adapter')
}

if (failures.length) {
  console.error('[check:agent-sdk-package-closure] production package closure 不完整:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('[check:agent-sdk-package-closure] OK: production provider adapter 与 pi-ai 依赖已锁定并进入 app package graph')
