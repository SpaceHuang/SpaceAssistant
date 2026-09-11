import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompactionMarker } from './CompactionMarker'

describe('CompactionMarker', () => {
  it('renders the committed compaction label and count', () => {
    render(<CompactionMarker count={2} />)
    expect(screen.getByTestId('chat-compaction-marker').textContent).toContain('以上内容已压缩')
    expect(screen.getByTestId('chat-compaction-marker').textContent).toContain('2')
  })
})
