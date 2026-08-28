# ZCode Skin — AI 交接文档（HANDOFF）

> 本文件面向**接手本项目的 AI 助手或开发者**，记录架构、机制、关键坑与开发约定。
> 阅读顺序：架构总览 → 核心机制 → 模块地图 → 已知坑（必读）→ 测试方法。

---

## 1. 项目概况

**用途**：给 ZCode 桌面应用（Electron 版，安装于 `D:\Zcode`）换肤的美化工具。
**原理**：本地 CDP 注入（`--remote-debugging-port=9335` + WebSocket + `Runtime.evaluate`），
**不改 `resources/app.asar`**，更新免疫。
**状态**：已上传 GitHub（`luoboaike/zcode-skin`），公开。
**技术栈**：Node.js ≥22（内置 WebSocket，零第三方依赖）+ Python 3 + Pillow（随景皮肤取色）+ 无构建前端。

**用户环境**：
- ZCode 3.7.6 安装于 `D:\Zcode\ZCode.exe`（Electron 41，React 19，Tailwind v4，CSS 变量主题体系）
- 桌面快捷方式「ZCode」→ `ZCode入口.vbs`（隐藏启动守护 + 带端口启动 ZCode）
- 用户数据在 `~/.zcode/skin/`（state.json / wallpapers/ / fonts/ / user-skins/）
- 开始菜单 ZCode.lnk 已移除端口参数（唯一入口是桌面快捷方式）

---

## 2. 架构总览

```
浏览器控制面板 (http://127.0.0.1:9733, web/)
      │ HTTP JSON API
      ▼
守护进程 (src/server.js，常驻 node)
      │ CDP WebSocket (127.0.0.1:9335)
      ▼
ZCode 渲染进程（必须带 --remote-debugging-port 启动）
      │ Runtime.evaluate 注入自执行脚本
      ▼
渲染端状态 window.__ZCODE_SKIN_STATE__（含 update/cleanup/payload）
  ├─ <style id="zcode-skin-style"> 皮肤 CSS（变量覆盖 + 背景层 + 字体 + 细节）
  ├─ 背景图：body::before 壁纸层（HTTP URL，z-index:0）
  ├─ @font-face 字体（守护进程 /api/fonts 提供，CORS）
  └─ 文案替换引擎（MutationObserver 保活）
```

**生命周期**：`ZCode入口.vbs` 双击 → 隐藏启动守护进程 → 2 秒后带端口启动 ZCode →
守护进程 4 秒轮询探测 → 连接注入。ZCode 退出后，守护进程**自我退出**（20 秒宽限，见坑 #9）。

---

## 3. 核心机制

### 3.1 注入协议版本（重要约定）

`src/injector.js` 顶部 `const VERSION = 7`。

- 渲染端 `window[NS].version === VERSION` 时复用旧实例走 `update()`；
- **修改 injector 内部逻辑后必须升 VERSION**，否则渲染端跑旧代码（本次开发踩过坑：改文案替换没升版本导致不生效）。
- 升级机制：旧实例存在 → `cleanup()` 重建。

### 3.2 payload 结构（server → 渲染端）

```js
{
  id, name, mode, css,                    // 皮肤
  background: { fileName, blur, opacity, url } | null,  // 背景（url 由 attachBgUrl 注入）
  textReplace: [{ from, to }]             // 文案替换规则
}
```

`server.js` 的 `attachPayload(payload)` 统一装配：`attachBgUrl`（背景 HTTP URL）+
`attachFontCss`（@font-face + 字体规则）+ `textReplace`。

### 3.3 皮肤系统（palette 驱动）

- 皮肤 = `skins/<id>/skin.json`，核心是 `palette: { light, dark }`（6 个核心色：
  bg/surface/foreground/brand/sidebar/accent）
- `src/generator.js` 的 `derive()` 把核心色派生成 **60+ 个 ZCode CSS 变量**
  （surfaceHover/边框/终端色/交互卡片等全部自动派生）
- 双目录：内置 `skins/` + 用户皮肤 `~/.zcode/skin/user-skins/`（用户同名覆盖内置）
- **随景皮肤**（`skins/auto-color`，`meta.auto: true`）：`prepareSkin()` 调
  `extract_palette.py`（PIL 中位切分量化 8 色）→ `extractAutoPalette()` 映射配色。
  映射规则：占比最大→brand，次大→accent，亮部→浅色背景，暗部→深色背景；
  **浅色主色强制压暗 45%**（否则白字看不清——用户反馈过的坑）。
  auto 皮肤不可删除/隐藏（403）/编辑，前端置顶。

