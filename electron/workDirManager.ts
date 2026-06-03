import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { Session } from '../src/shared/domainTypes'
import type { WorkDirProfile } from '../src/shared/feishuTypes'
import type { AppDatabase } from './database'
import { getConfigValue, listSessions, setConfigValue } from './database'

const PROFILES_KEY = 'config.workDirProfiles'
const ACTIVE_KEY = 'config.activeWorkDirProfileId'
const WORK_DIR_KEY = 'config.workDir'
const LEGACY_MIGRATED_PROFILE_NAME = '工作目录'

export type WorkDirManager = {
  listProfiles(): WorkDirProfile[]
  addProfile(input: Omit<WorkDirProfile, 'id'>): { success: boolean; profile?: WorkDirProfile; error?: string }
  updateProfile(profileId: string, updates: Partial<WorkDirProfile>): { success: boolean; error?: string }
  removeProfile(profileId: string): { success: boolean; error?: string }
  switchProfile(profileId: string): Promise<{ success: boolean; error?: string; sessions: Session[] }>
  getActiveProfile(): WorkDirProfile | undefined
  getActiveWorkDir(): string
  getActiveProfileId(): string
  validateProfilesForSave(profiles: WorkDirProfile[]): { valid: boolean; error?: string }
  validateProfileInput(
    input: { name: string; path: string },
    excludeId?: string
  ): { valid: boolean; error?: string }
  checkDirectoryWritable(dirPath: string): { ok: boolean; error?: string }
  migrateFromLegacy(): void
  persistProfiles(profiles: WorkDirProfile[], activeId: string): void
}

