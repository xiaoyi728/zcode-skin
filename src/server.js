'use strict';
/**
 * server.js — ZCode Skin 守护进程
 *
 * 职责：
 *  - HTTP 静态服务：浏览器控制面板（web/）
 *  - JSON API：状态查询、皮肤应用/还原、背景图设置、ZCode 启动/关闭、DevTools
 *  - CDP 会话管理：发现 ZCode 渲染目标 → 连接 → 注入当前皮肤，断线自动重连
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const detect = require('./detect');
const launcher = require('./launcher');
const cdp = require('./cdp');
const injector = require('./injector');
const skinCompiler = require('./skin-compiler');
const state = require('./state');

const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = 9733; // 控制面板端口（固定，冲突则自动 +1）
const WALLPAPERS_DIR = path.join(os.homedir(), '.zcode', 'skin', 'wallpapers'); // 背景图库（用户上传，与皮肤解耦）
const LEGACY_UPLOAD_DIR = path.join(os.homedir(), '.zcode', 'skin', 'uploads'); // 旧版上传目录（迁移用）
const FONTS_DIR = path.join(os.homedir(), '.zcode', 'skin', 'fonts'); // 字体库（内置 + 用户上传）

const FONT_EXT = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

const BG_MIME = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
};

/** 当前背景图文件路径（仅来自图库，皮肤不带背景） */
function currentBgFile() {
  const st = state.read();
  if (st.background && st.background.fileName) {
    const f = path.join(WALLPAPERS_DIR, st.background.fileName);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

/** 迁移旧版上传目录到图库目录（启动时执行一次） */
function migrateLegacyUploads() {
  try {
    if (fs.existsSync(LEGACY_UPLOAD_DIR) && !fs.existsSync(WALLPAPERS_DIR)) {
      fs.mkdirSync(path.dirname(WALLPAPERS_DIR), { recursive: true });
      fs.renameSync(LEGACY_UPLOAD_DIR, WALLPAPERS_DIR);
      log('已迁移旧版背景上传目录 → wallpapers');
    }
  } catch (e) {
    log(`旧目录迁移失败（忽略）：${e.message}`);
  }
}

// ---------- 日志（内存环形缓冲） ----------
const logRing = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  logRing.push(line);
  if (logRing.length > 200) logRing.shift();
  console.log(line);
}

// ---------- 运行时状态 ----------
const runtime = {
  exe: null,
  version: null,
  zcodeRunning: false,
  port: 0,          // ZCode 的 CDP 端口
  httpPort: 0,      // 控制面板 HTTP 端口（背景图 URL 需要）
  session: null,    // CdpSession
  target: null,     // 当前目标 target
  reconnectTimer: null,
  launchedByUs: false,
  httpServer: null, // 控制面板 HTTP 服务（模块级持有，防 GC 回收）
};

/** 为 payload 补充背景图 HTTP URL（稳定 URL，页面刷新不失效，不受 CSP 限制） */
function attachBgUrl(payload) {
  if (payload.background && runtime.httpPort) {
    payload.background.url = `http://127.0.0.1:${runtime.httpPort}/api/skin/background-image?v=${Date.now()}`;
  }
  return payload;
}

/** 注入前统一装配：背景 URL + 字体 CSS + 文案替换 */
function attachPayload(payload) {
  attachBgUrl(payload);
  attachFontCss(payload);
  const st = state.read();
  if (st.textReplace && st.textReplace.length) {
    payload.textReplace = st.textReplace;
  }
  return payload;
}

// ---------- 自适应皮肤（auto-color） ----------

const gen = require('./generator');

function lum(hex) {
  const { r, g, b } = gen.hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 调用 Python 从背景图提取主色板（按占比降序） */
function extractColors(bgFile) {
  const py = path.join(__dirname, 'extract_palette.py');
  return new Promise((resolve, reject) => {
    execFile('python', [py, bgFile], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      if (err) return reject(new Error(`调色板提取失败：${err.message}`));
      try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(e); }
    });
  });
}

/**
 * 主色板 → palette（按占比分配界面颜色）：
 *   占比最大的颜色 = 品牌色；次大 = 强调色；
 *   亮部主色 → 浅色模式背景；暗部主色 → 深色模式背景。
 */
async function extractAutoPalette(bgFile) {
  const colors = await extractColors(bgFile);
  if (!colors.length) throw new Error('未提取到颜色');
  const brand = colors[0].hex;
  const accent = colors[1] ? colors[1].hex : gen.lighten(brand, 0.25);
  const brights = colors.filter((c) => lum(c.hex) > 128);
  const darks = colors.filter((c) => lum(c.hex) <= 128);
  const lightest = brights[0] || gen.lighten(brand, 0.45);
  const darkest = darks[darks.length - 1] || gen.darken(brand, 0.45);

  // 深色模式：暗部主色作背景（压深保证白字可读、不泛白）
  const bgDark = lum(darkest.hex) > 90 ? gen.darken(darkest.hex, 0.5) : darkest.hex;
  // 品牌色深色化：浅色主色直接作 brand 会让白字看不清，强制压到中暗亮度
  const brandDark = lum(brand) > 150
    ? gen.darken(brand, 0.45)
    : (lum(brand) < 80 ? gen.lighten(brand, 0.2) : brand);
  const accentDark = lum(accent) > 160
    ? gen.darken(accent, 0.35)
    : (lum(accent) < 80 ? gen.lighten(accent, 0.25) : accent);
  const dark = {
    bg: bgDark,
    surface: gen.lighten(bgDark, 0.07),
    foreground: lum(bgDark) < 110 ? '#e8ecf4' : '#1a2030',
    brand: brandDark,
    sidebar: gen.darken(bgDark, 0.05),
    accent: accentDark,
  };

  // 浅色模式：亮部主色作背景
  const bgLight = lum(lightest.hex) < 180 ? gen.lighten(lightest.hex, 0.55) : lightest.hex;
  // 浅色模式品牌色同样压深（按钮白字可读）
  const brandLight = lum(brand) > 170 ? gen.darken(brand, 0.35) : brand;
  const accentLight = lum(accent) > 180 ? gen.darken(accent, 0.3) : accent;
  const light = {
    bg: bgLight,
    surface: '#ffffff',
    foreground: lum(bgLight) > 150 ? '#26303c' : '#f0f4fa',
    brand: brandLight,
    sidebar: gen.darken(bgLight, 0.06),
    accent: accentLight,
  };
  return { light, dark };
}

