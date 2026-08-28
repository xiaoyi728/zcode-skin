/* ============================================================
   ZCode Skin 控制面板逻辑
   ============================================================ */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const state = {
    status: null,
    bgTimer: null,
    lastBgOpacity: 0.45, // 关闭壁纸前的透明度，重新开启时恢复
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // ---------- 状态轮询 ----------
  function setChip(el, label, kind) {
    el.className = `status-chip ${kind || ''}`;
    el.querySelector('.chip-text').textContent = label;
  }

  async function refreshStatus() {
    try {
      const s = await api('/api/status');
      state.status = s;
      setChip($('#chip-zcode'),
        s.zcodeRunning ? (s.connected ? 'ZCode 运行中 · 已连接' : 'ZCode 运行中 · 等待连接') : 'ZCode 未运行',
        s.zcodeRunning ? (s.connected ? 'ok' : 'warn') : 'err');
      setChip($('#chip-cdp'), s.connected ? `CDP 已连接 · :${s.cdpPort}` : 'CDP 未连接', s.connected ? 'ok' : 'warn');
      $('#chip-version').textContent = s.version ? `版本 ${s.version}` : '版本 —';
      renderSkins(s.skins || []);
      renderCurrent(s);
      updateBgControls(s);
      renderWallpapers(); // 刷新图库"使用中"标记
      renderFonts(s);     // 刷新字体下拉与列表
      renderTextRules(s); // 刷新文案替换规则
    } catch (e) {
      setChip($('#chip-zcode'), '面板服务异常', 'err');
    }
  }

  // ---------- 皮肤画廊 ----------
  const CORE_COLORS = [
    ['bg', '背景色'], ['surface', '表面色'], ['foreground', '文字色'],
    ['brand', '品牌色'], ['sidebar', '侧边栏'], ['accent', '强调色'],
  ];
  const PRESETS = ['#3b82f6', '#7c6cf0', '#e8769a', '#4c9e72', '#f08a4b', '#22b8a5', '#e5484d', '#5b6b7d', '#8fa3b8', '#f2a900'];

  function renderSkins(skins) {
    const grid = $('#skin-grid');
    const cur = state.status && state.status.currentSkinId;
    // 自适应皮肤（功能项）永远置顶
    const visible = skins.filter((s) => !s.hidden).sort((a, b) => (b.auto ? 1 : 0) - (a.auto ? 1 : 0));
    const hidden = skins.filter((s) => s.hidden);
    grid.innerHTML = visible.map((s) => {
      const pal = s.palette && (s.palette.dark || s.palette.light) || {};
      const swatches = [pal.brand || '#666', pal.bg || '#555', pal.surface || '#777', pal.foreground || '#aaa']
        .map((c) => `<div class="sw" style="background:${c}"></div>`).join('');
      const badges = [
        s.auto ? '<span class="badge auto">自适应</span>' : '',
        s.mode === 'dark' ? '<span class="badge">深色</span>' : s.mode === 'light' ? '<span class="badge">浅色</span>' : '<span class="badge">双模式</span>',
        s.id === cur ? '<span class="badge current">当前</span>' : '',
        s.source === 'user' ? '<span class="badge user">自定义</span>' : '',
      ].join('');
      // 自适应皮肤是功能项：仅可应用，不可复制/编辑/删除
      const actions = s.auto
        ? `<button class="icon-btn apply" title="应用" data-act="apply">✓</button>`
        : `
        ${s.source === 'user' ? '<button class="icon-btn" title="编辑调色盘" data-act="edit">✎</button>' : '<button class="icon-btn" title="复制为自定义皮肤" data-act="copy">⧉</button>'}
        <button class="icon-btn danger" title="删除（内置=隐藏，可恢复）" data-act="del">🗑</button>
        <button class="icon-btn apply" title="应用" data-act="apply">✓</button>`;
      return `
      <div class="skin-card ${s.id === cur ? 'active' : ''}" data-id="${s.id}">
        <div class="skin-swatch">${swatches}</div>
        <div class="skin-body">
          <div class="skin-name">${esc(s.name)}</div>
          <div class="skin-desc">${esc(s.description || '')}</div>
          <div class="skin-meta">
            ${badges}
            <div class="skin-actions">${actions}</div>
          </div>
        </div>
      </div>`;
    }).join('');

    // 已隐藏区
    if (hidden.length) {
      grid.insertAdjacentHTML('beforeend', `<div class="hidden-zone">
        <div class="hidden-title">已隐藏（${hidden.length}）</div>
        ${hidden.map((s) => `
          <div class="skin-card hidden-card" data-id="${s.id}">
            <div class="skin-body">
              <div class="skin-name">${esc(s.name)} <span class="badge">已隐藏</span></div>
              <div class="skin-meta">
                <div class="skin-actions">
                  <button class="icon-btn" title="恢复显示" data-act="unhide">⤴</button>
                </div>
              </div>
            </div>
          </div>`).join('')}
      </div>`);
    }

    $$('.skin-card').forEach((card) => {
      card.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-act]');
        if (act) {
          ev.stopPropagation();
          const id = card.dataset.id;
          if (act.dataset.act === 'apply') applySkin(id);
          else if (act.dataset.act === 'edit') openEditor(id);
          else if (act.dataset.act === 'copy') openEditor(id, true);
          else if (act.dataset.act === 'del') deleteSkin(id);
          else if (act.dataset.act === 'unhide') unhideSkin(id);
        } else if (!card.classList.contains('hidden-card')) {
          applySkin(card.dataset.id);
        }
      });
    });
    $('#skin-count').textContent = `${visible.length} 套皮肤${hidden.length ? `（+${hidden.length} 已隐藏）` : ''}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- 动作 ----------
  async function applySkin(id) {
    try {
      const r = await api('/api/skin/apply', { method: 'POST', body: { id } });
      if (!r.applied) toast(`皮肤已保存：${r.reason || '稍后自动生效'}`, 'warn');
      else toast(`已应用「${skinsName(id)}」`, 'ok');
      refreshStatus();
    } catch (e) {
      toast(`应用失败：${e.message}`, 'err');
    }
  }

  function skinsName(id) {
    const s = (state.status && state.status.skins || []).find((x) => x.id === id);
    return s ? s.name : id;
  }

  function renderCurrent(s) {
    const name = $('#current-name');
    const desc = $('#current-desc');
    const btn = $('#btn-restore');
    $('#chip-skin-name').textContent = s.currentSkinId ? (s.skins.find((x) => x.id === s.currentSkinId)?.name || s.currentSkinId) : '官方默认';
    if (s.currentSkinId) {
      const skin = (s.skins || []).find((x) => x.id === s.currentSkinId);
      name.textContent = skin ? skin.name : s.currentSkinId;
      desc.textContent = skin ? skin.description : '自定义皮肤';
      btn.disabled = false;
    } else {
      name.textContent = '官方默认';
      desc.textContent = '未应用任何皮肤，ZCode 保持官方外观。';
      btn.disabled = true;
    }
  }

  function updateBgControls(s) {
    const bg = s.background;
    const enable = $('#bg-enable');
    const hasSkin = !!s.currentSkinId;
    // 开关 = 壁纸显隐（无自定义背景时皮肤自带壁纸默认开启）
    enable.checked = bg ? bg.enabled !== false : true;
    $('#bg-blur').value = bg && bg.blur != null ? bg.blur : 0;
    $('#bg-opacity').value = bg && bg.opacity != null ? Math.round(bg.opacity * 100) : 45;
    $('#bg-blur-val').textContent = `${$('#bg-blur').value}px`;
    $('#bg-opacity-val').textContent = `${$('#bg-opacity').value}%`;
    $('#bg-controls').classList.toggle('disabled', !hasSkin);
  }

  // ---------- 背景图库 ----------
  const wpState = { list: [] };

  async function refreshWallpapers() {
    try {
      const d = await api('/api/wallpapers');
      wpState.list = d.wallpapers || [];
      renderWallpapers();
    } catch { /* 静默 */ }
  }

  function renderWallpapers() {
    const grid = $('#wp-grid');
    const curFile = state.status && state.status.background ? state.status.background.fileName : null;
    if (!wpState.list.length) {
      grid.innerHTML = '<div class="wp-empty">还没有背景图，点击下方「上传背景图」添加</div>';
      return;
    }
    grid.innerHTML = wpState.list.map((w) => `
      <div class="wp-item ${w.fileName === curFile ? 'active' : ''}" data-file="${esc(w.fileName)}" title="${esc(w.fileName)}">
        <img src="/api/skin/background-image?file=${encodeURIComponent(w.fileName)}" loading="lazy" alt="">
        ${w.fileName === curFile ? '<span class="wp-cur">使用中</span>' : ''}
        <button class="wp-del" title="删除">✕</button>
      </div>`).join('');
    $$('.wp-item').forEach((item) => {
      item.addEventListener('click', (ev) => {
        if (ev.target.classList.contains('wp-del')) {
          ev.stopPropagation();
          deleteWallpaper(item.dataset.file);
          return;
        }
        useWallpaper(item.dataset.file);
      });
    });
  }

  async function useWallpaper(fileName) {
    try {
      const r = await api('/api/background', { method: 'POST', body: { fileName } });
      toast('背景已应用', 'ok');
      refreshStatus();
      if (!r.updated) toast('ZCode 未连接，背景将在下次连接后应用', 'warn');
    } catch (e) { toast(`应用失败：${e.message}`, 'err'); }
  }

  async function deleteWallpaper(fileName) {
    if (!confirm(`确定删除这张背景图？`)) return;
    try {
      await api(`/api/wallpapers/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
      toast('已删除', 'ok');
      refreshWallpapers();
      refreshStatus();
    } catch (e) { toast(`删除失败：${e.message}`, 'err'); }
  }

  async function pushBackground(patch) {
    try {
      const r = await api('/api/background', { method: 'POST', body: patch });
      if (r.updated) toast('背景已实时更新', 'ok');
      refreshStatus();
    } catch (e) {
      toast(`背景更新失败：${e.message}`, 'err');
    }
  }

  // ---------- 日志 ----------
  async function refreshLogs() {
    try {
      const d = await api('/api/logs');
      const box = $('#logs');
      if (!d.logs || !d.logs.length) {
        box.innerHTML = '<div class="log-empty">暂无日志</div>';
        return;
      }
      const last = d.logs[d.logs.length - 1];
      if (box.dataset.last === last) return;
      box.dataset.last = last;
      box.innerHTML = d.logs.map((l) => `<div class="line">${esc(l)}</div>`).join('');
      box.scrollTop = box.scrollHeight;
    } catch { /* 静默 */ }
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText = 'position:fixed;bottom:26px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:10px;font-size:13px;background:#161930;border:1px solid #34396b;box-shadow:0 8px 30px rgba(0,0,0,.5);z-index:99;transition:opacity .25s;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.borderColor = kind === 'err' ? '#f0656a' : kind === 'warn' ? '#eab355' : '#55c79a';
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2600);
  }

  // ---------- 事件绑定 ----------
  $('#btn-restore').addEventListener('click', async () => {
    try {
      await api('/api/skin/restore', { method: 'POST' });
      toast('已还原官方外观', 'ok');
      refreshStatus();
    } catch (e) { toast(`还原失败：${e.message}`, 'err'); }
  });

  $('#btn-launch').addEventListener('click', async () => {
    const btn = $('#btn-launch');
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⟳</span> 正在启动…';
    try {
      const r = await api('/api/zcode/launch', { method: 'POST' });
      toast(`ZCode 已以注入模式启动（端口 ${r.port}），皮肤将自动应用`, 'ok');
      setTimeout(() => btn.innerHTML = '<span class="btn-icon">▶</span> 启动 / 重启 ZCode（注入模式）', 1500);
    } catch (e) {
      toast(e.message, 'err');
      btn.innerHTML = '<span class="btn-icon">▶</span> 启动 / 重启 ZCode（注入模式）';
    }
    btn.disabled = false;
  });

  $('#btn-devtools').addEventListener('click', async () => {
    try {
      const r = await api('/api/zcode/devtools');
      if (r.url) window.open(r.url, '_blank');
      else toast('未连接 ZCode', 'warn');
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#btn-folder').addEventListener('click', () => api('/api/skin/open-folder', { method: 'POST' }).catch(() => {}));

  $('#bg-enable').addEventListener('change', (ev) => {
    if (!ev.target.checked) {
      // 关闭壁纸：记住当前透明度，仅隐藏（不删自定义图）
      state.lastBgOpacity = Number($('#bg-opacity').value) / 100 || 0.45;
      pushBackground({ opacity: 0 });
    } else {
      // 重新开启：恢复之前的透明度（自定义图或皮肤自带壁纸都会重新显示）
      pushBackground({ opacity: state.lastBgOpacity });
    }
  });

  function scheduleBgPush() {
    clearTimeout(state.bgTimer);
    state.bgTimer = setTimeout(() => {
      pushBackground({ blur: $('#bg-blur').value, opacity: $('#bg-opacity').value / 100 });
    }, 250);
  }
  $('#bg-blur').addEventListener('input', () => {
    $('#bg-blur-val').textContent = `${$('#bg-blur').value}px`;
    scheduleBgPush();
  });
  $('#bg-opacity').addEventListener('input', () => {
    $('#bg-opacity-val').textContent = `${$('#bg-opacity').value}%`;
    scheduleBgPush();
  });

  // ---------- 图片压缩（上传背景图时限制体积，data URL 过大可能超浏览器限制） ----------
  function compressImage(dataUrl, maxEdge = 1920, maxBytes = 1.4 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (Math.max(w, h) > maxEdge) {
          const scale = maxEdge / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        let quality = 0.82;
        let out = canvas.toDataURL('image/webp', quality);
        // 先降质量，再降分辨率
        while (out.length > maxBytes && quality > 0.3) {
          quality -= 0.13;
          out = canvas.toDataURL('image/webp', quality);
        }
        while (out.length > maxBytes && w > 800) {
          w = Math.round(w * 0.72);
          h = Math.round(h * 0.72);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0, w, h);
          out = canvas.toDataURL('image/webp', quality);
        }
        resolve(out);
      };
      img.onerror = () => reject(new Error('无法解码该图片'));
      img.src = dataUrl;
    });
  }

  $('#bg-file').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) return toast('图片不能超过 16MB', 'err');
    const reader = new FileReader();
    reader.onload = () => {
      compressImage(reader.result)
        .then((dataUrl) => api('/api/wallpapers', { method: 'POST', body: { dataUrl } }))
        .then((d) => {
          toast('已上传到背景图库，点击图片即可使用', 'ok');
          wpState.list = d.wallpapers || [];
          renderWallpapers();
          refreshStatus();
        })
        .catch((e) => toast(`上传失败：${e.message}`, 'err'));
    };
    reader.readAsDataURL(file);
    ev.target.value = '';
  });

  $('#bg-none').addEventListener('click', async () => {
    try {
      await api('/api/background', { method: 'POST', body: { fileName: null } });
      toast('已关闭背景', 'ok');
      refreshStatus();
    } catch (e) { toast(`操作失败：${e.message}`, 'err'); }
  });

  // ---------- 启动 ----------

  // ---------- 皮肤编辑器（新建 / 调色盘 / 删除） ----------
  const editState = { id: null, fromId: null, isCopy: false, mode: 'dark', palette: { light: {}, dark: {} } };

  function lightenHex(hex, ratio) {
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.min(255, v + Math.round(255 * ratio / 100)).toString(16).padStart(2, '0');
    return '#' + ch((n >> 16) & 255) + ch((n >> 8) & 255) + ch(n & 255);
  }

  function openNewDialog() {
    const skins = (state.status && state.status.skins) || [];
    $('#new-from').innerHTML = skins.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    $('#new-name').value = '';
    $('#new-desc').value = '';
    $('#new-mask').hidden = false;
    setTimeout(() => $('#new-name').focus(), 60);
  }

  async function createUserSkin() {
    const name = $('#new-name').value.trim();
    if (!name) return toast('请输入皮肤名称', 'err');
    try {
      const r = await api('/api/user-skins', { method: 'POST', body: { name, description: $('#new-desc').value.trim(), fromSkinId: $('#new-from').value } });
      toast(`已创建「${name}」，可以开始调色了`, 'ok');
      $('#new-mask').hidden = true;
      refreshStatus();
      openEditor(r.id, false, {
        id: r.id,
        name,
        description: $('#new-desc').value.trim(),
        source: 'user',
        palette: (r.meta && r.meta.palette) || { light: {}, dark: {} },
      });
    } catch (e) { toast(`创建失败：${e.message}`, 'err'); }
  }

  function openEditor(id, asCopy = false, skinInfo = null) {
    const skin = skinInfo || (state.status && state.status.skins || []).find((s) => s.id === id);
    if (!skin) return toast('皮肤不存在', 'err');
    editState.fromId = id;
    if (skin.source === 'user' && !asCopy) {
      editState.id = skin.id;
      editState.isCopy = false;
      $('#edit-title').textContent = `编辑调色盘 · ${skin.name}`;
    } else {
      editState.id = null;
      editState.isCopy = true;
      $('#edit-title').textContent = `另存为自定义 · ${skin.name}`;
    }
    $('#edit-name').value = skin.name + (editState.isCopy ? ' 副本' : '');
    $('#edit-desc').value = skin.description || '';
    editState.palette = JSON.parse(JSON.stringify(skin.palette || { light: {}, dark: {} }));
    editState.mode = 'dark';
    $('#edit-mask').hidden = false;
    renderPaletteEditor();
  }

  function renderPaletteEditor() {
    const mode = editState.mode;
    const pal = editState.palette[mode] || (editState.palette[mode] = {});
    $$('#edit-mode .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    const fallback = mode === 'dark'
      ? { bg: '#0c1422', surface: '#131e31', foreground: '#e4eaf6', brand: '#5b8def', sidebar: '#101a2c', accent: '#7aa8ff' }
      : { bg: '#f4f7fd', surface: '#ffffff', foreground: '#1e2a3a', brand: '#3b82f6', sidebar: '#eaf1fb', accent: '#60a5fa' };
    $('#palette-grid').innerHTML = CORE_COLORS.map(([key, label]) => {
      const val = pal[key] || fallback[key];
      return `<div class="palette-item">
        <span class="p-name">${label}</span>
        <span class="p-hex" id="hex-${key}">${val}</span>
        <input type="color" id="col-${key}" value="${val}">
      </div>`;
    }).join('');
    CORE_COLORS.forEach(([key]) => {
      $(`#col-${key}`).addEventListener('input', () => {
        pal[key] = $(`#col-${key}`).value;
        $(`#hex-${key}`).textContent = pal[key];
        renderPreview();
      });
    });
    $('#presets').innerHTML = PRESETS.map((c) =>
      `<div class="preset-chip" data-c="${c}" style="background:${c}" title="${c}"></div>`).join('');
    $$('#presets .preset-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        pal.brand = chip.dataset.c;
        pal.accent = lightenHex(chip.dataset.c, 18);
        renderPaletteEditor();
      });
    });
    renderPreview();
  }

  function renderPreview() {
    const mode = editState.mode;
    const pal = editState.palette[mode] || {};
    const fallback = mode === 'dark'
      ? { bg: '#0c1422', surface: '#131e31', foreground: '#e4eaf6', brand: '#5b8def', sidebar: '#101a2c', accent: '#7aa8ff' }
      : { bg: '#f4f7fd', surface: '#ffffff', foreground: '#1e2a3a', brand: '#3b82f6', sidebar: '#eaf1fb', accent: '#60a5fa' };
    const keys = ['bg', 'surface', 'sidebar', 'brand', 'accent', 'foreground'];
    const labels = ['背景', '表面', '侧边栏', '品牌', '强调', '文字'];
    $('#preview-swatches').innerHTML = keys.map((k, i) => {
      const c = pal[k] || fallback[k];
      return `<div class="pv ${mode === 'dark' ? 'pv-dark' : ''}" style="background:${c}"><span>${labels[i]}</span></div>`;
    }).join('');
  }

  async function saveEditor() {
    const name = $('#edit-name').value.trim();
    if (!name) return toast('请输入名称', 'err');
    const body = { name, description: $('#edit-desc').value.trim(), palette: editState.palette };
    try {
      if (editState.isCopy || !editState.id) {
        // 另存为新的用户皮肤（从源皮肤复制壁纸，再写入调色板）
        const r = await api('/api/user-skins', { method: 'POST', body: { ...body, fromSkinId: editState.fromId } });
        await api(`/api/user-skins/${r.id}`, { method: 'PUT', body });
        $('#edit-mask').hidden = true;
        refreshStatus();
        await applySkin(r.id);
        toast('已创建并应用自定义皮肤', 'ok');
      } else {
        await api(`/api/user-skins/${editState.id}`, { method: 'PUT', body });
        $('#edit-mask').hidden = true;
        refreshStatus();
        await applySkin(editState.id);
        toast('已保存并应用', 'ok');
      }
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
  }

  async function deleteSkin(id) {
    const skin = (state.status && state.status.skins || []).find((s) => s.id === id);
    const isUser = skin && skin.source === 'user';
    const tip = isUser
      ? `确定永久删除皮肤「${skin.name}」？此操作不可恢复。`
      : `确定隐藏皮肤「${skin.name}」？它会在面板中消失，但随时可以恢复。`;
    if (!confirm(tip)) return;
    try {
      await api(`/api/skins/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(isUser ? '已删除' : '已隐藏（可恢复）', 'ok');
      refreshStatus();
    } catch (e) { toast(`操作失败：${e.message}`, 'err'); }
  }

  async function unhideSkin(id) {
    try {
      await api(`/api/skins/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      toast('已恢复显示', 'ok');
      refreshStatus();
    } catch (e) { toast(`恢复失败：${e.message}`, 'err'); }
  }

  $('#btn-new-skin').addEventListener('click', openNewDialog);
  $('#new-cancel').addEventListener('click', () => { $('#new-mask').hidden = true; });
  $('#new-confirm').addEventListener('click', createUserSkin);
  $('#new-name').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') createUserSkin(); });
  $('#edit-close').addEventListener('click', () => { $('#edit-mask').hidden = true; });
  $('#edit-cancel').addEventListener('click', () => { $('#edit-mask').hidden = true; });
  $('#edit-save').addEventListener('click', saveEditor);
  $$('#edit-mode .seg-btn').forEach((b) => b.addEventListener('click', () => {
    editState.mode = b.dataset.mode;
    renderPaletteEditor();
  }));
  $('#edit-mask').addEventListener('click', (ev) => { if (ev.target === $('#edit-mask')) $('#edit-mask').hidden = true; });
  $('#new-mask').addEventListener('click', (ev) => { if (ev.target === $('#new-mask')) $('#new-mask').hidden = true; });

  // ---------- 字体 ----------
  const fontState = { list: [] };

  function fontFamilyName(fileName) {
    return fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  /** 面板预览用的 @font-face（注入到面板页面，与 ZCode 内的无关） */
  function ensurePreviewFace(fileName) {
    const family = fontFamilyName(fileName);
    const id = 'zf-' + family;
    if (document.getElementById(id)) return family;
    const style = document.createElement('style');
    style.id = id;
    const ext = fileName.split('.').pop().toLowerCase();
    const fmt = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' }[ext] || 'woff2';
    style.textContent = `@font-face { font-family: '${family}'; src: url('/api/fonts/${encodeURIComponent(fileName)}') format('${fmt}'); }`;
    document.head.appendChild(style);
    return family;
  }

  function renderFonts(s) {
    const families = s.fontFamilies || [];
    const fonts = s.fonts || [];
    fontState.list = fonts;
    const ui = $('#font-ui');
    const code = $('#font-code');
    const opts = ['<option value="">默认（系统字体）</option>']
      .concat(families.map((f) => `<option value="${esc(f.family)}">${esc(f.name)}${f.count > 1 ? `（${f.count} 个文件）` : ''}${f.cjk ? ' · 含中文' : ''}</option>`)).join('');
    ui.innerHTML = opts;
    code.innerHTML = opts;
    // 当前值（state 存的是代表文件名）→ 映射回家族选中
    const famOf = (file) => {
      if (!file) return '';
      return families.find((f) => f.pick === file || f.family === file)?.family || '';
    };
    ui.value = famOf(s.fontFamily);
    code.value = famOf(s.codeFontFamily);
    // 预览：应用界面字体（家族代表文件）
    const preview = $('#font-preview');
    if (s.fontFamily) {
      const fam = families.find((f) => f.pick === s.fontFamily || f.family === s.fontFamily);
      const pick = fam ? fam.pick : s.fontFamily;
      preview.style.fontFamily = `'${fontFamilyName(pick)}', system-ui, sans-serif`;
      ensurePreviewFace(pick);
    } else {
      preview.style.fontFamily = '';
    }
  }

  async function applyFonts(patch) {
    try {
      const r = await api('/api/fonts/apply', { method: 'POST', body: patch });
      toast(r.updated ? '字体已应用' : '字体已保存，ZCode 连接后生效', 'ok');
      refreshStatus();
    } catch (e) { toast(`字体应用失败：${e.message}`, 'err'); }
  }

  $('#font-ui').addEventListener('change', (ev) => applyFonts({ uiFont: ev.target.value || null }));
  $('#font-code').addEventListener('change', (ev) => applyFonts({ codeFont: ev.target.value || null }));
  $('#font-reset').addEventListener('click', () => applyFonts({ uiFont: null, codeFont: null }));

  $('#font-file').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['woff2', 'woff', 'ttf', 'otf'].includes(ext)) return toast('仅支持 woff2/woff/ttf/otf', 'err');
    if (file.size > 40 * 1024 * 1024) return toast('字体文件不能超过 40MB', 'err');
    const reader = new FileReader();
    reader.onload = () => {
      api('/api/fonts', { method: 'POST', body: { dataUrl: reader.result, fileName: file.name } })
        .then(() => { toast('字体已上传', 'ok'); refreshStatus(); })
        .catch((e) => toast(`上传失败：${e.message}`, 'err'));
    };
    reader.readAsDataURL(file);
    ev.target.value = '';
  });

  // ---------- 文案替换 ----------
  function renderTextRules(s) {
    const rules = s.textReplace || [];
    const list = $('#tr-list');
    list.innerHTML = rules.length
      ? rules.map((r, i) => `
        <div class="tr-item">
          <span class="tr-orig" title="${esc(r.from)}">${esc(r.from)}</span>
          <span class="tr-arrow">→</span>
          <span class="tr-new" title="${esc(r.to)}">${esc(r.to)}</span>
          <button class="icon-btn" title="删除规则" data-i="${i}">🗑</button>
        </div>`).join('')
      : '<div class="tr-empty">暂无替换规则。下方输入原文和替换文添加。</div>';
    $$('#tr-list .tr-item .icon-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.i);
        const next = rules.filter((_, i) => i !== idx);
        await saveTextRules(next);
      });
    });
  }

  async function saveTextRules(rules) {
    try {
      const r = await api('/api/textrules', { method: 'POST', body: { rules } });
      toast(r.updated ? '已保存并生效' : '已保存（ZCode 连接后生效）', 'ok');
      refreshStatus();
    } catch (e) { toast(`保存失败：${e.message}`, 'err'); }
  }

  $('#tr-add').addEventListener('click', async () => {
    const from = $('#tr-from').value.trim();
    const to = $('#tr-to').value;
    if (!from) return toast('请输入原文', 'err');
    const rules = (state.status && state.status.textReplace || []).slice();
    rules.push({ from, to });
    $('#tr-from').value = '';
    $('#tr-to').value = '';
    await saveTextRules(rules);
  });

  $('#tr-clear').addEventListener('click', async () => {
    if (!confirm('清空全部文案替换规则？')) return;
    await saveTextRules([]);
  });

  // ---------- 日志折叠 ----------
  $('#log-toggle').addEventListener('click', () => {
    document.querySelector('.log-card').classList.toggle('collapsed');
  });

  // ---------- 启动 ----------
  refreshStatus();
  refreshLogs();
  refreshWallpapers();
  setInterval(refreshStatus, 3000);
  setInterval(refreshLogs, 2500);
  setInterval(refreshWallpapers, 8000);
})();
