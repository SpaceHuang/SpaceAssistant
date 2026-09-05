import {
  TypedToolRegistry,
  type DirectToolSpec,
  type PlannedToolSpec,
  type PreparedInvocation,
  type RegisteredTool,
  type ToolExecutionContext,
  type ToolPlanningContext
} from './plannedToolRegistry'
import { describe, expect, it } from 'vitest'

const direct: DirectToolSpec<string, string> = {
  name: 'direct',
  parseInput: (raw) => String(raw),
  execute: async (input: string, _context: ToolExecutionContext) => input
}

const planned: PlannedToolSpec<{ command: string }, { argv: string[] }, string> = {
  name: 'planned',
  parseInput: (raw) => raw as { command: string },
  plan: async (input: { command: string }, _context: ToolPlanningContext) => ({ argv: [input.command] }),
  execute: async (plan: { argv: string[] }, _context: ToolExecutionContext) => plan.argv[0] ?? ''
}

void direct
void planned
const registry: TypedToolRegistry = new TypedToolRegistry()
const registered: RegisteredTool = { name: 'contract', kind: 'direct', begin: async () => { throw new Error('test-only') } }
registry.register(registered)

// PreparedInvocation is intentionally opaque to callers; construction is factory-only.
type PreparedKeys = keyof PreparedInvocation
const requiredKeys: PreparedKeys[] = ['invocationId', 'requestId', 'toolUseId', 'toolName', 'kind', 'planDigest', 'factsDigest', 'displayDigest']
void requiredKeys

describe('plannedToolRegistry type contracts', () => {
  it('loads runtime registry contract without executing a tool', () => {
    expect(registry.get('contract')?.kind).toBe('direct')
  })
})
