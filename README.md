# ZCode Skin 🎨

给 **ZCode 桌面应用**（Electron 版）换肤的美化工具：配色主题、背景图库、字体库、文案替换、自适应皮肤，
全部**实时生效**，不改官方安装包。

> 原理参考 [fei-away/codex-dream-skin](https://github.com/fei-away/codex-dream-skin)：
> **本地 CDP 注入**（`--remote-debugging-port` + WebSocket），不修改 `resources/app.asar`、
> 不改文件签名——应用自动更新后**天然免疫**。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🎨 **11 套配色主题** | 蓝白、暗夜、墨绿、黑白、樱粉、紫罗兰、暖橙、青碧、绯夜、星辉 + 随景（自适应） |
| 🌈 **随景自适应皮肤** | 从当前背景图提取主色板，按颜色占比自动生成界面配色（浅色图深色化，保证白字可读） |
| 🎛️ **调色盘编辑器** | 深/浅模式独立调色（6 核心色，其余自动派生），皮肤增删查改，一键保存应用 |
| 🖼️ **背景图库** | 上传/浏览/删除/点击即用，模糊与透明度可调，与皮肤完全解耦 |
| 🔤 **字体库** | 13 个开源字体家族（黑体/楷体/行书/草书/圆体/仿宋/像素/装饰/等宽），界面字体与代码字体独立，自动标注「含中文」 |
| ✏️ **文案替换** | 修改 ZCode 界面提示语（问候语、输入框占位符等），精确匹配防误伤 |
| 🐛 **DevTools 调试器** | 面板一键打开 ZCode 的 CDP 调试前端 |
| 💾 **一键还原** | 恢复官方外观，不留痕迹 |

## 🚀 快速开始

```bash
# 1. 启动守护进程（自动打开浏览器控制面板 http://127.0.0.1:9733）
node bin/zcode-skin

# 2. 用「美化模式」启动 ZCode（带调试端口 9335）
#    桌面「ZCode」快捷方式 / ZCode入口.vbs 双击即可
```

**Windows 一键入口**：将 `ZCode入口.vbs` 创建为桌面快捷方式——
启动 = 隐藏守护进程 + 带端口启动 ZCode；退出 ZCode 后守护进程自动关闭（20 秒宽限）。

## 🖥️ 控制面板

浏览器打开 `http://127.0.0.1:9733`：

- **皮肤画廊**：点卡片应用；内置皮肤可「复制为自定义」再调色；自定义皮肤可编辑/删除；被隐藏的内置皮肤可恢复
- **背景图库**：上传（自动压缩至 1920px）、点击即用、删除；模糊/透明度滑块实时调节
- **字体**：界面字体/代码字体下拉（家族分组、含中文标注）、上传 woff2/ttf/otf、预览
- **文案替换**：原文 → 替换文规则列表，SPA 动态变化持续生效
- **工具**：启动/重启 ZCode、打开 DevTools、还原官方外观、实时日志（可折叠）

## ⚙️ 命令

| 命令 | 说明 |
|---|---|
| `node bin/zcode-skin` | 启动守护进程 + 浏览器面板（默认） |
| `node bin/zcode-skin status` | 检测 ZCode 安装/运行/CDP 状态 |
| `node bin/zcode-skin list` | 列出皮肤 |
| `node bin/zcode-skin apply <id>` | 应用皮肤（运行中则实时注入） |
| `node bin/zcode-skin restore` | 还原官方外观 |
| `node bin/zcode-skin launch` | 以注入模式（CDP 端口）启动 ZCode |
| `node bin/zcode-skin close` | 关闭 ZCode |

## 🔧 工作原理

```
浏览器控制面板 (http://127.0.0.1:9733)
      │ HTTP API
      ▼
守护进程 (Node，零第三方依赖)
      │ CDP WebSocket (127.0.0.1:9335)
      ▼
ZCode 渲染进程（--remote-debugging-port 启动）
  ├─ <style id="zcode-skin-style"> 注入皮肤 CSS（覆盖 --color-* 双层变量）
  ├─ 背景图 → HTTP URL → body::before 壁纸层（页面刷新不失效）
  ├─ @font-face 字体加载 + 全局/代码字体覆盖（带 CORS）
  └─ 文案替换引擎（MutationObserver 保活，精确匹配文本/placeholder）
```

- **皮肤 = 调色板驱动**：`skin.json` 定义核心色（bg/surface/foreground/brand/sidebar/accent），
  其余 60+ 个 ZCode CSS 变量由 `src/generator.js` 自动派生
- **随景皮肤**：Python + PIL 从背景图提取主色板（中位切分量化），按占比映射为配色
- **注入免疫更新**：不动 `resources/app.asar`，ZCode 升级后无需重装
- **还原** = 移除注入的 `<style>` 并清理全局状态

## 🗂️ 目录结构

```
zcode-skin/
├── bin/zcode-skin        # CLI 入口
├── src/
│   ├── server.js         # 守护进程 + HTTP API + CDP 会话管理
│   ├── cdp.js            # CDP 客户端（发现/连接/注入）
│   ├── injector.js       # 渲染端注入脚本（皮肤/背景/字体/文案替换，版本化协议）
│   ├── generator.js      # 调色板 → 皮肤 CSS 生成器（派生色自动计算）
│   ├── skin-compiler.js  # 皮肤包编译（内置 + 用户皮肤双目录）
│   ├── extract_palette.py# 背景图主色板提取（PIL 量化）
│   ├── detect.js         # ZCode 安装/版本/运行检测
│   ├── launcher.js       # 启动/关闭 ZCode、快捷方式管理
│   └── state.js          # 状态持久化（~/.zcode/skin/state.json）
├── skins/                # 内置皮肤（palette 驱动）
├── web/                  # 浏览器控制面板（无构建）
└── ZCode入口.vbs         # Windows 一键入口（守护 + 带端口启动）
```

## 🛡️ 安全边界（重要）

- CDP 只绑定 `127.0.0.1`，**没有身份认证**：同机其他进程理论上可连接读取/控制 ZCode 渲染进程。
  运行期间请勿运行来路不明的本机程序。
- 本工具**不会**修改 ZCode 的模型供应商/API 配置，换肤与配置完全独立。
- 皮肤 CSS 只覆盖官方定义的 `--color-*` 变量与通用元素样式，不注入外部资源。
- 背景图/字体均为本地文件，由守护进程 HTTP 服务提供（回环地址）。

## ⚠️ 已知限制

- ZCode 打包版默认不开启调试端口，**必须通过本工具入口启动**（一键入口 / `launch` 命令 / 面板按钮）。
- 杀毒软件可能对 `vbs` 隐藏启动与常驻 node 进程产生启发式误报，建议将项目目录加入信任区。
- 需要 Node.js ≥ 22（内置 WebSocket）与 Python 3 + Pillow（随景皮肤调色板提取）。

## 📄 License

MIT
