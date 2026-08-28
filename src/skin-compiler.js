'use strict';
/**
 * skin-compiler.js — 皮肤包编译为 CDP 注入 payload
 *
 * 皮肤包结构（skins/<id>/ 或 ~/.zcode/skin/user-skins/<id>/）：
 *   skin.json         必选：{ id, name, description, mode, version, preview, background?, palette? }
 *   skin.css          可选：手写 CSS（palette 缺失时使用；palette 驱动则自动生成）
 *   background.*      可选：webp/jpg/jpeg/png/svg，作为壁纸
 *
 * 调色板（palette）驱动：皮肤只需定义 { light, dark } 两组核心色
 * （bg/surface/foreground/brand/sidebar/accent），其余变量由 generator 自动派生。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const generator = require('./generator');

const SKINS_DIR = path.join(__dirname, '..', 'skins');                    // 内置皮肤（只读）
const USER_SKINS_DIR = path.join(os.homedir(), '.zcode', 'skin', 'user-skins'); // 用户皮肤（CRUD）
const MAX_BG_BYTES = 16 * 1024 * 1024; // 16 MiB，对齐参考项目

/** 公共背景图层样式（compiler 自动附加到每个皮肤） */
const COMMON_BG_CSS = `
/* ---- zcode-skin 背景图层（由工具注入） ---- */
html.zcode-skin-bg, html.zcode-skin-bg body { background: transparent !important; }
/* ZCode 全屏壳抬升一层，壁纸层（z-index:0）保持在壳之下：负 z-index 在此页面会被根层叠上下文压掉 */
html.zcode-skin-bg body > div:first-child {
  position: relative;
  z-index: 1;
}
/* 壳内部再用 --color-background 的容器与壳背景双层叠加会几乎不透出壁纸，这里只留壳一层背景 */
html.zcode-skin-bg [class~="bg-background"] {
  background: transparent !important;
}
html.zcode-skin-bg body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 0;
  background-image: var(--zcode-skin-bg, none);
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(var(--zcode-skin-bg-blur, 0px));
  opacity: var(--zcode-skin-bg-visible, 0.5);
  pointer-events: none;
  transition: opacity .3s ease;
}
`;

/** 公共视觉细节增强（src/details.css，compiler 自动附加） */
const COMMON_DETAILS_CSS =
  '\n/* ---- zcode-skin 视觉细节增强 ---- */\n' +
  fs.readFileSync(path.join(__dirname, 'details.css'), 'utf8');

/** 轻量 CSS 压缩：去注释 + 去行首尾空白 + 压空行（皮肤 CSS 由本工具维护，无字符串内注释风险） */
function minifyCss(css) {
  return String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s+|\s+$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** 列出皮肤目录项：[{ dir, id, source: 'builtin'|'user' }] */
function listSkinDirs() {
  const out = [];
  const scan = (root, source) => {
    if (!fs.existsSync(root)) return;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'skin.json'))) {
        out.push({ dir: path.join(root, d.name), id: d.name, source });
      }
    }
  };
  scan(USER_SKINS_DIR, 'user');   // 用户皮肤优先（同名覆盖内置）
  scan(SKINS_DIR, 'builtin');
  return out;
}

function listSkinIds() {
  return listSkinDirs().map((d) => d.id);
}

function readSkinJson(id) {
  const found = listSkinDirs().find((d) => d.id === id);
  if (!found) throw new Error(`皮肤不存在：${id}`);
  const raw = JSON.parse(fs.readFileSync(path.join(found.dir, 'skin.json'), 'utf8'));
  return { dir: found.dir, id, meta: raw, source: found.source };
}

/** 找到皮肤的背景图文件，返回 { file, ext, dataUrl }（支持用户皮肤目录） */
function loadBackground(id) {
  const { dir } = readSkinJson(id);
  const candidates = ['webp', 'jpg', 'jpeg', 'png', 'gif', 'svg']
    .map((ext) => path.join(dir, `background.${ext}`))
    .filter((p) => fs.existsSync(p));
  if (!candidates.length) return null;
  const file = candidates[0];
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_BG_BYTES) {
    throw new Error(`背景图超过 16MiB 上限：${file}`);
  }
  const mime = {
    webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml',
  }[path.extname(file).slice(1).toLowerCase()] || 'image/png';
  return { file, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

/**
 * 编译皮肤为注入 payload
 * @param {string} id 皮肤 id
 * @param {object} [overrides] { background, palette? } — palette 覆盖 skin.json（auto 皮肤动态生成）
 */
function compileSkin(id, overrides) {
  const { dir, meta } = readSkinJson(id);
  const palette = (overrides && overrides.palette) || meta.palette;
  // palette 驱动 → generator 生成 CSS；否则读手写 skin.css
  let css;
  if (palette) {
    css = generator.buildCss(palette);
  } else {
    const cssFile = path.join(dir, meta.css || 'skin.css');
    if (!fs.existsSync(cssFile)) throw new Error(`皮肤 ${id} 缺少 CSS`);
    css = fs.readFileSync(cssFile, 'utf8');
  }
  css = minifyCss(css) + '\n' + COMMON_BG_CSS + '\n' + COMMON_DETAILS_CSS;

  // 背景与皮肤解耦：皮肤不带背景，背景图仅来自图库（overrides.background.fileName）
  let background = null;
  if (overrides && overrides.background && overrides.background.fileName) {
    background = {
      fileName: overrides.background.fileName,
      blur: overrides.background.blur || 0,
      opacity: overrides.background.opacity != null ? overrides.background.opacity : 0.45,
      enabled: true,
    };
  }

  const payload = {
    id,
    name: meta.name || id,
    mode: meta.mode || 'both',
    version: meta.version || 1,
    css,
    background,
  };
  return { payload, meta };
}

/** 皮肤列表（面板用）：含缩略色板、来源与可编辑性 */
function listSkins() {
  return listSkinDirs().map(({ id, source }) => {
    const { meta } = readSkinJson(id);
    const palette = meta.palette || null;
    // 缩略色板：优先取 palette 核心色（面板调色盘展示）
    const preview = meta.preview || (palette ? {
      colors: palette.light ? [palette.light.brand || '#3b82f6', palette.light.bg || '#f4f7fd', palette.light.surface || '#fff', palette.light.foreground || '#1e2a3a'] : null,
      darkColors: palette.dark ? [palette.dark.brand || '#5b8def', palette.dark.bg || '#0c1422', palette.dark.surface || '#131e31', palette.dark.foreground || '#e4eaf6'] : null,
    } : null);
    return {
      id,
      name: meta.name || id,
      description: meta.description || '',
      mode: meta.mode || 'both',
      version: meta.version || 1,
      auto: !!meta.auto, // 自适应皮肤（随背景图变色，不可编辑/删除）
      preview,
      source,            // 'builtin' | 'user'
      editable: source === 'user',          // 用户皮肤可改/可删
      palette,           // 调色板（面板编辑器用）
    };
  });
}

/** 用户皮肤目录中的皮肤 id 列表 */
function listUserSkinIds() {
  return listSkinDirs().filter((d) => d.source === 'user').map((d) => d.id);
}

module.exports = {
  SKINS_DIR, USER_SKINS_DIR, compileSkin, listSkins, listSkinIds,
  listSkinDirs, listUserSkinIds, minifyCss, loadBackground, readSkinJson,
};
