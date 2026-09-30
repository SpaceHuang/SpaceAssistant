import { describe, expect, it } from 'vitest'
import {
  accumulateToolResultVolume,
  ATTRIBUTION_SCHEMA_VERSION,
  BLOCK_V1_ESTIMATOR_VERSION,
  buildMessageSkeleton,
  buildStepAttribution,
  classifyToolSource,
  emptyTurnToolDimension,
  estimateBlockV1ThreeSources,
  normalizeInputAttribution,
  normalizeOutputAttribution,
  normalizeTokensLargestRemainder,
  splitSystemSkillSection,
  summarizeOutputBlocks,
  summarizeToolDeclarations,
  type TurnToolDimension
} from './usageAttribution'

describe('buildMessageSkeleton', () => {
  it('字符串 content 归入 role|text', () => {
    const skeleton = buildMessageSkeleton([{ role: 'user', content: 'abcd' }])
    expect(skeleton['user|text']).toEqual({ chars: 4, tokens: null })
  })

  it('按 role|type 汇总各类 block 的字符数', () => {
    const skeleton = buildMessageSkeleton([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: 't1', content: '1234567' },
          { type: 'image', source: { type: 'base64', data: 'xxx' } }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinkthink', signature: 'sig' },
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'abc' } }
        ]
      }
    ])
    expect(skeleton['user|text']).toEqual({ chars: 5, tokens: null })
    expect(skeleton['user|tool_result']).toEqual({ chars: 7, tokens: null })
    expect(skeleton['user|image']).toEqual({ chars: 0, tokens: null })
    expect(skeleton['assistant|thinking']).toEqual({ chars: 10, tokens: null })
    expect(skeleton['assistant|text']).toEqual({ chars: 2, tokens: null })
    expect(skeleton['assistant|tool_use']).toEqual({ chars: JSON.stringify({ pattern: 'abc' }).length, tokens: null })
  })

  it('同类多 block 字符累加；tool_result 数组内容按 text 拼接计数', () => {
    const skeleton = buildMessageSkeleton([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'abc' }] },
          { type: 'tool_result', tool_use_id: 'b', content: 'de' }
        ]
      },
      { role: 'assistant', content: [{ type: 'text', text: 'x' }, { type: 'text', text: 'yz' }] }
    ])
    expect(skeleton['user|tool_result']).toEqual({ chars: 5, tokens: null })
    expect(skeleton['assistant|text']).toEqual({ chars: 3, tokens: null })
  })

  it('未知 block 类型按 JSON 序列化计字符（含 type 字段）；不落正文', () => {
    const block = { type: 'custom_widget', payload: 'zz' }
    const skeleton = buildMessageSkeleton([{ role: 'user', content: [block] }])
    expect(skeleton['user|custom_widget']).toEqual({ chars: JSON.stringify(block).length, tokens: null })
  })
})

describe('summarizeOutputBlocks', () => {
  it('输出侧三类分别计数：thinking / text / tool_use 参数（取自 content block，不依赖分片）', () => {
    const summary = summarizeOutputBlocks([
      { type: 'thinking', thinking: 'abcd' },
      { type: 'text', text: 'ef' },
      { type: 'tool_use', id: 't', name: 'grep', input: { p: 1 } }
    ])
    expect(summary.thinking.chars).toBe(4)
    expect(summary.text.chars).toBe(2)
    expect(summary.toolUseArgs.chars).toBe(JSON.stringify({ p: 1 }).length)
  })

  it('无输出的 step 三类均为 0', () => {
    const summary = summarizeOutputBlocks([])
    expect(summary.thinking.chars).toBe(0)
    expect(summary.text.chars).toBe(0)
    expect(summary.toolUseArgs.chars).toBe(0)
  })
})

