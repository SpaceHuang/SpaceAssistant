/**
 * Auditable transitional type gate for WP7.
 *
 * Full `tsconfig.renderer.json` still has pre-existing renderer UI type debt.
 * This file + `tsconfig.renderer.gate.json` run real `tsc --noEmit` over the
 * shared IPC/config surface (including configSet wechat + workspaceLayout).
 * Expand the gate include list as renderer debt is paid down — do not replace
 * with text-only checks.
 */
import type { SpaceAssistantApi } from './api'

type ConfigSetPayload = Parameters<SpaceAssistantApi['configSet']>[0]

type AssertTrue<T extends true> = T
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false

type _WechatRequired = AssertTrue<HasKey<Required<ConfigSetPayload>, 'wechat'>>
type _WorkspaceLayoutRequired = AssertTrue<HasKey<Required<ConfigSetPayload>, 'workspaceLayout'>>

export type ConfigSetGate = {
  wechat: NonNullable<ConfigSetPayload['wechat']>
  workspaceLayout: NonNullable<ConfigSetPayload['workspaceLayout']>
}
