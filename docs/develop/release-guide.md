# SpaceAssistant 发版操作指南

## 概述

SpaceAssistant 通过 **GitHub Actions** 在推送版本 tag 时自动完成质量门禁、双平台打包与 GitHub Release 发布。维护者只需在 `main` 分支上更新版本号、提交代码并推送 tag，无需在本地手动打安装包（除非调试）。

**当前状态**：
- 支持平台：**Windows**（NSIS x64）、**macOS**（x64 / arm64 / universal 三种 DMG）
- 代码签名：**未启用**（安装说明见 Release Notes）
- 触发方式：推送 `v*` 格式 tag（如 `v0.1.5`）

---

## 一、发版前检查

在动手发版前，确认以下条件：

| 检查项 | 说明 |
|--------|------|
| 代码已合并到 `main` | Release 工作流**仅接受指向 `main` 分支提交的 tag** |
| CI 通过 | `main` 上最近一次 push / PR 的 CI 工作流应为绿色 |
| 版本号一致 | `package.json` 的 `version` 与即将推送的 tag 对应（`0.1.5` → `v0.1.5`） |
| 图标资源齐全 | `res/icons/sa-logo.ico`（Windows）、`res/icons/sa-logo.iconset/`（macOS）已提交 |

本地可选预检：

```bash
npm run i18n:generate-types
npm run i18n:check
npm test
npm run build
node scripts/dry-run-mac-pack.mjs   # 校验 macOS 多架构配置（Windows/Linux 可运行）
```

> **注意**：`pack:mac` 只能在 macOS 上真实执行。Windows 开发机请依赖 CI 或上述 dry-run 脚本。

---

## 二、标准发版流程

```
┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│ 1. 更新版本号     │───▶│ 2. 提交并推送 main   │───▶│ 3. 打 tag 并推送  │
└──────────────────┘    └─────────────────────┘    └──────────────────┘
         │                          │                          │
         ▼                          ▼                          ▼
┌──────────────────┐    ┌─────────────────────┐    ┌──────────────────┐
│ package.json     │    │ origin/main 更新     │    │ GitHub Actions   │
│ package-lock.json│    │                     │    │ 自动打包 & 发布   │
└──────────────────┘    └─────────────────────┘    └──────────────────┘
```

### 步骤 1：更新版本号

将 `X.Y.Z` 替换为目标版本（示例 `0.1.5`）：

```bash
npm version 0.1.5 --no-git-tag-version
```

此命令会同步更新 `package.json` 与 `package-lock.json`，**不会**自动创建 git tag。

### 步骤 2：提交并推送到 main

```bash
git add package.json package-lock.json
git commit -m "chore: bump version to 0.1.5"
git push origin main
```

若本次发版还包含其他需入库的变更（如 Release 配置、文案修订），一并 `git add` 后提交。

### 步骤 3：打 tag 并推送

tag 必须打在**已推送到 `origin/main` 的提交**上：

```bash
git tag v0.1.5
git push origin v0.1.5
```

推送 tag 后，GitHub Actions **Release** 工作流自动启动。

### 步骤 4：确认发布结果

在 GitHub 仓库中检查：

- **Actions**：`.github/workflows/release.yml` 对应运行记录应为成功
- **Releases**：应出现 `v0.1.5`，并附带安装包附件

参考链接（将 `SpaceHuang/SpaceAssistant` 替换为实际仓库）：

- Actions：`https://github.com/SpaceHuang/SpaceAssistant/actions/workflows/release.yml`
- Releases：`https://github.com/SpaceHuang/SpaceAssistant/releases`

---

## 三、CI 流水线说明

工作流文件：`.github/workflows/release.yml`

### 3.1 触发条件

```yaml
on:
  push:
    tags:
      - 'v*'
```

仅 `v` 前缀 tag 触发，例如 `v0.1.5`、`v1.0.0-rc.1`。

### 3.2 三个阶段

| Job | Runner | 职责 |
|-----|--------|------|
| `verify` | `ubuntu-latest` | 质量门禁：tag 必须在 `main` 上；`i18n:check` + `npm test` |
| `build` | `windows-latest` + `macos-latest` 并行 | `pack:win` / `pack:mac`，上传产物到 artifact |
| `publish` | `ubuntu-latest` | 汇总产物，生成 Release 说明，创建 GitHub Release |

### 3.3 质量门禁（verify）

以下任一不满足则发版中止：

1. tag 指向的提交必须是 `origin/main` 的祖先（即提交在 main 历史上）
2. `origin/main` 分支包含该提交
3. `npm run i18n:check` 通过
4. `npm test` 通过

**常见失败原因**：在 feature 分支上打 tag 后推送，未先合并到 `main`。

### 3.4 构建产物

| 平台 | 命令 | 产出（示例） |
|------|------|-------------|
| Windows | `npm run pack:win` | `SpaceAssistant Setup 0.1.5.exe` |
| macOS | `npm run pack:mac` | `SpaceAssistant-0.1.5-x64.dmg` |
| macOS | | `SpaceAssistant-0.1.5-arm64.dmg` |
| macOS | | `SpaceAssistant-0.1.5-universal.dmg` |