describe('summarizeToolDeclarations / classifyToolSource', () => {
  it('按工具名统计 schema 字符，并按来源分组（mcp_ 前缀 → mcp，其余 builtin）', () => {
    const tools = [
      { name: 'grep', description: 'd1', input_schema: {} },
      { name: 'mcp_scys_search', description: 'dddd', input_schema: {} }
    ]
    const summary = summarizeToolDeclarations(tools)
    expect(summary.tools['grep']).toBe(JSON.stringify(tools[0]).length)
    expect(summary.tools['mcp_scys_search']).toBe(JSON.stringify(tools[1]).length)
    expect(summary.toolSource).toEqual({
      builtin: summary.tools['grep'],
      mcp: summary.tools['mcp_scys_search']
    })
  })

  it('classifyToolSource：mcp_ 前缀为 mcp，skills_ 工具仍是 builtin（工具声明 ≠ skill 定义）', () => {
    expect(classifyToolSource('mcp_a_b')).toBe('mcp')
    expect(classifyToolSource('skills_read')).toBe('builtin')
    expect(classifyToolSource('grep')).toBe('builtin')
  })
})

describe('工具返回体量累计', () => {
  it('emptyTurnToolDimension 为全空结构', () => {
    expect(emptyTurnToolDimension()).toEqual({ tools: {}, toolSource: {}, toolSources: {}, toolResults: {} })
  })

  it('accumulateToolResultVolume 按工具名累加调用次数与返回字符', () => {
    const dim: TurnToolDimension = emptyTurnToolDimension()
    accumulateToolResultVolume(dim, 'grep', '12345')
    accumulateToolResultVolume(dim, 'grep', '67')
    accumulateToolResultVolume(dim, 'read_file', [{ type: 'text', text: 'abc' }])
    expect(dim.toolResults['grep']).toEqual({ calls: 2, chars: 7 })
    expect(dim.toolResults['read_file']).toEqual({ calls: 1, chars: 3 })
  })
})

describe('splitSystemSkillSection', () => {
  const BASE = 'a'.repeat(100)

  it('无 ## Skills 标记时返回 null', () => {
    expect(splitSystemSkillSection(BASE)).toBeNull()
  })

  it('从 ## Skills 处切出固定样板与 skill 段，条目格式对齐 skillPrompt 生产格式（- **name**: desc (read: path)）', () => {
    const system = `${BASE}
## Skills

### Available skills

- **browser-setup-guide**: setup guide (read: )
- **diagram-design**: long desc here (read: C:\skills\diagram-design\SKILL.md)
- **truncated-skill**: 描述被预算截断无 read`
    const split = splitSystemSkillSection(system)
    expect(split).not.toBeNull()
    expect(split!.baseChars).toBe(system.indexOf('## Skills'))
    expect(split!.skillsChars).toBe(system.length - split!.baseChars)
    expect(split!.skills.map((s) => s.name)).toEqual(['browser-setup-guide', 'diagram-design', 'truncated-skill'])
    expect(split!.skills.every((s) => s.chars > 0)).toBe(true)
    expect(split!.skills[1]!.readPath).toBe('C:\skills\diagram-design\SKILL.md')
    expect(split!.skills[0]!.readPath).toBeNull()
    expect(split!.skills[2]!.readPath).toBeNull()
  })
})

describe('estimateBlockV1ThreeSources（block-v1 整体重估）', () => {
  it('三源同批产出且覆盖全部输入；与既有 default-v1 同公式但版本独立', () => {
    const messages = [{ role: 'user', content: 'hello' }]
    const three = estimateBlockV1ThreeSources({ system: 'sys', tools: [{ name: 't' }], messages })
    expect(three.systemTokens).toBe(Math.ceil('sys'.length / 3.5))
    expect(three.toolsTokens).toBe(Math.ceil(JSON.stringify([{ name: 't' }]).length / 3.5))
    expect(three.messageTokens).toBeGreaterThan(0)
    expect(three.estimatorVersion).toBe(BLOCK_V1_ESTIMATOR_VERSION)
  })
})

