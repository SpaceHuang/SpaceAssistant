import { isDeepStrictEqual } from 'node:util'

/** Accepts legacy tool_call records that predate optional request attribution fields. */
export function toolCallProjectionPayloadMatches(
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>>
): boolean {
  const compatibleExpected = { ...expected }
  for (const key of ['requestId', 'invocationRequestId', 'lane'] as const) {
    if (typeof compatibleExpected[key] === 'string' && actual[key] === undefined) delete compatibleExpected[key]
  }
  return isDeepStrictEqual(actual, compatibleExpected)
}
