/**
 * Pure planner for the one-time remote-security migration/summary (§2.3.3, plan §6.2).
 *
 * Given the RAW stored feishu/wechat configs plus install state, it computes:
 *  - whether a summary must be shown before applying looser defaults;
 *  - the pre-summary effective security strength (for honest UI);
 *  - legacy mappings (remote_read_only, combined browser field);
 *  - "recommended" and "safer" preset patches;
 * without ever silently widening behavior. Applying a patch is done atomically elsewhere.
 */
import { CURRENT_REMOTE_SECURITY_CONFIG_VERSION, type RemoteSecurityPresetSource } from './imTypes'
import type { FeishuConfig } from './feishuTypes'
import type { WeChatConfig } from './wechatTypes'

export type RemoteSecurityPresetKind = 'recommended' | 'safer'

type RawFeishu =
  | (Omit<Partial<FeishuConfig>, 'remoteConfirmPolicy'> & { remoteConfirmPolicy?: string })
  | null
  | undefined
type RawWeChat =
  | (Omit<Partial<WeChatConfig>, 'remoteConfirmPolicy'> & { remoteConfirmPolicy?: string })
  | null
  | undefined

export interface RemoteSecurityMigrationInput {
  feishu?: RawFeishu
  wechat?: RawWeChat
  /** True when remote has never been configured/enabled (fresh install). */
  isNewInstall: boolean
}

export interface RemoteSecurityCommonPatch {
  remoteAllowLocalWrite: boolean
  remoteDenyOutbound: boolean
  remoteScriptRequiresConfirm: boolean
  remoteBrowserNavigateRequiresConfirm: boolean
  remoteBrowserActRequiresConfirm: boolean
  remoteSecurityConfigVersion: number
  remoteSecurityPresetSource: RemoteSecurityPresetSource
}

export interface RemoteSecurityPatch {
  common: RemoteSecurityCommonPatch
  feishu: { larkCliWriteRequiresConfirm: boolean }
}

export type EffectiveVerdict = 'confirm' | 'skip' | 'deny'

export interface RemoteSecurityEffectiveStrength {
  fileWrite: EffectiveVerdict
  scriptAllow: EffectiveVerdict
  browserNavigate: EffectiveVerdict
  browserAct: EffectiveVerdict
  larkWrite: EffectiveVerdict
}

/** Result returned by the atomic commit IPC: the merged configs for both channels. */
export interface RemoteSecurityCommitResult {
  feishu: FeishuConfig
  wechat: WeChatConfig
}

export interface RemoteSecurityMigrationPlan {
  needsSummary: boolean
  isMigrated: boolean
  isNewInstall: boolean
  legacyReadOnly: boolean
  legacyBrowserCombined?: boolean
  legacyMappings: string[]
  effectiveStrength: RemoteSecurityEffectiveStrength
  recommended: RemoteSecurityPatch
  safer: RemoteSecurityPatch
}

function isReadOnly(cfg: RawFeishu | RawWeChat): boolean {
  return cfg?.remoteConfirmPolicy === 'remote_read_only'
}

/** Legacy combined browser confirm switch, if explicitly present as `true`. */
function legacyBrowserCombinedTrue(input: RemoteSecurityMigrationInput): boolean {
  return input.feishu?.remoteBrowserRequiresConfirm === true ||
    input.wechat?.remoteBrowserRequiresConfirm === true
}

function anyDenyOutbound(input: RemoteSecurityMigrationInput): boolean {
  return input.feishu?.remoteDenyOutbound === true || input.wechat?.remoteDenyOutbound === true
}

function configVersion(cfg: RawFeishu | RawWeChat): number | undefined {
  return cfg?.remoteSecurityConfigVersion
}

export function isRemoteSecurityMigrated(input: RemoteSecurityMigrationInput): boolean {
  const versions: (number | undefined)[] = []
  if (input.feishu) versions.push(configVersion(input.feishu))
  if (input.wechat) versions.push(configVersion(input.wechat))
  if (versions.length === 0) return false
  return versions.every((v) => v === CURRENT_REMOTE_SECURITY_CONFIG_VERSION)
}

export function buildRemoteSecurityPreset(
  kind: RemoteSecurityPresetKind,
  input: RemoteSecurityMigrationInput
): RemoteSecurityPatch {
  const readOnly = isReadOnly(input.feishu) || isReadOnly(input.wechat)
  const browserCombinedTrue = legacyBrowserCombinedTrue(input)
  const denyOutbound = readOnly || anyDenyOutbound(input)

  // remote_read_only always maps to hard deny-write + deny-outbound (unaffected by preset).
  const remoteAllowLocalWrite = readOnly ? false : true

  const presetSource: RemoteSecurityPresetSource = input.isNewInstall
    ? 'new-install'
    : kind === 'recommended'
      ? 'upgrade-recommended'
      : 'upgrade-safer'

  if (kind === 'safer') {
    return {
      common: {
        remoteAllowLocalWrite,
        remoteDenyOutbound: denyOutbound,
        remoteScriptRequiresConfirm: true,
        remoteBrowserNavigateRequiresConfirm: true,
        remoteBrowserActRequiresConfirm: true,
        remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION,
        remoteSecurityPresetSource: presetSource
      },
      feishu: { larkCliWriteRequiresConfirm: true }
    }
  }

  // recommended (low-friction): file allow skip, script allow skip, navigate skip, act confirm,
  // lark high-impact confirm. Browser combined-true legacy forces navigate confirm (no widening).
  return {
    common: {
      remoteAllowLocalWrite,
      remoteDenyOutbound: denyOutbound,
      remoteScriptRequiresConfirm: false,
      remoteBrowserNavigateRequiresConfirm: browserCombinedTrue ? true : false,
      remoteBrowserActRequiresConfirm: true,
      remoteSecurityConfigVersion: CURRENT_REMOTE_SECURITY_CONFIG_VERSION,
      remoteSecurityPresetSource: presetSource
    },
    feishu: { larkCliWriteRequiresConfirm: true }
  }
}

export function planRemoteSecurityMigration(
  input: RemoteSecurityMigrationInput
): RemoteSecurityMigrationPlan {
  const isMigrated = isRemoteSecurityMigrated(input)
  const readOnly = isReadOnly(input.feishu) || isReadOnly(input.wechat)
  const browserCombinedTrue = legacyBrowserCombinedTrue(input)

  const legacyMappings: string[] = []
  if (readOnly) legacyMappings.push('remote_read_only→deny_write+deny_outbound')
  if (browserCombinedTrue) legacyMappings.push('browser_combined_true→navigate+act_confirm')

  // Pre-summary effective behavior (WP0 conservative overlay keeps gated tools confirming).
  const navigateSkipsPreSummary = !browserCombinedTrue
  const effectiveStrength: RemoteSecurityEffectiveStrength = {
    fileWrite: readOnly ? 'deny' : 'confirm',
    scriptAllow: 'confirm',
    browserNavigate: navigateSkipsPreSummary ? 'skip' : 'confirm',
    browserAct: 'confirm',
    larkWrite: readOnly ? 'deny' : 'confirm'
  }

  return {
    needsSummary: !isMigrated,
    isMigrated,
    isNewInstall: input.isNewInstall,
    legacyReadOnly: readOnly,
    legacyBrowserCombined: browserCombinedTrue || undefined,
    legacyMappings,
    effectiveStrength,
    recommended: buildRemoteSecurityPreset('recommended', input),
    safer: buildRemoteSecurityPreset('safer', input)
  }
}
