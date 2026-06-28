# 工作区管理 — 产品需求总览



> **状态**：M1 需求定稿  

> **来源**：原 analysis 产品计划拆分并合并为可发布单元  

> **现状分析**：[multi-workdir-file-management-as-is.md](../../analysis/multi-workdir-file-management-as-is.md)



---



## 1. 文档结构



按**可独立发布**划分，一版一文档：



| 版本 | 文档 | 主题 | 发布 |

|------|------|------|------|

| **V1** | [v1-workspace-management-requirement.md](./v1-workspace-management-requirement.md) | **工作区管理（M1 完整）** | M1 |
| — | [v1-workspace-management-m1-detail.md](./v1-workspace-management-m1-detail.md) | M1 必做详细规格（附录） | M1 |
| — | [M1-deferred-open-and-out-of-scope.md](./M1-deferred-open-and-out-of-scope.md) | **后置 / 待决 / 明确不做** | 路线图 |

| **V6** | [v6-git-local-version-control-requirement.md](./v6-git-local-version-control-requirement.md) | Git 本地版本管理 | M2 |

| **V7** | [v7-git-remote-sync-requirement.md](./v7-git-remote-sync-requirement.md) | Git 远端同步 | M2 |

| **V8** | [v8-git-advanced-requirement.md](./v8-git-advanced-requirement.md) | Git 进阶（可选） | M2+ |



**依赖链**：V1（M1）→ V6（M2 首期）→ V7（M2 第二期）；V8 可选。  

**V2–V5 编号已废弃**（原 M1 拆得过细，已并入 V1）。



**Git 完整原文**：[isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md)



---



## 2. M1 发布范围（R1–R8，均在 V1）



| ID | 内容 |

|----|------|

| R1 | 工作台安装向导（先于 API Key） |

| R2 | 内置布局模板 |

| R3 | focus + 新建项目向导 |

| R4 | 文件树增强 |

| R5 | AI 成长 + 跨 Profile 聚合读 |

| R6 | SessionBackupManager workDir 同步 |

| R7 | 配置版本 + 与 v1（multi-workdir）并行兼容 |

| R8 | 写入路径 Hook（F6）+ `ProjectGatePromptCard`（F5 字母选项） |



---



## 3. M2 Git 发布范围



| 版本 | 可独立发布 | 核心交付 |

|------|------------|----------|

| **V6** | ✅ M2 首期 | 本地 Git 闭环 + 与 M1 边界 |

| **V7** | ✅ M2 第二期 | 同步、clone、凭据 |

| **V8** | 可选 | merge/stash/性能等 |



---



## 4. 核心产品原则



1. Profile = 工作方向；项目 = workDir 子文件夹；bucket = 项目内分类。

2. 五类创作方向 + AI 成长并列。

3. 布局模板仅内置；只补缺失不覆盖。

4. Git 与 M1 分开发布（V6 起）。

5. M1 与 v1 multi-workdir 共用 DB；M1 扩展存 `workspaceV1` 侧车，不破坏 v1 三件套（R7）。



---



## 5. 关联文档



| 文档 | 说明 |

|------|------|

| [multi-workdir-file-management-as-is.md](../../analysis/multi-workdir-file-management-as-is.md) | 代码现状 |

| [multi-workdir-requirement.md](../multi-workdir-requirement.md) | 旧版规格（部分 supersede） |

| [isomorphic-git-workdir-version-control-requirement.md](./isomorphic-git-workdir-version-control-requirement.md) | Git 完整规格 |



---



## 6. 修订记录



| 版本 | 日期 | 说明 |

|------|------|------|

| 1.0 | 2026-06-27 | 初版 V1–V5 + Git 拆分 |

| 1.2 | 2026-06-27 | 恢复 M1 后置/待决文档；补 M1 detail 附录 |

| 1.3 | 2026-06-27 | 新增 R7：配置版本与 v1 并行兼容（C1–C7） |

| 1.4 | 2026-06-27 | 主 PRD V1.1 细化：数据模型、模板 bucket、focus、聚合读、验收 |

| 1.5 | 2026-06-27 | F5/F6 重写：首次项目归因 + 写入 Hook；R8 |


