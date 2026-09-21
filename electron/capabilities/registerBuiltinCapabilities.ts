import type { CapabilityDescriptor } from './types'
import { capabilityRegistry } from './registry'
import { createEnvCapabilities } from './handlers/env'
import { createSessionCapabilities } from './handlers/session'
import { createMcpCapabilities } from './handlers/mcp'

/**
 * 内置能力注册（进程级单例）。新增能力在此追加一条描述符即可，
 * 模型面（toolkit.find/call）不变、上下文零增长——这是本架构的治理入口：
 * 每次新增必须随附风险定级评审（需求 §9.5）。
 */
export function registerBuiltinCapabilities(): void {
  const builtin: CapabilityDescriptor[] = [
    ...createEnvCapabilities(),
    ...createSessionCapabilities(),
    ...createMcpCapabilities()
  ]
  for (const descriptor of builtin) {
    capabilityRegistry.register(descriptor)
  }
}

registerBuiltinCapabilities()
