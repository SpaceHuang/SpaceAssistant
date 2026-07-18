import { describe, expect, it } from 'vitest'
import { choiceToRelocatePayload, describeRelocateChoice } from './ArtifactRelocateDialog'

const t = (key: string) => {
  const labels: Record<string, string> = {
    'sessionArtifacts.relocateChoiceMoveSwitch': '移动并切换',
    'sessionArtifacts.relocateChoiceCopyContinue': '复制并继续编辑 {{title}}',
    'sessionArtifacts.relocateChoiceCopySwitch': '复制并切换到副本'
  }
  return labels[key] ?? key
}

describe('ArtifactRelocateDialog', () => {
  it('maps move/copy choices to IPC payload modes', () => {
    expect(choiceToRelocatePayload('move-switch')).toEqual({ mode: 'move' })
    expect(choiceToRelocatePayload('copy-continue')).toEqual({ mode: 'copy', switchToCopy: false })
    expect(choiceToRelocatePayload('copy-switch')).toEqual({ mode: 'copy', switchToCopy: true })
  })

  it('describes the current editing object for each relocate choice', () => {
    expect(describeRelocateChoice('move-switch', 'Draft', t)).toBe('移动并切换')
    expect(describeRelocateChoice('copy-continue', 'Draft', t)).toBe('复制并继续编辑 Draft')
    expect(describeRelocateChoice('copy-switch', 'Draft', t)).toBe('复制并切换到副本')
  })
})
