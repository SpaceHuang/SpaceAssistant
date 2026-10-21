import { isDeepStrictEqual } from 'node:util'

/** Accepts tool_call records across the additive request-attribution schema change. */
export function toolCallProjectionPayloadMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): boolean {
  const compatibleActual = { ...actual }
  const compatibleExpected = { ...expected }
  for (const key of ['requestId', 'invocationRequestId', 'lane'] as const) {
    if (typeof compatibleExpected[key] === 'string' && actual[key] === undefined) delete compatibleExpected[key]
    if (expected[key] === undefined && typeof compatibleActual[key] === 'string') delete compatibleActual[key]
  }
  return isDeepStrictEqual(compatibleActual, compatibleExpected)
}
