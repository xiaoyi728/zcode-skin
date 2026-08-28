'use strict';
/**
 * cdp.js — 本地 CDP 客户端（零依赖，Node 22 内置 WebSocket）
 *
 * 流程：
 *   1. discover(port) — GET http://127.0.0.1:<port>/json/list 找 ZCode 渲染目标
 *   2. CdpSession.connect(wsUrl) — 校验回环地址后建立 WebSocket
 *   3. evaluate() — Runtime.evaluate 注入/更新皮肤
 *
 * 安全：只接受 127.0.0.1 / localhost / [::1] 的 WebSocket 地址；
 *       目标页面需通过 ZCode 特征探测，避免误注入其他窗口。
 */

const ZCODE_PAGE_HINTS = ['app://', 'zcode://', '/index.html', 'localhost', '127.0.0.1'];

function isLoopbackWsUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** 读取 CDP 端点 /json/list，失败返回空数组 */
async function fetchTargets(port, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

/** 从 targets 中挑选最可能是 ZCode 渲染页面的目标 */
function pickZCodeTarget(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) return null;
  const score = (t) => {
    const url = String(t.url || '').toLowerCase();
    let s = 0;
    if (url.startsWith('app://')) s += 100;
    if (url.includes('zcode')) s += 50;
    if (url.includes('index.html')) s += 10;
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) s += 10;
    if (t.title && /zcode/i.test(t.title)) s += 30;
    return s;
  };
  const sorted = [...pages].sort((a, b) => score(b) - score(a));
  return sorted[0];
}

/**
 * CDP 会话：包装 WebSocket，消息 ID 跟踪 + 超时。
 */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this._handlers = new Map(); // 事件名 → Set<cb>
    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.reject(new Error('CDP WebSocket 错误'));
      this.pending.clear();
    });
  }

  /** 订阅 CDP 事件（如 Page.frameNavigated） */
  on(event, cb) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(cb);
    return cb;
  }

  off(event, cb) {
    this._handlers.get(event)?.delete(cb);
  }

  _emit(event, params) {
    this._handlers.get(event)?.forEach((cb) => {
      try { cb(params); } catch (e) { /* 事件回调异常忽略 */ }
    });
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    if (!isLoopbackWsUrl(wsUrl)) {
      throw new Error(`拒绝连接非回环 CDP 地址：${wsUrl}`);
    }
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new CdpSession(ws);
  }

  _onMessage(data) {
    let msg;
    if (typeof data === 'string') {
      msg = JSON.parse(data);
    } else if (data && typeof data.text === 'function') {
      // Blob 帧（Node 22 WebSocket 可能以 Blob 投递）
      data.text().then((t) => this._onMessage(t));
      return;
    } else if (data instanceof ArrayBuffer) {
      msg = JSON.parse(Buffer.from(data).toString('utf8'));
    } else {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP ${msg.error.code || ''}: ${msg.error.message || '未知错误'}`));
      else p.resolve(msg.result);
    } else if (msg.method) {
      // 事件通知（无 id）：如 Page.frameNavigated
      this._emit(msg.method, msg.params || {});
    }
  }

  send(method, params = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('CDP 会话已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runtime.evaluate 快捷方式（返回 value 或抛错） */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 10000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }, timeoutMs);
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || '表达式异常';
      throw new Error(`渲染进程执行失败：${detail}`);
    }
    return res.result?.value;
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* noop */ }
  }
}

/**
 * 等待 ZCode 渲染目标出现（轮询 /json/list）。
 * resolve(null) 表示超时仍未发现。
 */
async function waitForZCodeTarget(port, { timeoutMs = 60000, intervalMs = 1500, onProbe } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchTargets(port);
    const candidate = pickZCodeTarget(targets);
    if (candidate) {
      if (typeof onProbe === 'function') {
        const ok = await onProbe(candidate);
        if (ok) return candidate;
      } else {
        return candidate;
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * 探测目标页面是否为 ZCode（只读检查渲染页 DOM 特征），
 * 返回 true 表示确认是 ZCode 页面。
 */
async function probeZCodePage(session) {
  try {
    const found = await session.evaluate(`(() => {
      const html = document.documentElement;
      const hasThemeClass =
        html.classList.contains('theme-zai-dark') ||
        html.classList.contains('theme-zai-light') ||
        html.classList.contains('dark');
      const hasZcodeMark = !!document.querySelector('[data-zcode], [data-zcode-app]');
      const hasInput = !!document.querySelector('[contenteditable="true"], textarea[data-slate-editor]');
      return { hasThemeClass, hasZcodeMark, hasInput, bodyChildren: document.body ? document.body.children.length : 0 };
    })()`, { timeoutMs: 5000 });
    const v = found || {};
    return !!(v.hasThemeClass || v.hasZcodeMark || (v.bodyChildren > 5 && v.hasInput));
  } catch {
    return false;
  }
}

module.exports = {
  CdpSession,
  fetchTargets,
  pickZCodeTarget,
  waitForZCodeTarget,
  probeZCodePage,
  isLoopbackWsUrl,
  ZCODE_PAGE_HINTS,
};