产物目录为 `release/`（已加入 `.gitignore`，不入库）。

macOS 多架构配置（`package.json` → `build.mac`）：

```json
"mac": {
  "icon": "res/icons/sa-logo.iconset",
  "mergeASARs": true,
  "x64ArchFiles": "Contents/Frameworks/**",
  "target": [{
    "target": "dmg",
    "arch": ["x64", "arm64", "universal"]
  }]
}
```

> `x64ArchFiles` 用于 universal 合并：在 arm64 CI runner 上交叉构建 x64 时，Electron Framework 等文件可能在两个架构产物中完全相同，需显式声明以避免 `@electron/universal` 报错。

### 3.5 Release 说明

发布时自动拼接两部分内容：

1. **变更摘要**：GitHub `generate-notes` API 根据 tag 间 commit 自动生成
2. **安装与签名说明**：追加 `.github/release-appendix.md`（中英文）

维护者可在 Release 创建后于 GitHub 网页上补充或编辑说明。

---

## 四、本地打包（调试用途）

日常发版**不需要**本地打包。仅在调试 electron-builder 配置时使用：

```bash
# 完整构建（打包脚本内部也会执行）
npm run build

# 分平台打包
npm run pack:win     # Windows NSIS 安装包
npm run pack:mac     # 仅 macOS 可执行
npm run pack:linux   # Linux AppImage（当前 CI 未纳入自动发版）
```

配置入口：`package.json` 的 `build` 字段（electron-builder）。

---

## 五、发版后用户安装说明

以下内容已写入 `.github/release-appendix.md`，随 Release 自动发布。维护者也可复制到公告或文档。

### Windows

下载 `SpaceAssistant Setup *.exe`，运行 NSIS 安装程序。未签名时可能出现 SmartScreen「未知发布者」提示，选择「仍要运行」即可。

### macOS

按芯片选择 DMG：

- **Apple Silicon（M 系列）**：文件名含 `arm64`
- **Intel**：文件名含 `x64`
- **不确定**：文件名含 `universal`（体积更大，两种芯片均可）

未签名时，首次打开可能被系统拦截，请在「系统设置 → 隐私与安全性」中允许，或对应用右键选择「打开」。

---

## 六、故障排查

| 现象 | 可能原因 | 处理建议 |
|------|----------|----------|
| `verify` 报 tag 不在 main | tag 打在 feature 分支提交上 | 合并到 main 后，在 main 最新提交重新打 tag |
| `i18n:check` 失败 | 翻译 key 未对齐或 JSON 非法 | 本地运行 `npm run i18n:check` 修复后重新发版 |
| `npm test` 失败 | 单元测试未通过 | 本地 `npm test` 修复后重新发版 |
| macOS job 失败（universal 合并） | `Electron Framework` 在 x64/arm64 产物中相同 | 确认 `mac.x64ArchFiles` 已配置；见 `package.json` |
| macOS job 失败 | 图标缺失、依赖问题、runner 异常 | 查看 Actions 日志；本地 `node scripts/dry-run-mac-pack.mjs` 预检 |
| Windows job `EBUSY` | 本地调试时安装包被占用 | 关闭正在运行的 SpaceAssistant / Electron 进程后重试 |
| Release 无附件 | `build` job 失败或 artifact 上传失败 | 检查 `build` 两个 matrix 子任务是否均成功 |
| 首次 macOS 构建较慢 | 需构建 x64、arm64、universal 三套 | 正常，通常 15–30 分钟 |

---

## 七、相关文件索引

| 文件 | 用途 |
|------|------|
| `.github/workflows/release.yml` | Release 自动打包与发布流水线 |
| `.github/workflows/ci.yml` | 日常 CI（push/PR → main 时跑测试） |
| `.github/release-appendix.md` | Release 正文末尾的安装与签名说明（中英文） |
| `scripts/dry-run-mac-pack.mjs` | macOS 打包配置本地 dry-run 校验 |
| `package.json` → `build` | electron-builder 打包配置 |
| `res/icons/` | 各平台应用图标资源 |

---

## 八、后续规划（可选）

当前发版**未启用代码签名**。若需消除系统安全提示，后续可：

- **Windows**：在 GitHub Secrets 配置 `CSC_LINK`、`CSC_KEY_PASSWORD`
- **macOS**：配置 Apple Developer 证书与 notarization 相关 secrets

启用签名后，需同步更新 `.github/release-appendix.md` 中的说明，并视情况调整 `release.yml` 中的 `CSC_IDENTITY_AUTO_DISCOVERY` 环境变量。

---

## 附录：完整命令速查（以 v0.1.5 为例）

```bash
# 1. 更新版本
npm version 0.1.5 --no-git-tag-version

# 2. 提交 & 推送 main
git add package.json package-lock.json
git commit -m "chore: bump version to 0.1.5"
git push origin main

# 3. 打 tag & 推送（触发 Release 流水线）
git tag v0.1.5
git push origin v0.1.5
```