describe('buildStepAttribution（P2：tokens 同批填充）', () => {
  it('schemaVersion + blocks；tokens 全部非 null 且与字符同批估算', () => {
    const attribution = buildStepAttribution({
      system: 'sys',
      tools: [{ name: 't' }],
      messages: [{ role: 'user', content: 'hello' }],
      outputContent: [{ type: 'text', text: 'abcd' }]
    })
    expect(attribution.schemaVersion).toBe(ATTRIBUTION_SCHEMA_VERSION)
    expect(attribution.blocks['user|text']!.tokens).not.toBeNull()
    expect(attribution.output!.text.chars).toBe(4)
    expect(attribution.output!.text.tokens).not.toBeNull()
    // 三源真列同步产出
    expect(attribution.threeSources.systemTokens).toBeGreaterThan(0)
    expect(attribution.threeSources.estimatorVersion).toBe(BLOCK_V1_ESTIMATOR_VERSION)
  })
})

describe('normalizeTokensLargestRemainder（§6.3 约束 6 / AT7 依赖）', () => {
  it('归一化后各项之和严格等于精确总量', () => {
    const weights = [1124, 16476, 320875]
    const total = 456105
    const out = normalizeTokensLargestRemainder(weights, total)
    expect(out.reduce((a, b) => a + b, 0)).toBe(total)
  })

  it('余量按小数部分降序分配，并列时按索引升序（确定性可复现）', () => {
    // total=10, weights 均等 → 每个 floor 后余 1，全并列 → +1 给索引 0
    expect(normalizeTokensLargestRemainder([1, 1, 1], 10)).toEqual([4, 3, 3])
  })

  it('权重为空或总量为 0 时返回全 0，不抛错', () => {
    expect(normalizeTokensLargestRemainder([], 100)).toEqual([])
    expect(normalizeTokensLargestRemainder([1, 2], 0)).toEqual([0, 0])
  })

  it('随机性质校验：任意权重下和恒等于总量', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0xffffffff
    }
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * 8)
      const weights = Array.from({ length: n }, () => Math.floor(rand() * 10000))
      const total = Math.floor(rand() * 500000)
      const out = normalizeTokensLargestRemainder(weights, total)
      expect(out.reduce((a, b) => a + b, 0)).toBe(total)
    }
  })
})

describe('normalizeInputAttribution（§6.3 两段式归一化 / AT7 恒等式）', () => {
  const attribution = buildStepAttribution({
    system: 'sys',
    tools: [{ name: 'grep' }],
    messages: [
      { role: 'user', content: '问一下' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'grep', input: { p: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '结果'.repeat(100) }] }
    ],
    outputContent: [{ type: 'text', text: '答' }]
  })

  it('AT7：归一化后 system + tools + 各消息块之和 == 精确输入总量，误差为 0', () => {
    const exactInput = 456105
    const out = normalizeInputAttribution(attribution, exactInput)
    const sum = out.system + out.tools + Object.values(out.messageBlocks).reduce((a, b) => a + b, 0)
    expect(sum).toBe(exactInput)
  })

  it('估算占比自洽：大块占比更高（结构来自估算层，总量来自精确层）', () => {
    const out = normalizeInputAttribution(attribution, 1000)
    const toolResultTokens = out.messageBlocks['user|tool_result']!
    const userTextTokens = out.messageBlocks['user|text']!
    expect(toolResultTokens).toBeGreaterThan(userTextTokens)
  })

  it('精确总量为 0 时全部归 0，不抛错（AT8/I5 降级语义）', () => {
    const out = normalizeInputAttribution(attribution, 0)
    expect(out.system).toBe(0)
    expect(out.tools).toBe(0)
    expect(Object.values(out.messageBlocks).every((v) => v === 0)).toBe(true)
  })

  it('多模态块 tokens 为 null 时按 0 权重参与（不伪造数值，留位不摊分）', () => {
    const withImage = buildStepAttribution({
      system: 's',
      tools: [],
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }, { type: 'text', text: 'abc' }] }]
    })
    const out = normalizeInputAttribution(withImage, 300)
    expect(out.messageBlocks['user|image']).toBe(0)
    expect(out.system + out.tools + out.messageBlocks['user|text']!).toBe(300)
  })
})

