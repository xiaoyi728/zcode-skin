'use strict';
/**
 * state.js — 工具状态持久化（~/.zcode/skin/state.json）
 * 只记录皮肤工具自身的状态，不触碰 ZCode 官方设置键（避免云同步污染）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILE = path.join(os.homedir(), '.zcode', 'skin', 'state.json');

const DEFAULTS = {
  port: 9335,
  currentSkinId: null,
  // background: { dataUrl, fileName, blur, opacity, enabled } — 自定背景图；null = 无自定义
  background: null,
  // 被隐藏的内置皮肤 id 列表（删除内置皮肤 = 隐藏，可恢复）
  hiddenSkins: [],
  // 字体（字体库文件名；null = 默认系统字体）
  fontFamily: null,
  codeFontFamily: null,
  // 文案替换规则：[{ from, to }] — 渲染端精确匹配替换文本/placeholder
  textReplace: [],
  // 上次检测到的 ZCode 版本（自动更新修复用）
  lastKnownVersion: null,
};

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const bg = raw.background;
    return {
      ...DEFAULTS,
      ...raw,
      background: bg == null ? null : { ...(DEFAULTS.background || {}), ...bg },
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  // background 语义：patch 传入的是完整新值（调用方已自行合并），直接替换；
  // null 表示显式清空。避免旧字段（如 fileName）被合并回来。
  if (patch.background !== undefined) {
    next.background = patch.background;
  }
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { read, write, STATE_FILE };
