/**
 * 包点现场调试面板（site-tuner.js）
 * ---------------------------------------------------------------------------
 * 和武器调参（tuner.js）完全分开：独立按钮、独立面板、独立数据文件。
 *
 * 打开方式：右上角「包点」按钮（在「调参」按钮正上方），
 * 开关在 config.js 的 DEV.siteTuner（0 关 / 1 开）。
 *
 * 面板里改 x / z / r 会立刻写进 src/bomb-sites.js 的数据对象，
 * 黄色圈、地面染色、下包判定同时跟着变，不用刷新。
 * 调好以后点「导出 bomb-sites.js」，覆盖项目里的同名文件即可永久生效。
 */
import { SITE_TUNE, BOMB_SITES } from './bomb-sites.js?v=r90';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const isPhone = () => window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;

/** 把数组压成单行，导出的文件更好读（和 view-tune.js 的导出一致） */
const compactJson = (v) => JSON.stringify(v, null, 2)
  .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.split(/,\s*/).join(', ') + ']');

export function initSiteTuner({ onChanged, teleport, getPlayer, onToggle } = {}) {
  // 面板里的「还原」用这份快照（= 游戏启动时读到的那份文件）
  const defaults = JSON.parse(JSON.stringify(BOMB_SITES));
  let toastTimer = 0;

  // ---------------------------------------------------------------- 按钮
  const btn = document.createElement('button');
  btn.id = 'siteBtn';
  btn.type = 'button';
  btn.textContent = '包点';
  btn.title = '包点位置 / 半径现场调试（J 键）';
  document.body.appendChild(btn);

  // ---------------------------------------------------------------- 面板
  const panel = document.createElement('div');
  panel.id = 'siteTuner';
  panel.className = 'hidden';
  panel.innerHTML = `
    <div class="st-head">
      <span class="st-grip"></span>
      <b>包点调试</b>
      <span class="st-src">bomb-sites.js</span>
      <button class="st-x" type="button" aria-label="关闭">×</button>
    </div>
    <div class="st-body">
      <div class="st-sites"></div>
      <div class="st-me">
        <span class="st-me-txt">玩家位置 —</span>
        <div class="st-me-btns">
          <button type="button" data-set="0">设为 A</button>
          <button type="button" data-set="1">设为 B</button>
        </div>
      </div>
      <div class="st-foot">
        <button class="st-primary" type="button" data-act="export">导出 bomb-sites.js</button>
        <button class="st-ghost" type="button" data-act="reset">还原</button>
      </div>
      <div class="st-note">改完点「导出」，覆盖项目里的 <code>src/bomb-sites.js</code> 即可永久生效。刷新页面会回到文件里的值。</div>
      <div class="st-toast"></div>
    </div>
    <div class="st-resize" title="拖动调整大小（双击恢复默认）"></div>
  `;
  document.body.appendChild(panel);
  const bodyEl = panel.querySelector('.st-body');
  const sitesEl = panel.querySelector('.st-sites');
  const meEl = panel.querySelector('.st-me-txt');
  const toastEl = panel.querySelector('.st-toast');

  const FIELDS = [
    { key: 'x', label: 'X', min: -90, max: 90 },
    { key: 'z', label: 'Z', min: -130, max: 60 },
    { key: 'r', label: '半径', min: 1, max: 30 },
  ];

  // 每个包点一张卡片：坐标 + 半径，滑杆和数字输入双向同步
  const cards = BOMB_SITES.map((site, i) => {
    const sec = document.createElement('section');
    sec.className = 'st-site';
    sec.innerHTML = `
      <div class="st-title">
        <b class="st-key">${site.key}</b>
        <span class="st-name">${site.name}</span>
        <button class="st-tp" type="button" data-tp="${i}">传送到此</button>
      </div>
      ${FIELDS.map(f => `
      <label class="st-row">
        <span class="st-lab">${f.label}</span>
        <input class="st-num" type="number" data-f="${f.key}" step="0.1"
               min="${f.min}" max="${f.max}">
        <input class="st-range" type="range" data-f="${f.key}" step="0.25"
               min="${f.min}" max="${f.max}">
      </label>`).join('')}
    `;
    sitesEl.appendChild(sec);

    const inputs = [...sec.querySelectorAll('[data-f]')];
    const sync = () => {
      for (const el of inputs) el.value = site[el.dataset.f];
    };
    const commit = (el) => {
      const v = +el.value;
      if (!Number.isFinite(v)) return;
      site[el.dataset.f] = clamp(v, FIELDS.find(f => f.key === el.dataset.f).min,
                                    FIELDS.find(f => f.key === el.dataset.f).max);
      sync();
      onChanged && onChanged();
    };
    for (const el of inputs) {
      el.addEventListener('input', () => commit(el));
      // 数字框失焦时把超范围的值拉回来
      el.addEventListener('change', () => { sync(); onChanged && onChanged(); });
      // 点面板不要穿透到游戏（开枪 / 转视角）
      el.addEventListener('pointerdown', e => e.stopPropagation());
    }
    sec.querySelector('[data-tp]').addEventListener('click', () => {
      teleport && teleport(site.x, site.z);
      toast(`已传送到 ${site.name}`);
    });
    sync();
    return { sec, sync };
  });

  const refreshAll = () => { for (const c of cards) c.sync(); };

  // ---------------------------------------------------------------- 交互
  panel.addEventListener('pointerdown', e => e.stopPropagation());
  panel.addEventListener('mousedown', e => e.stopPropagation());

  let open = false;
  function setOpen(v) {
    open = !!v;
    panel.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    if (open) {
      if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) {} }
      refreshAll();
      tickMe();
    }
    onToggle && onToggle(open);
  }
  btn.addEventListener('click', () => setOpen(!open));
  panel.querySelector('.st-x').addEventListener('click', () => setOpen(false));

  // 窗口右上角贴住「调参」按钮的正上方
  function placeBtn() {
    const tb = document.getElementById('tuneBtn');
    const w = btn.offsetWidth, h = btn.offsetHeight;
    const r = tb ? tb.getBoundingClientRect() : null;
    // fixed 定位元素的 offsetParent 恒为 null，不能用它判断可见性，量宽度最稳
    if (r && r.width > 0) {
      btn.style.right = Math.max(8, Math.round(window.innerWidth - r.right)) + 'px';
      btn.style.top = Math.max(8, Math.round(r.top - h - 8)) + 'px';
    } else {
      btn.style.right = '14px';
      btn.style.top = isPhone() ? '42px' : '14px';
    }
    return w && h;
  }
  placeBtn();
  window.addEventListener('resize', placeBtn);
  // 调参按钮是启动后才创建的，稍后再对一次位
  setTimeout(placeBtn, 0);
  setTimeout(placeBtn, 800);

  // 玩家坐标：打开面板时和每 0.4 秒刷新一次
  function tickMe() {
    if (!open || !getPlayer) return;
    const p = getPlayer();
    if (p) meEl.textContent = `玩家 X ${p.x.toFixed(1)} · Z ${p.z.toFixed(1)}`;
  }
  setInterval(tickMe, 400);

  for (const b of panel.querySelectorAll('[data-set]')) {
    b.addEventListener('click', () => {
      const i = +b.dataset.set, site = BOMB_SITES[i];
      if (!site || !getPlayer) return;
      const p = getPlayer();
      site.x = +p.x.toFixed(2);
      site.z = +p.z.toFixed(2);
      refreshAll();
      onChanged && onChanged();
      toast(`${site.name} 已移到你脚下`);
    });
  }

  // ---------------------------------------------------------------- 拖动
  const head = panel.querySelector('.st-head');
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.st-x')) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture && head.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const x = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - w - 4));
    const y = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - h - 4));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  });
  const endDrag = () => { drag = null; panel.classList.remove('dragging'); };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  // ---------------------------------------------------------------- 缩放
  // 面板宽度原来是写死的 340px，坐标/半径六个滑杆挤在一列里，
  // 想看清数字只能放大网页。这里给右下角一个把手，拖多大都行，
  // 双击把手回到默认尺寸（高度回 auto，跟着内容走）。
  const rz = panel.querySelector('.st-resize');
  let sizing = null;
  rz.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = panel.getBoundingClientRect();
    sizing = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
    rz.setPointerCapture && rz.setPointerCapture(e.pointerId);
    panel.classList.add('sizing');
  });
  rz.addEventListener('pointermove', (e) => {
    if (!sizing) return;
    const maxW = Math.max(240, window.innerWidth - 16);
    const maxH = Math.max(160, window.innerHeight - 16);
    panel.style.width = Math.round(clamp(sizing.w + e.clientX - sizing.x, 248, maxW)) + 'px';
    panel.style.height = Math.round(clamp(sizing.h + e.clientY - sizing.y, 180, maxH)) + 'px';
  });
  const endSize = () => { sizing = null; panel.classList.remove('sizing'); };
  rz.addEventListener('pointerup', endSize);
  rz.addEventListener('pointercancel', endSize);
  rz.addEventListener('dblclick', () => {
    panel.style.width = '';
    panel.style.height = '';
    toast('已恢复默认大小');
  });

  // ---------------------------------------------------------------- 提示
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2200);
  }

  // ---------------------------------------------------------------- 导出
  function buildFile() {
    const payload = {
      version: SITE_TUNE.version || 1,
      stamp: new Date().toISOString(),
      sites: BOMB_SITES.map(s => ({
        key: s.key, name: s.name,
        x: +(+s.x).toFixed(2), z: +(+s.z).toFixed(2), r: +(+s.r).toFixed(2),
      })),
    };
    const when = new Date().toLocaleString('zh-CN', { hour12: false });
    return `/**
 * 包点存档（bomb-sites.js）
 * ---------------------------------------------------------------------------
 * 由游戏内「包点」调试面板导出，导出时间：${when}
 * 直接覆盖项目里的 src/bomb-sites.js，刷新页面即可保留全部调整。
 *
 * 说明：本文件是包点数据的唯一来源。游戏里的判定范围、地面黄色圈、
 * 圈内的地面染色都用下面这份数据，改完刷新即可生效。
 *
 * x / z：包点圆心在世界里的坐标（米）
 * r    ：包点半径（米），一个值同时决定「能下包的范围」和「黄色圈的大小」
 */
export const SITE_TUNE = ${compactJson(payload)};

/** 实际使用的包点数组（和 SITE_TUNE.sites 是同一个引用，改了立刻生效） */
export const BOMB_SITES = SITE_TUNE.sites;
`;
  }

  function downloadText(name, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  panel.querySelector('[data-act="export"]').addEventListener('click', () => {
    downloadText('bomb-sites.js', buildFile(), 'text/javascript');
    toast('已导出 bomb-sites.js，覆盖 src/bomb-sites.js 即可');
  });

  panel.querySelector('[data-act="reset"]').addEventListener('click', () => {
    BOMB_SITES.forEach((s, i) => {
      const d = defaults[i];
      if (!d) return;
      s.x = d.x; s.z = d.z; s.r = d.r;
    });
    refreshAll();
    onChanged && onChanged();
    toast('已还原到文件里的值');
  });

  // J 键开关（B 被购买菜单占用，P 被武器调参占用）
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyJ' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      setOpen(!open);
    }
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    refresh: () => { refreshAll(); onChanged && onChanged(); },
  };
}