describe('normalizeOutputAttribution（SRC-D1：输出侧三类按 output_tokens 摊回）', () => {
  it('三类之和 == 精确 output_tokens', () => {
    const attribution = buildStepAttribution({
      system: 's',
      tools: [],
      messages: [{ role: 'user', content: 'hi' }],
      outputContent: [
        { type: 'thinking', thinking: 't'.repeat(300) },
        { type: 'text', text: 'a'.repeat(100) },
        { type: 'tool_use', id: 'x', name: 'grep', input: { q: 'b'.repeat(50) } }
      ]
    })
    const out = normalizeOutputAttribution(attribution, 292827)
    const sum = out.thinking + out.text + out.toolUseArgs
    expect(sum).toBe(292827)
    // thinking 权重最大 → 摊回值最大
    expect(out.thinking).toBeGreaterThan(out.text)
    expect(out.thinking).toBeGreaterThan(out.toolUseArgs)
  })
})

describe('工具体量累计不变量（AGENTS 纪律：随机操作序列 + 守恒断言）', () => {
  it('mulberry32 随机累计后：每工具 Σcalls == 累计次数、Σchars == 累计字符，总调用数守恒', () => {
    // mulberry32 确定性伪随机（与 butlerAdmission.test.ts 同款做法）
    let seed = 20260930
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const toolNames = ['grep', 'read_file', 'mcp_a', 'mcp_b', 'write_file']
    const expectedCalls = new Map<string, number>()
    const expectedChars = new Map<string, number>()
    const dim: TurnToolDimension = emptyTurnToolDimension()
    let totalCalls = 0
    let totalChars = 0
    for (let i = 0; i < 500; i++) {
      const name = toolNames[Math.floor(rand() * toolNames.length)]!
      const contentLen = Math.floor(rand() * 200)
      accumulateToolResultVolume(dim, name, 'x'.repeat(contentLen))
      expectedCalls.set(name, (expectedCalls.get(name) ?? 0) + 1)
      expectedChars.set(name, (expectedChars.get(name) ?? 0) + contentLen)
      totalCalls += 1
      totalChars += contentLen
      // 每步不变量：Σcalls 守恒
      const sumCalls = Object.values(dim.toolResults).reduce((a, b) => a + b.calls, 0)
      expect(sumCalls).toBe(totalCalls)
    }
    for (const name of toolNames) {
      expect(dim.toolResults[name]).toEqual({ calls: expectedCalls.get(name), chars: expectedChars.get(name) })
    }
    expect(Object.values(dim.toolResults).reduce((a, b) => a + b.chars, 0)).toBe(totalChars)
  })

  it('声明明细整表替换语义：工具面收窄后旧声明不残留、toolResults 不受影响', () => {
    const dim: TurnToolDimension = emptyTurnToolDimension()
    const first = summarizeToolDeclarations([{ name: 'grep' }, { name: 'mcp_x' }])
    dim.tools = first.tools
    dim.toolSource = first.toolSource
    dim.toolSources = first.toolSources
    accumulateToolResultVolume(dim, 'grep', 'abc')
    const narrowed = summarizeToolDeclarations([{ name: 'grep' }])
    dim.tools = narrowed.tools
    dim.toolSource = narrowed.toolSource
    dim.toolSources = narrowed.toolSources
    expect(Object.keys(dim.tools)).toEqual(['grep'])
    expect(Object.keys(dim.toolSource)).toEqual(['builtin'])
    expect(dim.toolResults['grep']).toEqual({ calls: 1, chars: 3 })
  })
})
