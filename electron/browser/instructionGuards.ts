const INSTRUCTION_MAX_LENGTH = 1024

const FORBIDDEN_SUBSTRINGS = [
  'evaluate',
  'agent(',
  'page.',
  'require(',
  'import(',
  '__',
  'javascript:',
  'data:',
  'vbscript:'
]

const ACT_MULTI_STEP_PATTERNS: Array<string | RegExp> = [
  '然后',
  '并且',
  '之后',
  '接着',
  '然后再',
  '接着就',
  '随后',
  '下一步',
  '接下来',
  '继而',
  'and then',
  'after that',
  'followed by',
  /\bthen\s+/i,
  ';',
  '&&',
  '||',
  '|'
]

export function assertInstructionLength(instruction: string): void {
  if (instruction.length > INSTRUCTION_MAX_LENGTH) {
    throw new Error('指令过长')
  }
  if (instruction.includes('\0')) {
    throw new Error('指令含空字节')
  }
}

export function assertNoForbiddenSubstrings(instruction: string): void {
  const lower = instruction.toLowerCase()
  for (const sub of FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(sub.toLowerCase())) {
      throw new Error('指令含禁止子串')
    }
  }
}

export function assertAtomicAct(instruction: string): void {
  if (instruction.includes('\n') || instruction.includes('\r')) {
    throw new Error('act 指令须为单步操作')
  }
  for (const pat of ACT_MULTI_STEP_PATTERNS) {
    if (typeof pat === 'string') {
      if (instruction.includes(pat)) {
        throw new Error('act 指令须为单步操作')
      }
    } else if (pat.test(instruction)) {
      throw new Error('act 指令须为单步操作')
    }
  }
}

export function assertSafeInstruction(instruction: string | undefined, action: string): void {
  if (action === 'observe' || action === 'extract') {
    if (instruction === undefined || instruction === null || instruction === '') return
  }
  if (instruction === undefined || instruction === null) {
    if (action === 'act' || action === 'extract') {
      throw new Error('缺少 instruction')
    }
    return
  }
  if (typeof instruction !== 'string') {
    throw new Error('指令无效')
  }
  assertInstructionLength(instruction)
  assertNoForbiddenSubstrings(instruction)
  if (action === 'act') {
    assertAtomicAct(instruction)
  }
}
