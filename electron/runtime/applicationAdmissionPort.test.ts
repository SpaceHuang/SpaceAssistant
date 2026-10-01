import { describe, expect, it, vi } from 'vitest'
import { createApplicationAdmissionPort } from './applicationAdmissionPort'

describe('createApplicationAdmissionPort', () => {
  it('keeps the admission ticket and allows the approval flow to continue when parking fails', async () => {
    const ticket = { release: vi.fn(() => true) }
    const park = vi.fn(() => undefined)
    const resume = vi.fn(async () => ({ ok: false as const, verdict: 'rejected' as const, cause: 'stale-park-handle', retryable: false }))
    const discard = vi.fn()
    const onParkFailure = vi.fn()
    const gate = { park, resume, discard, isActiveTicket: () => true } as never
    const { port, release } = createApplicationAdmissionPort(gate, ticket as never, onParkFailure)

    const handle = port.park({ reason: 'approval-wait' })
    expect(handle).toBeDefined()
    expect(park).toHaveBeenCalledWith(ticket)
    expect(onParkFailure).toHaveBeenCalledOnce()

    await expect(port.resume(handle)).resolves.toEqual({ ok: true })
    expect(resume).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()

    release()
    expect(ticket.release).toHaveBeenCalledOnce()
  })

  it('uses the gate park and resume path when parking succeeds', async () => {
    const ticket = { release: vi.fn(() => true) }
    const parkedHandle = { token: {}, request: {} }
    const resumedTicket = { release: vi.fn(() => true) }
    const gate = {
      park: vi.fn(() => parkedHandle),
      resume: vi.fn(async () => ({ ok: true as const, ticket: resumedTicket })),
      discard: vi.fn(),
      isActiveTicket: vi.fn(() => true)
    } as never
    const { port, release } = createApplicationAdmissionPort(gate, ticket as never)

    const handle = port.park({ reason: 'approval-wait' })
    expect(handle).toMatchObject({ ...parkedHandle, checkpoint: { reason: 'approval-wait' } })
    await expect(port.resume(handle)).resolves.toEqual({ ok: true })
    expect(gate.resume).toHaveBeenCalledWith(expect.objectContaining(parkedHandle), undefined)

    release()
    expect(resumedTicket.release).toHaveBeenCalledOnce()
  })

  it('does not mask a ticket that is no longer active', () => {
    const ticket = { release: vi.fn(() => true) }
    const onParkFailure = vi.fn()
    const gate = {
      park: vi.fn(() => undefined),
      resume: vi.fn(),
      discard: vi.fn(),
      isActiveTicket: vi.fn(() => false)
    } as never
    const { port } = createApplicationAdmissionPort(gate, ticket as never, onParkFailure)

    expect(port.park()).toBeUndefined()
    expect(onParkFailure).not.toHaveBeenCalled()
  })
})
