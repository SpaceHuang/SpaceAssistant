
---

## 安装说明

### Windows
下载 `SpaceAssistant Setup *.exe`，运行 NSIS 安装程序。

### macOS
按 Mac 芯片选择对应 DMG：
- **Apple Silicon（M 系列）**：文件名含 `arm64` 的 DMG（如 `SpaceAssistant-*-arm64.dmg`）
- **Intel**：文件名**不含** `arm64` 的 DMG（如 `SpaceAssistant-*.dmg`）

### 代码签名说明
当前版本安装包**未进行代码签名**：
- **Windows**：安装时可能出现 SmartScreen「未知发布者」提示，选择「仍要运行」即可。
- **macOS**：因为没有 Apple 官方签名，从 GitHub 下载的安装包首次打开时会被 Mac 拦截，可能提示「已损坏」或「无法验证开发者」。这不是安装包坏了。将 app 拖入 `/Applications` 后，打开「终端」执行下面这条命令即可正常运行：

  ```bash
  xattr -cr /Applications/SpaceAssistant.app
  ```

---

## Installation

### Windows
Download `SpaceAssistant Setup *.exe` and run the NSIS installer.

### macOS
Choose the DMG that matches your Mac chip:
- **Apple Silicon (M series)**: DMG with `arm64` in the filename (e.g. `SpaceAssistant-*-arm64.dmg`)
- **Intel**: DMG **without** `arm64` in the filename (e.g. `SpaceAssistant-*.dmg`)

### Code signing
Installers in this release are **not code-signed**:
- **Windows**: SmartScreen may warn about an unknown publisher — choose **Run anyway** to proceed.
- **macOS**: With no Apple developer signature, the downloaded installer is blocked by macOS on first launch — you may see a "damaged" or "unidentified developer" warning. The download is not broken. Drag the app into `/Applications`, open Terminal, and run the following command to launch it:

  ```bash
  xattr -cr /Applications/SpaceAssistant.app
  ```
