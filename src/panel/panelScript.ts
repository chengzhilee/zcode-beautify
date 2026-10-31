/**
 * The injected settings panel: a floating, draggable panel in the ZCode
 * renderer for live-tuning blur/dim, toggling Monet colors and wallpaper
 * visibility, and swapping the wallpaper image — all via the local API
 * started by `zcode-beautify serve`.
 *
 * The script always rebuilds the panel, so a stale copy left in the DOM can
 * never shadow a newer script version, and it is safe to re-evaluate on every
 * injection or reload.
 */

export const PANEL_ROOT_ID = "zcode-beautify-panel-root";
/** Heartbeat marker the serve daemon looks for; its disappearance means the
 *  panel was dropped (page reload, session switch) and must be re-injected. */
export const PANEL_ALIVE_ID = "zcode-beautify-panel-alive";
/** Local patch series label, shown in the panel header. */
export const PANEL_BUILD = "local-4";

export function buildPanelScript(apiPort: number, token: string): string {
  const api = `http://127.0.0.1:${apiPort}`;
  return `(function(){
  var API = ${JSON.stringify(api)};
  var TOKEN = ${JSON.stringify(token)};
  var ROOT_ID = ${JSON.stringify(PANEL_ROOT_ID)};
  var ALIVE_ID = ${JSON.stringify(PANEL_ALIVE_ID)};
  var BUILD = ${JSON.stringify(PANEL_BUILD)};
  // Always rebuild: an older panel left in the DOM would otherwise shadow the
  // current script version forever (the old build skipped installation).
  var stale = document.getElementById(ROOT_ID);
  if (stale) stale.remove();
  var staleStyle = document.getElementById('zcode-beautify-panel-style');
  if (staleStyle) staleStyle.remove();

  // Heartbeat: keep a hidden marker in the DOM so the serve daemon can tell
  // the panel is alive. A page reload drops it, which triggers re-injection.
  var staleAlive = document.getElementById(ALIVE_ID);
  if (staleAlive) staleAlive.remove();
  var alive = document.createElement('div');
  alive.id = ALIVE_ID;
  alive.style.display = 'none';
  alive.setAttribute('data-build', BUILD);
  (document.body || document.documentElement).appendChild(alive);
  setInterval(function () { alive.setAttribute('data-beat', String(Date.now())); }, 2000);

  var css = [
    '#zcode-beautify-panel-root, #zcode-beautify-panel-root * { box-sizing: border-box; font-family: system-ui, sans-serif; }',
    '#zcode-beautify-panel-root { position: fixed; inset: auto; z-index: 2147483647; font-size: 12px; color: #e8e8ea; }',
    '#zb-fab { position: fixed; right: 18px; bottom: 18px; width: 34px; height: 34px; border-radius: 50%;',
      ' background: rgba(32,32,38,.78); border: 1px solid rgba(255,255,255,.12); cursor: pointer;',
      ' display: flex; align-items: center; justify-content: center; backdrop-filter: blur(10px);',
      ' box-shadow: 0 2px 12px rgba(0,0,0,.35); user-select: none; font-size: 15px; line-height: 1; }',
    '#zb-fab:hover { background: rgba(52,52,60,.85); }',
    '#zb-panel { position: fixed; right: 18px; bottom: 60px; width: 264px; padding: 0 0 10px;',
      ' background: rgba(24,24,30,.88); border: 1px solid rgba(255,255,255,.12); border-radius: 12px;',
      ' backdrop-filter: blur(16px); box-shadow: 0 8px 32px rgba(0,0,0,.45); user-select: none; }',
    '#zb-panel[hidden] { display: none; }',
    '#zb-head { padding: 9px 12px; font-weight: 600; cursor: move; border-bottom: 1px solid rgba(255,255,255,.1);',
      ' display: flex; justify-content: space-between; align-items: center; }',
    '#zb-close { cursor: pointer; opacity: .7; padding: 0 4px; } #zb-close:hover { opacity: 1; }',
    '#zb-body { padding: 10px 12px 0; }',
    '.zb-row { margin-bottom: 10px; }',
    '.zb-row label { display: flex; justify-content: space-between; margin-bottom: 4px; opacity: .85; }',
    '#zb-panel input[type=range] { width: 100%; accent-color: #7aa2f7; height: 18px; margin: 0; cursor: pointer; }',
    '.zb-toggles { display: flex; justify-content: center; gap: 16px; }',
    '.zb-toggles label { display: flex; align-items: center; gap: 5px; margin: 0; cursor: pointer; }',
    '.zb-actions { display: flex; justify-content: center; gap: 10px; }',
    '.zb-btn { display: inline-block; padding: 6px 20px; text-align: center; border-radius: 999px; cursor: pointer;',
      ' background: rgba(255,255,255,.09); border: 1px solid rgba(255,255,255,.14); color: inherit; font-size: 12px; }',
    '.zb-btn:hover { background: rgba(255,255,255,.16); }',
    '#zb-status { min-height: 14px; padding: 2px 12px 0; opacity: .6; font-size: 11px; }',
    '#zb-offline { display: flex; flex-direction: column; gap: 6px; align-items: center;',
      ' padding: 10px 12px; background: rgba(120,53,15,.55); font-size: 11px; line-height: 1.5; text-align: center; }',
    '#zb-offline[hidden] { display: none; }',
    '#zb-offline code { background: rgba(0,0,0,.35); padding: 1px 4px; border-radius: 4px;',
      ' font-size: 10px; user-select: text; }',
    '#zb-offline .zb-hint { opacity: .85; }',
    // While offline the controls hold nothing we could read, so they must not
    // look interactive — a slider parked mid-track next to a "0px" label reads
    // as a real (wrong) setting.
    '#zcode-beautify-panel-root[data-offline="1"] #zb-body { opacity: .45; pointer-events: none; }',
    '#zcode-beautify-panel-root[data-offline="1"] #zb-status { display: none; }',
    '#zcode-beautify-panel-root[data-offline="1"] #zb-fab { border-color: rgba(248,113,113,.7); }',
    '#zb-needs-relaunch { display: flex; flex-direction: column; gap: 6px; align-items: center;',
      ' padding: 10px 12px; background: rgba(120,53,15,.45); font-size: 11px; line-height: 1.5; text-align: center; }',
    '#zb-needs-relaunch[hidden] { display: none; }',
    '#zb-recovery { width: 100%; padding: 4px 6px; border-radius: 6px; font-size: 11px; color: inherit;',
      ' background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.14); }',
    '#zcode-beautify-panel-root option { color: #111; background: #fff; }',
    '#zb-recovery-hint { margin-top: 4px; opacity: .65; font-size: 10px; line-height: 1.45; }',
    '#zb-lib-view { position: fixed; right: 292px; bottom: 60px; width: 286px; max-height: 380px; overflow-y: auto;',
      ' background: rgba(18,18,24,.95); border: 1px solid rgba(255,255,255,.14); border-radius: 12px;',
      ' padding: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.5); }',
    '#zb-lib-view[hidden] { display: none; }',
    '#zb-lib-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; padding: 2px 4px 8px; }',
    '#zb-lib-close { cursor: pointer; opacity: .7; padding: 0 4px; } #zb-lib-close:hover { opacity: 1; }',
    '#zb-lib-filter { display: flex; gap: 4px; padding: 0 4px 8px; flex-wrap: wrap; align-items: center; }',
    '.zb-chip { cursor: pointer; padding: 3px 8px; border-radius: 999px; font-size: 10px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); color: inherit; }',
    '.zb-chip:hover { background: rgba(255,255,255,.14); }',
    '.zb-chip[data-on="1"] { background: rgba(122,162,247,.35); border-color: rgba(122,162,247,.8); }',
    '#zb-lib-search { flex: 1; min-width: 60px; padding: 3px 6px; border-radius: 6px; font-size: 10px; color: inherit; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); }',
    '#zb-lib-preview { position: fixed; right: 588px; bottom: 60px; width: 420px; z-index: 2147483647;',
      ' background: rgba(14,14,20,.96); border: 1px solid rgba(255,255,255,.16); border-radius: 10px; padding: 6px;',
      ' box-shadow: 0 10px 40px rgba(0,0,0,.55); pointer-events: none; }',
    '#zb-lib-preview[hidden] { display: none; }',
    '#zb-lib-preview img, #zb-lib-preview video { width: 100%; max-height: 320px; object-fit: contain; display: block; border-radius: 6px; background: #111; }',
    '#zb-lib-preview .zb-pv-cap { font-size: 10px; padding: 5px 2px 1px; opacity: .85; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '#zb-tabs { display: flex; gap: 4px; padding: 0 8px 8px; }',
    '.zb-tab { flex: 1; cursor: pointer; padding: 5px 2px; text-align: center; font-size: 11px; border-radius: 8px;',
      ' background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: inherit; }',
    '.zb-tab:hover { background: rgba(255,255,255,.12); }',
    '.zb-tab[data-on="1"] { background: rgba(122,162,247,.3); border-color: rgba(122,162,247,.7); }',
    '.zb-page.hidden, .zb-page[hidden] { display: none; }',
    '#zb-cur-thumb.no-media { display: flex; align-items: center; justify-content: center; color: #888; font-size: 18px; }',
    '#zb-dropzone { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center;',
      ' background: rgba(20,30,60,.55); }',
    '#zb-dropzone[hidden] { display: none; }',
    '#zb-dropzone div { padding: 18px 34px; border: 2px dashed rgba(122,162,247,.9); border-radius: 14px;',
      ' font-size: 15px; color: #dbe4ff; background: rgba(20,30,60,.8); }',
    '.zb-preset-row { display: flex; align-items: center; gap: 6px; font-size: 10px; padding: 3px 0; }',
    '.zb-preset-name { flex: 1; min-width: 0; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .9; }',
    '.zb-preset-name:hover { text-decoration: underline; }',
    '.zb-preset-del { cursor: pointer; opacity: .6; padding: 0 4px; } .zb-preset-del:hover { opacity: 1; }',
    '#zb-lib-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }',
    '.zb-lib-cell { position: relative; cursor: pointer; border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); }',
    '.zb-lib-cell:hover { border-color: rgba(122,162,247,.8); }',
    '.zb-lib-cell.fav { border-color: rgba(255,200,80,.7); }',
    '.zb-star { position: absolute; top: 4px; right: 4px; cursor: pointer; font-size: 13px; line-height: 1; text-shadow: 0 1px 3px rgba(0,0,0,.7); opacity: .8; z-index: 2; }',
    '.zb-star:hover { transform: scale(1.25); }',
    '.zb-star.on { opacity: 1; }',
    '.zb-dimbadge { position: absolute; left: 4px; bottom: 24px; font-size: 9px; padding: 1px 5px; border-radius: 4px; background: rgba(0,0,0,.62); color: #fff; z-index: 2; }',
    '.zb-dimbadge.warn { background: rgba(180,120,20,.8); }',
    '#zb-grid-toggle { cursor: pointer; padding: 3px 6px; font-size: 10px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); border-radius: 6px; color: inherit; flex: none; }',
    '#zb-lib-grid.cols4 { grid-template-columns: repeat(4, 1fr); }',
    '#zb-lib-grid.cols4 .zb-lib-cell img { height: 44px; }',
    '.zb-lib-cell img { width: 100%; height: 66px; object-fit: cover; display: block; background: #222; }',
    '.zb-lib-cap { font-size: 10px; padding: 4px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .9; }',
    '.zb-lib-sec { font-size: 10px; opacity: .6; padding: 8px 4px 4px; }',
    '.zb-pl-row { display: flex; align-items: center; gap: 6px; font-size: 10px; padding: 2px 0; }',
    '.zb-pl-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: .85; }',
    '.zb-pl-del { cursor: pointer; opacity: .6; padding: 0 4px; } .zb-pl-del:hover { opacity: 1; }'
  ].join('');

  var style = document.createElement('style');
  style.id = 'zcode-beautify-panel-style';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  var root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML =
    '<div id="zb-fab" title="壁纸工坊">🎨</div>' +
    '<div id="zb-panel" hidden>' +
    '  <div id="zb-head"><span>壁纸工坊 <span style="opacity:.5;font-size:10px">v' + BUILD + '</span></span><span id="zb-close">✕</span></div>' +
    '  <div id="zb-tabs">' +
    '    <button class="zb-tab" data-t="wp" data-on="1">🖼 壁纸</button>' +
    '    <button class="zb-tab" data-t="fx">✨ 效果</button>' +
    '    <button class="zb-tab" data-t="rot">🔁 轮播</button>' +
    '    <button class="zb-tab" data-t="set">⚙ 设置</button>' +
    '  </div>' +
    '  <div id="zb-offline" hidden>' +
    '    <div>⚠ 美化服务未运行,面板不可用</div>' +
    '    <div class="zb-hint">在插件目录执行 <code>node dist/cli.js serve --detach</code> 启动</div>' +
    '    <button class="zb-btn" id="zb-retry">重试连接</button>' +
    '  </div>' +
    '  <div id="zb-needs-relaunch" hidden>' +
    '    <div>⚠ ZCode 美化插件还没生效,需要重启一下 ZCode</div>' +
    '    <button class="zb-btn" id="zb-relaunch">立即重启 ZCode</button>' +
    '  </div>' +
    '  <div id="zb-body">' +
    '    <div class="zb-page" id="zb-page-wp">' +
    '      <div id="zb-cur" class="zb-row" style="display:flex;gap:8px;align-items:center">' +
    '        <img id="zb-cur-thumb" alt="" style="width:64px;height:40px;object-fit:cover;border-radius:6px;background:#222;flex:none">' +
    '        <div style="min-width:0;flex:1">' +
    '          <div id="zb-cur-name" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">—</div>' +
    '          <div id="zb-cur-type" style="font-size:10px;opacity:.6">当前壁纸</div>' +
    '        </div>' +
    '      </div>' +
    '      <div class="zb-row zb-actions">' +
    '        <label class="zb-btn" for="zb-file" title="选择一张图片作为背景壁纸,UI 配色随之更新">更换图片…</label>' +
    '        <input type="file" id="zb-file" accept="image/*" hidden>' +
    '        <button class="zb-btn" id="zb-lib" title="浏览 Steam 创意工坊和本地壁纸,点缩略图直接应用,悬停可预览">🖼 壁纸库</button>' +
    '      </div>' +
    '      <div class="zb-row" style="display:flex;gap:6px">' +
    '        <input id="zb-path" type="text" placeholder="粘贴图片或视频路径" title="图片: PNG/JPG/GIF/WebP/BMP；视频: MP4/WebM/MOV（按扩展名自动识别）" style="flex:1;min-width:0;padding:6px 8px;border-radius:8px;font-size:11px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '        <button class="zb-btn" id="zb-path-apply" style="padding:6px 12px;flex:none" title="把上面路径指向的图片或视频设为壁纸">导入</button>' +
    '      </div>' +
    '      <div class="zb-row" style="display:flex;gap:6px">' +
    '        <input id="zb-web" type="text" placeholder="网页壁纸 URL(https://…)" title="任何 https 网页都能当壁纸：在线时钟、雨滴模拟、可视化…沙箱隔离运行" style="flex:1;min-width:0;padding:6px 8px;border-radius:8px;font-size:11px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '        <button class="zb-btn" id="zb-web-apply" style="padding:6px 12px;flex:none" title="把网页设为壁纸(沙箱隔离运行,访问不了 ZCode 内部)">打开</button>' +
    '      </div>' +
    '      <div class="zb-row" id="zb-web-row" style="display:flex;gap:6px;align-items:center">' +
    '        <button class="zb-btn" id="zb-web-stop" style="padding:5px 10px;flex:none" title="停止网页壁纸，回到静态图片">■ 停止网页</button>' +
    '      </div>' +
    '      <div class="zb-row" id="zb-video-row" style="display:flex;gap:6px;align-items:center">' +
    '        <button class="zb-btn" id="zb-video-stop" style="padding:5px 10px;flex:none" title="停止视频壁纸，回到静态图片">■ 停止视频</button>' +
    '        <label title="取消静音：面板上的点击属于用户手势，浏览器允许出声播放" style="display:flex;align-items:center;gap:5px;cursor:pointer;margin:0">' +
    '          <input type="checkbox" id="zb-video-mute"> 静音</label>' +
    '        <label title="每5秒从视频抽一帧重新取色,UI 配色跟着画面变(视频改走本地服务加载)" style="display:flex;align-items:center;gap:5px;cursor:pointer;margin:0">' +
    '          <input type="checkbox" id="zb-livecolor"> 实时取色</label>' +
    '      </div>' +
    '      <div class="zb-row zb-actions">' +
    '        <button class="zb-btn" id="zb-reset" title="移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)">还原默认外观</button>' +
    '      </div>' +
    '      <div class="zb-hint" style="padding:2px 4px 0">💡 面板开着时,把图片/视频拖进窗口也能直接导入</div>' +
    '    </div>' +
    '    <div class="zb-page" id="zb-page-fx" hidden>' +
    '      <div class="zb-row"><label title="背景模糊程度(像素)"><span>背景模糊</span><span><span id="zb-blur-val">0</span>px</span></label>' +
    '        <input type="range" id="zb-blur" min="0" max="30" step="1" value="0"></div>' +
    '      <div class="zb-row"><label title="背景压暗程度(百分比,越高越暗)"><span>背景压暗</span><span><span id="zb-dim-val">0</span>%</span></label>' +
    '        <input type="range" id="zb-dim" min="0" max="80" step="1" value="0"></div>' +
    '      <div class="zb-row zb-toggles">' +
    '        <label title="根据壁纸自动生成 UI 配色;关闭则保留 ZCode 原生颜色"><input type="checkbox" id="zb-monet">UI 莫奈取色</label>' +
    '        <label title="显示或隐藏背景壁纸"><input type="checkbox" id="zb-vis">显示壁纸</label>' +
    '      </div>' +
    '      <div class="zb-row zb-actions">' +
    '        <button class="zb-btn" id="zb-fit" title="背景填充方式:填满裁剪铺满窗口 / 完整显示不裁剪(模糊垫底)/ 智能适配自动分析画面主体">背景填充: …</button>' +
    '      </div>' +
    '      <div class="zb-row" style="border-top:1px solid rgba(255,255,255,.1);padding-top:8px">' +
    '        <label title="给静态壁纸加轻量动画:呼吸缩放/鼠标视差/飘落粒子,几乎不耗性能"><span>✨ 动态特效</span></label>' +
    '        <div style="display:flex;gap:12px;margin:4px 0">' +
    '          <label style="display:flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" id="zb-fx-kb"> 呼吸缩放</label>' +
    '          <label style="display:flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" id="zb-fx-par"> 鼠标视差</label>' +
    '        </div>' +
    '        <div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">' +
    '          <select id="zb-fx-parts" style="flex:1;padding:4px 6px;border-radius:6px;font-size:11px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '            <option value="none">无粒子</option><option value="snow">❄ 飘雪</option>' +
    '            <option value="petals">🌸 花瓣</option><option value="light">✦ 光斑</option></select>' +
    '          <input type="range" id="zb-fx-int" min="0" max="100" step="1" style="flex:1" title="特效强度(粒子数量/幅度)">' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '    <div class="zb-page" id="zb-page-rot" hidden>' +
    '      <div class="zb-row">' +
    '        <label title="收藏的壁纸定时轮换;夜间(19:00-7:00)可自动换夜间壁纸"><span>🔁 轮播</span></label>' +
    '        <div style="display:flex;gap:6px;align-items:center;margin:4px 0">' +
    '          <select id="zb-rot" style="flex:1;padding:4px 6px;border-radius:6px;font-size:11px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '            <option value="0">轮换: 关闭</option><option value="1">每 1 分钟</option>' +
    '            <option value="5">每 5 分钟</option>' +
    '            <option value="15">每 15 分钟</option><option value="30">每 30 分钟</option>' +
    '            <option value="60">每 60 分钟</option></select>' +
    '          <button class="zb-btn" id="zb-pl-add" style="padding:4px 8px;flex:none" title="把当前正在使用的壁纸加入轮播列表">+ 收藏当前</button>' +
    '        </div>' +
    '        <div id="zb-pl-list"></div>' +
    '        <div style="display:flex;gap:6px;margin-top:4px">' +
    '          <input id="zb-night" type="text" placeholder="夜间壁纸路径(19:00-7:00)" style="flex:1;min-width:0;padding:4px 6px;border-radius:6px;font-size:10px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '          <button class="zb-btn" id="zb-night-apply" style="padding:4px 8px;flex:none">设夜间</button>' +
    '        </div>' +
    '      </div>' +
    '    </div>' +
    '    <div class="zb-page" id="zb-page-set" hidden>' +
    '      <div class="zb-row">' +
    '        <label title="ZCode 每次重启都会丢掉壁纸和配色,这里决定由谁来把它们恢复回来"><span>自动恢复</span></label>' +
    '        <select id="zb-recovery">' +
    '          <option value="off">关闭</option>' +
    '          <option value="on-start">ZCode 启动时恢复</option>' +
    '          <option value="always">后台常驻(可用本面板)</option>' +
    '        </select>' +
    '        <label title="ZCode 更新后常因缺启动参数导致背景消失;开启后后台服务检测到这种情况会自动重启 ZCode 修复" style="display:flex;align-items:center;gap:5px;cursor:pointer;margin:6px 0 0">' +
    '          <input type="checkbox" id="zb-autorepair"> 更新后自动修复</label>' +
    '        <div id="zb-recovery-hint"></div>' +
    '      </div>' +
    '      <div class="zb-row" style="border-top:1px solid rgba(255,255,255,.1);padding-top:8px">' +
    '        <label title="省电省 GPU:窗口隐藏时暂停视频解码;笔记本低电量时自动切回静态图" style="display:flex;align-items:center;gap:5px;cursor:pointer;margin:0 0 4px">' +
    '          <input type="checkbox" id="zb-pg-hide"> 隐藏窗口时暂停视频(省电)</label>' +
    '        <label title="电量低于20%且未接电源时自动切回静态图,插电后恢复" style="display:flex;align-items:center;gap:5px;cursor:pointer;margin:0">' +
    '          <input type="checkbox" id="zb-pg-bat"> 低电量自动切回静态图</label>' +
    '      </div>' +
    '      <div class="zb-row" style="border-top:1px solid rgba(255,255,255,.1);padding-top:8px">' +
    '        <label title="把当前整套外观(壁纸/视频/特效/调校)存成快照,随时一键切回"><span>📸 预设快照</span></label>' +
    '        <div style="display:flex;gap:6px;margin:4px 0">' +
    '          <input id="zb-preset-name" type="text" placeholder="快照名称,如: 长安雪+飘雪" style="flex:1;min-width:0;padding:4px 6px;border-radius:6px;font-size:10px;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14)">' +
    '          <button class="zb-btn" id="zb-preset-save" style="padding:4px 8px;flex:none">保存</button>' +
    '        </div>' +
    '        <div id="zb-preset-list"></div>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<div id="zb-dropzone" hidden><div>松开导入壁纸</div></div>' +
    '<div id="zb-lib-view" hidden>' +
    '  <div id="zb-lib-head"><span>🖼 壁纸库</span><span id="zb-lib-close">✕</span></div>' +
    '  <div id="zb-lib-filter">' +
    '    <button class="zb-chip" data-f="all" data-on="1">全部</button>' +
    '    <button class="zb-chip" data-f="fav" title="只看收藏的">⭐</button>' +
    '    <button class="zb-chip" data-f="video">▶ 视频</button>' +
    '    <button class="zb-chip" data-f="image">🖼 图片</button>' +
    '    <button class="zb-chip" data-f="scene">✦ 场景</button>' +
    '    <input id="zb-lib-search" placeholder="搜标题…">' +
    '    <button id="zb-grid-toggle" title="切换网格大小">▦ 大图</button>' +
    '  </div>' +
    '  <div id="zb-lib-grid"></div>' +
    '</div>' +
    '<div id="zb-lib-preview" hidden></div>' +
    '<div id="zb-status"></div>';
  document.body.appendChild(root);

  function $(id) { return document.getElementById(id); }
  function wallpaperEl() { return document.getElementById('zcode-beautify-wallpaper'); }
  function status(msg) {
    var el = $('zb-status'); if (!el) return;
    el.textContent = msg;
    setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 2200);
  }
  function auth(extra) {
    var h = extra || {};
    h['x-zb-token'] = TOKEN;
    return h;
  }
  function post(path, body, cb) {
    fetch(API + path, { method: 'POST', headers: auth({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.error) { status('操作失败: ' + d.error); return; }
        if (cb) cb(d);
      })
      .catch(function () { status('无法连接美化服务 service unreachable'); });
  }

  // Local live preview; the server re-injects the authoritative CSS right after.
  function preview() {
    var w = wallpaperEl(); if (!w) return;
    var b = Number($('zb-blur').value), d = Number($('zb-dim').value);
    w.style.filter = b > 0 ? 'blur(' + b + 'px)' : 'none';
    w.style.transform = b > 0 ? 'scale(1.04)' : 'none';
    document.documentElement.style.setProperty('--zcode-beautify-dim', String(d / 100));
  }

  var pushTimer = null;
  function pushConfig() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      post('/api/config', {
        blur: Number($('zb-blur').value),
        dim: Number($('zb-dim').value),
        monet: $('zb-monet').checked,
        wallpaperVisible: $('zb-vis').checked
      }, function (d) { status(d && d.windows > 0 ? '已应用 applied' : '已保存(ZCode 未连接)'); });
    }, 300);
  }

  // The control service lives in a separate process that can stop or die. When
  // it is unreachable the panel must say so instead of rendering values it
  // never read, and it must recover on its own once the service is back.
  var beatTimer = null;
  function panelOpen() { return !$('zb-panel').hidden; }
  /** Re-check the service: while the panel is open, and always while offline. */
  function beat(on) {
    if (on && !beatTimer) beatTimer = setInterval(function () { refresh(); refreshStatus(); }, 4000);
    if (!on && beatTimer) { clearInterval(beatTimer); beatTimer = null; }
  }

  function setOffline(on) {
    root.setAttribute('data-offline', on ? '1' : '0');
    $('zb-offline').hidden = !on;
    $('zb-retry').textContent = '重试连接';
    $('zb-fab').title = on ? 'ZCode Beautify — 美化服务未运行' : 'ZCode Beautify';
    if (on) {
      $('zb-blur').value = 0; $('zb-blur-val').textContent = '0';
      $('zb-dim').value = 0; $('zb-dim-val').textContent = '0';
      $('zb-monet').checked = false;
      $('zb-vis').checked = false;
      $('zb-fit').textContent = '背景填充: 未知';
      $('zb-fit').removeAttribute('data-fit');
      $('zb-reset').textContent = '还原默认外观';
      $('zb-reset').setAttribute('data-mode', 'reset');
      beat(true);
    } else {
      if (!panelOpen()) beat(false);
    }
  }

  function refresh() {
    fetch(API + '/api/config', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        setOffline(false);
        libFavs = c.favorites || [];
        $('zb-blur').value = c.blur; $('zb-blur-val').textContent = c.blur;
        $('zb-dim').value = c.dim; $('zb-dim-val').textContent = c.dim;
        $('zb-monet').checked = !!c.monet;
        $('zb-vis').checked = !!c.wallpaperVisible;
        $('zb-fit') && applyFitLabel($('zb-fit'), c.fit || 'cover');
        $('zb-video-mute').checked = c.videoMuted !== false;
        $('zb-livecolor').checked = !!c.videoLiveColor;
        $('zb-video-row').style.display = c.videoSet ? 'flex' : 'none';
        $('zb-web-row').style.display = c.webSet ? 'flex' : 'none';
        if (document.activeElement !== $('zb-web')) $('zb-web').value = c.webUrl || '';
        var fx = c.effects || {};
        $('zb-fx-kb').checked = !!fx.kenburns;
        $('zb-fx-par').checked = !!fx.parallax;
        $('zb-fx-parts').value = fx.particles || 'none';
        $('zb-fx-int').value = Math.round((typeof fx.intensity === 'number' ? fx.intensity : 0.5) * 100);
        var pl = c.playlist || [];
        $('zb-rot').value = String(c.rotateMin || 0);
        var list = $('zb-pl-list'); list.innerHTML = '';
        pl.forEach(function (p, idx) {
          var row = document.createElement('div'); row.className = 'zb-pl-row';
          var name = document.createElement('span'); name.className = 'zb-pl-name';
          name.textContent = p.split(String.fromCharCode(92)).pop().split('/').pop();
          name.title = p;
          var del = document.createElement('span'); del.className = 'zb-pl-del'; del.textContent = '✕';
          del.addEventListener('click', function () {
            var next = pl.slice(); next.splice(idx, 1);
            post('/api/config', { playlist: next }, function () { refresh(); });
          });
          row.appendChild(name); row.appendChild(del); list.appendChild(row);
        });
        if (!pl.length) { var hint = document.createElement('div'); hint.className = 'zb-pl-row'; hint.style.opacity = '.5'; hint.textContent = '（列表为空,点「+ 收藏当前」加入）'; list.appendChild(hint); }
        if (document.activeElement !== $('zb-night')) $('zb-night').value = c.nightPath || '';
        $('zb-autorepair').checked = c.autoRepair !== false;
        $('zb-pg-hide').checked = (c.perfGuard || {}).pauseHidden !== false;
        $('zb-pg-bat').checked = (c.perfGuard || {}).batteryStill !== false;
        // current wallpaper card
        var curName = $('zb-cur-name'), curType = $('zb-cur-type'), curThumb = $('zb-cur-thumb');
        if (c.currentPath || c.webSet) {
          var shownName = c.webSet ? ($('zb-web').value || c.webUrl || '网页壁纸') : c.currentPath;
          curName.textContent = c.webSet ? '网页壁纸' : shownName.split(String.fromCharCode(92)).pop().split('/').pop();
          curName.title = c.webSet ? (c.webUrl || '') : c.currentPath;
          curType.textContent = c.webSet ? '🌐 网页壁纸' : (c.videoSet ? '▶ 视频壁纸' : '图片壁纸');
          if (!c.videoSet && !c.webSet) {
            curThumb.style.display = 'block';
            curThumb.classList.remove('no-media');
            curThumb.textContent = '';
            curThumb.src = API + '/api/thumb?size=320&token=' + TOKEN + '&path=' + encodeURIComponent(c.currentPath);
          } else {
            curThumb.removeAttribute('src');
            curThumb.style.display = 'flex';
            curThumb.classList.add('no-media');
            curThumb.textContent = c.webSet ? '🌐' : '▶';
          }
        } else {
          curName.textContent = '默认外观';
          curType.textContent = '尚未设置壁纸';
          curThumb.removeAttribute('src');
          curThumb.style.display = 'flex';
          curThumb.classList.add('no-media');
          curThumb.textContent = '🎨';
        }
        var resetBtn = $('zb-reset');
        if (c.wallpaperSet) {
          resetBtn.textContent = '还原默认外观';
          resetBtn.setAttribute('data-mode', 'reset');
          resetBtn.title = '移除壁纸与配色,还原 ZCode 默认外观(壁纸会被记住,可再次恢复)';
        } else if (c.hasBackup) {
          resetBtn.textContent = '恢复我的壁纸';
          resetBtn.setAttribute('data-mode', 'restore');
          resetBtn.title = '从备份恢复你之前的壁纸与配色';
        } else {
          resetBtn.textContent = '还原默认外观';
          resetBtn.setAttribute('data-mode', 'reset');
          resetBtn.title = '当前已是默认外观';
        }
      })
      .catch(function () { setOffline(true); });
  }

  $('zb-blur').addEventListener('input', function () {
    $('zb-blur-val').textContent = this.value; preview(); pushConfig();
  });
  $('zb-dim').addEventListener('input', function () {
    $('zb-dim-val').textContent = this.value; preview(); pushConfig();
  });
  $('zb-monet').addEventListener('change', pushConfig);
  $('zb-vis').addEventListener('change', pushConfig);

  var FITS = ['cover', 'contain', 'smart'];
  var FIT_LABELS = { cover: '填满裁剪', contain: '完整显示', smart: '智能适配' };
  function applyFitLabel(btn, fit) {
    btn.textContent = '背景填充: ' + (FIT_LABELS[fit] || fit);
    btn.setAttribute('data-fit', fit);
  }
  $('zb-fit').addEventListener('click', function () {
    var current = this.getAttribute('data-fit') || 'cover';
    var next = FITS[(FITS.indexOf(current) + 1) % FITS.length];
    applyFitLabel(this, next);
    post('/api/config', { fit: next }, function (d) { status(d && d.windows > 0 ? '已应用:' + FIT_LABELS[next] : '已保存(ZCode 未连接)'); });
  });

  $('zb-file').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) { status('图片过大,上限 20 MB'); return; }
    var fr = new FileReader();
    fr.onload = function () {
      post('/api/wallpaper', { dataUri: fr.result, name: f.name }, function () { status('壁纸已更新 updated'); });
    };
    fr.readAsDataURL(f);
  });

  function applyPath() {
    var input = $('zb-path');
    var p = (input.value || '').trim();
    if (!p) { status('请先粘贴图片或视频路径'); return; }
    status('正在导入…');
    post('/api/wallpaper-path', { path: p }, function (d) {
      if (d && d.ok) {
        status(d.video ? '视频壁纸已应用' : '壁纸已更新 updated');
        input.value = '';
        refresh();
      }
    });
  }
  $('zb-path-apply').addEventListener('click', applyPath);
  $('zb-path').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyPath(); });

  $('zb-video-stop').addEventListener('click', function () {
    var btn = this;
    btn.textContent = '停止中…';
    post('/api/video-stop', {}, function () {
      btn.textContent = '■ 停止视频';
      status('视频已停止,回到图片壁纸');
      refresh();
    });
    btn.textContent = '■ 停止视频';
  });
  $('zb-video-mute').addEventListener('change', function () {
    var muted = this.checked;
    post('/api/video-mute', { muted: muted }, function () {
      status(muted ? '已静音' : '已开声音');
    });
  });

  // --- effects ----------------------------------------------------------------
  function pushEffects(patch) {
    var fx = {
      kenburns: $('zb-fx-kb').checked,
      parallax: $('zb-fx-par').checked,
      particles: $('zb-fx-parts').value,
      intensity: Number($('zb-fx-int').value) / 100
    };
    Object.assign(fx, patch);
    post('/api/config', { effects: fx }, function (d) {
      status(d && d.windows > 0 ? '特效已应用' : '已保存(ZCode 未连接)');
    });
  }
  $('zb-fx-kb').addEventListener('change', function () { pushEffects({}); });
  $('zb-fx-par').addEventListener('change', function () { pushEffects({}); });
  $('zb-fx-parts').addEventListener('change', function () { pushEffects({}); });
  $('zb-fx-int').addEventListener('input', function () { pushEffects({}); });

  // --- carousel ---------------------------------------------------------------
  $('zb-rot').addEventListener('change', function () {
    post('/api/config', { rotateMin: Number(this.value) }, function (d) {
      status(d ? '轮换设置已保存' : '');
    });
  });
  $('zb-pl-add').addEventListener('click', function () {
    fetch(API + '/api/config', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (c) {
        var cur = c.currentPath;
        if (!cur) { status('当前没有正在使用的壁纸'); return; }
        var pl = (c.playlist || []).slice();
        if (pl.indexOf(cur) >= 0) { status('已经在轮播列表里了'); return; }
        if (pl.length >= 30) { status('列表最多 30 张'); return; }
        pl.push(cur);
        post('/api/config', { playlist: pl }, function () { status('已加入轮播'); refresh(); });
      })
      .catch(function () { status('无法连接美化服务'); });
  });
  $('zb-night-apply').addEventListener('click', function () {
    var p = ($('zb-night').value || '').trim();
    if (!p) { status('请先粘贴夜间壁纸路径'); return; }
    post('/api/config', { nightPath: p }, function (d) {
      if (d && d.ok) status('夜间壁纸已保存(19:00-7:00 生效)');
      refresh();
    });
  });

  // --- repair + live color ----------------------------------------------------
  $('zb-autorepair').addEventListener('change', function () {
    var on = this.checked;
    post('/api/config', { autoRepair: on }, function () {
      status(on ? '已开启自动修复' : '已关闭自动修复');
    });
  });
  function pushPerfGuard(patch) {
    var pg = {
      pauseHidden: $('zb-pg-hide').checked,
      batteryStill: $('zb-pg-bat').checked
    };
    Object.assign(pg, patch);
    post('/api/config', { perfGuard: pg }, function () { status('性能守护设置已保存'); });
  }
  $('zb-pg-hide').addEventListener('change', function () { pushPerfGuard({}); });
  $('zb-pg-bat').addEventListener('change', function () { pushPerfGuard({}); });

  // --- web wallpaper ----------------------------------------------------------
  $('zb-web-apply').addEventListener('click', function () {
    var u = ($('zb-web').value || '').trim();
    if (!u) { status('请先粘贴网页地址(https://…)'); return; }
    status('正在打开网页壁纸…');
    post('/api/config', { webUrl: u }, function (d) {
      if (d && d.ok) { status('网页壁纸已打开'); refresh(); }
    });
  });
  $('zb-web').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('zb-web-apply').click(); });
  $('zb-web-stop').addEventListener('click', function () {
    post('/api/web-stop', {}, function (d) {
      if (d && d.ok) { status('网页已停止,回到静态图片'); refresh(); }
    });
  });
  $('zb-livecolor').addEventListener('change', function () {
    post('/api/config', { videoLiveColor: this.checked }, function (d) {
      status(d && d.ok ? (d.videoLiveColor ? '实时取色已开启' : '实时取色已关闭') : '');
    });
  });

  // --- wallpaper library ------------------------------------------------------
  var libItems = [], libFilter = 'all', libQuery = '', libFavs = [];
  function dimBadgeText(it) {
    if (it.dims) {
      var m = Math.max(it.dims.w, it.dims.h);
      if (m >= 7680) return '8K';
      if (m >= 3840) return '4K';
      if (m >= 2560) return '2K';
      if (m >= 1920) return '1080p';
      if (m >= 1280) return '720p';
      return '小图';
    }
    if (it.type === 'scene' && !it.stillPath) return '未提取';
    return '';
  }
  function hideLibPreview() {
    var pv = $('zb-lib-preview');
    pv.hidden = true;
    var v = pv.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    pv.innerHTML = '';
  }
  function showLibPreview(it) {
    var pv = $('zb-lib-preview');
    pv.innerHTML = '';
    if (it.type === 'video' && it.streamUrl) {
      var v = document.createElement('video');
      v.muted = true; v.loop = true; v.autoplay = true;
      v.setAttribute('playsinline', '');
      v.src = API + it.streamUrl;
      pv.appendChild(v);
      var pp = v.play(); if (pp && pp.catch) pp.catch(function () {});
    } else if (it.previewUrl) {
      var img = document.createElement('img');
      img.src = API + it.previewUrl;
      pv.appendChild(img);
    } else { pv.hidden = true; return; }
    var cap = document.createElement('div');
    cap.className = 'zb-pv-cap';
    cap.textContent = it.title + (it.dims ? '　·　' + it.dims.w + '×' + it.dims.h : '');
    cap.title = cap.textContent;
    pv.appendChild(cap);
    pv.hidden = false;
  }
  function renderLib() {
    var grid = $('zb-lib-grid');
    var cols4 = localStorage.getItem('zcode-beautify:libcols') === '4';
    grid.className = cols4 ? 'cols4' : '';
    $('zb-grid-toggle').textContent = cols4 ? '▦ 小图' : '▦ 大图';
    grid.innerHTML = '';
    var q = libQuery.toLowerCase();
    var shown = libItems.filter(function (it) {
      if (libFilter === 'fav') { if (libFavs.indexOf(it.id) < 0) return false; }
      else if (libFilter !== 'all' && it.type !== libFilter) return false;
      if (q && it.title.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    shown.sort(function (a, b) {
      var fa = libFavs.indexOf(a.id) >= 0, fb = libFavs.indexOf(b.id) >= 0;
      return fa === fb ? 0 : (fa ? -1 : 1);
    });
    if (!shown.length) { grid.innerHTML = '<div class="zb-lib-sec">没有匹配的壁纸</div>'; return; }
    shown.forEach(function (it) {
      var badge = it.type === 'video' ? '▶ ' : '';
      var isFav = libFavs.indexOf(it.id) >= 0;
      var cell = document.createElement('div');
      cell.className = 'zb-lib-cell' + (isFav ? ' fav' : '');
      var img = document.createElement('img');
      img.src = it.thumbUrl ? API + it.thumbUrl : '';
      img.loading = 'lazy';
      img.alt = it.title;
      var cap = document.createElement('div');
      cap.className = 'zb-lib-cap';
      cap.textContent = badge + it.title;
      cap.title = it.title;
      var star = document.createElement('span');
      star.className = 'zb-star' + (isFav ? ' on' : '');
      star.textContent = isFav ? '⭐' : '☆';
      star.title = isFav ? '取消收藏' : '收藏(排最前)';
      star.addEventListener('click', function (e) {
        e.stopPropagation();
        var arr = libFavs.slice();
        var idx = arr.indexOf(it.id);
        if (idx >= 0) arr.splice(idx, 1); else arr.push(it.id);
        libFavs = arr;
        post('/api/config', { favorites: arr }, function () { renderLib(); });
      });
      cell.appendChild(img);
      var dimText = dimBadgeText(it);
      if (dimText) {
        var dimBadge = document.createElement('span');
        dimBadge.className = 'zb-dimbadge' + (dimText === '未提取' ? ' warn' : '');
        dimBadge.textContent = dimText;
        cell.appendChild(dimBadge);
      }
      cell.appendChild(star);
      cell.appendChild(cap);
      cell.addEventListener('click', function () {
        status('正在应用…');
        post('/api/library-apply', { id: it.id }, function (dd) {
          if (dd && dd.ok) { status('已应用: ' + it.title); refresh(); }
        });
      });
      cell.addEventListener('mouseenter', function () { showLibPreview(it); });
      cell.addEventListener('mouseleave', hideLibPreview);
      grid.appendChild(cell);
    });
  }
  $('zb-grid-toggle').addEventListener('click', function () {
    localStorage.setItem('zcode-beautify:libcols', localStorage.getItem('zcode-beautify:libcols') === '4' ? '2' : '4');
    renderLib();
  });
  $('zb-lib').addEventListener('click', function () {
    $('zb-lib-view').hidden = false;
    var grid = $('zb-lib-grid');
    grid.innerHTML = '<div class="zb-lib-sec">加载中…</div>';
    fetch(API + '/api/library', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        libItems = d.items || [];
        if (!libItems.length) { grid.innerHTML = '<div class="zb-lib-sec">没有找到壁纸（工坊目录不存在或为空）</div>'; return; }
        renderLib();
      })
      .catch(function () { grid.innerHTML = '<div class="zb-lib-sec">无法连接美化服务</div>'; });
  });
  Array.from(document.querySelectorAll('#zb-lib-filter .zb-chip')).forEach(function (chip) {
    chip.addEventListener('click', function () {
      libFilter = this.getAttribute('data-f');
      Array.from(document.querySelectorAll('#zb-lib-filter .zb-chip')).forEach(function (c) {
        c.setAttribute('data-on', c === chip ? '1' : '0');
      });
      renderLib();
    });
  });
  var libSearchTimer = null;
  $('zb-lib-search').addEventListener('input', function () {
    clearTimeout(libSearchTimer);
    var v = this.value;
    libSearchTimer = setTimeout(function () { libQuery = v; renderLib(); }, 200);
  });
  $('zb-lib-close').addEventListener('click', function () {
    $('zb-lib-view').hidden = true;
    hideLibPreview();
  });

  // --- tabs -------------------------------------------------------------------
  Array.from(document.querySelectorAll('#zb-tabs .zb-tab')).forEach(function (tab) {
    tab.addEventListener('click', function () {
      Array.from(document.querySelectorAll('#zb-tabs .zb-tab')).forEach(function (t2) {
        t2.setAttribute('data-on', t2 === tab ? '1' : '0');
      });
      var t = tab.getAttribute('data-t');
      Array.from(document.querySelectorAll('#zb-body .zb-page')).forEach(function (pg) {
        pg.hidden = pg.id !== 'zb-page-' + t;
      });
      if (t === 'set') loadPresets();
    });
  });
  function loadPresets() {
    fetch(API + '/api/presets', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(function (d) { renderPresets(d.presets || []); })
      .catch(function () {});
  }
  function renderPresets(list) {
    var el = $('zb-preset-list');
    el.innerHTML = '';
    if (!list.length) {
      var h = document.createElement('div');
      h.className = 'zb-preset-row';
      h.style.opacity = '.5';
      h.textContent = '（还没有快照——调好外观后起个名字保存）';
      el.appendChild(h);
      return;
    }
    list.forEach(function (ps) {
      var row = document.createElement('div');
      row.className = 'zb-preset-row';
      var name = document.createElement('span');
      name.className = 'zb-preset-name';
      name.textContent = '📸 ' + ps.name;
      name.title = '点击应用快照: ' + ps.name;
      name.addEventListener('click', function () {
        status('正在应用快照…');
        post('/api/presets-apply', { name: ps.name }, function (d) {
          if (d && d.ok) { status('快照已应用: ' + ps.name); refresh(); }
        });
      });
      var del = document.createElement('span');
      del.className = 'zb-preset-del';
      del.textContent = '✕';
      del.title = '删除快照';
      del.addEventListener('click', function () {
        post('/api/presets-del', { name: ps.name }, function () { status('快照已删除'); loadPresets(); });
      });
      row.appendChild(name);
      row.appendChild(del);
      el.appendChild(row);
    });
  }
  $('zb-preset-save').addEventListener('click', function () {
    var name = ($('zb-preset-name').value || '').trim();
    if (!name) { status('请先输入快照名称'); return; }
    post('/api/presets-save', { name: name }, function (d) {
      if (d && d.ok) { status('快照已保存: ' + name); $('zb-preset-name').value = ''; renderPresets(d.presets || []); }
    });
  });

  // --- drag & drop import (active only while the panel is open, so the app's
  // own chat-attach drag flow is untouched the rest of the time) ---------------
  var dropHideTimer = null;
  function panelOpenNow() { return !$('zb-panel').hidden; }
  window.addEventListener('dragover', function (e) {
    if (!panelOpenNow()) return;
    if (!e.dataTransfer || Array.prototype.indexOf.call((e.dataTransfer).types, 'Files') < 0) return;
    e.preventDefault();
    $('zb-dropzone').hidden = false;
    clearTimeout(dropHideTimer);
    dropHideTimer = setTimeout(function () { $('zb-dropzone').hidden = true; }, 450);
  }, true);
  window.addEventListener('drop', function (e) {
    if (!panelOpenNow()) return;
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    e.stopPropagation();
    $('zb-dropzone').hidden = true;
    var p = f.path;
    if (p) {
      status('正在导入拖入的文件…');
      post('/api/wallpaper-path', { path: p }, function (d) {
        if (d && d.ok) { status('已导入: ' + p.split(String.fromCharCode(92)).pop().split('/').pop()); refresh(); }
      });
    } else if (/^image[/]/.test(f.type) && f.size <= 20 * 1024 * 1024) {
      var fr = new FileReader();
      fr.onload = function () {
        post('/api/wallpaper', { dataUri: fr.result, name: f.name }, function () { status('壁纸已更新'); refresh(); });
      };
      fr.readAsDataURL(f);
    } else {
      status('拖入的文件无法导入');
    }
  }, true);

  $('zb-reset').addEventListener('click', function () {
    var mode = this.getAttribute('data-mode') || 'reset';
    post(mode === 'restore' ? '/api/restore' : '/api/reset', {}, function () {
      if (mode === 'reset') {
        try { localStorage.removeItem('zcode-beautify:css'); localStorage.removeItem('zcode-beautify:wallpaper'); localStorage.removeItem('zcode-beautify:video'); } catch (e) {}
        status('已还原默认外观');
      } else {
        status('已恢复你的壁纸');
      }
      refresh();
    });
  });

  $('zb-retry').addEventListener('click', function () {
    this.textContent = '正在重试…';
    refresh();
  });

  // The service answers but ZCode is not listening for it: either the app is
  // closed, or it came up without the debug port. The second case is the one
  // the plugin cannot fix on its own, and the only lever is a proper restart.
  var RECOVERY_HINTS = {
    off: 'ZCode 重启后不会自动恢复,需要手动重新应用。',
    'on-start': 'ZCode 每次启动时自动恢复一次,不占内存;设置面板不会自动出现。',
    always: '后台常驻一个小服务(约 60MB 内存),壁纸自动恢复,设置面板随时可用。'
  };

  function applyStatus(s) {
    $('zb-needs-relaunch').hidden = !(s && !s.cdpReachable && s.zcodeRunning);
    if (s && s.recovery) {
      var sel = $('zb-recovery');
      if (sel && document.activeElement !== sel) sel.value = s.recovery.mode;
      var hint = $('zb-recovery-hint');
      if (hint) hint.textContent = RECOVERY_HINTS[s.recovery.mode] || '';
    }
  }

  function refreshStatus() {
    fetch(API + '/api/status', { headers: auth() })
      .then(function (r) { return r.json(); })
      .then(applyStatus)
      .catch(function () { /* the offline banner already covers this */ });
  }

  $('zb-relaunch').addEventListener('click', function () {
    var btn = this;
    btn.textContent = '正在重启 ZCode,请稍候…';
    btn.disabled = true;
    post('/api/relaunch', {}, function () {
      btn.textContent = '立即重启 ZCode';
      btn.disabled = false;
      status('ZCode 已重启,壁纸马上回来');
      setTimeout(refresh, 2000);
      setTimeout(refreshStatus, 3000);
    });
  });

  $('zb-recovery').addEventListener('change', function () {
    var value = this.value;
    post('/api/recovery', { mode: value }, function () {
      var hint = $('zb-recovery-hint');
      if (hint) hint.textContent = RECOVERY_HINTS[value] || '';
      status('自动恢复设置已保存');
    });
  });

  $('zb-fab').addEventListener('click', function () {
    var p = $('zb-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) {
      refresh();
      refreshStatus();
      beat(true);
    } else if (root.getAttribute('data-offline') !== '1') {
      beat(false);
    }
  });
  $('zb-close').addEventListener('click', function () {
    $('zb-panel').hidden = true;
    $('zb-lib-view').hidden = true;
    hideLibPreview();
    if (root.getAttribute('data-offline') !== '1') beat(false);
  });

  // Fill in the fit label (and control values) right away, not just on open.
  refresh();
  refreshStatus();

  (function () {
    var head = $('zb-head'), panel = $('zb-panel');
    var sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('pointerdown', function (e) {
      dragging = true; sx = e.clientX; sy = e.clientY;
      var r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var x = Math.max(4, Math.min(window.innerWidth - 80, ox + e.clientX - sx));
      var y = Math.max(4, Math.min(window.innerHeight - 60, oy + e.clientY - sy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
    });
    head.addEventListener('pointerup', function () { dragging = false; });
  })();

  // Self-heal: if the theme style is missing but a previous injection saved it,
  // restore it from localStorage. A saved video URL wins over the still image.
  if (!document.getElementById('zcode-beautify-style')) {
    var savedCss = null, savedWp = null, savedVid = null;
    try {
      savedCss = localStorage.getItem('zcode-beautify:css');
      savedWp = localStorage.getItem('zcode-beautify:wallpaper');
      savedVid = localStorage.getItem('zcode-beautify:video');
    } catch (e) {}
    if (savedCss) {
      var s = document.createElement('style');
      s.id = 'zcode-beautify-style';
      s.textContent = savedCss;
      (document.head || document.documentElement).appendChild(s);
      if (savedVid && !document.getElementById('zcode-beautify-video')) {
        var v = document.createElement('video');
        v.id = 'zcode-beautify-video';
        v.setAttribute('autoplay', ''); v.setAttribute('loop', ''); v.setAttribute('playsinline', '');
        v.muted = true;
        v.src = savedVid;
        document.documentElement.appendChild(v);
        var vp = v.play();
        if (vp && vp.catch) vp.catch(function () {});
      } else if (savedWp && !wallpaperEl() && !savedVid) {
        var w = document.createElement('div');
        w.id = 'zcode-beautify-wallpaper';
        document.documentElement.appendChild(w);
        w.style.backgroundImage = 'url(' + savedWp + ')';
      }
    }
  }
})();`;
}