/**
 * 皮肤编译统一入口：auto 皮肤按当前背景图动态生成 palette，
 * 无背景图时退回 skin.json 默认 palette。
 */
async function prepareSkin(id, overrides = {}) {
  const { meta } = skinCompiler.readSkinJson(id);
  if (meta.auto) {
    const bgFile = currentBgFile();
    if (bgFile) {
      try {
        overrides = { ...overrides, palette: await extractAutoPalette(bgFile) };
      } catch (e) {
        log(`自适应配色生成失败（使用默认配色）：${e.message}`);
      }
    }
  }
  return skinCompiler.compileSkin(id, overrides);
}

// ---------- 字体 ----------

/** 字体中文显示名映射（内置字体友好名） */
const FONT_DISPLAY_NAMES = {
  'SmileySans-Oblique': '得意黑',
  'LXGWWenKai': '霞鹜文楷',
  'LXGWNeoXiHei': '霞鹜新晰黑',
  'LXGW975YuanSC': '975圆体',
  'ZhuqueFangsong': '朱雀仿宋',
  'fusion-pixel-12px-monospaced-zh_hans': '缝合像素·简体',
  'fusion-pixel-12px-monospaced-zh_hant': '缝合像素·繁体',
  'fusion-pixel-12px-proportional-zh_hans': '缝合像素·简体(比例)',
  'fusion-pixel-12px-proportional-zh_hant': '缝合像素·繁体(比例)',
  'ZCOOLXiaoWei': '站酷小薇',
  'ZhiMangXing': '志莽行书',
  'MaShanZheng': '马善政楷书',
  'LiuJianMaoCao': '柳建毛草',
  'LongCang': '龙藏手写',
  'JetBrainsMono': 'JetBrains Mono',
};

