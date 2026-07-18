export interface PathTypeDecisionRequest {
  kind: 'path-type'
  requestId: string
  requestedPath: string
  choices: ['file', 'directory']
}

/** Constructs the explicit decision required for a genuinely ambiguous absent path. */
export function requestPathTypeDecision(input: {
  requestId: string
  requestedPath: string
}): PathTypeDecisionRequest {
  return { kind: 'path-type', requestId: input.requestId, requestedPath: input.requestedPath, choices: ['file', 'directory'] }
}
