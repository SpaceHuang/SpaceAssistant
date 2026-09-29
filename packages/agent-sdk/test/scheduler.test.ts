import { describe, expect, it } from 'vitest'
import { canParkInvocation, InvocationRuntime, ToolScheduler, ToolSchedulerReservationError } from '../src/scheduler'

describe('SDK tool scheduler', () => {
  it('不会让失败依赖继续启动后继，也不受原型属性影响', async () => {
    const events: string[] = []
    const result = await new ToolScheduler().run([
      { id: 'toString', resourceKeys: [], run: () => false, isSuccess: (value) => value },
      { id: '__proto__', dependsOn: ['toString'], resourceKeys: [], run: () => { events.push('bad'); return true }, onDependencyFailure: () => false, isSuccess: (value) => value }
    ])
    expect(events).toEqual([])
    expect(result['__proto__']).toBe(false)
  })
  it('runs independent nodes concurrently while keeping dependencies ordered', async () => {
    const events: string[] = []
    const scheduler = new ToolScheduler()
    const result = await scheduler.run([
      { id: 'a', resourceKeys: [], run: async () => { events.push('a:start'); await Promise.resolve(); events.push('a:end'); return 'a' } },
      { id: 'b', dependsOn: ['a'], resourceKeys: [], run: async () => { events.push('b:start'); return 'b' } },
      { id: 'c', resourceKeys: [], run: async () => { events.push('c:start'); return 'c' } }
    ])
    expect(result).toEqual({ a: 'a', b: 'b', c: 'c' })
    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('a:end'))
    expect(events.indexOf('c:start')).toBeLessThan(events.indexOf('b:start'))
  })

  it('respects the injected execution concurrency limit', async () => {
    let active = 0
    let peak = 0
    const scheduler = new ToolScheduler({ maxConcurrent: 2 })
    await scheduler.run(Array.from({ length: 5 }, (_, index) => ({
      id: `node-${index}`,
      resourceKeys: [], run: async () => {
        active += 1
        peak = Math.max(peak, active)
        await Promise.resolve()
        active -= 1
        return index
      }
    })))
    expect(peak).toBe(2)
  })

  it('does not overlap nodes sharing a resource key or an unknown resource', async () => {
    let activeShared = 0
    let peakShared = 0
    const scheduler = new ToolScheduler({ maxConcurrent: 3 })
    await scheduler.run([
      { id: 'same-a', resourceKeys: ['file:/a'], run: async () => { activeShared++; peakShared = Math.max(peakShared, activeShared); await Promise.resolve(); activeShared--; return 'a' } },
      { id: 'same-b', resourceKeys: ['file:/a'], run: async () => { activeShared++; peakShared = Math.max(peakShared, activeShared); await Promise.resolve(); activeShared--; return 'b' } },
      { id: 'unknown', run: async () => 'unknown' }
    ])
    expect(peakShared).toBe(1)
  })

  it('目录资源与其子路径资源不并行，但兄弟路径仍可并行', async () => {
    const events: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 3 })
    await scheduler.run([
      { id: 'write-child', resourceKeys: ['workspace:/p/src/new.ts'], run: async () => { events.push('write'); await Promise.resolve(); return 'w' } },
      { id: 'list-dir', resourceKeys: ['workspace:/p/src'], run: async () => { events.push('list'); return 'l' } },
      { id: 'read-sibling', resourceKeys: ['workspace:/p/other.ts'], run: async () => { events.push('sibling'); return 's' } }
    ])
    expect(events.indexOf('list')).toBeGreaterThan(events.indexOf('write'))
    expect(events).toContain('sibling')
  })

  it('等待审批节点释放调度容量后，独立节点可继续执行', async () => {
    let waiting = false
    let releaseApproval!: () => void
    const approval = new Promise<string>((resolve) => { releaseApproval = () => resolve('approved') })
    const events: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 2, isWaiting: (id) => id === 'a' && waiting })
    const run = scheduler.run([
      { id: 'a', resourceKeys: [], run: async () => { waiting = true; events.push('a:waiting'); return approval } },
      { id: 'b', resourceKeys: [], run: async () => { events.push('b'); return 'b' } },
      { id: 'c', resourceKeys: [], run: async () => { events.push('c'); return 'c' } }
    ])
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toContain('c')
    releaseApproval()
    await expect(run).resolves.toMatchObject({ a: 'approved', b: 'b', c: 'c' })
  })

  it('所有在途节点都等待审批时，仍启动后续独立节点', async () => {
    const waiting = new Set<string>()
    let releaseA!: () => void
    let releaseB!: () => void
    const a = new Promise<string>((resolve) => { releaseA = () => resolve('a') })
    const b = new Promise<string>((resolve) => { releaseB = () => resolve('b') })
    const events: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 2, isWaiting: (id) => waiting.has(id) })
    const run = scheduler.run([
      { id: 'a', resourceKeys: [], run: async () => { waiting.add('a'); return a } },
      { id: 'b', resourceKeys: [], run: async () => { waiting.add('b'); return b } },
      { id: 'c', resourceKeys: [], run: async () => { events.push('c'); return 'c' } }
    ])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(events).toContain('c')
    releaseA(); releaseB()
    await expect(run).resolves.toMatchObject({ a: 'a', b: 'b', c: 'c' })
  })

  it('审批候选在启动前受限，超额节点留在计划而不是进入无界等待队列', async () => {
    let reserved = 0
    let peak = 0
    const release: Array<() => void> = []
    const scheduler = new ToolScheduler({
      maxConcurrent: 8,
      tryReserveStart: () => {
        if (reserved >= 2) return false
        reserved += 1
        peak = Math.max(peak, reserved)
        return true
      },
      releaseStart: () => { reserved -= 1 }
    })
    const nodes = Array.from({ length: 5 }, (_, index) => ({
      id: `approval-${index}`,
      resourceKeys: [],
      run: async () => new Promise<number>((resolve) => { release.push(() => resolve(index)) })
    }))
    const run = scheduler.run(nodes)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(peak).toBe(2)
    expect(release).toHaveLength(2)
    release.splice(0, 2).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(release).toHaveLength(2)
    release.splice(0, 2).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 5))
    release.splice(0).forEach((resolve) => resolve())
    await expect(run).resolves.toHaveProperty('approval-4', 4)
  })

  it('首个 ready 节点预留失败时等待容量事件，不阻塞定时器与取消', async () => {
    let available = false
    let notifyProgress!: () => void
    const scheduler = new ToolScheduler({
      tryReserveStart: () => available,
      subscribeProgress: (notify) => { notifyProgress = notify; return () => undefined }
    })
    const run = scheduler.run([{ id: 'first', resourceKeys: [], run: () => 'started' }])
    setTimeout(() => {
      available = true
      notifyProgress()
    }, 0)
    await expect(run).resolves.toEqual({ first: 'started' })
  })

  it('预留失败且没有进度订阅时返回可识别的可恢复错误，而不是同步空转', async () => {
    const run = new ToolScheduler({ tryReserveStart: () => false }).run([
      { id: 'never-started', resourceKeys: [], run: () => 'unreachable' }
    ])
    await expect(run).rejects.toBeInstanceOf(ToolSchedulerReservationError)
  })

  it('宿主提供进度订阅但永不通知时，在有界等待后返回超时错误', async () => {
    const run = new ToolScheduler({
      tryReserveStart: () => false,
      progressWaitTimeoutMs: 5,
      subscribeProgress: () => () => undefined
    }).run([{ id: 'lost-capacity', resourceKeys: [], run: () => 'unreachable' }])
    await expect(run).rejects.toMatchObject({
      name: 'ToolSchedulerReservationError',
      reason: 'progress-timeout',
      retryable: true
    })
  })

  it('节点异步进入 waiting 后仍会唤醒调度器启动后继', async () => {
    const waiting = new Set<string>()
    let release!: () => void
    const approval = new Promise<string>((resolve) => { release = () => resolve('ok') })
    const events: string[] = []
    let notifyProgress!: () => void
    const run = new ToolScheduler({
      maxConcurrent: 1,
      isWaiting: (id) => waiting.has(id),
      subscribeProgress: (notify) => { notifyProgress = notify; return () => undefined }
    }).run([
      { id: 'a', resourceKeys: [], run: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); waiting.add('a'); notifyProgress(); return approval } },
      { id: 'b', resourceKeys: [], run: async () => { events.push('b'); return 'b' } }
    ])
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(events).toEqual(['b'])
    release()
    await expect(run).resolves.toMatchObject({ a: 'ok', b: 'b' })
  })

  it('生产组合：审批候选占满预留后异步进入 waiting，事件唤醒独立节点立即运行', async () => {
    const waiting = new Set<string>()
    const approvalReleases: Array<() => void> = []
    const events: string[] = []
    let notifyProgress!: () => void
    let reserved = 0
    const run = new ToolScheduler({
      maxConcurrent: 2,
      isWaiting: (id) => waiting.has(id),
      tryReserveStart: (id) => {
        if (!id.startsWith('approval-')) return true
        if (reserved >= 2) return false
        reserved += 1
        return true
      },
      releaseStart: (id) => { if (id.startsWith('approval-')) reserved -= 1 },
      subscribeProgress: (notify) => { notifyProgress = notify; return () => undefined }
    }).run([
      { id: 'approval-a', resourceKeys: [], run: async () => { await Promise.resolve(); waiting.add('approval-a'); notifyProgress(); return new Promise<string>((resolve) => { approvalReleases.push(() => resolve('a')) }) } },
      { id: 'approval-b', resourceKeys: [], run: async () => { await Promise.resolve(); waiting.add('approval-b'); notifyProgress(); return new Promise<string>((resolve) => { approvalReleases.push(() => resolve('b')) }) } },
      { id: 'independent-read', resourceKeys: [], run: async () => { events.push('independent-read'); return 'read' } }
    ])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['independent-read'])
    approvalReleases.forEach((release) => release())
    await expect(run).resolves.toMatchObject({ 'independent-read': 'read', 'approval-a': 'a', 'approval-b': 'b' })
  })

  it('未知资源节点作为双向串行屏障', async () => {
    const events: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 2 })
    await scheduler.run([
      { id: 'unknown', run: async () => { events.push('unknown:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('unknown:end'); return 1 } },
      { id: 'known', resourceKeys: [], run: async () => { events.push('known'); return 2 } }
    ])
    expect(events).toEqual(['unknown:start', 'unknown:end', 'known'])
  })

  it('已声明资源先启动时，后继未知副作用仍必须等待', async () => {
    const events: string[] = []
    await new ToolScheduler({ maxConcurrent: 2 }).run([
      { id: 'known', resourceKeys: ['workspace:/tmp/a'], run: async () => { events.push('known'); return 1 } },
      { id: 'unknown', run: async () => { events.push('unknown:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('unknown:end'); return 2 } }
    ])
    expect(events).toEqual(['known', 'unknown:start', 'unknown:end'])
  })

  it('节点失败时等待其他在途节点收敛', async () => {
    const events: string[] = []
    const scheduler = new ToolScheduler({ maxConcurrent: 2 })
    await expect(scheduler.run([
      { id: 'failure', resourceKeys: [], run: async () => { await Promise.resolve(); throw new Error('failure') } },
      { id: 'active', resourceKeys: [], run: async () => { events.push('active:start'); await new Promise((resolve) => setTimeout(resolve, 5)); events.push('active:end'); return 1 } }
    ])).rejects.toThrow('failure')
    expect(events).toEqual(['active:start', 'active:end'])
  })

  it('节点失败时父调度不会早于兄弟副作用结束', async () => {
    const events: string[] = []
    await expect(new ToolScheduler({ maxConcurrent: 2 }).run([
      { id: 'failure', resourceKeys: [], run: async () => { await Promise.resolve(); throw new Error('failure') } },
      { id: 'side-effect', resourceKeys: ['workspace:/tmp/a'], run: async () => { events.push('start'); await new Promise((resolve) => setTimeout(resolve, 10)); events.push('end'); return 1 } }
    ])).rejects.toThrow('failure')
    expect(events).toEqual(['start', 'end'])
  })

  it('目录键带尾斜杠时仍与子文件键冲突', async () => {
    let active = 0
    let peak = 0
    await new ToolScheduler({ maxConcurrent: 2 }).run([
      { id: 'dir', resourceKeys: ['workspace:/p/src/'], run: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return 1 } },
      { id: 'file', resourceKeys: ['workspace:/p/src/new.ts'], run: async () => { active++; peak = Math.max(peak, active); await Promise.resolve(); active--; return 2 } }
    ])
    expect(peak).toBe(1)
  })

  it('returns results in original toolUse order, not completion order', async () => {
    const scheduler = new ToolScheduler({ maxConcurrent: 2 })
    const result = await scheduler.runOrdered([
      { id: 'tool-1', resourceKeys: [], run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return 'first' } },
      { id: 'tool-2', resourceKeys: [], run: async () => 'second' }
    ])
    expect(result).toEqual([
      { id: 'tool-1', value: 'first' },
      { id: 'tool-2', value: 'second' }
    ])
  })
})