/** 字体库列表 */
function listFonts() {
  if (!fs.existsSync(FONTS_DIR)) return [];
  return fs.readdirSync(FONTS_DIR)
    .filter((f) => FONT_EXT[path.extname(f).toLowerCase()])
    .map((f) => {
      let size = 0;
      try { size = fs.statSync(path.join(FONTS_DIR, f)).size; } catch { /* noop */ }
      return { fileName: f, size };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** 字体家族名（去扩展名与字重后缀） */
function familyKey(fileName) {
  // 先去掉最终扩展名和中间的双扩展（.ttf.woff2 / .otf.woff2）
  let base = fileName
    .replace(/\.(woff2|woff|ttf|otf)$/i, '')
    .replace(/\.(otf|ttf)$/i, '');
  // 再去掉可变字重与字重/风格后缀（顺序：先 [wght]，再 -Italic，再字重组）
  base = base
    .replace(/\[wght\]$/i, '')
    .replace(/-\d+W$/i, '')
    .replace(/-(Italic)$/i, '')
    .replace(/-(Bold|Light|Medium|Thin|SemiBold|ExtraBold|ExtraLight|Black|Regular)(Italic)?$/i, '');
  return base;
}

/** 家族内挑选代表文件：woff2 优先，Regular/常规字重优先 */
function pickFontFile(files) {
  const woff2 = files.filter((f) => f.endsWith('.woff2'));
  const pool = woff2.length ? woff2 : files;
  return pool.find((f) => /-Regular|400W|\[wght\]|^Regular/i.test(f)) || pool[0];
}

/** 字体库 → 家族分组（下拉用） */
function listFontFamilies() {
  const groups = new Map();
  for (const f of listFonts()) {
    const key = familyKey(f.fileName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f.fileName);
  }
  return [...groups.entries()].map(([key, files]) => {
    const pick = pickFontFile(files);
    return {
      family: key,
      name: FONT_DISPLAY_NAMES[key] || key,
      count: files.length,
      pick,
      // 是否包含中文字形（JetBrains Mono 等纯拉丁字体对中文无效）
      cjk: /zh_hans|zh_hant|WenKai|Yuan|Fangsong|SmileySans|Pixel|zpix|NeoXiHei|ZCOOL|ZhiMang|MaShan|LongCang|MaoCao/i.test(key + pick),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

/** 家族 key → 代表文件 */
function resolveFontFile(familyOrFile) {
  // 直接是文件
  if (listFonts().some((f) => f.fileName === familyOrFile)) return familyOrFile;
  // 是家族 key
  const fam = listFontFamilies().find((f) => f.family === familyOrFile || f.name === familyOrFile);
  return fam ? fam.pick : null;
}

/** 生成 @font-face 家族名（ASCII 化，去扩展名） */
function fontFamilyOf(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
}

/**
 * 把字体应用规则拼接到注入 CSS 前部（@font-face 必须在引用前定义）。
 * 界面字体覆盖 body（全局），代码字体覆盖 pre/code 等（总是生成，避免界面字体污染代码块）。
 */
function attachFontCss(payload) {
  const st = state.read();
  if (!runtime.httpPort) return payload;
  const parts = [];
  const addFace = (fileName) => {
    if (!fileName) return null;
    const file = path.join(FONTS_DIR, fileName);
    if (!fs.existsSync(file)) return null;
    const ext = path.extname(fileName).toLowerCase();
    if (!FONT_EXT[ext]) return null;
    const family = fontFamilyOf(fileName);
    const url = `http://127.0.0.1:${runtime.httpPort}/api/fonts/${encodeURIComponent(fileName)}`;
    parts.push(`@font-face { font-family: '${family}'; src: url('${url}') format('${FONT_EXT[ext]}'); font-display: swap; }`);
    return family;
  };
  const uiFamily = addFace(st.fontFamily);
  const codeFamily = addFace(st.codeFontFamily) || uiFamily;
  if (uiFamily) {
    parts.push(`html body { font-family: '${uiFamily}', system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif !important; }`);
  }
  // 代码块规则总是生成（即使只设了界面字体），保证代码区保持等宽
  const mono = codeFamily
    ? `'${codeFamily}', ui-monospace, 'Cascadia Code', Consolas, monospace`
    : `ui-monospace, 'Cascadia Code', Consolas, monospace`;
  parts.push(`html pre, html code, html kbd, html samp, html [class*="language-"], html .token, html textarea { font-family: ${mono} !important; }`);
  if (parts.length) {
    payload.css = parts.join('\n') + '\n' + payload.css;
  }
  return payload;
}

// ---------- CDP 会话管理 ----------

function stopSession() {
  if (runtime.session) {
    try { runtime.session.close(); } catch { /* noop */ }
  }
  runtime.session = null;
  runtime.target = null;
}

/** 注入当前皮肤（无皮肤时不注入） */
async function injectCurrentSkin(session) {
  const st = state.read();
  if (!st.currentSkinId) return false;
  const { payload } = await prepareSkin(st.currentSkinId, { background: st.background });
  attachPayload(payload);
  await session.evaluate(injector.buildInjectorScript(payload));
  return true;
}

/**
 * 导航后带重试的注入：frameNavigated 时 DOM 可能尚未就绪，
 * 延迟重试几次（页面刷新会重建文档，旧 blob URL 失效，必须重新注入）。
 */
async function injectWithRetry(session, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await injectCurrentSkin(session);
      return true;
    } catch (e) {
      if (i === attempts - 1) {
        log(`皮肤重注入失败：${e.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return false;
}

async function connectToZCode() {
  if (!runtime.zcodeRunning) return false;
  stopSession();
  const target = await cdp.waitForZCodeTarget(runtime.port, { timeoutMs: 12000, intervalMs: 1200 });
  if (!target) return false;
  let session;
  try {
    session = await cdp.CdpSession.connect(target.webSocketDebuggerUrl, 8000);
  } catch (e) {
    log(`CDP 连接失败：${e.message}`);
    return false;
  }
  const isZcode = await cdp.probeZCodePage(session).catch(() => false);
  if (!isZcode) {
    session.close();
    log(`目标页面 ${target.url} 不是 ZCode 页面，跳过`);
    return false;
  }
  runtime.session = session;
  runtime.target = target;
  log(`已连接 ZCode 渲染目标：${target.url}（${target.id}）`);

  // 订阅导航事件：页面刷新/导航后自动重新注入（blob URL 随文档重建而失效）
  session.on('Page.frameNavigated', () => {
    log('ZCode 页面导航，自动重新注入皮肤…');
    injectWithRetry(session).then((ok) => {
      if (ok) log('皮肤已重新注入');
    });
  });
  await session.send('Page.enable').catch(() => {});

  // 连接后：若有当前皮肤则（重新）注入，并同步背景设置
  if (state.read().currentSkinId) {
    await injectWithRetry(session, 1).catch((e) => log(`注入皮肤失败：${e.message}`));
  }
  return true;
}

/** 后台重连循环 + 自动更新修复 */
function scheduleReconnect() {
  if (runtime.reconnectTimer) return;
  let lastVerCheck = 0;
  runtime.reconnectTimer = setInterval(async () => {
    const running = await detect.isZCodeRunning().catch(() => false);
    runtime.zcodeRunning = running;
    // 注意：ZCode 重启后旧 session 对象仍在但已 closed，必须按 closed 状态判断
    if (running && (!runtime.session || runtime.session.closed)) {
      await connectToZCode().catch((e) => log(`重连异常：${e.message}`));
    }

    // 自动更新修复：ZCode 自动更新后会以「无端口实例」自重启（单实例锁导致
    // 后续带端口启动被转发失效）。检测到「运行中 + CDP 不可达 + 版本号变化」
    // 视为更新完成 → 自动退出旧实例并带端口重启，美化无缝恢复。
    if (running && (!runtime.session || runtime.session.closed) && runtime.exe && Date.now() - lastVerCheck > 20000) {
      lastVerCheck = Date.now();
      try {
        const targets = await cdp.fetchTargets(runtime.port);
        if (targets.length) return; // 端口其实可达（session 尚未连上），不触发
        const ver = await detect.getVersion(runtime.exe);
        const st = state.read();
        if (ver && st.lastKnownVersion && ver !== st.lastKnownVersion) {
          log(`检测到 ZCode 版本更新（${st.lastKnownVersion} → ${ver}），自动重启为美化模式…`);
          state.write({ lastKnownVersion: ver });
          await launcher.closeZCode();
          await new Promise((r) => setTimeout(r, 2000));
          await launcher.launchZCode(runtime.exe, runtime.port);
          runtime.launchedByUs = true;
          log(`已带调试端口重启 ZCode（:${runtime.port}）`);
        }
      } catch (e) {
        log(`自动更新修复失败：${e.message}`);
      }
    }
  }, 4000);
}

// ---------- 动作 ----------

async function ensureZCodeReady() {
  if (!runtime.exe) {
    const detected = await detect.detectAll();
    runtime.exe = detected.exe;
    runtime.version = detected.version;
    if (!detected.exe) throw new Error('未找到 ZCode.exe，请检查安装路径');
  }
  const running = await detect.isZCodeRunning();
  if (running && !runtime.launchedByUs) {
    throw new Error('ZCode 已在运行但未带调试端口。请先关闭 ZCode，再由面板启动（以注入模式启动）。');
  }
  if (!running) {
    await launcher.launchZCode(runtime.exe, runtime.port);
    runtime.launchedByUs = true;
    log(`已启动 ZCode（CDP 端口 ${runtime.port}）`);
    await new Promise((r) => setTimeout(r, 2500));
  }
  return true;
}

async function applySkin(id) {
  const st = state.read();
  const { payload } = await prepareSkin(id, { background: st.background });
  attachPayload(payload);
  let result = { applied: false, connected: false };
  if (runtime.session) {
    try {
      await runtime.session.evaluate(injector.buildInjectorScript(payload));
      result.applied = true;
      result.connected = true;
    } catch (e) {
      log(`CDP 注入失败：${e.message}`);
      result.connected = false;
    }
  }
  state.write({ currentSkinId: id });
  if (!result.applied && runtime.zcodeRunning) {
    // 会话可能已断，重连一次再注入
    const ok = await connectToZCode().catch(() => false);
    if (ok && runtime.session) {
      await runtime.session.evaluate(injector.buildInjectorScript(payload)).catch(() => {});
      result.applied = true;
      result.connected = true;
    }
  }
  return { ...result, id, reason: !result.applied ? 'ZCode 未运行或未连接，皮肤已保存，启动后将自动应用' : undefined };
}

async function restoreSkin() {
  state.write({ currentSkinId: null });
  let restored = false;
  if (runtime.session) {
    try {
      await runtime.session.evaluate(injector.buildCleanupScript());
      restored = true;
    } catch (e) {
      log(`还原失败：${e.message}`);
    }
  }
  return { restored, reason: !restored && runtime.zcodeRunning ? '未连接 ZCode，还原将在下次连接时完成' : undefined };
}

async function setBackground(bg) {
  const st = state.read();
  // bg: { fileName?, blur?, opacity? } — 背景图来自图库（与皮肤解耦）
  const next = { ...(st.background || {}), ...bg };
  if (bg.fileName === null) {
    // 显式移除背景图（回退无背景；blur/opacity 参数仍可调整）
    delete next.fileName;
  }
  if (!next.fileName && next.blur == null && next.opacity == null) {
    state.write({ background: null });
  } else {
    state.write({ background: next });
  }
  // 渲染端实时更新
  let updated = false;
  const skinId = state.read().currentSkinId;
  if (runtime.session && skinId) {
    try {
      const { payload } = await prepareSkin(skinId, { background: next });
      attachPayload(payload);
      await runtime.session.evaluate(injector.buildInjectorScript(payload));
      updated = true;
    } catch (e) {
      log(`背景更新失败：${e.message}`);
    }
  }
  return { updated, background: next.fileName ? { ...next } : null };
}

/** 图库列表 */
function listWallpapers() {
  if (!fs.existsSync(WALLPAPERS_DIR)) return [];
  return fs.readdirSync(WALLPAPERS_DIR)
    .filter((f) => /\.(webp|png|jpe?g|gif|svg)$/i.test(f))
    .map((f) => {
      let size = 0;
      try { size = fs.statSync(path.join(WALLPAPERS_DIR, f)).size; } catch { /* noop */ }
      return { fileName: f, size };
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

function devtoolsUrl() {
  const ws = runtime.target?.webSocketDebuggerUrl;
  if (!ws) return null;
  return `http://127.0.0.1:${runtime.port}/devtools/inspector.html?ws=${encodeURIComponent(ws)}`;
}

// ---------- HTTP 服务 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 64 * 1024 * 1024) reject(new Error('body 过大')); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch { reject(new Error('JSON 解析失败')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(WEB_DIR, pathname));
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory?.()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/status') {
    const st = state.read();
    const hidden = new Set(st.hiddenSkins || []);
    // 背景 enabled：壁纸当前是否可见（有背景图来源且 opacity 非 0）
    const bgEnabled = !!currentBgFile() && !(st.background && st.background.opacity === 0);
    return sendJson(res, {
      zcodeRunning: runtime.zcodeRunning,
      exe: runtime.exe,
      version: runtime.version,
      cdpPort: runtime.port,
      connected: !!runtime.session,
      targetUrl: runtime.target?.url || null,
      currentSkinId: st.currentSkinId,
      background: st.background ? { ...st.background, enabled: bgEnabled } : null,
      fontFamily: st.fontFamily,
      codeFontFamily: st.codeFontFamily,
      textReplace: st.textReplace || [],
      fonts: listFonts(),
      fontFamilies: listFontFamilies(),
      skins: skinCompiler.listSkins().map((s) => ({ ...s, hidden: s.source === 'builtin' && hidden.has(s.id) })),
    });
  }

  if (pathname === '/api/logs') {
    return sendJson(res, { logs: logRing.slice(-80) });
  }

  if (pathname === '/api/skins') {
    return sendJson(res, { skins: skinCompiler.listSkins() });
  }

  if (pathname === '/api/skin/css') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!id) return sendJson(res, { error: '缺少 id' }, 400);
    try {
      const { payload } = await prepareSkin(id, { background: null });
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(payload.css);
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  if (pathname === '/api/skin/background') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    try {
      const bg = id ? (await prepareSkin(id, { background: null })).payload.background : null;
      return sendJson(res, { background: bg ? { ...bg, dataUrl: bg.dataUrl.slice(0, 128) + '…', _full: bg.dataUrl } : null });
    } catch (e) {
      return sendJson(res, { error: e.message }, 500);
    }
  }

  if (req.method === 'POST' && pathname === '/api/skin/apply') {
    const body = await readBody(req);
    if (!body.id) return sendJson(res, { error: '缺少皮肤 id' }, 400);
    const r = await applySkin(body.id);
    return sendJson(res, r, r.applied ? 200 : 409);
  }

  if (req.method === 'POST' && pathname === '/api/skin/restore') {
    const r = await restoreSkin();
    return sendJson(res, r);
  }

  if (req.method === 'POST' && pathname === '/api/background') {
    const body = await readBody(req);
    const r = await setBackground(body);
    return sendJson(res, r);
  }

  if (req.method === 'POST' && pathname === '/api/zcode/launch') {
    try {
      await ensureZCodeReady();
      await connectToZCode();
      return sendJson(res, { ok: true, port: runtime.port });
    } catch (e) {
      return sendJson(res, { ok: false, error: e.message }, 409);
    }
  }

  if (req.method === 'POST' && pathname === '/api/zcode/close') {
    await launcher.closeZCode();
    stopSession();
    runtime.launchedByUs = false;
    runtime.zcodeRunning = false;
    return sendJson(res, { ok: true });
  }

  if (pathname === '/api/zcode/devtools') {
    const url = devtoolsUrl();
    return sendJson(res, url ? { url } : { url: null, error: '未连接 ZCode' }, url ? 200 : 409);
  }

  if (pathname === '/api/skin/background-image') {
    // 背景图资源：file:// 页面加载 http:// 图片可行且不受 CSP/blob 失效影响
    // ?file=xxx 指定图库文件（缩略图）；无参数返回当前使用中的背景
    const q = new URL(req.url, 'http://x').searchParams;
    const fileParam = q.get('file');
    let file = null;
    if (fileParam) {
      if (!/^[\w.-]+\.(webp|png|jpe?g|gif|svg)$/i.test(fileParam)) return sendJson(res, { error: '非法文件名' }, 400);
      file = path.join(WALLPAPERS_DIR, fileParam);
      if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在' }, 404);
    } else {
      file = currentBgFile();
      if (!file) return sendJson(res, { error: '无背景图' }, 404);
    }
    res.writeHead(200, {
      'Content-Type': BG_MIME[path.extname(file).toLowerCase()] || 'image/png',
      'Cache-Control': 'no-store',
    });
    return fs.createReadStream(file).pipe(res);
  }

  // ---------- 背景图库 ----------

  if (pathname === '/api/wallpapers' && req.method === 'GET') {
    return sendJson(res, { wallpapers: listWallpapers() });
  }

  if (pathname === '/api/wallpapers' && req.method === 'POST') {
    // 上传：{ dataUrl } → 存入图库
    const body = await readBody(req);
    if (!body.dataUrl) return sendJson(res, { error: '缺少图片数据' }, 400);
    try {
      fs.mkdirSync(WALLPAPERS_DIR, { recursive: true });
      const mime = (String(body.dataUrl).match(/^data:([^;]+)/) || [])[1] || 'image/png';
      const ext = {
        'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg',
        'image/gif': '.gif', 'image/svg+xml': '.svg',
      }[mime] || '.png';
      const fileName = `bg-${Date.now().toString(36)}${ext}`;
      fs.writeFileSync(path.join(WALLPAPERS_DIR, fileName), Buffer.from(String(body.dataUrl).split(',')[1], 'base64'));
      log(`已上传背景图：${fileName}`);
      return sendJson(res, { ok: true, wallpapers: listWallpapers() });
    } catch (e) {
      log(`背景图保存失败：${e.message}`);
      return sendJson(res, { error: `保存失败：${e.message}` }, 500);
    }
  }

  const wpDelMatch = pathname.match(/^\/api\/wallpapers\/([^/]+)$/);
  if (wpDelMatch && req.method === 'DELETE') {
    const fileName = decodeURIComponent(wpDelMatch[1]);
    if (!/^[\w.-]+\.(webp|png|jpe?g|gif|svg)$/i.test(fileName)) {
      return sendJson(res, { error: '非法文件名' }, 400);
    }
    const file = path.join(WALLPAPERS_DIR, fileName);
    if (!fs.existsSync(file)) return sendJson(res, { error: '文件不存在' }, 404);
    fs.unlinkSync(file);
    log(`已删除背景图：${fileName}`);
    // 若删除的是当前使用的背景 → 清除背景状态
    const st = state.read();
    if (st.background && st.background.fileName === fileName) {
      state.write({ background: null });
      const skinId = state.read().currentSkinId;
      if (runtime.session && skinId) {
        try {
          const { payload } = await prepareSkin(skinId, { background: null });
          attachPayload(payload);
          await runtime.session.evaluate(injector.buildInjectorScript(payload));
        } catch (e) { log(`背景清除注入失败：${e.message}`); }
      }
    }
    return sendJson(res, { ok: true, wallpapers: listWallpapers() });
  }

  // ---------- 用户皮肤 CRUD ----------

  if (pathname === '/api/user-skins' && req.method === 'POST') {
    // 创建：{ name, description?, fromSkinId?, mode? } — 从源皮肤复制调色板与壁纸为起点
    const body = await readBody(req);
    if (!body.name) return sendJson(res, { error: '缺少名称' }, 400);
    const id = `custom-${Date.now().toString(36)}`;
    const dir = path.join(skinCompiler.USER_SKINS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    let palette = null;
    if (body.fromSkinId) {
      try {
        const { meta } = skinCompiler.readSkinJson(body.fromSkinId);
        palette = meta.palette || null;
      } catch { /* 源皮肤不存在则用默认 */ }
    }
    const meta = {
      id,
      name: String(body.name).slice(0, 40),
      description: String(body.description || '').slice(0, 120),
      mode: body.mode || 'both',
      version: 1,
      palette: palette || { light: {}, dark: {} },
    };
    fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify(meta, null, 2), 'utf8');
    log(`已创建用户皮肤：${id}（${meta.name}）`);
    return sendJson(res, { ok: true, id, meta });
  }

  const userSkinMatch = pathname.match(/^\/api\/user-skins\/([^/]+)$/);
  if (userSkinMatch) {
    const id = decodeURIComponent(userSkinMatch[1]);
    let found = null;
    try {
      const info = skinCompiler.readSkinJson(id);
      if (info.source === 'user') found = info;
    } catch { /* 不存在 */ }
    if (!found) return sendJson(res, { error: `用户皮肤不存在：${id}` }, 404);

    if (req.method === 'PUT') {
      // 修改：{ name?, description?, palette? }
      const body = await readBody(req);
      const meta = { ...found.meta, id };
      if (body.name !== undefined) meta.name = String(body.name).slice(0, 40);
      if (body.description !== undefined) meta.description = String(body.description).slice(0, 120);
      if (body.mode !== undefined) meta.mode = body.mode;
      if (body.palette) {
        // 只接受核心色键，白名单过滤
        const clean = (m) => {
          const out = {};
          for (const k of ['bg', 'surface', 'foreground', 'brand', 'sidebar', 'accent']) {
            if (typeof m[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(m[k])) out[k] = m[k];
          }
          return out;
        };
        meta.palette = {
          light: clean(body.palette.light || {}),
          dark: clean(body.palette.dark || {}),
        };
      }
      fs.writeFileSync(path.join(found.dir, 'skin.json'), JSON.stringify(meta, null, 2), 'utf8');
      log(`已更新用户皮肤：${id}`);
      // 正在应用该皮肤 → 实时重注入
      let updated = false;
      if (state.read().currentSkinId === id && runtime.session) {
        try {
          const { payload } = await prepareSkin(id, { background: state.read().background });
          attachPayload(payload);
          await runtime.session.evaluate(injector.buildInjectorScript(payload));
          updated = true;
        } catch (e) { log(`皮肤更新注入失败：${e.message}`); }
      }
      return sendJson(res, { ok: true, id, updated });
    }

    if (req.method === 'DELETE') {
      fs.rmSync(found.dir, { recursive: true, force: true });
      log(`已删除用户皮肤：${id}`);
      if (state.read().currentSkinId === id) {
        state.write({ currentSkinId: null });
        await restoreSkin();
      }
      return sendJson(res, { ok: true, id });
    }
  }

  // ---------- 通用皮肤删除/恢复（内置=隐藏，用户=物理删除） ----------
  const skinActionMatch = pathname.match(/^\/api\/skins\/([^/]+)(\/restore)?$/);
  if (skinActionMatch) {
    const id = decodeURIComponent(skinActionMatch[1]);
    const isRestore = !!skinActionMatch[2];
    let info = null;
    try { info = skinCompiler.readSkinJson(id); } catch { /* 不存在 */ }
    if (!info) return sendJson(res, { error: `皮肤不存在：${id}` }, 404);

    if (req.method === 'DELETE') {
      if (info.source === 'user') {
        // 用户皮肤：物理删除
        fs.rmSync(info.dir, { recursive: true, force: true });
        log(`已删除用户皮肤：${id}`);
        if (state.read().currentSkinId === id) {
          state.write({ currentSkinId: null });
          await restoreSkin();
        }
      } else if (info.meta && info.meta.auto) {
        // 自适应皮肤：功能项，不可删除/隐藏
        return sendJson(res, { error: '自适应皮肤为功能项，不可删除' }, 403);
      } else {
        // 内置皮肤：隐藏（不物理删除，可恢复）
        const st = state.read();
        const hidden = new Set(st.hiddenSkins || []);
        hidden.add(id);
        state.write({ hiddenSkins: [...hidden] });
        log(`已隐藏内置皮肤：${id}`);
        if (state.read().currentSkinId === id) {
          state.write({ currentSkinId: null });
          await restoreSkin();
        }
      }
      return sendJson(res, { ok: true, id });
    }

    if (req.method === 'POST' && isRestore) {
      const st = state.read();
      const hidden = new Set(st.hiddenSkins || []);
      hidden.delete(id);
      state.write({ hiddenSkins: [...hidden] });
      log(`已恢复皮肤：${id}`);
      return sendJson(res, { ok: true, id });
    }
  }

  // ---------- 文案替换 ----------

  if (pathname === '/api/textrules' && req.method === 'GET') {
    return sendJson(res, { textReplace: state.read().textReplace || [] });
  }

  if (pathname === '/api/textrules' && req.method === 'POST') {
    // 保存规则列表：[{ from, to }]
    const body = await readBody(req);
    const rules = Array.isArray(body.rules) ? body.rules : [];
    const clean = rules
      .filter((r) => r && typeof r.from === 'string' && r.from.trim())
      .map((r) => ({
        from: String(r.from).slice(0, 200),
        to: r.to != null ? String(r.to).slice(0, 200) : '',
      }))
      .slice(0, 50);
    state.write({ textReplace: clean });
    let updated = false;
    const skinId = state.read().currentSkinId;
    if (runtime.session && skinId) {
      try {
        const { payload } = await prepareSkin(skinId, { background: state.read().background });
        attachPayload(payload);
        await runtime.session.evaluate(injector.buildInjectorScript(payload));
        updated = true;
      } catch (e) { log(`文案替换应用失败：${e.message}`); }
    }
    return sendJson(res, { ok: true, updated, textReplace: clean });
  }

  // ---------- 字体库 ----------

  if (pathname === '/api/fonts' && req.method === 'GET') {
    return sendJson(res, { fonts: listFonts() });
  }

  if (pathname === '/api/fonts' && req.method === 'POST') {
    // 上传：{ dataUrl, fileName }
    const body = await readBody(req);
    if (!body.dataUrl || !body.fileName) return sendJson(res, { error: '缺少文件数据' }, 400);
    const ext = path.extname(String(body.fileName)).toLowerCase();
    if (!FONT_EXT[ext]) return sendJson(res, { error: '仅支持 woff2/woff/ttf/otf' }, 400);
    const safeName = path.basename(String(body.fileName)).replace(/[^a-zA-Z0-9._-]/g, '_');
    try {
      fs.mkdirSync(FONTS_DIR, { recursive: true });
      const buf = Buffer.from(String(body.dataUrl).split(',')[1], 'base64');
      const target = path.join(FONTS_DIR, safeName);
      if (fs.existsSync(target)) {
        // 同名文件已存在 → 加时间戳后缀
        fs.writeFileSync(path.join(FONTS_DIR, `${Date.now().toString(36)}-${safeName}`), buf);
      } else {
        fs.writeFileSync(target, buf);
      }
      log(`已上传字体：${safeName}`);
      return sendJson(res, { ok: true, fonts: listFonts() });
    } catch (e) {
      log(`字体保存失败：${e.message}`);
      return sendJson(res, { error: `保存失败：${e.message}` }, 500);
    }
  }

  // 应用字体设置：{ uiFont?, codeFont? }（家族 key 或文件名；null/空 表示恢复默认）
  if (pathname === '/api/fonts/apply' && req.method === 'POST') {
    const body = await readBody(req);
    const st = state.read();
    const resolve = (v) => {
      if (!v) return null;
      const f = resolveFontFile(String(v));
      return f || null;
    };
    const next = {
      fontFamily: body.uiFont !== undefined ? resolve(body.uiFont) : st.fontFamily,
      codeFontFamily: body.codeFont !== undefined ? resolve(body.codeFont) : st.codeFontFamily,
    };
    state.write(next);
    let updated = false;
    const skinId = state.read().currentSkinId;
    if (runtime.session && skinId) {
      try {
        const { payload } = await prepareSkin(skinId, { background: state.read().background });
        attachPayload(payload);
        await runtime.session.evaluate(injector.buildInjectorScript(payload));
        updated = true;
      } catch (e) { log(`字体应用失败：${e.message}`); }
    }
    return sendJson(res, { ok: true, updated, fonts: listFonts() });
  }

  const fontFileMatch = pathname.match(/^\/api\/fonts\/([^/]+)$/);
  if (fontFileMatch && req.method === 'GET') {
    // 字体静态服务：@font-face 跨源加载需要 CORS 头
    const fileName = decodeURIComponent(fontFileMatch[1]);
    if (!FONT_EXT[path.extname(fileName).toLowerCase()]) return sendJson(res, { error: '非法文件' }, 400);
    const file = path.join(FONTS_DIR, path.basename(fileName));
    if (!fs.existsSync(file)) return sendJson(res, { error: '字体不存在' }, 404);
    res.writeHead(200, {
      'Content-Type': {
        '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
      }[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=3600',
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (fontFileMatch && req.method === 'DELETE') {
    const fileName = decodeURIComponent(fontFileMatch[1]);
    const file = path.join(FONTS_DIR, path.basename(fileName));
    if (!fs.existsSync(file)) return sendJson(res, { error: '字体不存在' }, 404);
    fs.unlinkSync(file);
    log(`已删除字体：${fileName}`);
    // 若删除的是当前应用的字体 → 清除字体设置并重注入
    const st = state.read();
    const changed = st.fontFamily === fileName || st.codeFontFamily === fileName;
    if (changed) {
      state.write({
        fontFamily: st.fontFamily === fileName ? null : st.fontFamily,
        codeFontFamily: st.codeFontFamily === fileName ? null : st.codeFontFamily,
      });
      const skinId = state.read().currentSkinId;
      if (runtime.session && skinId) {
        try {
          const { payload } = await prepareSkin(skinId, { background: state.read().background });
          attachPayload(payload);
          await runtime.session.evaluate(injector.buildInjectorScript(payload));
        } catch (e) { log(`字体清除注入失败：${e.message}`); }
      }
    }
    return sendJson(res, { ok: true, fonts: listFonts() });
  }

  if (pathname === '/api/skin/open-folder') {
    execFile('explorer.exe', [skinCompiler.SKINS_DIR], { windowsHide: true }, () => {});
    return sendJson(res, { ok: true, dir: skinCompiler.SKINS_DIR });
  }

  return sendJson(res, { error: '未知接口' }, 404);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = u.pathname;
    try {
      if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
      return serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
    } catch (e) {
      log(`请求异常 ${req.url}：${e.message}`);
      if (!res.headersSent) sendJson(res, { error: e.message }, 500);
    }
  });
}

function openBrowser(url) {
  execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

// ---------- 启动 ----------

async function main() {
  migrateLegacyUploads();
  const detected = await detect.detectAll();
  runtime.exe = detected.exe;
  runtime.version = detected.version;
  runtime.zcodeRunning = detected.running;

  if (!runtime.exe) {
    log('!! 未找到 ZCode.exe，请在 ZCode 安装后重试（检测路径：D:\\Zcode、C:\\Program Files\\ZCode 等）');
  } else {
    log(`ZCode 安装：${runtime.exe}（版本 ${runtime.version || '未知'}）`);
    // 记录已知版本（自动更新修复的基准）
    const st0 = state.read();
    if (runtime.version && st0.lastKnownVersion !== runtime.version) {
      state.write({ lastKnownVersion: runtime.version });
    }
  }

  const st = state.read();
  // 先确定面板端口（背景图 URL 依赖它，需在 CDP 连接/注入之前就绪）
  const httpPort = await detect.findFreePort(PORT);
  runtime.httpPort = httpPort;

  if (runtime.zcodeRunning) {
    // ZCode 已在运行：探测它的 CDP 端口（配置端口优先，其次常见端口）
    const targets = await cdp.fetchTargets(st.port || 9335);
    if (targets.length) {
      runtime.port = st.port || 9335;
    } else {
      for (const p of [9229, 9335, 9341, 9342, 9350]) {
        if (p === st.port) continue;
        if ((await cdp.fetchTargets(p)).length) { runtime.port = p; break; }
      }
      if (!runtime.port) runtime.port = st.port || 9335;
    }
    log(`ZCode 正在运行，探测到 CDP 端口 :${runtime.port}`);
    const targets2 = await cdp.fetchTargets(runtime.port);
    if (targets2.length) {
      await connectToZCode().catch((e) => log(`连接异常：${e.message}`));
    }
  } else {
    // ZCode 未运行：找一个空闲端口作为后续启动的 CDP 端口
    runtime.port = await detect.findFreePort(st.port || 9335);
    if (runtime.port !== (st.port || 9335)) {
      state.write({ port: runtime.port });
      log(`CDP 端口 ${st.port} 被占用，改用 ${runtime.port}`);
    }
  }

  scheduleReconnect();

  // ZCode 关闭后自动退出（90 秒宽限）：兼顾"退出 ZCode = 退出美化后台"与
  // 用户退出后快速重启的场景（20 秒窗口内重启会被误杀）
  let zcodeGoneAt = null;
  const exitWatch = setInterval(async () => {
    try {
      const running = await detect.isZCodeRunning();
      if (!running) {
        if (!zcodeGoneAt) zcodeGoneAt = Date.now();
        else if (Date.now() - zcodeGoneAt > 90000) {
          log('ZCode 已退出，美化后台自动关闭');
          clearInterval(exitWatch);
          process.exit(0);
        }
      } else {
        zcodeGoneAt = null;
      }
    } catch { /* 忽略检测错误 */ }
  }, 5000);
  // 不阻止进程退出（若主流程提前结束）
  exitWatch.unref();

  runtime.httpServer = createServer();
  await new Promise((resolve, reject) => {
    runtime.httpServer.once('error', reject);
    runtime.httpServer.listen(httpPort, '127.0.0.1', resolve);
  });
  log(`控制面板：http://127.0.0.1:${httpPort}`);

  openBrowser(`http://127.0.0.1:${httpPort}`);
  log('ZCode Skin 守护进程运行中（Ctrl+C 退出）');
}

// 仅作为 CLI 直接运行时启动主流程
if (require.main === module) {
  main().catch((e) => {
    console.error('启动失败：', e.message);
    process.exit(1);
  });
}

module.exports = { main, applySkin, restoreSkin, setBackground, connectToZCode, log, attachPayload, attachFontCss, listFonts };
