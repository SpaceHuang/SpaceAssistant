import { lock } from 'proper-lockfile'

/** The derived-projection resource fence is local to this adapter and shared across processes. */
export default lock