describe('runtime park/resume handles', () => {
  it('only parks when every active node is waiting for approval', () => {
    expect(canParkInvocation(2, 1)).toBe(false)
    expect(canParkInvocation(2, 2)).toBe(true)
    expect(canParkInvocation(0, 0)).toBe(false)
  })

  it('rejects foreign and stale handles and does not duplicate leases', () => {
    const a = new InvocationRuntime('runtime-a')
    const b = new InvocationRuntime('runtime-b')
    const lease = a.acquireLease('inv-1')
    const parked = a.park('inv-1', lease)
    expect(parked).toBeDefined()
    if (!parked) return
    expect(b.resume(parked)).toBe(false)
    expect(a.resume(parked)).toBe(true)
    expect(a.resume(parked)).toBe(false)
    lease.release()
    expect(a.park('inv-1', lease)).toBeUndefined()
  })

  it('park 让出租约，resumeLease 返回新的 generation', () => {
    const runtime = new InvocationRuntime('runtime-lease')
    const lease = runtime.acquireLease('inv-lease')
    const parked = runtime.park('inv-lease', lease, { nodes: ['approval-wait'] })
    expect(parked).toBeDefined()
    expect(() => runtime.acquireLease('inv-lease')).toThrow('invocation already leased')
    expect(runtime.resumeLease(parked!)).toBeDefined()
    expect(runtime.resumeLease(parked!)).toBeUndefined()
  })

  it('rejects park when the runtime parked-turn bound is full', () => {
    const runtime = new InvocationRuntime('runtime-cap', { maxParkedTurns: 1 })
    const first = runtime.acquireLease('inv-1')
    const firstPark = runtime.park('inv-1', first)
    expect(firstPark).toBeDefined()
    const second = runtime.acquireLease('inv-2')
    expect(runtime.park('inv-2', second)).toBeUndefined()
    expect(() => runtime.acquireLease('inv-2')).toThrow('invocation already leased')
    second.release()
    expect(runtime.resumeLease(firstPark!)).toBeDefined()
  })
})
