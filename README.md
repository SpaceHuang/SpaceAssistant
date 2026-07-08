# SpaceAssistant

SpaceAssistant — 你的桌面 AI 助手

[English](docs/i18n/README_en.md) | 中文

这是什么？

SpaceAssistant 是一款桌面学习与创作助手。它聚焦普通个人创作者的四大场景：学习、思考、创作、分享。它能帮你减轻日常工作和思考的负荷强度，帮你完成日常琐碎的事情，提升你学习和成长的效率。支持Skills扩展，支持自主学习，越用越好用。

支持 Windows、macOS、Linux。

SpaceAssistant 有什么特点？

- 本地数据存储：真正的数据自主权

  所有数据存储在你电脑上，API Key 通过操作系统级加密保护。你的数据不会上传到第三方服务器，只有你和你选择的大模型服务商接触你的对话数据。

- 多种 AI 模型支持

  拒绝强买强卖，可以自主选择大模型服务。支持 11+ 主流大模型：Claude
  全系（Opus/Sonnet/Haiku）、DeepSeek、GPT、Gemini、Kimi、GLM、MiniMax。你可以根据任务需求自由切换。

- Diff 模式：更适合创作者的AI工作流程

  写文件之前，先让你看清楚AI改了什么（diff
模式），避免大模型悄悄自作主张的修改你的作品。


- 飞书集成

  连接飞书后，你可以在飞书里远程指挥 AI：

  - 给飞书机器人发消息，AI 在电脑上执行任务并回复结果
  - 操作飞书文档、日历、多维表格、邮箱
  - 远程确认工具执行（写文件、运行命令等高危操作）

  人不在电脑前也能让 AI 干活。

- 支持 Skill 扩展

  - 支持安装第三方 Skill
  - AI 自动识别用户意图并匹配对应 Skill

支持 Windows、macOS、Linux。

## macOS 安装提示

SpaceAssistant 暂未接入 Apple 开发者签名与公证。从 GitHub 下载的 macOS 安装包会被 Gatekeeper 隔离，首次打开会提示「已损坏」或「无法验证开发者」。这是正常现象，执行以下命令去除隔离属性即可运行：

```bash
xattr -cr /Applications/SpaceAssistant.app
```

（将 app 拖入 `/Applications` 后在终端执行。Intel 与 Apple Silicon 均已包含对应架构的原生模块。）

## 第三方库许可证

本项目使用了以下开源库，在此对其作者和贡献者表示感谢。

### 生产依赖

| 库 | 许可证 |
|---|--------|
| [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) | MIT |
| [@browserbasehq/stagehand](https://github.com/browserbase/stagehand) | MIT |
| [@reduxjs/toolkit](https://github.com/reduxjs/redux-toolkit) | MIT |
| [antd](https://github.com/ant-design/ant-design) | MIT |
| [axios](https://github.com/axios/axios) | MIT |
| [katex](https://github.com/KaTeX/KaTeX) | MIT |
| [lucide-react](https://github.com/lucide-icons/lucide) | ISC |
| [mingcute_icon](https://github.com/Richard9394/MingCute) | Apache-2.0 |
| [playwright](https://github.com/microsoft/playwright) | Apache-2.0 |
| [react](https://github.com/facebook/react) | MIT |
| [react-dom](https://github.com/facebook/react) | MIT |
| [react-markdown](https://github.com/remarkjs/react-markdown) | MIT |
| [react-redux](https://github.com/reduxjs/react-redux) | MIT |
| [react-syntax-highlighter](https://github.com/react-syntax-highlighter/react-syntax-highlighter) | MIT |
| [rehype-external-links](https://github.com/rehypejs/rehype-external-links) | MIT |
| [rehype-katex](https://github.com/remarkjs/remark-math/tree/main/packages/rehype-katex) | MIT |
| [remark-gfm](https://github.com/remarkjs/remark-gfm) | MIT |
| [remark-math](https://github.com/remarkjs/remark-math/tree/main/packages/remark-math) | MIT |
| [shiki](https://github.com/shikijs/shiki) | MIT |
| [zod](https://github.com/colinhacks/zod) | MIT |

### 主要间接依赖

| 库 | 许可证 |
|---|--------|
| [@ai-sdk/*](https://github.com/vercel/ai) (Vercel AI SDK 系列) | Apache-2.0 |
| [@langchain/core](https://github.com/langchain-ai/langchainjs) | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause |

### 开发依赖

| 库 | 许可证 |
|---|--------|
| [electron](https://github.com/electron/electron) | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT |
| [vite](https://github.com/vitejs/vite) | MIT |
| [vitest](https://github.com/vitest-dev/vitest) | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 |
| [jsdom](https://github.com/jsdom/jsdom) | MIT |

以上列表仅涵盖直接依赖及部分主要间接依赖。完整的依赖树及许可证信息可通过 `npm ls --all` 或运行 `npx license-checker` 查看。

## 许可证

本项目基于 [Apache-2.0 License](LICENSE) 开源。
