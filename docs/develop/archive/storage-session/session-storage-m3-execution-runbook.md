# M3 批量投影补迁 coordinator 工程规程

状态：**仅供工程实现和隔离 SQLite 验收使用；不是客户端升级说明，也不是生产用户操作手册。**

## 适用边界

SpaceAssistant 是本地桌面应用。用户安装新版时，schema migration 随应用升级自动执行；符合条件的旧会话在打开、恢复或构建 API 上下文时按需生成新投影。M3-6 coordinator 是额外的批量补迁工具，默认关闭，当前没有面向用户的启动、进度或暂停入口，因此不会在安装升级时运行，也不能由开发者从开发进程直接对真实用户 profile 启动。

目前没有证据表明按需迁移不足以满足产品需求，所以真实 profile 批量运行暂缓。普通用户升级不需要组织级 owner、operator、cohort 或维护窗口审批。若未来证明需要批量整理，先设计应用内由本机用户发起并能查看进度、暂停/恢复、处理失败的完整流程；届时再更新本规程和发布计划。

## 隔离验收要求

对 synthetic、file-backed SQLite fixture 验证以下行为：

1. 固定 census 和 `inventorySha256`，拒绝 scope/hash 漂移。
2. 仅按有界批次运行；活跃 turn 延后，不阻塞应用主窗口。
3. 重复启动幂等；暂停后重开可续跑；失败可安全重试或保留旧读取路径。
4. pause、resume、cancel 语义清晰；cancel 为终态。
5. 报告成功/失败/跳过数量与原因；运行结果可和 inventory 总量对账。
6. internal/hidden 与 unknown scope 不进入产品消息投影批次；范围异常 fail closed。
7. 不删除 `messages.content`、不清理 spill、不停写会话，也不调用模型或外部服务。

## 代码安全围栏

M3 coordinator 的生产执行 gate 保持关闭。初始化不得创建真实 migration run、启动 scheduler 或开放 renderer IPC。任何代码变更仍按 TDD 在隔离 fixture 上验证；合成验收通过不代表真实用户数据已批量迁移，也不代表批量工具获准进入产品流程。

## 后续决策

只有观察到按需迁移造成明确产品问题时，才重新评估批量功能。评估对象是用户是否需要批量整理，以及如何在本地应用中让用户控制它；不创建企业级 operator 流程。若不需要该功能，M3 coordinator 可继续保持关闭，不影响 schema 升级、逐会话按需迁移或产品发布。
