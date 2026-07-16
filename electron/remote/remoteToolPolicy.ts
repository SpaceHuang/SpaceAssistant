/**
 * Pure, injectable remote tool policy decision helpers used by toolChatLoop.
 *
 * Decision order (§3.1):
 *   identity/p2p → hard deny → risk classify → migration overlay → per-tool switches
 *   → structured trust → budget → execute/audit
 *
 * This module owns the "migration overlay" and "per-tool switch" steps as small pure
 * functions so the tool loop only wires them together. It never expands loose defaults:
 * until the security migration completes, all confirm-skips below are forced OFF (ask).
 */
import { commandHasShellMetasyntax } from '../shell/shellCommandTrust'
import { CURRENT_REMOTE_SECURITY_CONFIG_VERSION } from '../../src/shared/imTypes'

export { CURRENT_REMOTE_SECURITY_CONFIG_VERSION }

/** Subset of RemoteImCommonConfig (+ feishu larkCli field) the policy reads. */
export interface RemoteSecurityPolicyConfig {
  remoteSecurityConfigVersion?: number
  remoteAllowLocalWrite?: boolean
  remoteScriptRequiresConfirm?: boolean
  remoteBrowserNavigateRequiresConfirm?: boolean
  remoteBrowserActRequiresConfirm?: boolean
  /** @deprecated combined field, only for conservative migration */
  remoteBrowserRequiresConfirm?: boolean
  larkCliWriteRequiresConfirm?: boolean
}

/** True only when the persisted config version equals the current schema version. */
export function isRemoteSecurityMigrationComplete(
  config?: { remoteSecurityConfigVersion?: number } | null
): boolean {
  return config?.remoteSecurityConfigVersion === CURRENT_REMOTE_SECURITY_CONFIG_VERSION
}

/**
 * Conservative overlay for raw/unmigrated configs. When migration is incomplete, force the
 * user-facing confirm skips OFF (i.e. keep asking) for: local file write, script `allow`,
 * browser `act`, and Feishu lark write. `navigate` is intentionally not forced by the overlay.
 */
export interface RemoteConfirmOverlay {
  fileWriteRequiresConfirm: boolean
  scriptAllowRequiresConfirm: boolean
  browserActRequiresConfirm: boolean
  larkWriteRequiresConfirm: boolean
}

export function applyMigrationConservativeOverlay(
  config?: RemoteSecurityPolicyConfig | null
): RemoteConfirmOverlay {
  if (!isRemoteSecurityMigrationComplete(config)) {
    return {
      fileWriteRequiresConfirm: true,
      scriptAllowRequiresConfirm: true,
      browserActRequiresConfirm: true,
      larkWriteRequiresConfirm: true
    }
  }
  return {
    // When migrated, follow the per-tool switches (conservative where unset).
    fileWriteRequiresConfirm: (config?.remoteAllowLocalWrite ?? true) === false,
    scriptAllowRequiresConfirm: config?.remoteScriptRequiresConfirm !== false,
    browserActRequiresConfirm: (config?.remoteBrowserActRequiresConfirm ?? true) !== false,
    larkWriteRequiresConfirm: config?.larkCliWriteRequiresConfirm !== false
  }
}

/**
 * @deprecated Remote file writes no longer skip confirm via config.
 * They require a session-scoped RemoteWriteGrant (always returns false).
 */
export function shouldSkipRemoteFileWriteConfirm(_config?: RemoteSecurityPolicyConfig | null): boolean {
  return false
}

/**
 * run_script `allow` verdict may skip confirm only when migrated and script confirm disabled.
 *
 * Callers must only invoke this when `analyzeScriptContent(code, { remote: true })` itself
 * already returned `verdict === 'allow'` (see `electron/shell/scriptContentSecurity.ts`, WP3).
 * That remote `allow` is a positive-allowlist certification: the script is fully parseable, all
 * call chains are statically resolvable, every call is in the explicit safe-capability
 * whitelist, and any whitelisted file path is static and relative to the working directory. Any
 * `ask`, `deny`, parse failure, or otherwise-uncertified script never reaches `allow`, so this
 * switch can never resurrect a skip for dynamic import, reflection (`getattr`/`setattr`),
 * `eval`/`exec`, variable-borne call objects, or unmodeled syntax — those are forced to `ask`
 * upstream regardless of this config switch.
 */
export function shouldSkipRemoteScriptConfirmOnAllow(config?: RemoteSecurityPolicyConfig | null): boolean {
  if (!isRemoteSecurityMigrationComplete(config)) return false
  return config?.remoteScriptRequiresConfirm === false
}

/**
 * browser navigate: not gated by the conservative overlay. Uses the split switch when present,
 * otherwise the deprecated combined field (default: skip when combined is false).
 */
export function shouldSkipRemoteBrowserNavigateConfirm(
  config?: RemoteSecurityPolicyConfig | null
): boolean {
  const requires =
    config?.remoteBrowserNavigateRequiresConfirm ?? config?.remoteBrowserRequiresConfirm ?? false
  return requires === false
}

/** browser act: gated by migration; default effective is require-confirm. */
export function shouldSkipRemoteBrowserActConfirm(config?: RemoteSecurityPolicyConfig | null): boolean {
  if (!isRemoteSecurityMigrationComplete(config)) return false
  const requires = config?.remoteBrowserActRequiresConfirm ?? true
  return requires === false
}

/** Feishu lark write: gated by migration; skip only when explicitly disabled. */
export function shouldSkipRemoteLarkWriteConfirm(config?: RemoteSecurityPolicyConfig | null): boolean {
  if (!isRemoteSecurityMigrationComplete(config)) return false
  return config?.larkCliWriteRequiresConfirm === false
}

/** Shell meta never-trust helper (re-exported for policy consumers). */
export function shellCommandNeverTrustable(command: string): boolean {
  return commandHasShellMetasyntax(command)
}
