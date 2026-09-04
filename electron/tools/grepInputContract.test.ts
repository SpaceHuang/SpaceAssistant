import { describe, expect, it } from 'vitest'
import { validateGrepInput } from './builtinExecutors'

describe('grep input contract', () => {
  it.each([
    [{ output_mode: 'bad' }, /output_mode/],
    [{ output_mode: 'content', context: 1.2 }, /context/],
    [{ output_mode: 'content', head_limit: -1 }, /head_limit/],
    [{ output_mode: 'count', multiline: true }, /仅适用于/]
  ])('拒绝非法参数 %#', (input, error) => expect(validateGrepInput(input)).toMatch(error))

  it('接受 content 的合法限制', () => expect(validateGrepInput({ output_mode: 'content', context: 10, head_limit: 100 })).toBeNull())
})
