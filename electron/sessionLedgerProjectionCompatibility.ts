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

/** Accepts execution diagnostics added by the live tool-result projection when canonical recovery replays its base result. */
export function toolResultProjectionPayloadMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): boolean {
  const compatibleActual = { ...actual }
  const compatibleExpected = { ...expected }
  const actualResult = actual.result
  const expectedResult = expected.result
  if (!actualResult || typeof actualResult !== 'object' || Array.isArray(actualResult) ||
    !expectedResult || typeof expectedResult !== 'object' || Array.isArray(expectedResult)) {
    return isDeepStrictEqual(compatibleActual, compatibleExpected)
  }
  const nextActualResult = { ...(actualResult as Record<string, unknown>) }
  const nextExpectedResult = { ...(expectedResult as Record<string, unknown>) }
  const allowedDiagnostics: Readonly<Record<string, readonly unknown[]>> = {
    executionOutcome: ['succeeded', 'known-failure', 'unknown-after-dispatch', 'not-dispatched'],
    executorEntry: ['not-entered', 'entered', 'unknown']
  }
  for (const [key, values] of Object.entries(allowedDiagnostics)) {
    if (nextExpectedResult[key] === undefined && nextActualResult[key] !== undefined && values.includes(nextActualResult[key])) {
      delete nextActualResult[key]
    }
  }
  compatibleActual.result = nextActualResult
  compatibleExpected.result = nextExpectedResult
  return isDeepStrictEqual(compatibleActual, compatibleExpected)
}
