import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const dependencyVersion = packageJson.devDependencies?.['@earendil-works/pi-ai']
if (!dependencyVersion || dependencyVersion.startsWith('^') || dependencyVersion.startsWith('~')) {
  throw new Error('@earendil-works/pi-ai must be pinned to an exact version in devDependencies')
}

const [{ getBuiltinModelDataGeneratedAt, getBuiltinModels, getBuiltinProviders }] = await Promise.all([
  import('@earendil-works/pi-ai/providers/all'),
])

const PROVIDER_PRIORITY = [
  'anthropic', 'openai', 'google', 'google-vertex',
  'deepseek', 'moonshotai', 'moonshotai-cn', 'zai', 'zai-coding-cn',
  'minimax', 'minimax-cn', 'xai', 'mistral',
  'openrouter', 'vercel-ai-gateway', 'opencode', 'opencode-go',
  'github-copilot', 'azure-openai-responses', 'amazon-bedrock'
]
const priorityIndex = new Map(PROVIDER_PRIORITY.map((provider, index) => [provider, index]))
const providers = getBuiltinProviders().sort((a, b) =>
  (priorityIndex.get(a) ?? Number.MAX_SAFE_INTEGER) - (priorityIndex.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
)
const models = {}
for (const provider of providers) {
  for (const model of getBuiltinModels(provider)) {
    if (typeof model.id !== 'string' || !model.id || models[model.id]) continue
    const contextWindow = model.contextWindow
    const maxTokens = model.maxTokens
    if (!Number.isFinite(contextWindow) || contextWindow <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) continue
    const entry = {
      maximumContext: contextWindow,
      maxTokens,
      isVision: Array.isArray(model.input) && model.input.includes('image'),
      reasoning: model.reasoning === true,
      sourceProvider: provider
    }
    if (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object') {
      entry.thinkingLevelMap = Object.fromEntries(Object.entries(model.thinkingLevelMap)
        .filter(([, value]) => value === null || typeof value === 'string'))
    }
    models[model.id] = entry
  }
}

const generatedAtValue = getBuiltinModelDataGeneratedAt?.()
const generatedAt = generatedAtValue && Number.isFinite(generatedAtValue)
  ? new Date(generatedAtValue).toISOString()
  : '2026-09-25T00:00:00.000Z'
const output = `${JSON.stringify({ schemaVersion: 1, generatedAt, piAiVersion: dependencyVersion, models }, null, 2)}\n`
const outputPath = path.join(root, 'res/resource/model-baseline.json')
const modesPath = path.join(root, 'res/resource/modes.md')
const isCheck = process.argv.includes('--check')
const modes = '模型能力基线来自 pi-ai。当前可用模型由用户配置的 API 服务发现与模型关联决定，本文件不维护预置模型名单。\n'

if (isCheck) {
  let existing
  try {
    existing = await readFile(outputPath, 'utf8')
  } catch {
    throw new Error('模型基线文件不存在，请运行 npm run model:baseline')
  }
  if (existing !== output) throw new Error('模型基线与当前固定依赖不一致，请运行 npm run model:baseline 后提交')
  const existingModes = await readFile(modesPath, 'utf8')
  if (existingModes !== modes) throw new Error('modes.md 与模型基线不一致，请运行 npm run model:baseline 后提交')
  const { LEGACY_MODEL_PARAMS } = await import('../src/shared/modelBaseline.ts')
  const overlaps = Object.keys(LEGACY_MODEL_PARAMS).filter((name) => Object.hasOwn(models, name))
  if (overlaps.length) throw new Error(`LEGACY_MODEL_PARAMS 已被基线覆盖，请删除：${overlaps.join(', ')}`)
} else {
  await writeFile(outputPath, output)
  await writeFile(modesPath, modes)
}
