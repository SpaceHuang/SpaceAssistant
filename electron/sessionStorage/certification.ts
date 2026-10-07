/** Canonical API/context and routing read certification surface. */
export {
  CANONICAL_API_READ_FEATURE_CONFIG_KEY,
  certifyCanonicalSessionApiRead,
  isCanonicalApiReadFenceCurrent,
  readCanonicalApiContextIfEligible,
  readCanonicalTurnRoutingInputIfEligible,
  readCanonicalTurnRoutingInputWithFenceIfEligible,
  setCanonicalApiReadFeatureEnabled
} from './internal/sqliteCertification'
export type { CanonicalApiReadCertification, CanonicalApiReadFence } from './internal/sqliteCertification'
