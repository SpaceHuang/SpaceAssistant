import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WORKSPACE_LAYOUT_CONFIG,
  mergeWorkspaceLayoutConfig
} from './domainTypes'

describe('WorkspaceLayoutConfig', () => {
  it('returns defaults for null/undefined', () => {
    expect(mergeWorkspaceLayoutConfig(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT_CONFIG)
    expect(mergeWorkspaceLayoutConfig(undefined)).toEqual(DEFAULT_WORKSPACE_LAYOUT_CONFIG)
  })

  it('merges partial and deep-copies extensionSubdirMap', () => {
    const merged = mergeWorkspaceLayoutConfig({ enabled: true })
    expect(merged.enabled).toBe(true)
    expect(merged.writeDirConfirmEnabled).toBe(true)
    expect(merged.extensionSubdirMap).not.toBe(DEFAULT_WORKSPACE_LAYOUT_CONFIG.extensionSubdirMap)
    expect(merged.extensionSubdirMap[0]).toEqual({ extension: 'py', subdir: 'Script' })
  })

  it('uses provided extensionSubdirMap entries', () => {
    const merged = mergeWorkspaceLayoutConfig({
      extensionSubdirMap: [{ extension: 'rs', subdir: 'src' }]
    })
    expect(merged.extensionSubdirMap).toEqual([{ extension: 'rs', subdir: 'src' }])
  })

  it('defaults to empty array when extensionSubdirMap is null', () => {
    const merged = mergeWorkspaceLayoutConfig({ extensionSubdirMap: null })
    expect(merged.extensionSubdirMap).toEqual([])
  })
})
