'use strict';
/**
 * generator.js — 调色板 → 皮肤 CSS 生成器
 *
 * 皮肤只需定义少量核心色（bg/surface/foreground/brand/sidebar/accent 等），
 * 其余 60+ 个 ZCode 变量全部自动派生（混色/明暗调整），保证任何自定义配色
 * 都生成结构完整、可读性可靠的皮肤 CSS。
 */

// ---------- 颜色工具 ----------

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 混色：mix(a, b, ratio) = a*(1-ratio) + b*ratio */
function mix(a, b, ratio) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex({
    r: ca.r * (1 - ratio) + cb.r * ratio,
    g: ca.g * (1 - ratio) + cb.g * ratio,
    b: ca.b * (1 - ratio) + cb.b * ratio,
  });
}

/** 亮度感知的明暗调整：调亮 = 向白混，调暗 = 向黑混 */
const lighten = (hex, ratio) => mix(hex, '#ffffff', ratio);
const darken = (hex, ratio) => mix(hex, '#000000', ratio);

/** 主题色透明度包装（深色模式更不透，浅色更透） */
const alpha = (hex, pct) => `color-mix(in srgb, ${hex} ${pct}%, transparent)`;

// ---------- 派生：核心色 → 完整变量集 ----------

const SEMANTIC = {
  destructive: '#ef6a63',
  warning: '#e5a33d',
  success: '#4fbd8d',
};

/** 由单一模式的核心色派生完整变量对象 */
function derive(mode, c) {
  const dark = mode === 'dark';
  const bg = c.bg || (dark ? '#0c1422' : '#f4f7fd');
  const surface = c.surface || (dark ? '#131e31' : '#ffffff');
  const foreground = c.foreground || (dark ? '#e4eaf6' : '#1e2a3a');
  const brand = c.brand || (dark ? '#5b8def' : '#3b82f6');
  const sidebar = c.sidebar || mix(bg, '#000000', dark ? 0.06 : 0.04);
  const accent = c.accent || mix(brand, '#ffffff', dark ? 0.22 : 0.12);
  const primary = mix(brand, '#000000', dark ? 0.1 : 0.08);
  const foregroundSubtle = mix(foreground, bg, dark ? 0.42 : 0.38);
  const foregroundSubtlest = mix(foreground, bg, dark ? 0.66 : 0.62);

  return {
    // 背景层（透明系）
    '--color-background': alpha(bg, dark ? 65 : 70),
    '--color-background-alt': alpha(mix(bg, '#000000', 0.03), dark ? 62 : 70),
    '--color-background-win-alt': alpha(sidebar, dark ? 78 : 70),
    // 表面/文字
    '--color-surface': surface,
    '--color-surface-hover': mix(surface, '#ffffff', dark ? 0.09 : 0.035),
    '--color-foreground': foreground,
    '--color-foreground-subtle': foregroundSubtle,
    '--color-foreground-subtlest': foregroundSubtlest,
    '--color-foreground-inverse': dark ? bg : '#ffffff',
    // 边框
    '--color-border': mix(foreground, bg, dark ? 0.82 : 0.84),
    '--color-border-hover': mix(foreground, bg, dark ? 0.72 : 0.74),
    // 卡片
    '--color-card': surface,
    '--color-card-selected': mix(surface, brand, dark ? 0.16 : 0.1),
    '--color-card-border': mix(foreground, bg, dark ? 0.82 : 0.84),
    '--color-header': dark ? mix(bg, '#000000', 0.08) : mix(surface, '#ffffff', 0.6),
    // 交互
    '--color-hover': mix(bg, brand, dark ? 0.1 : 0.06),
    '--color-selected': mix(bg, brand, dark ? 0.22 : 0.14),
    // 输入（微微透明，露出壁纸；全局统一 75%）
    '--color-input': alpha(mix(surface, '#ffffff', dark ? 0.02 : 0), 75),
    '--color-input-focused': alpha(mix(surface, '#ffffff', dark ? 0.02 : 0), 75),
    '--color-input-border': mix(foreground, bg, dark ? 0.82 : 0.84),
    '--color-input-border-hover': mix(foreground, bg, dark ? 0.72 : 0.74),
    '--color-input-border-focused': accent,
    // 语义色
    '--color-destructive': SEMANTIC.destructive,
    '--color-destructive-foreground': '#ffffff',
    '--color-warning': SEMANTIC.warning,
    '--color-warning-foreground': dark ? bg : '#ffffff',
    '--color-success': SEMANTIC.success,
    '--color-success-foreground': dark ? bg : '#ffffff',
    '--color-markdown-inline-code': mix(brand, bg, dark ? 0.92 : 0.9),
    // 品牌
    '--color-brand': brand,
    '--color-primary': primary,
    '--color-primary-foreground': '#ffffff',
    '--color-accent': accent,
    // 结构区域
    '--color-sidebar': alpha(sidebar, dark ? 86 : 80),
    '--color-panel': surface,
    '--color-tab': surface,
    '--color-tab-active': sidebar,
    '--color-tab-border': mix(foreground, bg, dark ? 0.82 : 0.84),
    '--color-menu': sidebar,
    '--color-menu-hover': mix(sidebar, '#ffffff', dark ? 0.1 : 0.04),
    '--color-secondary': mix(sidebar, '#ffffff', dark ? 0.1 : 0.04),
    '--color-tag': mix(sidebar, '#ffffff', dark ? 0.1 : 0.04),
    '--color-popover': sidebar,
    '--color-popover-header': surface,
    '--color-popover-border': mix(foreground, bg, dark ? 0.82 : 0.84),
    '--color-popover-foreground': foreground,
    '--color-toast': sidebar,
    '--color-tooltip': foreground,
    '--color-tooltip-foreground': bg,
    '--color-tooltip-tag': primary,
    '--color-tooltip-tag-foreground': '#ffffff',
    // 终端
    '--color-terminal-bg': alpha(bg, dark ? 65 : 70),
    '--color-terminal-fg': foreground,
    '--color-terminal-black': sidebar,
    '--color-terminal-bright-black': foregroundSubtlest,
    '--color-terminal-red': SEMANTIC.destructive,
    '--color-terminal-bright-red': lighten(SEMANTIC.destructive, 0.14),
    '--color-terminal-green': SEMANTIC.success,
    '--color-terminal-bright-green': lighten(SEMANTIC.success, 0.14),
    '--color-terminal-yellow': SEMANTIC.warning,
    '--color-terminal-bright-yellow': lighten(SEMANTIC.warning, 0.12),
    '--color-terminal-blue': brand,
    '--color-terminal-bright-blue': accent,
    '--color-terminal-magenta': mix(brand, '#a888f2', 0.5),
    '--color-terminal-bright-magenta': lighten(mix(brand, '#a888f2', 0.5), 0.12),
    '--color-terminal-cyan': mix(accent, '#42c8c8', 0.55),
    '--color-terminal-bright-cyan': lighten(mix(accent, '#42c8c8', 0.55), 0.12),
    '--color-terminal-white': mix(foreground, '#ffffff', 0.25),
    '--color-terminal-bright-white': '#f8f8f8',
    '--color-terminal-cursor': foreground,
    '--color-terminal-cursor-accent': bg,
    '--color-terminal-selection': `${brand}47`,
    '--color-terminal-selection-inactive': '#ffffff1a',
    // 交互卡片
    '--color-interaction-ask-surface': mix(bg, brand, dark ? 0.22 : 0.1),
    '--color-interaction-ask-fill': `${brand}3d`,
    '--color-interaction-ask-foreground': accent,
    '--color-interaction-confirmation-surface': `${SEMANTIC.success}29`,
    '--color-interaction-confirmation-foreground': lighten(SEMANTIC.success, 0.15),
    '--color-idle-task': mix(brand, '#7c6cf0', 0.5),
    '--color-idle-task-surface': mix(bg, '#7c6cf0', dark ? 0.24 : 0.08),
  };
}

