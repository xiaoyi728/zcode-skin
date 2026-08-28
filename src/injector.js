'use strict';
/**
 * injector.js — 渲染端注入脚本模板
 *
 * 通过 CDP Runtime.evaluate 在 ZCode 渲染进程中执行：
 *  - 创建 <style id="zcode-skin-style"> 注入皮肤 CSS
 *  - 背景图经 fetch → Blob → createObjectURL 绕过 CSP，写入 --zcode-skin-bg 变量
 *  - MutationObserver(180ms 防抖) + 5s 定时器保活，应对 SPA 路由/重渲染
 *  - 全局状态 __ZCODE_SKIN_STATE__ 防重复注入；update() 实时换肤；cleanup() 一键还原
 */

function _rendererMain(payload) {
  const NS = '__ZCODE_SKIN_STATE__';
  const VERSION = 7; // v7：文案替换支持 aria-placeholder 属性
  const doc = document;
  const root = doc.documentElement;
  const STYLE_ID = 'zcode-skin-style';

  const mkStyle = () => {
    let el = doc.getElementById(STYLE_ID);
    if (!el) {
      el = doc.createElement('style');
      el.id = STYLE_ID;
      (doc.head || root).appendChild(el);
    }
    return el;
  };

  // ---------- 文案替换引擎 ----------
  // rules: [{ from, to }] — 文本节点/placeholder 完全匹配才替换，避免误伤
  const replaceNodeText = (node, rules) => {
    if (!node || node.nodeType !== 3) return;
    const v = node.nodeValue;
    if (!v || !v.trim()) return;
    for (const r of rules) {
      if (r.from && v === r.from) {
        node.nodeValue = r.to != null ? r.to : '';
        return;
      }
    }
  };
  const replacePlaceholder = (el, rules) => {
    if (!el || el.nodeType !== 1) return;
    for (const r of rules) {
      if (!r.from) continue;
      // placeholder / aria-placeholder 属性精确匹配
      for (const attr of ['placeholder', 'aria-placeholder']) {
        const cur = el.getAttribute && el.getAttribute(attr);
        if (cur === r.from) {
          el.setAttribute(attr, r.to != null ? r.to : '');
          return;
        }
      }
    }
  };
  const applyTextReplace = (rules) => {
    if (!rules || !rules.length) return;
    // 文本节点
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    let n;
    const replaced = [];
    while ((n = walker.nextNode())) {
      const before = n.nodeValue;
      replaceNodeText(n, rules);
      if (n.nodeValue !== before) replaced.push(n);
    }
    // placeholder 属性（含 aria-placeholder）
    const inputs = doc.querySelectorAll('[placeholder], [aria-placeholder]');
    inputs.forEach((el) => replacePlaceholder(el, rules));
    return replaced.length;
  };

  // 文案替换保活：内容区变化时重新扫描
  let trObserver = null;
  let trTimer = null;
  const startTextReplace = (rules) => {
    if (trObserver) trObserver.disconnect();
    if (!rules || !rules.length) return;
    applyTextReplace(rules);
    try {
      trObserver = new MutationObserver(() => {
        clearTimeout(trTimer);
        trTimer = setTimeout(() => applyTextReplace(rules), 300);
      });
      trObserver.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'aria-placeholder'] });
    } catch { trObserver = null; }
  };

  // ---------- 主体 ----------
  const applyBg = (bg) => {
    if (!bg || (!bg.url && !bg.dataUrl)) {
      root.classList.remove('zcode-skin-bg');
      root.style.removeProperty('--zcode-skin-bg');
      root.style.removeProperty('--zcode-skin-bg-blur');
      root.style.removeProperty('--zcode-skin-bg-visible');
      return;
    }
    root.classList.add('zcode-skin-bg');
    root.style.setProperty('--zcode-skin-bg-blur', String(bg.blur || 0) + 'px');
    root.style.setProperty('--zcode-skin-bg-visible', String(bg.opacity != null ? bg.opacity : 0.5));
    // 优先使用守护进程提供的 HTTP URL（稳定、页面刷新不失效）；
    // 兜底使用 data URL（file:// 页面下 blob:file:// 不可加载，不用 blob）
    const src = bg.url || bg.dataUrl;
    if (src) {
      root.style.setProperty('--zcode-skin-bg', 'url(' + JSON.stringify(src) + ')');
    }
  };

  // 已注入过且版本一致 → 复用实例，直接更新（实时换肤）
  if (window[NS] && window[NS].version === VERSION && typeof window[NS].update === 'function') {
    const r = window[NS].update(payload);
    return { ok: true, reused: true, r };
  }  // 存在旧版本实例 → 先清理，避免状态残留
  if (window[NS] && typeof window[NS].cleanup === 'function') {
    try { window[NS].cleanup(); } catch { /* 忽略清理异常 */ }
  }

  mkStyle().textContent = payload.css || '';
  applyBg(payload.background);

  let observer = null;
  let debounceTimer = null;
  let cleanupDone = false;

  const ensure = () => {
    if (cleanupDone) return;
    const el = doc.getElementById(STYLE_ID);
    if (!el || !el.isConnected) {
      mkStyle().textContent = payload.css || '';
      applyBg(payload.background);
    }
  };

  try {
    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(ensure, 180);
    });
    observer.observe(doc.head || root, { childList: true, subtree: false });
  } catch (e) {
    observer = null;
  }
  const interval = setInterval(ensure, 5000);

  const cleanup = () => {
    cleanupDone = true;
    if (observer) observer.disconnect();
    if (trObserver) trObserver.disconnect();
    clearInterval(interval);
    clearTimeout(debounceTimer);
    clearTimeout(trTimer);
    const el = doc.getElementById(STYLE_ID);
    if (el) el.remove();
    root.classList.remove('zcode-skin-bg');
    root.style.removeProperty('--zcode-skin-bg');
    root.style.removeProperty('--zcode-skin-bg-blur');
    root.style.removeProperty('--zcode-skin-bg-visible');
    delete window[NS];
  };

  // 启动文案替换（含 placeholder）
  startTextReplace(payload.textReplace);

  window[NS] = {
    version: VERSION,
    update(p) {
      const el = doc.getElementById(STYLE_ID);
      if (el) el.textContent = p.css || '';
      applyBg(p.background);
      startTextReplace(p.textReplace);
      payload = p;
      window[NS].payload = p; // 同步公开状态（buildStatusScript 依赖）
      return { ok: true };
    },
    cleanup,
    payload,
  };
  return { ok: true, applied: true };
}

/** 构建注入表达式：自执行函数 + JSON 载荷 */
function buildInjectorScript(payload) {
  return `(${_rendererMain.toString()})(${JSON.stringify(payload)})`;
}

/** 构建清理表达式：调用渲染端 cleanup() */
function buildCleanupScript() {
  return `(() => {
    const s = window.__ZCODE_SKIN_STATE__;
    if (s && typeof s.cleanup === 'function') { s.cleanup(); return { ok: true }; }
    return { ok: false, reason: 'not-injected' };
  })()`;
}

/** 构建探针：读取当前注入状态（面板展示用） */
function buildStatusScript() {
  return `(() => {
    const s = window.__ZCODE_SKIN_STATE__;
    return {
      injected: !!(s && s.payload),
      skinId: s && s.payload ? s.payload.id : null,
      theme: document.documentElement.classList.contains('theme-zai-dark') ? 'dark' : 'light',
      bgEnabled: document.documentElement.classList.contains('zcode-skin-bg'),
    };
  })()`;
}

module.exports = { buildInjectorScript, buildCleanupScript, buildStatusScript };
