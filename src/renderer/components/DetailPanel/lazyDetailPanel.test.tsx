import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { createLazyDetailPanel } from './lazyDetailPanel'

describe('createLazyDetailPanel', () => {
  it('loads the panel body only when rendered', async () => {
    const load = vi.fn(async () => ({ DetailPanel: () => <div>文件面板已加载</div> }))
    const LazyDetailPanel = createLazyDetailPanel(load)

    expect(load).not.toHaveBeenCalled()
    render(<Suspense fallback={<div>加载中</div>}><LazyDetailPanel /></Suspense>)

    expect(await screen.findByText('文件面板已加载')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
