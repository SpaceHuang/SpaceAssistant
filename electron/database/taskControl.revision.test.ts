import { describe, expect, it } from 'vitest'
import { mapTaskPlanRevision } from './taskControl'

describe('task control plan revision mapping', () => {
  it('retains only explicitly mapped unchanged steps and invalidates removed or replaced work', () => {
    const result = mapTaskPlanRevision({
      oldRevision: 3,
      newRevision: 4,
      oldSteps: [
        { stepId: 'scope', instruction: 'Confirm scope' },
        { stepId: 'research', instruction: 'Research options' },
        { stepId: 'budget', instruction: 'Estimate budget' }
      ],
      newSteps: [
        { stepId: 'scope-v2', instruction: 'Confirm scope' },
        { stepId: 'research-v2', instruction: 'Research alternatives' },
        { stepId: 'summary', instruction: 'Summarize findings' }
      ],
      explicitStepMapping: [
        { fromStepId: 'scope', toStepId: 'scope-v2' },
        { fromStepId: 'research', toStepId: 'research-v2' }
      ],
      outstandingInvocations: [
        { invocationId: 'invoke-scope', stepId: 'scope' },
        { invocationId: 'invoke-research', stepId: 'research' },
        { invocationId: 'invoke-budget', stepId: 'budget' }
      ]
    })

    expect(result).toEqual({
      retained: [{ fromStepId: 'scope', toStepId: 'scope-v2' }],
      invalidatedInvocationIds: ['invoke-research', 'invoke-budget'],
      oldRevision: 3,
      newRevision: 4
    })
  })
})
