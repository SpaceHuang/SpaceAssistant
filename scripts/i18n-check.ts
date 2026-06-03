import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RESOURCES_DIR = path.resolve(__dirname, '../src/renderer/i18n/resources')
const LANGS = ['zh-CN', 'en-US'] as const
const strictHardcoded = process.argv.includes('--strict-hardcoded')

function walkJson(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...walkJson(v as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

function collectKeys(langDir: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const file of fs.readdirSync(langDir).filter((f) => f.endsWith('.json'))) {
    const ns = path.basename(file, '.json')
    const raw = fs.readFileSync(path.join(langDir, file), 'utf-8')
    const json = JSON.parse(raw) as Record<string, unknown>
    map.set(ns, new Set(walkJson(json)))
  }
  return map
}

function diffKeys(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((k) => !b.has(k)).sort()
}

function checkKeyAlignment(): boolean {
  const zhKeys = collectKeys(path.join(RESOURCES_DIR, 'zh-CN'))
  const enKeys = collectKeys(path.join(RESOURCES_DIR, 'en-US'))
  let ok = true

  for (const ns of new Set([...zhKeys.keys(), ...enKeys.keys()])) {
    const zh = zhKeys.get(ns) ?? new Set<string>()
    const en = enKeys.get(ns) ?? new Set<string>()
    const zhOnly = diffKeys(zh, en)
    const enOnly = diffKeys(en, zh)
    if (zhOnly.length > 0) {
      console.error(`❌ Keys in zh-CN/${ns}.json but missing in en-US:`, zhOnly)
      ok = false
    }
    if (enOnly.length > 0) {
      console.error(`❌ Keys in en-US/${ns}.json but missing in zh-CN:`, enOnly)
      ok = false
    }
  }
  return ok
}

function walkDir(dir: string, extensions: string[]): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'i18n') continue
      results.push(...walkDir(full, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full)
    }
  }
  return results
}

function checkHardcodedChinese(): boolean {
  const srcDir = path.resolve(__dirname, '../src/renderer')
  const files = walkDir(srcDir, ['.tsx', '.ts'])
  const chinesePattern = /[\u4e00-\u9fff]/
  let count = 0

  for (const file of files) {
    if (file.includes(`${path.sep}i18n${path.sep}resources${path.sep}`)) continue
    const content = fs.readFileSync(file, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (chinesePattern.test(lines[i]!)) {
        console.warn(`⚠️  Hardcoded Chinese: ${path.relative(path.resolve(__dirname, '..'), file)}:${i + 1}`)
        count++
      }
    }
  }

  console.log(`${count} hardcoded Chinese occurrences found`)
  if (strictHardcoded && count > 0) return false
  return true
}

function checkJsonFormat(): boolean {
  let ok = true
  for (const lang of LANGS) {
    const langDir = path.join(RESOURCES_DIR, lang)
    for (const file of fs.readdirSync(langDir).filter((f) => f.endsWith('.json'))) {
      try {
        JSON.parse(fs.readFileSync(path.join(langDir, file), 'utf-8'))
      } catch {
        console.error(`❌ Invalid JSON: ${lang}/${file}`)
        ok = false
      }
    }
  }
  return ok
}

const alignmentOk = checkKeyAlignment()
const jsonOk = checkJsonFormat()
const noChinese = checkHardcodedChinese()

if (alignmentOk && jsonOk && noChinese) {
  console.log('✅ i18n check passed')
  process.exit(0)
} else {
  console.error('❌ i18n check failed')
  process.exit(1)
}
