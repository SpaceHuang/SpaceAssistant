import type { ArtifactPublicApi } from '../../electron/artifacts'

/** Ensures the shared layer can depend on the artifact public type boundary only. */
export type SharedArtifactEntrypointImport = ArtifactPublicApi
