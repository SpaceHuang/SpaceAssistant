# SpaceAssistant 桌面图标使用说明

> 图标设计：**V5-Sharp · 四瓣尖突** — 以四片暖橙尖突花瓣象征学习、思考、创作、分享四大场景，中心锚点代表 AI 助手始终在旁。

---

## 📁 文件清单

```
icons/
├── sa-logo-16.png               # 浅色主题 18 尺寸 PNG
├── sa-logo-20.png
├── sa-logo-24.png
├── sa-logo-30.png
├── sa-logo-32.png
├── sa-logo-36.png
├── sa-logo-40.png
├── sa-logo-48.png
├── sa-logo-64.png
├── sa-logo-72.png
├── sa-logo-96.png
├── sa-logo-128.png
├── sa-logo-144.png
├── sa-logo-192.png
├── sa-logo-256.png
├── sa-logo-384.png
├── sa-logo-512.png
├── sa-logo-1024.png
│
├── dark/
│   ├── sa-logo-dark-16.png      # 深色背景 18 尺寸 PNG
│   ├── ...
│   └── sa-logo-dark-1024.png
│
├── sa-logo.ico                  # Windows 图标（16/32/48/256）
├── sa-logo-full.ico             # Windows 图标完整版（8 尺寸）
│
├── sa-logo.iconset/             # macOS .iconset（拖入 Xcode 即可）
│   ├── icon_16x16.png
│   ├── icon_16x16@2x.png
│   ├── icon_32x32.png
│   ├── icon_32x32@2x.png
│   ├── icon_128x128.png
│   ├── icon_128x128@2x.png
│   ├── icon_256x256.png
│   ├── icon_256x256@2x.png
│   ├── icon_512x512.png
│   └── icon_512x512@2x.png
│
└── README.md                    # 本文件
```

---

## 🔧 各平台集成方法

### Electron

```javascript
// main.js / main.ts
const { app, BrowserWindow } = require('electron');

const win = new BrowserWindow({
  icon: path.join(__dirname, 'icons/sa-logo-256.png'),
  // ...
});
```

> Electron 建议统一使用 256×256 PNG，Windows 和 macOS 均可识别。

---

### Windows（原生 / C# / WPF / WinForms）

**方法一：直接引用 .ico**
```xml
<!-- WPF 窗口设置 -->
<Window Icon="icons/sa-logo.ico" ... />
```
```csharp
// WinForms
this.Icon = new Icon("icons/sa-logo.ico");
```

**方法二：打包工具配置**

| 打包工具 | 配置 |
|----------|------|
| **electron-builder** | `"icon": "icons/sa-logo.ico"` |
| **Tauri** | `"icon": ["icons/sa-logo.ico"]` |
| **NSIS** | 放入安装脚本资源目录，指向 `sa-logo.ico` |
| **MSIX** | 将 ico 设为 Package.appxmanifest 中的 VisualElements 图标 |

---

### macOS

**1. 生成 .icns 文件**
```bash
cd icons
iconutil -c icns sa-logo.iconset
# 生成 sa-logo.icns，放入 Xcode Assets 或 Info.plist 引用
```

**2. Electron 打包**
```json
// package.json
{
  "build": {
    "mac": {
      "icon": "icons/sa-logo.icns"
    }
  }
}
```

**3. Tauri**
```json
{
  "tauri": {
    "bundle": {
      "icon": [
        "icons/sa-logo.icns"
      ]
    }
  }
}
```

---

### Linux

**1. 安装到系统图标路径**
```bash
sudo cp icons/sa-logo-256.png /usr/share/icons/hicolor/256x256/apps/spaceassistant.png
sudo cp icons/sa-logo-48.png /usr/share/icons/hicolor/48x48/apps/spaceassistant.png
sudo gtk-update-icon-cache /usr/share/icons/hicolor
```

**2. .desktop 文件引用**
```ini
[Desktop Entry]
Name=SpaceAssistant
Icon=spaceassistant
Exec=/usr/bin/spaceassistant
Type=Application
```

---

## 🎨 浅色 vs 深色

| 背景类型 | 使用文件 |
|----------|----------|
| 白色 / 浅灰 UI | `sa-logo-*.png`（浅色主题） |
| 暗色 UI / 深色任务栏 | `dark/sa-logo-dark-*.png` |

> SVG 矢量源文件 `logo-fourpetals-sharp.svg` 和 `logo-fourpetals-sharp-dark.svg` 位于项目根目录，可用于任意尺寸的无损缩放。

---

## ✅ 最低分辨率验证

| 尺寸 | 辨识度 | 说明 |
|------|--------|------|
| **16×16** | ✅ 清晰 | 四瓣十字结构可辨，中心锚点稳定感强 |
| **24×24** | ✅ 优秀 | 叶片尖突方向感明显，双色交替可见 |
| **32×32** | ✅ 完美 | 所有细节（曲线弧度、中心高光）完整呈现 |
| **48×48+** | ✅ 完整 | 原始矢量品质，无任何丢失 |

---

## 📐 技术规格

- **色彩**：主色 `#f06529`（暖橙），辅色 `#f59e0b`（琥珀），中心锚 `#e05820`
- **格式**：PNG（RGBA 透明背景）、ICO（Windows）、.iconset（macOS）
- **生成方式**：4 阶贝塞尔曲线精确解析 → Pillow 渲染 → 小尺寸 2× 超采样下变换
