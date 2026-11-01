import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import type React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createLazyChatView } from './lazyChatView'

describe('createLazyChatView', () => {
  it('keeps the fallback until the ChatView chunk is available', async () => {
    let resolveModule!: (value: { ChatView: () => React.JSX.Element }) => void
    const load = vi.fn(() => new Promise<{ ChatView: () => React.JSX.Element }>((resolve) => { resolveModule = resolve }))
    const LazyChatView = createLazyChatView(load)

    render(<Suspense fallback={<div data-testid="chat-loading" />}><LazyChatView /></Suspense>)

    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('chat-loading')).toBeTruthy()
    await act(async () => resolveModule({ ChatView: () => <div>chat ready</div> }))
    expect(screen.getByText('chat ready')).toBeTruthy()
  })
})
