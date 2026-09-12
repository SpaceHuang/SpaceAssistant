import fs from 'fs'
import path from 'path'
import type { SkillDefinition, SkillMeta, SkillScope } from '../../src/shared/domainTypes'
import { parse as parseYaml } from 'yaml'

export const SKILL_MD_MAX_BYTES = 100 * 1024
export const SKILL_DIR_HARD_MAX_BYTES = 512 * 1024 * 1024
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/

export type SkillValidationError = { ok: false; error: string }
export type SkillValidationOk = { ok: true; meta: SkillMeta; content: string }

export function parseFrontMatter(raw: string): { frontMatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error('SKILL.md 缺少 front matter')
  const yamlText = match[1]
  const content = match[2]
  let frontMatter: Record<string, unknown>
  try {
    const parsed = parseYaml(yamlText)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('front matter must be a mapping')
    frontMatter = parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`SKILL_FRONT_MATTER_INVALID: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { frontMatter, content }
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let currentArrayKey: string | null = null

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const arrayItem = trimmed.match(/^-\s+(.+)$/)
    if (arrayItem && currentArrayKey) {
      const arr = result[currentArrayKey]
      if (Array.isArray(arr)) arr.push(unquote(arrayItem[1].trim()))
      continue
    }

    const kv = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    const valueRaw = kv[2].trim()
    currentArrayKey = null

    if (valueRaw === '' || valueRaw === '|' || valueRaw === '>') {
      result[key] = []
      currentArrayKey = key
      continue
    }

    if (valueRaw.startsWith('[') && valueRaw.endsWith(']')) {
      const inner = valueRaw.slice(1, -1).trim()
      result[key] = inner
        ? inner.split(',').map((s) => unquote(s.trim())).filter(Boolean)
        : []
      continue
    }

    result[key] = unquote(valueRaw)
  }

  return result
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

export function validateSkillMeta(frontMatter: Record<string, unknown>): SkillValidationOk | SkillValidationError {
  const missing: string[] = []
  if (frontMatter.name === undefined) missing.push('name')
  if (frontMatter.description === undefined) missing.push('description')
  if (missing.length > 0) return { ok: false, error: `SKILL.md 缺少必填字段：${missing.join('、')}` }

  const name = String(frontMatter.name).trim()
  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: 'Skill 名称格式不合法：仅允许小写字母、数字和连字符，且以字母开头' }
  }
  if (name.length < 1 || name.length > 64) {
    return { ok: false, error: 'Skill 名称长度不合法：需为 1~64 个字符' }
  }

  const description = String(frontMatter.description).trim()
  if (!description) return { ok: false, error: 'Skill 描述不能为空' }

  const triggersRaw = frontMatter.triggers
  const triggers =
    triggersRaw === undefined
      ? []
      : Array.isArray(triggersRaw)
        ? triggersRaw.map((t) => String(t).trim()).filter(Boolean)
        : [String(triggersRaw).trim()].filter(Boolean)

  const meta: SkillMeta = {
    name,
    description,
    triggers,
    version: frontMatter.version ? String(frontMatter.version).trim() : '1.0.0',
    author: frontMatter.author ? String(frontMatter.author).trim() : ''
  }

  return { ok: true, meta, content: '' }
}

export function computeSkillDirSize(dirPath: string, limitBytes = SKILL_DIR_HARD_MAX_BYTES): { ok: boolean; totalBytes: number; exceeded: boolean } {
  let total = 0
  const stack = [dirPath]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name)
      if (ent.isDirectory()) {
        stack.push(full)
      } else if (ent.isFile()) {
        total += fs.lstatSync(full).size
        if (total > limitBytes) return { ok: false, totalBytes: total, exceeded: true }
      }
    }
  }
  return { ok: true, totalBytes: total, exceeded: false }
}

export function validateSkillDirectorySize(dirPath: string): SkillValidationError | { ok: true } {
  const result = computeSkillDirSize(dirPath)
  return result.exceeded
    ? { ok: false, error: `SKILL_DIR_TOO_LARGE: Skill 目录体积 ${result.totalBytes} 超过 ${SKILL_DIR_HARD_MAX_BYTES} 安装上限` }
    : { ok: true }
}

export function readSkillFromDirectory(
  dirPath: string,
  scope: SkillScope,
  skillMdPath?: string
): SkillDefinition {
  const filePath = skillMdPath ?? path.join(dirPath, 'SKILL.md')
  if (!fs.existsSync(filePath)) throw new Error('所选目录中未找到 SKILL.md 文件，请选择一个合法的 Skill 目录')

  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error('SKILL.md 文件无法读取，请检查文件是否损坏')
  }
  if (stat.size > SKILL_MD_MAX_BYTES) throw new Error('SKILL.md 文件体积超过 100 KB 限制')

  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new Error('SKILL.md 文件无法读取，请检查文件是否损坏')
  }

  const { frontMatter, content } = parseFrontMatter(raw)
  const validated = validateSkillMeta(frontMatter)
  if (!validated.ok) throw new Error(validated.error)

  const sizeCheck = validateSkillDirectorySize(dirPath)
  if (!sizeCheck.ok) throw new Error(sizeCheck.error)

  let source: SkillDefinition['source']
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dirPath, '.skill-source.json'), 'utf8')) as Partial<NonNullable<SkillDefinition['source']>>
    if (parsed.sourceType === 'github' && typeof parsed.sourceUrl === 'string' && typeof parsed.owner === 'string' && typeof parsed.repo === 'string' && typeof parsed.ref === 'string' && typeof parsed.subPath === 'string') source = parsed as SkillDefinition['source']
  } catch { /* 本地安装或旧版本 Skill 无来源文件 */ }

  return {
    meta: validated.meta,
    content: content.trim(),
    scope,
    directoryPath: path.resolve(dirPath),
    filePath: path.resolve(filePath),
    lastModified: stat.mtimeMs,
    source
  }
}

export function validateSkillSourceDir(sourcePath: string): SkillValidationOk & { content: string } {
  const resolved = path.resolve(sourcePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('所选路径不是有效目录')
  }
  const skill = readSkillFromDirectory(resolved, 'user')
  return { ok: true, meta: skill.meta, content: skill.content }
}
