import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOOL_LOOP_MAX_TOKENS,
  effectiveMaxTokensForBuiltinToolLoop,
  TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN,
  normalizeToolLoopMaxTokens
} from './toolLoopMaxTokens'

describe('effectiveMaxTokensForBuiltinToolLoop', () => {
  it('raises small session limits to the tools floor', () => {
    expect(effectiveMaxTokensForBuiltinToolLoop(4096)).toBe(TOOL_LOOP_MAX_TOKENS_WITH_BUILTIN_TOOLS_MIN)
  })

  it('keeps defaults when unset', () => {
    expect(effectiveMaxTokensForBuiltinToolLoop(undefined)).toBe(DEFAULT_TOOL_LOOP_MAX_TOKENS)
    expect(normalizeToolLoopMaxTokens(undefined)).toBe(DEFAULT_TOOL_LOOP_MAX_TOKENS)
  })

  it('does not reduce above-floor values', () => {
    expect(effectiveMaxTokensForBuiltinToolLoop(50000)).toBe(50000)
  })
})
