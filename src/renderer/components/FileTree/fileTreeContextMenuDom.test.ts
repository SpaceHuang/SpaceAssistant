import { describe, expect, it } from 'vitest'
import { resolveFileTreeNodeKeyFromTarget } from './fileTreeContextMenuDom'

describe('resolveFileTreeNodeKeyFromTarget', () => {
  it('resolves key from switcher click within treenode', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="ant-tree-treenode">
        <span class="ant-tree-switcher"></span>
        <span class="ant-tree-node-content-wrapper">
          <div class="file-tree-node" data-file-tree-key="src/docs">
            <span class="file-tree-node-label">docs</span>
          </div>
        </span>
      </div>
    `
    const switcher = root.querySelector('.ant-tree-switcher')!
    expect(resolveFileTreeNodeKeyFromTarget(switcher)).toBe('src/docs')
  })

  it('returns null for inline input nodes without key host', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="ant-tree-treenode">
        <span class="ant-tree-node-content-wrapper">
          <div class="file-tree-node">
            <input />
          </div>
        </span>
      </div>
    `
    const input = root.querySelector('input')!
    expect(resolveFileTreeNodeKeyFromTarget(input)).toBeNull()
  })

  it('ignores inline input placeholder keys', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div class="ant-tree-treenode">
        <span class="ant-tree-node-content-wrapper">
          <div class="file-tree-node" data-file-tree-key="__inline_input__src">
            <input />
          </div>
        </span>
      </div>
    `
    const input = root.querySelector('input')!
    expect(resolveFileTreeNodeKeyFromTarget(input)).toBeNull()
  })
})
