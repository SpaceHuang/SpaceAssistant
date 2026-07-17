import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_DEFINITIONS } from './builtinToolDefinitions'

type JsonSchema = {
  properties?: Record<string, JsonSchema>
  enum?: string[]
  required?: string[]
  oneOf?: JsonSchema[]
}

function schemaFor(toolName: 'write_file' | 'edit_file'): JsonSchema {
  const tool = BUILTIN_TOOL_DEFINITIONS.find((candidate) => candidate.name === toolName)
  if (!tool) throw new Error(`Missing ${toolName} schema`)
  return tool.input_schema as JsonSchema
}

describe('artifact write intent schema', () => {
  it('allows pathKind only inside write_file artifact metadata', () => {
    const schema = schemaFor('write_file')
    const artifact = schema.properties?.artifact

    expect(schema.properties?.pathKind).toBeUndefined()
    expect(artifact?.properties?.pathKind?.enum).toEqual(['file', 'directory', 'auto'])
  })

  it('requires pathEvidenceId when user provenance is declared', () => {
    const artifact = schemaFor('write_file').properties?.artifact
    const userBranch = artifact?.oneOf?.find((branch) => branch.properties?.pathSource?.enum?.includes('user'))

    expect(userBranch?.required).toContain('pathEvidenceId')
  })

  it('does not expose main-process provenance sources to the agent', () => {
    const artifact = schemaFor('write_file').properties?.artifact
    const allowedSources = artifact?.oneOf?.flatMap((branch) => branch.properties?.pathSource?.enum ?? [])

    expect(allowedSources).toEqual(['user', 'project-convention', 'agent-default'])
  })
})
