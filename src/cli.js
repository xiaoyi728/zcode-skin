'use strict';
/**
 * cli.js — zcode-skin 命令行入口
 *
 *   zcode-skin               启动守护进程 + 浏览器控制面板（默认）
 *   zcode-skin status        检测 ZCode 安装/运行/CDP 状态
 *   zcode-skin list          列出内置皮肤
 *   zcode-skin apply <id>    应用皮肤（ZCode 运行中则立即注入，否则保存待启动后生效）
 *   zcode-skin restore       还原官方外观
 *   zcode-skin launch        以注入模式（CDP 端口）启动 ZCode
 *   zcode-skin close         关闭 ZCode
 *   zcode-skin enable-port   给开始菜单 ZCode.lnk 永久附加调试端口参数
 *   zcode-skin disable-port  移除快捷方式上的端口参数
 */

const detect = require('./detect');
const launcher = require('./launcher');
const cdp = require('./cdp');
const injector = require('./injector');
const skinCompiler = require('./skin-compiler');
const state = require('./state');

const COLORS = {
  dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', bold: '\x1b[1m', reset: '\x1b[0m',
};
const c = (code, s) => `${COLORS[code]}${s}${COLORS.reset}`;

async function cmdStatus() {
  const d = await detect.detectAll();
  console.log(c('bold', 'ZCode 检测'));
  console.log(`  安装路径 : ${d.exe ? c('green', d.exe) : c('red', '未找到')}`);
  console.log(`  版本     : ${d.version || '未知'}`);
  console.log(`  运行状态 : ${d.running ? c('green', '运行中') : c('yellow', '未运行')}`);

  const st = state.read();
  console.log(c('bold', '\n皮肤状态'));
  console.log(`  当前皮肤 : ${st.currentSkinId ? c('cyan', st.currentSkinId) : c('dim', '官方默认')}`);
  console.log(`  状态文件 : ${state.STATE_FILE}`);

  if (d.running) {
    const port = await detect.findFreePort(st.port);
    if (port !== st.port) {
      console.log(c('yellow', `\n  CDP 端口 ${st.port} 空闲（ZCode 可能未带调试端口启动，请用 zcode-skin launch 重启）`));
    } else {
      console.log(`  调试端口 : :${st.port}（ZCode 未开启调试端口，请用 ${c('cyan', 'zcode-skin launch')} 启动）`);
    }
  } else {
    console.log(c('dim', '\n  提示：启动 ZCode 请使用 zcode-skin launch（带 CDP 注入端口）'));
  }
  return 0;
}

async function cmdList() {
  const skins = skinCompiler.listSkins();
  const st = state.read();
  console.log(c('bold', `内置皮肤（${skins.length} 套）`));
  for (const s of skins) {
    const mark = s.id === st.currentSkinId ? c('green', '  ← 当前') : '';
    const bg = s.hasBackground ? c('cyan', ' [壁纸]') : '';
    const mode = s.mode === 'dark' ? '深色' : s.mode === 'light' ? '浅色' : '双模式';
    console.log(`  ${c('cyan', s.id.padEnd(18))} ${mode.padEnd(4)}${bg}  ${s.name}${mark}`);
    if (s.description) console.log(`${' '.repeat(20)}${c('dim', s.description)}`);
  }
  return 0;
}

async function cmdApply(id) {
  const skins = skinCompiler.listSkinIds();
  if (!skins.includes(id)) {
    console.error(c('red', `未知皮肤：${id}`));
    console.error(c('dim', `可用：${skins.join(', ')}`));
    return 1;
  }
  const st = state.read();
  state.write({ currentSkinId: id });
  console.log(`${c('green', '✓')} 皮肤「${id}」已保存`);

  const running = await detect.isZCodeRunning();
  if (running) {
    // 尝试实时注入
    let injected = false;
    for (let i = 0; i < 3 && !injected; i++) {
      const target = await cdp.waitForZCodeTarget(st.port, { timeoutMs: 4000, intervalMs: 1000 });
      if (!target) break;
      let session = null;
      try {
        session = await cdp.CdpSession.connect(target.webSocketDebuggerUrl, 6000);
        if (await cdp.probeZCodePage(session)) {
          const { payload } = skinCompiler.compileSkin(id, { background: st.background });
          await session.evaluate(injector.buildInjectorScript(payload));
          console.log(c('green', '✓') + ' 已实时注入 ZCode（立即生效）');
          injected = true;
        }
      } catch (e) {
        console.log(c('yellow', `  注入重试：${e.message}`));
      } finally {
        if (session && !injected) session.close();
      }
    }
    if (!injected) {
      console.log(c('yellow', `  ZCode 正在运行但未开启调试端口（:${st.port}）。请用 ${c('cyan', 'zcode-skin launch')} 重启后重新 apply。`));
    }
  } else {
    console.log(c('dim', '  ZCode 未运行，皮肤将在启动后自动应用（需带调试端口启动）。'));
  }
  return 0;
}

async function cmdRestore() {
  state.write({ currentSkinId: null });
  console.log(c('green', '✓') + ' 已还原为官方外观（保存状态已清除）');
  const st = state.read();
  if (await detect.isZCodeRunning()) {
    const target = await cdp.waitForZCodeTarget(st.port, { timeoutMs: 4000, intervalMs: 1000 });
    if (target) {
      try {
        const session = await cdp.CdpSession.connect(target.webSocketDebuggerUrl, 6000);
        await session.evaluate(injector.buildCleanupScript());
        console.log(c('green', '✓') + ' 已从运行中的 ZCode 移除皮肤');
        session.close();
      } catch (e) {
        console.log(c('yellow', `  移除失败：${e.message}`));
      }
    }
  }
  return 0;
}

async function cmdLaunch() {
  const d = await detect.detectAll();
  if (!d.exe) {
    console.error(c('red', '未找到 ZCode.exe'));
    return 1;
  }
  const st = state.read();
  const port = await detect.findFreePort(st.port || 9335);
  if (port !== st.port) {
    state.write({ port });
    console.log(c('yellow', `端口 ${st.port} 被占用，改用 ${port}`));
  }
  if (await detect.isZCodeRunning()) {
    console.log(c('yellow', 'ZCode 已在运行（未带调试端口）。先关闭旧实例…'));
    await launcher.closeZCode();
    await new Promise((r) => setTimeout(r, 1200));
  }
  await launcher.launchZCode(d.exe, port);
  console.log(`${c('green', '✓')} 已启动 ZCode（CDP 端口 :${port}）`);
  const target = await cdp.waitForZCodeTarget(port, { timeoutMs: 60000, intervalMs: 1500 });
  if (target) console.log(`${c('green', '✓')} 渲染目标已就绪：${target.url}`);
  else console.log(c('yellow', '  ZCode 已启动，但等待渲染目标超时（可稍后 zcode-skin apply 再注入）'));
  return 0;
}

async function cmdClose() {
  const r = await launcher.closeZCode();
  console.log(r.killed ? c('green', '✓ 已关闭 ZCode') : c('dim', r.note));
  return 0;
}

async function cmdShortcutPort(enable) {
  try {
    const st = state.read();
    const port = st.port || 9335;
    const r = await launcher.setShortcutPort(port, enable);
    console.log(`${c('green', '✓')} 快捷方式 ${enable ? '已附加' : '已移除'}调试端口参数：${r.shortcut}`);
    console.log(c('dim', enable
      ? `  之后从开始菜单启动 ZCode 也会带 :${port} 调试端口，面板随时可连接。`
      : '  现在 ZCode 只会通过 zcode-skin launch 启动时才带调试端口。'));
  } catch (e) {
    console.error(c('red', e.message));
    return 1;
  }
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = (args[0] || 'serve').toLowerCase();
  const arg = args[1];

  switch (cmd) {
    case 'serve':
    case 'panel':
    case 'ui':
      // 守护进程自带浏览器面板：server.main() 启动后即 resolve，
      // 进程由 HTTP 服务/定时器的事件循环保持，这里挂起等待，避免被 process.exit 终止
      return require('./server').main().then(() => new Promise(() => {}));
    case 'status': return cmdStatus();
    case 'list': return cmdList();
    case 'apply':
      if (!arg) { console.error('用法：zcode-skin apply <皮肤id>'); return 1; }
      return cmdApply(arg);
    case 'restore': return cmdRestore();
    case 'launch': return cmdLaunch();
    case 'close': return cmdClose();
    case 'enable-port': return cmdShortcutPort(true);
    case 'disable-port': return cmdShortcutPort(false);
    case 'help':
    case '--help':
    case '-h':
      console.log(`用法：
  zcode-skin               启动守护进程 + 浏览器控制面板（推荐）
  zcode-skin status        检测 ZCode 安装/运行/CDP 状态
  zcode-skin list          列出内置皮肤
  zcode-skin apply <id>    应用皮肤（运行中则实时注入）
  zcode-skin restore       还原官方外观
  zcode-skin launch        以注入模式（CDP 端口）启动 ZCode
  zcode-skin close         关闭 ZCode
  zcode-skin enable-port   给开始菜单 ZCode.lnk 永久附加调试端口
  zcode-skin disable-port  移除快捷方式调试端口参数`);
      return 0;
    default:
      console.error(c('red', `未知命令：${cmd}`) + c('dim', '（用 zcode-skin help 查看用法）'));
      return 1;
  }
}

module.exports = { main };

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    console.error(c('red', `错误：${e.message}`));
    process.exit(1);
  });
}
