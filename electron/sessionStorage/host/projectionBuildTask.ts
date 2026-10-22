import type { LifecycleTaskRegistration } from './ports'
import type { ProjectionBuildSupervisorOptions } from '../application/projectionBuildSupervisor'
import { createProjectionBuildSupervisor } from '../application/projectionBuildSupervisor'
import type { ProjectionPreparationRequest } from './ports'

/** Binds the application supervisor to the existing derived-index lifecycle category. */
export function createProjectionBuildLifecycleTask(options: ProjectionBuildSupervisorOptions): LifecycleTaskRegistration {
  const supervisor = createProjectionBuildSupervisor(options)
  return Object.freeze({ taskId: 'session-projection-build', category: 'derived-index', start: () => supervisor.start(),
    ...(options.resolveWorkItem ? { prepare: async (input: ProjectionPreparationRequest) => {
      const item = options.resolveWorkItem!(input)
      if (!item) throw new Error('PROJECTION_SCOPE_UNAVAILABLE')
      const result = await supervisor.prepare(item)
      if (result.kind !== 'published') throw new Error(`PROJECTION_PREPARATION_${result.kind.toUpperCase().replaceAll('-', '_')}`)
    } } : {}) })
}

