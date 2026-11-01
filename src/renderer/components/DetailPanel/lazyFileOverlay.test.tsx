import { act, render, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { createLazyFileOverlay } from './lazyFileOverlay'

describe('createLazyFileOverlay', () => {
  it('keeps the overlay fallback until its preview chunk is available', async () => {
    let resolveModule!: (value: { FileOverlay: () => React.JSX.Element }) => void
    const load = vi.fn(() => new Promise<{ FileOverlay: () => React.JSX.Element }>((resolve) => { resolveModule = resolve }))
    const LazyFileOverlay = createLazyFileOverlay(load)

    render(<Suspense fallback={<div data-testid="overlay-loading" />}><LazyFileOverlay /></Suspense>)

    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('overlay-loading')).toBeTruthy()
    await act(async () => resolveModule({ FileOverlay: () => <div>overlay ready</div> }))
    expect(screen.getByText('overlay ready')).toBeTruthy()
  })
})
