# 远程一对一私聊安全优化 — 发布说明草稿（v1.6 收口）

> 范围：飞书 / 微信远程私聊；对应开发计划 WP0–WP9  
> 状态：内部灰度可用；全量前须跑通计划 §8 门禁

## 用户可见变化

- 飞书绑定改为桌面一次性配对码（`绑定 <code>` / `bind <code>`），不再「窗口内首条消息即绑定」。
- 存量升级弹出安全摘要；取消不改变配置版本。新默认仅在摘要确认后生效。
- Shell 信任改为结构化简单命令；含管道/重定向/替换等元语法不可信任免确认。
- 脚本分析结果文案统一为「未发现已知高风险模式」；拒绝执行不展示 A/B 技术编号。
- 远程浏览器 confirm 拆成 navigate / act；高影响 act 与扫描失败始终确认。
- 飞书外部写按 argv 影响分类；高影响默认确认。
- 任务预算（工具次数 / 时长 / 并发 / 连续外部写）达阈后暂停，可继续、回桌面或停止。
- 近期活动支持脱敏导出与清理；绑定变化、信任新增、短时多次拒绝会桌面告警。

## 残余风险（须披露）

- `run_script` 内容分析是**启发式闸门**，不是沙箱。R1–R4 类（运行时拼接、多步数据流、字节码/loader 等）可漏检。
- 「一键限制写/出站」**并不真正只读**：Shell / 脚本副作用仍可能发生，需依赖脚本/Shell 门禁与确认。
- 设备失窃、Bot 凭据泄露不在本层防御范围内。

## Feature flag / 回滚

可分别关闭：

- 脚本 allow 免确认（`remoteScriptRequiresConfirm=true`）
- 远程 navigate / act 免确认
- 飞书低影响写免确认（`larkCliWriteRequiresConfirm=true`）
- 结构化 trust 命中失败时视为未命中（不得回退字符串前缀）

紧急关闭远程前会先取消执行、排队与 pending confirm，再停监听。

## 跨文档指针

- 需求基线：`remote-private-chat-security-optimization-requirement.md` v1.6
- 开发/测试：`../develop/remote-private-chat-security-optimization-development-test-plan.md`
- 冲突内容以本需求 v1.6 为准，同步更新飞书/微信集成与 confirmation-card-trust 中关于「首条绑定 / 字符串 trust / 组合 browser」的旧描述。
