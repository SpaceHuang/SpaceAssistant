import { describe, expect, it } from 'vitest'
import { tableToMarkdown } from './tableMarkdownCopy'

describe('tableToMarkdown', () => {
  it('serializes a table as a GFM Markdown table', () => {
    const table = document.createElement('table')
    table.innerHTML = '<thead><tr><th>Name</th><th>State</th></tr></thead><tbody><tr><td>Alpha</td><td>Ready</td></tr></tbody>'

    expect(tableToMarkdown(table)).toBe('| Name | State |\n| --- | --- |\n| Alpha | Ready |')
  })

  it('escapes pipes, normalizes cell whitespace, and pads short rows', () => {
    const table = document.createElement('table')
    table.innerHTML = '<tr><th>A | B</th><th>C</th><th>D</th></tr><tr><td>one\ntwo</td><td></td></tr>'

    expect(tableToMarkdown(table)).toBe('| A \\| B | C | D |\n| --- | --- | --- |\n| one two |  |  |')
  })

  it('returns null for a table without rows', () => {
    expect(tableToMarkdown(document.createElement('table'))).toBeNull()
  })
})
