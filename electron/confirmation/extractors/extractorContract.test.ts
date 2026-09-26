import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_METADATA } from '../../../src/shared/builtinToolMetadata'
import { assertExtractorsImplemented } from './runExtractors'

describe('builtin fact extractor contract', () => {
  it('每个 descriptor 声明的 extractor 都有实现', () => {
    expect(() => assertExtractorsImplemented(Object.values(BUILTIN_TOOL_METADATA))).not.toThrow()
    expect(() => assertExtractorsImplemented([{ toolName: 'test', actionClass: 'read', riskLevel: 'low', extractors: ['missing-fact'] }])).toThrow('UNIMPLEMENTED_FACT_EXTRACTOR:test:missing-fact')
  })
})
