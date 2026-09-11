import { computeContextPressureFromEvents, type ContextInput, type ContextPressureProjection } from './contextMeter'

type EventSource = () => ReadonlyArray<{ seq: number; type: string; payload: Record<string, unknown> }>

export class ContextMeter {
  constructor(private readonly readEvents: EventSource) {}

  measure(input: Omit<ContextInput, 'anchor'>): ContextPressureProjection {
    return computeContextPressureFromEvents(this.readEvents(), input)
  }
}
