import { describe, expect, it } from 'vitest'
import { resolveArtifactSafeTarget } from './safeTarget'

describe('resolveArtifactSafeTarget', () => {
  it.each(['../escape.txt', '/tmp/escape.txt', 'C:\\temp\\escape.txt', '\\\\server\\share\\escape.txt'])(
    'rejects unsafe target %s without normalizing it into a workspace path',
    async (target) => {
      await expect(resolveArtifactSafeTarget('/tmp/workspace', target)).rejects.toThrow(/artifact path/i)
    }
  )
})
