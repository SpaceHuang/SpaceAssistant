
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
- **macOS**：从 GitHub 下载的安装包会被 Gatekeeper 隔离，首次打开可能提示「已损坏」或「无法验证开发者」。将 app 拖入 `/Applications` 后，在终端执行以下命令去除隔离属性即可运行：

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
- **macOS**: Installers downloaded from GitHub are quarantined by Gatekeeper and may appear "damaged" or show an "unidentified developer" warning on first launch. Drag the app into `/Applications`, then run the following command in Terminal to remove the quarantine attribute:

  ```bash
  xattr -cr /Applications/SpaceAssistant.app
  ```
