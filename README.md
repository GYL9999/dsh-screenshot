# dsh-screenshot

**DeepSeek Harness（DSH）截图插件**：点一下输入框旁边的「截屏」，屏幕立刻冻结，拖一下框选、按 `Enter` 就复制好；也可以悬停选窗口、把截图存本机并把路径插进对话。

> A screenshot plugin for [DeepSeek Harness](https://github.com/deepseek-ai). Click the camera beside the composer, the screen freezes, drag a rectangle, press Enter — done. Window snapping and save-with-path included.

![platform](https://img.shields.io/badge/platform-Windows-0f9b8e) ![type](https://img.shields.io/badge/DSH-plugin-2f6fed) ![license](https://img.shields.io/badge/license-MIT-blue)

---

## 它解决什么

在 DSH 里想把屏幕上的东西给模型看，原本要：系统截图 → 找文件 → 拖进对话。这个插件把它压成一条线：

**点「截屏」→ 拖 → Enter → Ctrl+V。**

## 功能

| 功能 | 说明 |
|---|---|
| **整屏冻结** | 点一下就抓整个虚拟桌面（多显示器、物理像素），立刻以冻结画面覆盖在界面上；不需要在系统弹窗里选窗口 |
| **框选区域** | 在冻结画面上拖矩形，框外压暗；**松手后四个角和四条边都有手柄，拖手柄改大小、拖框内整体移动**；`Enter`/`Ctrl+C` 复制选区并自动关闭，`Ctrl+S` 保存 |
| **窗口吸附** | 工具条点 `窗口`，鼠标悬停高亮，点一下截该窗口**自身渲染**（`PrintWindow`），被别的窗口遮挡也能拿到完整内容 |
| **复制 / 保存** | 复制到剪贴板；保存走本机，落到 `%USERPROFILE%\Downloads\dsh-screenshots\`，并把文件路径**自动插入输入框草稿**，模型可以直接读文件 |
| **快捷键** | `Ctrl+Alt+S` 随时唤出；`R` 重截；`Esc` 先清选区再关闭；`Backspace` 清选区 |
| **给 Agent 用** | 注册工具 `screen_capture`：模型可自行截屏拿路径；加 `read: true` 时可选调用 modlens 视觉桥，一次返回 OCR/版面/语义 |
| **浏览器兜底** | 本机路由不可达时，可用 `getDisplayMedia` 从页面侧共享屏幕 |

> 选区不是一次性的：松手后拖**四个角/四条边**上的手柄改大小，拖**选区内部**整体平移，拖**框外**重新画；`Backspace` / `Esc` 清掉重来。

## 安装

```bash
dsh plugin --profile desktop add github:GYL9999/dsh-screenshot
# 然后重启 DSH
```

装好后，输入框工具栏会出现「📷 截屏」，就在 `剪辑` 右边；`Ctrl+Alt+S` 也能用。

> 只支持 Windows 桌面截图（依赖 PowerShell + `System.Drawing`）。其他平台仍可用浏览器兜底截图。

## 为什么快

早期版本每次截图都新起一个 `powershell` 进程并现场编译 P/Invoke 助手，一次要 2 秒多。现在插件激活时就拉起**一个常驻 worker**，C# 只编译一次，之后每条命令是一行 stdin、一行回复：

| 动作 | 旧 | 现 |
|---|---|---|
| 整屏截图 | 2.17 s | **0.16 – 0.24 s** |
| 窗口列表 | 2.02 s | **0.09 s** |
| 窗口截图 | 5.3 s | **0.24 s** |

（本机实测；worker 崩溃或超时会自动重启。）

## 结构

```
index.js            Host：四条本机路由 + PowerShell 常驻 worker + screen_capture 工具
client.js           Client：输入框旁的按钮、冻结覆盖层、选区、窗口选择、复制/保存
cordis.patch.yml    Loader 行
locale/{zh,en}.json 插件管理页里的标题与描述
icon.svg            插件图标
```

Host 路由（仅接受 loopback 且同源）：

| 路由 | 用途 |
|---|---|
| `GET /api/fullscreen-shot` | 整个虚拟桌面 PNG |
| `GET /api/fullscreen-shot/windows` | 顶层窗口（z 序，最上在前）+ 虚拟屏边界 |
| `GET /api/fullscreen-shot/window?id=<hwnd>` | 单个窗口自身渲染 |
| `POST /api/fullscreen-shot` | 保存发来的 PNG，返回落盘路径 |

## 已知限制

- 窗口选择只在预览是整屏时出现：图已经被裁过或本身是窗口截图后，坐标不再对应屏幕。
- DSH 自己的窗口不进窗口列表：让应用在 UI 线程忙时打印自己是最容易卡死请求的操作。
- 最小化的窗口不列入候选（截不到就不假装能截）。
- 视觉识图需要 modlens 配好 provider；没配时 `read: true` 只返回提示，截图本身不受影响。

## 许可

MIT © GYL9999