/** 生成一个模式的 CSS 块 */
function modeBlock(selector, vars) {
  const lines = Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n');
  return `${selector} {\n${lines}\n}`;
}

/**
 * 调色板 → 完整皮肤 CSS
 * @param {object} palette { light: {...}, dark: {...} }
 */
function buildCss(palette) {
  const light = derive('light', palette.light || {});
  const dark = derive('dark', palette.dark || {});
  return [
    '/* ============================================================',
    '   zcode-skin 生成皮肤（调色板驱动，勿手工编辑此文件）',
    '   ============================================================ */',
    '',
    '/* ---------- 浅色模式 ---------- */',
    modeBlock('html.theme-zai-light,\nhtml:not(.dark):not(.theme-zai-dark)', light),
    '',
    modeBlock('html.theme-zai-light', {
      '--color-brand': light['--color-brand'],
      '--color-accent': light['--color-accent'],
      '--color-primary': light['--color-primary'],
    }),
    '',
    '/* ---------- 深色模式 ---------- */',
    modeBlock('html.theme-zai-dark,\nhtml.dark', dark),
    '',
    modeBlock('html.theme-zai-dark', {
      '--color-brand': dark['--color-brand'],
      '--color-accent': dark['--color-accent'],
      '--color-primary': dark['--color-primary'],
    }),
    '',
  ].join('\n');
}

/** 从现有 skin.json 读取调色板（缺失时补默认） */
function paletteOf(meta) {
  return meta.palette || { light: {}, dark: {} };
}

module.exports = { buildCss, derive, mix, lighten, darken, hexToRgb, paletteOf };
