
---

## 安装说明

### Windows
下载 `SpaceAssistant Setup *.exe`，运行 NSIS 安装程序。

### macOS
按 Mac 芯片选择对应 DMG：
- **Apple Silicon（M 系列）**：文件名含 `arm64` 的 DMG
- **Intel**：文件名含 `x64` 的 DMG
- **不确定 / 通用包**：文件名含 `universal` 的 DMG（体积更大，两种芯片均可运行）

### 代码签名说明
当前版本安装包**未进行代码签名**：
- **Windows**：安装时可能出现 SmartScreen「未知发布者」提示，选择「仍要运行」即可。
- **macOS**：首次打开时系统可能拦截，请在「系统设置 → 隐私与安全性」中允许，或对应用右键选择「打开」。

---

## Installation

### Windows
Download `SpaceAssistant Setup *.exe` and run the NSIS installer.

### macOS
Choose the DMG that matches your Mac chip:
- **Apple Silicon (M series)**: DMG with `arm64` in the filename
- **Intel**: DMG with `x64` in the filename
- **Unsure / universal build**: DMG with `universal` in the filename (larger, runs on both chip types)

### Code signing
Installers in this release are **not code-signed**:
- **Windows**: SmartScreen may warn about an unknown publisher — choose **Run anyway** to proceed.
- **macOS**: macOS may block the app on first launch. Allow it under **System Settings → Privacy & Security**, or right-click the app and choose **Open**.
