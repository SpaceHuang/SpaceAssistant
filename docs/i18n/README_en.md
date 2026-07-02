# SpaceAssistant

SpaceAssistant — Your Desktop AI Assistant

## What is it?

SpaceAssistant is a desktop AI assistant application that not only chats with you but also gets things done — reading files, writing code, looking up information. It's like your smart workbench, helping you handle daily mundane tasks. It supports Skill extensions and autonomous learning, getting better the more you use it.

Supports Windows, macOS, and Linux.

## What makes SpaceAssistant special?

- **Safe Tool Execution**

  Before writing files or executing commands, the AI shows you what will change (diff mode), and executes only after your confirmation. Each type of tool is marked with a risk level — high-risk operations (running scripts, executing commands) always require confirmation.

- **Multi-Model Support**

  Supports 11+ major LLMs: the full Claude lineup (Opus/Sonnet/Haiku), DeepSeek, GPT, Gemini, Kimi, GLM, MiniMax. You can switch freely based on your task needs.

- **Local Data Storage**

  All data is stored on your computer (JSON files), with API keys protected by OS-level encryption. Your conversation data is never uploaded to third-party servers.

- **Feishu (Lark) Integration**

  After connecting to Feishu, you can remotely command the AI from within Feishu:

  - Send messages to the Feishu bot, and the AI executes tasks on your computer and replies with results
  - Operate Feishu Docs, Calendar, Base, and Mail
  - Remotely confirm tool executions (writing files, running commands, and other high-risk operations)

  Let the AI work for you even when you're away from your computer.

- **Skill Extensions**

  - Supports installing third-party Skills
  - AI automatically recognizes user intent and matches the appropriate Skill

## Third-Party Licenses

This project uses the following open-source libraries. Our gratitude goes to their authors and contributors.

### Production Dependencies

| Library | License |
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

### Major Transitive Dependencies

| Library | License |
|---|--------|
| [@ai-sdk/*](https://github.com/vercel/ai) (Vercel AI SDK series) | Apache-2.0 |
| [@langchain/core](https://github.com/langchain-ai/langchainjs) | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause |

### Development Dependencies

| Library | License |
|---|--------|
| [electron](https://github.com/electron/electron) | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT |
| [vite](https://github.com/vitejs/vite) | MIT |
| [vitest](https://github.com/vitest-dev/vitest) | MIT |
| [typescript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [sharp](https://github.com/lovell/sharp) | Apache-2.0 |
| [jsdom](https://github.com/jsdom/jsdom) | MIT |

The above list covers only direct dependencies and some major transitive ones. The full dependency tree and license information can be viewed via `npm ls --all` or by running `npx license-checker`.

## License

This project is open source under the [MIT License](LICENSE).
