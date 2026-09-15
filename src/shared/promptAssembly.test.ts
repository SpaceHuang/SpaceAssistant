import { describe, expect, it } from 'vitest'

import {
  TOOL_ORDER_REST,
  orderTools,
  renderContextSections,
  renderContextSnapshot,
  renderPrompt,
  renderSkillFragments,
  skillCatalogBudget
} from './promptAssembly'
import { buildPromptAssembly } from './promptAssembly'
import type { PromptAssembly } from './promptAssembly'

const assembly = (overrides: Partial<PromptAssembly> = {}): PromptAssembly => ({
  sections: [],
  contexts: [],
  tools: [],
  skillFragments: [],
  variables: {},
  ...overrides
})

describe('prompt assembly rendering', () => {
  it('builds a protocol-neutral assembly without rendering it', () => {
    const result = buildPromptAssembly({ sections: [{ name: 'base', order: 1, text: 'base' }], contexts: [], tools: [{ name: 'z' }] })
    expect(result.sections).toHaveLength(1)
    expect(result.tools[0]?.name).toBe('z')
  })
  it('sorts sections, drops empty text, and interpolates variables deterministically', () => {
    expect(
      renderPrompt(
        assembly({
          variables: { name: 'Ada' },
          sections: [
            { name: 'late', order: 20, text: 'Hello {{name}}', template: true },
            { name: 'empty', order: 1, text: '   ' },
            { name: 'early', order: 10, text: 'System' }
          ]
        })
      )
    ).toBe('System\n\nHello Ada')
  })

  it('rejects unknown variables and conflicting complete sections', () => {
    expect(() => renderPrompt(assembly({ sections: [{ name: 'x', order: 1, text: '{{missing}}', template: true }] }))).toThrow(
      /unknown variable/i
    )
    expect(() =>
      renderPrompt(
        assembly({
          sections: [
            { name: 'a', order: 1, text: 'a', complete: true },
            { name: 'b', order: 2, text: 'b', complete: true }
          ]
        })
      )
    ).toThrow(/complete/i)
  })
  it('preserves ordinary double-brace text unless explicitly marked as a template', () => {
    expect(renderPrompt(assembly({ sections: [{ name: 'memory', order: 1, text: 'Hello {{name}}' }] }))).toBe('Hello {{name}}')
  })

  it('renders context sections and snapshot with the replacement banner', () => {
    const input = assembly({ contexts: [{ name: 'runtime', order: 1, text: 'cwd=/tmp' }] })
    expect(renderContextSections(input)).toBe('cwd=/tmp')
    expect(renderContextSnapshot(input)).toBe(
      'This snapshot supersedes earlier runtime-context snapshots.\n\ncwd=/tmp'
    )
    expect(renderContextSnapshot(assembly())).toBe('')
  })

  it('renders selected skill fragments as user-facing fragments', () => {
    expect(
      renderSkillFragments(
        assembly({
          skillFragments: [{ name: 'review', path: '/skills/review/SKILL.md', contents: 'Check tests.' }]
        })
      )
    ).toEqual(['<skill name="review" path="/skills/review/SKILL.md">\nCheck tests.\n</skill>'])
    expect(renderSkillFragments(assembly())).toEqual([])
  })
})

describe('prompt assembly helpers', () => {
  it('orders tools by stable code-unit name and honors an optional order', () => {
    const tools = [{ name: 'zeta' }, { name: 'alpha' }, { name: 'beta' }]
    expect(orderTools(tools).map((tool) => tool.name)).toEqual(['alpha', 'beta', 'zeta'])
    expect(orderTools(tools, ['beta', 'alpha']).map((tool) => tool.name)).toEqual(['beta', 'alpha', 'zeta'])
    expect(() => orderTools(tools, [TOOL_ORDER_REST])).toThrow(/reserved/i)
  })

  it('caps skill catalog budget at 2% of the window and 10000 tokens', () => {
    expect(skillCatalogBudget(100_000)).toBe(2_000)
    expect(skillCatalogBudget(1_000_000)).toBe(10_000)
    expect(skillCatalogBudget(100, 3_000)).toBe(2)
  })
})
