import type { CapabilityDescriptor, CapabilityFamily } from './types'

/**
 * 能力注册表：单一事实来源。新增能力只需 register 一条描述符，模型面（toolkit.find/call
 * 两个网关工具）不变。注册同 id 视为编程错误直接抛出。
 */
export class CapabilityRegistry {
  private readonly descriptors = new Map<string, CapabilityDescriptor>()

  register(descriptor: CapabilityDescriptor): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(`CAPABILITY_ALREADY_REGISTERED:${descriptor.id}`)
    }
    this.descriptors.set(descriptor.id, descriptor)
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.descriptors.get(id)
  }

  list(family?: CapabilityFamily): CapabilityDescriptor[] {
    const all = [...this.descriptors.values()]
    return family ? all.filter((d) => d.family === family) : all
  }
}

/** 进程级单例；内置能力由 registerBuiltinCapabilities 在模块加载时注册。 */
export const capabilityRegistry = new CapabilityRegistry()