### 3.4 背景图

- 图库 `~/.zcode/skin/wallpapers/`，上传时前端 canvas 压缩（1920px、webp、≤1.4MB）
- 注入背景用 **HTTP URL**（`/api/skin/background-image`）——**blob:file:// 和 data: 在此页面都不可用**（坑 #2）
- 壁纸层 = `body::before` fixed + **z-index: 0**，同时 ZCode 全屏壳抬升 `z-index: 1`（坑 #3）

### 3.5 字体

- 字体库 `~/.zcode/skin/fonts/`，内置 13 个开源家族 + 用户上传
- `listFontFamilies()` 家族分组（去字重后缀），下拉只显示家族（中文名 + 含中文标记）
- `@font-face` 注入 + `html body { font-family: ... !important }`；代码块规则**总是生成**
  （防止界面字体污染代码区）
- 字体端点带 `Access-Control-Allow-Origin: *`（file:// 页面 @font-face 跨源必需）

### 3.6 文案替换

- 规则存 `state.textReplace`，注入进 payload
- 渲染端 TreeWalker 扫描文本节点 + `placeholder`/`aria-placeholder` 属性，**完全匹配才替换**
- MutationObserver（300ms 防抖）保活，SPA 动态内容持续生效

### 3.7 状态与自愈

- `state.json`：currentSkinId / background / hiddenSkins / fontFamily / codeFontFamily / textReplace / port
- 重连：4 秒轮询 `isZCodeRunning()` + 连接（**条件含 `session.closed`**，坑 #8）
- 导航重注入：`Page.frameNavigated` 事件 → `injectWithRetry()`（页面刷新后 blob 重建）
- ZCode 退出 → 守护进程 20 秒后 `process.exit(0)`（自我退出，无需外部杀进程）

---

## 4. 模块地图

| 文件 | 职责 | 关键函数 |
|---|---|---|
| `src/server.js`（1105 行）| 守护进程：HTTP API + CDP 管理 + 注入装配 | `attachPayload` `prepareSkin` `connectToZCode` `scheduleReconnect` `injectWithRetry` `attachFontCss` `listFontFamilies` `extractAutoPalette` |
| `src/cdp.js` | CDP 客户端（内置 WebSocket）| `CdpSession`（on/off 事件）`waitForZCodeTarget` `probeZCodePage` |
| `src/injector.js` | 渲染端注入脚本（字符串模板）| `_rendererMain`（VERSION 常量）`buildInjectorScript` `buildCleanupScript` |
| `src/generator.js` | 调色板 → CSS 生成器 | `derive` `buildCss` `mix` `lighten` `darken` `hexToRgb` |
| `src/skin-compiler.js` | 皮肤编译（双目录）| `compileSkin` `listSkins` `readSkinJson` |
| `src/detect.js` | 环境检测 | `findZCodeExe` `isZCodeRunning` `findFreePort` |
| `src/launcher.js` | ZCode 启动/关闭/快捷方式 | `launchZCode` `setShortcutPort` |
| `src/state.js` | 状态持久化 | `read` `write`（background 完整替换语义）|
| `src/cli.js` | CLI 命令 | serve/status/list/apply/restore/launch/close/enable-port |
| `src/extract_palette.py` | 背景图取色 | PIL quantize 8 色 + 占比 |
| `src/details.css` | 公共视觉细节（滚动条/选区/聚焦）| — |
| `web/` | 控制面板（无构建）| app.js 714 行（皮肤/图库/字体/文案替换/编辑器）|
| `bin/zcode-skin` | CLI 入口 | — |
| `ZCode入口.vbs` | Windows 一键入口 | 隐藏守护 + 带端口启动 |
| `upload-github.bat` | GitHub 上传辅助 | gh repo create --push |

---

## 5. 已知坑（必读，全部踩过）

1. **file:// 页面中 blob:file:// 与 data: URL 不可加载**（Image/fetch 均失败）——
   一切外部资源（背景图、字体）走守护进程 **HTTP URL**。
