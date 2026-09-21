// electron 项目专属 setup（§2.3 归属约束）：脚本安全解析服务初始化。
// 本文件只挂载在 vitest electron project（见 vitest.config.mts），
// 不得写入三项目共享的 src/test/setup.ts（避免 jsdom 渲染测试被拖入 wasm 加载）。
// fork 单 worker 内模块状态共享：首个用到的测试文件初始化一次，后续文件幂等复用。
import { scriptParserService } from '../../electron/shell/scriptParserService'

beforeAll(async () => {
  await scriptParserService.ensureInitialized()
}, 30_000)
