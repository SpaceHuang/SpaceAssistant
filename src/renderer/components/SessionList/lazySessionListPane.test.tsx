import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { createLazySessionListPane } from './lazySessionListPane'

describe('createLazySessionListPane', () => {
  it('loads the session list component only when rendered', async () => {
    const load = vi.fn(async () => ({ SessionListPane: () => <div>会话列表已加载</div> }))
    const LazySessionListPane = createLazySessionListPane(load)

    expect(load).not.toHaveBeenCalled()
    render(<Suspense fallback={<div>加载中</div>}><LazySessionListPane /></Suspense>)

    expect(await screen.findByText('会话列表已加载')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })
})