2. **负 z-index 被页面根层叠上下文压掉**——`body::before` 用 `z-index: -1` 不可见；
   方案：壁纸层 `z-index: 0` + 全屏壳（`body > div:first-child`）抬升 `z-index: 1`。
3. **背景双层叠加**：壳（`--color-background-win-alt`，78%）+ 内部 SECTION
   （`bg-background`，78%）≈95% 不透明 → 壁纸透不出。方案：透明化内层
   `[class~="bg-background"]`（注意 `class~=` 精确匹配，避免误伤 `bg-background-win-alt`）。
4. **`<input type="range">` 的百分比宽度无效**（替换元素）——用像素 + `max-width: 100%`。
5. **VBScript 只认 ANSI 编码**——vbs 必须纯 ASCII（中文注释会导致解析错误）；bat 同理避免 UTF-8 中文。
6. **Git Bash 会展开 bat/vbs 内容里的 `$` 变量**——写这类文件用 heredoc（`cat > f << 'EOF'`）。
7. **杀毒软件启发式误报**（Trojan/Veil.a）：隐藏启动 + taskkill + 启动 exe 的组合特征。
   已重构：无 bat、无 taskkill、守护自我退出。未来新增脚本避免此类特征组合。
8. **重连判断必须含 `session.closed`**——ZCode 重启后旧 session 对象仍在但已断，
   只判断对象存在性会永不重连。
9. **守护进程自我退出有 20 秒宽限**——防止误判（ZCode 短暂重启时守护别退）。
   注意：面板本身使用场景是"ZCode 退出后台也退"（用户明确要求）。
10. **generator/compiler 修改后必须重启守护进程**（Node 模块缓存），
   仅改 `skins/*/skin.json` 则无需重启（运行时读文件）。
11. **注入脚本修改必须升 VERSION**（见 3.1），否则渲染端复用旧实例。
12. **随景取色需 Python + Pillow**，缺失时自动回退默认 palette（prepareSkin 内 try/catch）。
13. **ZCode 的 closeToTrayOnWindows=true**——关窗口=进托盘，"退出"必须是托盘右键退出；
    用户测试时经常因此误判"重启成功"。
14. **ZCode 单实例锁**：无端口实例运行时再启动带端口实例不会生效——必须先退出。

---

## 6. 测试方法

```bash
# 语法检查
npm run check

# 起守护（改 server/generator/compiler 后必须重启）
node bin/zcode-skin serve        # 面板 http://127.0.0.1:9733

# API 冒烟
curl -s http://127.0.0.1:9733/api/status

# 渲染端验证（CDP 直查，绕过面板）
node -e "…"  # 连 ws://127.0.0.1:9335，Runtime.evaluate 查 window.__ZCODE_SKIN_STATE__
```

**像素级验证**（确认壁纸/配色真的渲染）：CDP `Page.captureScreenshot` → Python PIL 采样
（侧边栏/聊天区/输入区）——本项目的视觉验证标准做法。

**修改后的标准回归清单**：
1. `node --check` 所有改动文件
2. 重启守护 → status.connected = true
3. 渲染端 `window.__ZCODE_SKIN_STATE__` 存在且 version 正确
4. 切皮肤 → brand 变量变化；设背景 → 像素采样确认；改字体 → `document.fonts.check`
5. 文案替换 → placeholder/文本实际变化
6. 还原 → style 移除、状态清空

---

## 7. 开发约定

- **零第三方依赖**是硬约束（Node 内置能力 + Python 标准库/Pillow）
- 前端无构建，直接改 `web/` 三件套；改 JS/CSS 刷新面板即可（改 server 需重启）
- 面板 UI 中文；代码注释中文（与现有风格一致）
- 新增内置皮肤：`skins/<id>/skin.json`（palette 驱动，可带 `background.svg` 但已不用——背景与皮肤解耦）
- 所有外部资源（背景/字体）必须走守护进程 HTTP 端点（坑 #1）
- 提交前跑 `npm run check`；commit message 英文

---

## 8. 数据文件位置

```
~/.zcode/skin/
├── state.json          # 全部设置（皮肤/背景/字体/文案替换/隐藏皮肤）
├── wallpapers/         # 背景图库
├── fonts/              # 字体库（13 个内置家族 + 上传）
└── user-skins/         # 用户自定义皮肤（palette 驱动）
```