export function checkDirectoryWritable(dirPath: string): { ok: boolean; error?: string } {
  try {
    if (!dirPath.trim()) {
      return { ok: false, error: '路径不能为空' }
    }
    fs.mkdirSync(dirPath, { recursive: true })
    const testFile = path.join(dirPath, `.write_test_${Date.now()}`)
    fs.writeFileSync(testFile, 'test')
    fs.unlinkSync(testFile)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function readProfiles(db: AppDatabase): WorkDirProfile[] {
  const raw = getConfigValue(db, PROFILES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as WorkDirProfile[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeProfiles(db: AppDatabase, profiles: WorkDirProfile[]): void {
  setConfigValue(db, PROFILES_KEY, JSON.stringify(profiles))
}

function readActiveId(db: AppDatabase): string {
  return getConfigValue(db, ACTIVE_KEY) ?? ''
}

function writeActiveId(db: AppDatabase, id: string): void {
  setConfigValue(db, ACTIVE_KEY, id)
}

function profileDisplayName(profile: Pick<WorkDirProfile, 'name' | 'path'>): string {
  const trimmed = profile.name.trim()
  if (trimmed) return trimmed
  return path.basename(profile.path) || profile.path
}

function normalizePath(p: string): string {
  return path.normalize(p.trim())
}

export function listSessionsForProfile(db: AppDatabase, profileId: string): Session[] {
  return listSessions(db).filter((s) => {
    if (!s.workDirProfileId) return false
    return s.workDirProfileId === profileId
  })
}

export function createWorkDirManager(ctx: {
  db: AppDatabase
  getWorkDir: () => string
  setWorkDir: (dir: string) => void
  onBeforeSwitch?: () => Promise<void>
  onAfterSwitch?: (fromId: string, toId: string) => void
}): WorkDirManager {
  let switchLock = false

  function listProfiles(): WorkDirProfile[] {
    return readProfiles(ctx.db)
  }

  function getActiveProfileId(): string {
    const profiles = listProfiles()
    const stored = readActiveId(ctx.db)
    if (stored && profiles.some((p) => p.id === stored)) return stored
    return profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? ''
  }

  function getActiveProfile(): WorkDirProfile | undefined {
    const id = getActiveProfileId()
    return listProfiles().find((p) => p.id === id)
  }

  function getActiveWorkDir(): string {
    const profile = getActiveProfile()
    if (profile?.path) return profile.path
    return ctx.getWorkDir()
  }

  function validateProfileInput(
    input: { name: string; path: string },
    excludeId?: string
  ): { valid: boolean; error?: string } {
    const name = input.name.trim()
    const dirPath = normalizePath(input.path)
    if (!name) return { valid: false, error: '名称不能为空' }
    if (!dirPath) return { valid: false, error: '路径不能为空' }
    const writeCheck = checkDirectoryWritable(dirPath)
    if (!writeCheck.ok) {
      return { valid: false, error: `目录 ${name} 不可写入：${writeCheck.error ?? '权限不足'}` }
    }
    const profiles = listProfiles()
    if (profiles.some((p) => p.id !== excludeId && p.name === name)) {
      return { valid: false, error: '工作目录名称不能重复' }
    }
    if (profiles.some((p) => p.id !== excludeId && normalizePath(p.path) === dirPath)) {
      return { valid: false, error: '工作目录路径不能重复' }
    }
    return { valid: true }
  }

  function validateProfilesForSave(profiles: WorkDirProfile[]): { valid: boolean; error?: string } {
    if (profiles.length === 0) {
      return { valid: false, error: '请至少添加一个工作目录' }
    }
    const defaultCount = profiles.filter((p) => p.isDefault).length
    if (defaultCount !== 1) {
      return { valid: false, error: '请指定一个默认工作目录' }
    }
    const names = new Set<string>()
    const paths = new Set<string>()
    for (const p of profiles) {
      const name = p.name.trim()
      const dirPath = normalizePath(p.path)
      if (!name) return { valid: false, error: '工作目录名称不能为空' }
      if (!dirPath) return { valid: false, error: '工作目录路径不能为空' }
      if (names.has(name)) return { valid: false, error: '工作目录名称不能重复' }
      if (paths.has(dirPath)) return { valid: false, error: '工作目录路径不能重复' }
      names.add(name)
      paths.add(dirPath)
      const writeCheck = checkDirectoryWritable(dirPath)
      if (!writeCheck.ok) {
        return { valid: false, error: `目录 ${profileDisplayName(p)} 不可写入：${writeCheck.error ?? '权限不足'}` }
      }
    }
    return { valid: true }
  }

  function persistProfiles(profiles: WorkDirProfile[], activeId: string): void {
    writeProfiles(ctx.db, profiles)
    writeActiveId(ctx.db, activeId)
    const active = profiles.find((p) => p.id === activeId) ?? profiles.find((p) => p.isDefault)
    if (active?.path) {
      setConfigValue(ctx.db, WORK_DIR_KEY, active.path)
      ctx.setWorkDir(active.path)
    }
  }

  function addProfile(input: Omit<WorkDirProfile, 'id'>): { success: boolean; profile?: WorkDirProfile; error?: string } {
    const validation = validateProfileInput(input)
    if (!validation.valid) return { success: false, error: validation.error }

    const profiles = listProfiles()
    const isFirst = profiles.length === 0
    const id = randomUUID()
    const profile: WorkDirProfile = {
      ...input,
      id,
      name: input.name.trim(),
      path: normalizePath(input.path),
      isDefault: isFirst ? true : Boolean(input.isDefault)
    }

    if (profile.isDefault) {
      profiles.forEach((p) => {
        p.isDefault = false
      })
    }
    profiles.push(profile)
    writeProfiles(ctx.db, profiles)

    if (isFirst || profile.isDefault) {
      writeActiveId(ctx.db, id)
      setConfigValue(ctx.db, WORK_DIR_KEY, profile.path)
      ctx.setWorkDir(profile.path)
    }

    return { success: true, profile }
  }

  function updateProfile(profileId: string, updates: Partial<WorkDirProfile>): { success: boolean; error?: string } {
    const profiles = listProfiles()
    const index = profiles.findIndex((p) => p.id === profileId)
    if (index < 0) return { success: false, error: '目录不存在' }

    const next = { ...profiles[index], ...updates }
    if (updates.name !== undefined) next.name = updates.name.trim()
    if (updates.path !== undefined) next.path = normalizePath(updates.path)

    const validation = validateProfileInput(
      { name: next.name, path: next.path },
      profileId
    )
    if (!validation.valid) return { success: false, error: validation.error }

    if (updates.isDefault) {
      profiles.forEach((p) => {
        p.isDefault = p.id === profileId
      })
    }

    profiles[index] = next
    writeProfiles(ctx.db, profiles)

    if (next.isDefault) {
      writeActiveId(ctx.db, profileId)
      setConfigValue(ctx.db, WORK_DIR_KEY, next.path)
      ctx.setWorkDir(next.path)
    } else if (getActiveProfileId() === profileId && updates.path) {
      setConfigValue(ctx.db, WORK_DIR_KEY, next.path)
      ctx.setWorkDir(next.path)
    }

    return { success: true }
  }

  function removeProfile(profileId: string): { success: boolean; error?: string } {
    const profiles = listProfiles()
    if (profiles.length <= 1) {
      return { success: false, error: '请至少保留一个工作目录' }
    }
    const index = profiles.findIndex((p) => p.id === profileId)
    if (index < 0) return { success: false, error: '目录不存在' }

    const wasDefault = profiles[index].isDefault
    profiles.splice(index, 1)
    if (wasDefault && profiles.length > 0) {
      profiles[0].isDefault = true
      writeActiveId(ctx.db, profiles[0].id)
      setConfigValue(ctx.db, WORK_DIR_KEY, profiles[0].path)
      ctx.setWorkDir(profiles[0].path)
    }
    writeProfiles(ctx.db, profiles)
    return { success: true }
  }

  async function switchProfile(
    profileId: string
  ): Promise<{ success: boolean; error?: string; sessions: Session[] }> {
    if (switchLock) {
      return { success: false, error: '切换进行中，请稍候', sessions: [] }
    }

    const profiles = listProfiles()
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile) {
      return { success: false, error: '目录不存在', sessions: [] }
    }

    if (!fs.existsSync(profile.path)) {
      return { success: false, error: `目录已失效：${profile.path}，请重新配置`, sessions: [] }
    }

    const fromId = getActiveProfileId()
    if (fromId === profileId) {
      return { success: true, sessions: listSessionsForProfile(ctx.db, profileId) }
    }

    switchLock = true
    try {
      await ctx.onBeforeSwitch?.()
      writeActiveId(ctx.db, profileId)
      setConfigValue(ctx.db, WORK_DIR_KEY, profile.path)
      ctx.setWorkDir(profile.path)
      ctx.onAfterSwitch?.(fromId, profileId)
      return { success: true, sessions: listSessionsForProfile(ctx.db, profileId) }
    } catch (err) {
      return { success: false, error: (err as Error).message, sessions: [] }
    } finally {
      switchLock = false
    }
  }

  function migrateFromLegacy(): void {
    let profiles = readProfiles(ctx.db)
    if (profiles.length > 0) return

    const legacyWorkDir = getConfigValue(ctx.db, WORK_DIR_KEY) ?? ctx.getWorkDir()
    if (!legacyWorkDir) return

    const defaultProfile: WorkDirProfile = {
      id: 'default',
      name: LEGACY_MIGRATED_PROFILE_NAME,
      path: legacyWorkDir,
      isDefault: true
    }
    writeProfiles(ctx.db, [defaultProfile])
    writeActiveId(ctx.db, defaultProfile.id)
    setConfigValue(ctx.db, WORK_DIR_KEY, legacyWorkDir)

    let changed = false
    for (const s of ctx.db.data.sessions) {
      if (!s.workDirProfileId) {
        s.workDirProfileId = defaultProfile.id
        changed = true
      }
    }
    if (changed) ctx.db.flushSave()
  }

  return {
    listProfiles,
    addProfile,
    updateProfile,
    removeProfile,
    switchProfile,
    getActiveProfile,
    getActiveWorkDir,
    getActiveProfileId,
    validateProfilesForSave,
    validateProfileInput,
    checkDirectoryWritable,
    migrateFromLegacy,
    persistProfiles
  }
}
