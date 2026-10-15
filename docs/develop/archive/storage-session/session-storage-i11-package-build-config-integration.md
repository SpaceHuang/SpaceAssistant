# I-11 package、i18n 与 macOS 构建配置核对（2026-10-05）

## 范围

依 I-11 计划核对 `package.json`/`package-lock.json`、生成的 i18n 类型及本机可执行的 test/build 配置。本阶段不构建或验收 Windows 包、不执行发布，也不启用 session content cleanup。

## 核对与验收

- `package-lock.json` 与 `package.json` 的根身份、workspaces、dependencies、devDependencies、license、engines 一致；新增 `proper-lockfile@^4.1.2` 与 `@types/proper-lockfile@^4.1.4` 均有 lock 条目及完整依赖解析。lockfile 的版本同步为 manifest `0.2.4`。无需重新生成锁文件，避免无关解析重排。
- `npm run i18n:generate-types` 连续执行两次，`src/renderer/i18n/types.ts` 两次 SHA-256 均为 `ad9357eb66d2b5d03bc2ad3a0664b972328738060c96c6e05ce4d5348abfb4de`，生成结果可复现。
- 既有主线 test 与 macOS build/pack scripts 保持原语义；Electron 构建前增加 cleanup boundary 静态门禁，清理 deployment/compatibility metadata 作为资源打包且默认 `allowContentCleanup: false`。没有更改签名、发布平台或产品 UX 配置。
- `npm run check:session-storage-cleanup-boundary` 通过；`git diff --check` 通过。

## 结论

I-11 验收通过，可以进入计划下一项 I-12。此结论不表示 I-12 全量集成树验收已完成；cleanup 真实部署/执行仍由 F-A07-01 阻断。
