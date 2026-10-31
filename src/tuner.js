import * as THREE from 'three';
import { VIEW_TUNE } from './view-tune.js?v=r90';

const DEG = Math.PI / 180;
const STORE = 'cs16.viewtune.v1';
const GEOM = 'cs16.tuner.geom.v1';
const clone = o => JSON.parse(JSON.stringify(o));
const isPhone = () => window.matchMedia('(max-width: 640px), (pointer: coarse)').matches;

// 源码里的原始参数快照（在应用存档之前记录），用于「恢复默认」
let DEFAULTS = {};
// 当前生效的存档来源：'builtin' 表示还在用 config.js 默认
const FILE_STAMP = (VIEW_TUNE && VIEW_TUNE.stamp) || 'builtin';

function applyPatch(defs, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const d of defs) {
    const s = patch[d.id];
    if (!s) continue;
    if (s.view) {
      d.view = d.view || {};
      const patch = clone(s.view);
      // portrait 单独合并：存档里可能只有 k/ox/oy，保留代码里新加的景深 oz
      const portrait = patch.portrait;
      delete patch.portrait;
      Object.assign(d.view, patch);
      if (portrait) d.view.portrait = { ...(d.view.portrait || {}), ...portrait };
    }
    if (s.mount) {
      // 大多数武器是运行时才建「枪体相对手」枢轴，这里先把微调值放到 def 上
      d.fix = d.fix || {};
      if (!d.fix.handMount) d.fix.handMount = { pivot: true };
      d.fix.handMount.tune = clone(s.mount);
    }
    if (s.eject) {
      // 抛壳口位置：直接覆盖到 fix.eject，spawnCasing 读取
      d.fix = d.fix || {};
      d.fix.eject = { r: +s.eject.r, u: +s.eject.u, f: +s.eject.f };
    }
    if (s.muzzle) {
      // 枪口火焰位置偏移：面板入口已移除，但存档里已经调好的值要继续生效
      d.fix = d.fix || {};
      d.fix.muzzle = { r: +s.muzzle.r, u: +s.muzzle.u, f: +s.muzzle.f };
    }
    if (s.caseScale != null) {
      // 弹壳大小缩放
      d.fix = d.fix || {};
      d.fix.casingScale = +s.caseScale;
    }
  }
}

function readStore() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return null;
    if (p.data && typeof p.data === 'object') return { stamp: p.stamp || '', data: p.data };
    // 旧版本（没有 stamp 包裹）直接当作本文件的存档
    return { stamp: FILE_STAMP, data: p };
  } catch (e) { return null; }
}

/**
 * 启动时套用调参存档（必须在创建 Weapon 之前调用）
 * 优先级：view-tune.js（玩家替换过的文件） > 浏览器本机缓存 > config.js 默认
 */
export function applySavedTuning(defs) {
  DEFAULTS = {};
  for (const d of defs) {
    DEFAULTS[d.id] = {
      view: clone(d.view || {}),
      mount: d.fix && d.fix.handMount ? clone(d.fix.handMount.tune || null) : null
    };
  }

  // 1) 存档文件（空文件时不产生任何影响）
  applyPatch(defs, VIEW_TUNE && VIEW_TUNE.weapons);

  // 2) 本机缓存只在「与当前存档文件同一版本」时才叠加，避免旧缓存盖住新替换的文件
  const saved = readStore();
  if (saved) {
    if (saved.stamp === FILE_STAMP) applyPatch(defs, saved.data);
    else { try { localStorage.removeItem(STORE); } catch (e) {} }
  }
}

const fmt = (v, d) => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(d);

function mountTune(w) {
  const cfg = w.def.fix && w.def.fix.handMount;
  if (!cfg) return null;
  if (!cfg.tune) cfg.tune = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };
  if (!cfg.tune.pos) cfg.tune.pos = [0, 0, 0];
  if (!cfg.tune.rotDeg) cfg.tune.rotDeg = [0, 0, 0];
  if (cfg.tune.scale == null) cfg.tune.scale = 1;
  return cfg.tune;
}

// 抛壳口默认偏移（单位米，相对相机：r 右正左负 / u 上正下负 / f 前正后负）
const EJECT_DEFAULT = { r: -0.06, u: 0.02, f: 0.0 };
function ejectTune(w) {
  const fix = w.def.fix || (w.def.fix = {});
  if (!fix.eject) fix.eject = { ...EJECT_DEFAULT };
  if (fix.eject.r == null) fix.eject.r = EJECT_DEFAULT.r;
  if (fix.eject.u == null) fix.eject.u = EJECT_DEFAULT.u;
  if (fix.eject.f == null) fix.eject.f = EJECT_DEFAULT.f;
  return fix.eject;
}

export function initTuner({ weapons, viewCamera, onToggle }) {
  const getW = () => weapons && weapons.current;
  let open = false;
  let lastId = null;
  let saveTimer = 0;
  let toastTimer = 0;

  // 「显示红框」：勾上就一直显示（存 localStorage，重启也在），直到手动取消
  const MUZZLE_BOX_KEY = 'cs16.tuner.muzzlebox';
  let muzzleBoxOn = false;
  try { muzzleBoxOn = localStorage.getItem(MUZZLE_BOX_KEY) === '1'; } catch (e) {}
  function applyMuzzleBox() {
    for (const x of weapons.weapons) {
      if (x._setMuzzleMarker) x._setMuzzleMarker(muzzleBoxOn && x === getW());
    }
  }
  function setMuzzleBox(on) {
    muzzleBoxOn = !!on;
    try { localStorage.setItem(MUZZLE_BOX_KEY, on ? '1' : '0'); } catch (e) {}
    applyMuzzleBox();
  }

  const btn = document.createElement('button');
  btn.id = 'tuneBtn';
  btn.type = 'button';
  btn.textContent = '调参';
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'tuner';
  panel.className = 'tune-win hidden';
  document.body.appendChild(panel);

  // ---------------------------------------------------------------- 窗口几何
  const MINW = 300, MINH = 220;
  let geom = null;

  function defaultGeom() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(isPhone() ? vw - 20 : 380, Math.max(MINW, vw - 24));
    const h = Math.min(Math.max(MINH, Math.round(w * 1.62)), vh - 70);
    const left = Math.max(8, Math.min(12, vw - w - 8));
    const top = Math.max(8, Math.min(isPhone() ? 56 : 12, vh - h - 8));
    return { left, top, w, h };
  }

  function loadGeom() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GEOM) || 'null'); } catch (e) { g = null; }
    if (!g || typeof g !== 'object' || !isFinite(g.left) || !isFinite(g.top) || !isFinite(g.w) || !isFinite(g.h)) {
      return defaultGeom();
    }
    return g;
  }

  function clampGeom(g) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.max(MINW, Math.min(g.w, vw - 12));
    const h = Math.max(MINH, Math.min(g.h, vh - 12));
    const left = Math.max(4, Math.min(g.left, Math.max(4, vw - w - 4)));
    const top = Math.max(4, Math.min(g.top, Math.max(4, vh - h - 4)));
    return { left, top, w, h };
  }

  function applyGeom(persistIt = false) {
    if (!geom) return;
    geom = clampGeom(geom);
    panel.style.left = geom.left + 'px';
    panel.style.top = geom.top + 'px';
    panel.style.width = geom.w + 'px';
    panel.style.height = geom.h + 'px';
    if (persistIt) {
      try { localStorage.setItem(GEOM, JSON.stringify(geom)); } catch (e) {}
    }
  }

  geom = loadGeom();

  // ---------------------------------------------------------------- 取值
  function vals(w) {
    const v = w.def.view || {};
    const p = v.pos || [0, 0, 0];
    const m = w.def.fix && w.def.fix.handMount;
    const t = (m && m.tune) || {};
    const tp = t.pos || [0, 0, 0];
    const tr = t.rotDeg || [0, 0, 0];
    const go = w.gunOffset ? w.gunOffset.toArray() : [0, 0, 0];
    const pt = v.portrait || {};
    const ej = (w.def.fix && w.def.fix.eject) || EJECT_DEFAULT;
    return {
      px: p[0], py: p[1], pz: p[2],
      sc: v.scale || 1,
      rx: v.rx || 0, ry: v.ry || 0, rz: v.rz || 0,
      mir: v.mirror !== false,
      mx: tp[0], my: tp[1], mz: tp[2],
      mrx: tr[0], mry: tr[1], mrz: tr[2],
      msc: t.scale == null ? 1 : t.scale,
      gx: go[0], gy: go[1], gz: go[2],
      er: ej.r == null ? EJECT_DEFAULT.r : ej.r,
      eu: ej.u == null ? EJECT_DEFAULT.u : ej.u,
      ef: ej.f == null ? EJECT_DEFAULT.f : ej.f,
      mr: (w.def.fix && w.def.fix.muzzle && w.def.fix.muzzle.r) || 0,
      mu: (w.def.fix && w.def.fix.muzzle && w.def.fix.muzzle.u) || 0,
      mf: (w.def.fix && w.def.fix.muzzle && w.def.fix.muzzle.f) || 0,
      ec: (w.def.fix && w.def.fix.casingScale) != null ? w.def.fix.casingScale : 1,
      pk: pt.k == null ? 1 : pt.k,
      pox: pt.ox == null ? 0 : pt.ox,
      poy: pt.oy == null ? 0 : pt.oy,
      poz: pt.oz == null ? 0 : pt.oz
    };
  }

  const R = (label, key, min, max, step, dec, val) => `
    <div class="trow"><span class="tl">${label}</span>
      <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${val}">
      <input class="tn" type="number" data-k="${key}" step="${step}" value="${fmt(val, dec)}">
    </div>`;

  // ---------------------------------------------------------------- 面板骨架
  function shell({ name = '', body = '' } = {}) {
    return `
      <div class="tune-head" data-drag>
        <span class="tune-grip"></span>
        <b>武器调参</b>
        <span class="tune-name" data-name>${name}</span>
        <button class="tune-ico" data-act="mini" title="收起 / 展开">—</button>
        <button class="tune-ico tune-x" data-act="close" title="关闭 (P)">×</button>
      </div>
      ${body}
      <div class="tune-resize" data-resize title="拖动改变窗口大小"></div>`;
  }

  function rebuild() {
    const w = getW();
    if (!w) {
      panel.innerHTML = shell({ body: `<div class="tune-body"><p class="tune-note">武器还没加载完。</p></div>` });
      applyGeom();
      return;
    }
    lastId = w.def.id;
    applyMuzzleBox();
    const o = vals(w);
    const compact = isPhone();
    const op = compact ? '' : ' open';
    const m = w.def.fix && w.def.fix.handMount;
    const hasGunOffset = !!w.gunOffset;
    const hasMuzzle = !!w.flashBone;
    const canEject = !w.def.noCasing && w.def.kind !== 'melee' && w.def.kind !== 'grenade';

    let gunSection;
    if (m) {
      gunSection = `
      <details>
        <summary>枪体相对手</summary>
        ${R('左右 X', 'mx', -100, 100, 0.05, 2, o.mx)}
        ${R('上下 Y', 'my', -100, 100, 0.05, 2, o.my)}
        ${R('前后 Z', 'mz', -100, 100, 0.05, 2, o.mz)}
        ${R('俯仰 X°', 'mrx', -180, 180, 1, 1, o.mrx)}
        ${R('偏航 Y°', 'mry', -180, 180, 1, 1, o.mry)}
        ${R('翻滚 Z°', 'mrz', -180, 180, 1, 1, o.mrz)}
        ${R('大小', 'msc', 0.01, 30, 0.01, 2, o.msc)}
        <div class="tune-acts"><button data-act="defMount">枪体归零</button></div>
        <p class="tune-note">只动枪、不动手臂：位置单位是骨骼局部单位（±10 够把枪摆进手里），
        大小 <b>1.00</b> 是模型原尺寸，放大不会带着手一起变大。</p>
      </details>`;
    } else if (hasGunOffset) {
      gunSection = `
      <details>
        <summary>枪体微调</summary>
        ${R('左右 X', 'gx', -150, 150, 0.1, 2, o.gx)}
        ${R('上下 Y', 'gy', -150, 150, 0.1, 2, o.gy)}
        ${R('前后 Z', 'gz', -150, 150, 0.1, 2, o.gz)}
      </details>`;
    } else {
      gunSection = `
      <details>
        <summary>枪体相对手</summary>
        <p class="tune-note">这把武器的枪体由动作动画直接驱动（不在手骨下面），没有可以单独偏移的枢轴，
        只能用上面的「整体位置（手臂 + 枪）」一起调。</p>
      </details>`;
    }

    const ejectSection = canEject ? `
      <details>
        <summary>抛壳口位置</summary>
        ${R('左右 R', 'er', -2.0, 2.0, 0.002, 3, o.er)}
        ${R('上下 U', 'eu', -2.0, 2.0, 0.002, 3, o.eu)}
        ${R('前后 F', 'ef', -3.0, 3.0, 0.002, 3, o.ef)}
        ${R('弹壳大小', 'ec', 0.10, 5.00, 0.05, 2, o.ec)}
        <div class="tune-acts"><button data-act="defEject">抛壳口恢复默认</button></div>
        <p class="tune-note">位置单位米，相对相机：R 右正左负、U 上正下负、F 前正后负；弹壳大小 1.00 为原始尺寸。
        调整时青色方框即抛壳口位置（屏幕等大，不会因离镜头近而爆大），开一枪立即生效。</p>
      </details>` : '';

    const muzzleSection = `
      <details${muzzleBoxOn ? ' open' : ''}>
        <summary>枪口火焰位置</summary>
        ${R('左右 R', 'mr', -1.0, 1.0, 0.002, 3, o.mr)}
        ${R('上下 U', 'mu', -1.0, 1.0, 0.002, 3, o.mu)}
        ${R('前后 F', 'mf', -1.0, 1.0, 0.002, 3, o.mf)}
        <div class="trow"><span class="tl">显示红框（一直显示）</span>
          <input type="checkbox" class="tchk" data-k="muzzlebox" ${muzzleBoxOn ? 'checked' : ''}></div>
        <div class="tune-acts"><button data-act="defMuzzle">火焰位置归零</button></div>
        <p class="tune-note">红框里放的就是真实火焰贴图，照着它调最准。
        位置单位米、相对相机（R 右正 / U 上正 / F 前正）。勾上「显示红框」会一直保留，
        重启页面也还在，直到你手动取消。</p>
      </details>`;

    const body = `
    <div class="tune-tabs">
      ${weapons.weapons.map(x => `<button class="tune-tab${x === w ? ' on' : ''}" data-act="equip" data-id="${x.def.id}">${x.def.short}</button>`).join('')}
    </div>
    <div class="tune-body">
      <details${op}>
        <summary>整体位置（手臂 + 枪）</summary>
        ${R('左右 X', 'px', -3.0, 3.0, 0.001, 3, o.px)}
        ${R('上下 Y', 'py', -3.0, 3.0, 0.001, 3, o.py)}
        ${R('前后 Z', 'pz', -3.0, 3.0, 0.001, 3, o.pz)}
        ${R('大小', 'sc', 0.0002, 0.60, 0.0001, 4, o.sc)}
        ${R('俯仰 X°', 'rx', -180, 180, 0.5, 1, o.rx)}
        ${R('偏航 Y°', 'ry', -180, 180, 0.5, 1, o.ry)}
        ${R('翻滚 Z°', 'rz', -180, 180, 0.5, 1, o.rz)}
        <div class="trow"><span class="tl">镜像翻转</span>
          <input type="checkbox" class="tchk" data-k="mir" ${o.mir ? 'checked' : ''}></div>
        <div class="tune-acts">
          ${hasMuzzle ? '<button data-act="aim">枪口对准准星</button>' : ''}
          <button data-act="defView">恢复默认</button>
        </div>
      </details>
      <details class="preview"${compact ? '' : ' open'}>
        <summary>动作预览</summary>
        <div class="tune-acts wrap">
          <button data-act="draw">拔枪</button>
          <button data-act="fire">开火</button>
          <button data-act="reload">换弹</button>
        </div>
      </details>
      ${gunSection}
      ${ejectSection}
      ${muzzleSection}
      <details>
        <summary>竖屏（手机）</summary>
        ${R('缩放', 'pk', 0.02, 15, 0.01, 2, o.pk)}
        ${R('左右 X', 'pox', -1.5, 1.5, 0.001, 3, o.pox)}
        ${R('上下 Y', 'poy', -1.5, 1.5, 0.001, 3, o.poy)}
        ${R('景深 Z', 'poz', -3.0, 1.5, 0.002, 3, o.poz)}
        <p class="tune-note">只在竖屏（宽高比小于 1.15）生效；景深 Z 为负会把枪推远，用来消除近处枪托的夸张透视。</p>
      </details>
      <details class="readout">
        <summary>读数</summary>
        <div id="tuneRead" class="tune-read">—</div>
      </details>
    </div>
    <div class="tune-exportbar">
      <div class="tune-acts wrap">
        <button class="primary" data-act="export" title="下载 view-tune.js，覆盖 src/view-tune.js 后永久生效">导出存档</button>
        <button data-act="copy">复制 JSON</button>
        <button data-act="clear">清除保存</button>
      </div>
      <p class="tune-note tune-src">存档来源：${FILE_STAMP === 'builtin' ? 'config.js 内置默认' : 'view-tune.js · ' + FILE_STAMP}</p>
    </div>`;

    panel.innerHTML = shell({ name: w.def.name, body });
    applyGeom();
    updateReadout();
  }

  // ---------------------------------------------------------------- 应用
  function applyKey(k, val) {
    const w = getW();
    if (!w) return;
    const v = w.def.view || (w.def.view = {});
    const p = v.pos || (v.pos = [0, 0, 0]);

    switch (k) {
      case 'px': p[0] = val; break;
      case 'py': p[1] = val; break;
      case 'pz': p[2] = val; break;
      case 'sc': v.scale = val; break;
      case 'rx': v.rx = val; break;
      case 'ry': v.ry = val; break;
      case 'rz': v.rz = val; break;
      case 'mir':
        if (val) delete v.mirror; else v.mirror = false;
        break;
      case 'pk': case 'pox': case 'poy': case 'poz': {
        const pt = v.portrait || (v.portrait = { k: 1, ox: 0, oy: 0 });
        if (k === 'pk') pt.k = val;
        else if (k === 'pox') pt.ox = val;
        else if (k === 'poy') pt.oy = val;
        else pt.oz = val;
        break;
      }
      case 'mx': case 'my': case 'mz':
      case 'mrx': case 'mry': case 'mrz':
      case 'msc': {
        const t = mountTune(w);
        if (!t) return;
        if (k === 'msc') { t.scale = val; break; }
        if (k === 'mx') t.pos[0] = val;
        else if (k === 'my') t.pos[1] = val;
        else if (k === 'mz') t.pos[2] = val;
        else if (k === 'mrx') t.rotDeg[0] = val;
        else if (k === 'mry') t.rotDeg[1] = val;
        else t.rotDeg[2] = val;
        break;
      }
      case 'gx': case 'gy': case 'gz': {
        if (!w.gunOffset) w.gunOffset = new THREE.Vector3();
        w.gunOffset[k === 'gx' ? 'x' : k === 'gy' ? 'y' : 'z'] = val;
        v.gunOffset = w.gunOffset.toArray();
        break;
      }
      case 'er': case 'eu': case 'ef': {
        const ej = ejectTune(w);
        if (k === 'er') ej.r = val;
        else if (k === 'eu') ej.u = val;
        else ej.f = val;
        break;
      }
      case 'ec': {
        const fix = w.def.fix || (w.def.fix = {});
        fix.casingScale = val;
        break;
      }
      case 'mr': case 'mu': case 'mf': {
        const fix = w.def.fix || (w.def.fix = {});
        const mz = fix.muzzle || (fix.muzzle = { r: 0, u: 0, f: 0 });
        if (k === 'mr') mz.r = val;
        else if (k === 'mu') mz.u = val;
        else mz.f = val;
        if (w._placeFlash) w._placeFlash();     // 立刻把火焰/红框挪过去
        break;
      }
      default: return;
    }

    weapons.setViewScale(weapons.viewScale, weapons.viewOX || 0, weapons.viewOY || 0, !!weapons.portraitMode);
    if (w.mountNode) w._applyMountTune();
    persist();
  }

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      for (const w of weapons.weapons) {
        const v = w.def.view || {};
        const m = w.def.fix && w.def.fix.handMount;
        const ej = w.def.fix && w.def.fix.eject;
        const cs = w.def.fix && w.def.fix.casingScale;
        out[w.def.id] = {
          view: {
            scale: v.scale,
            rx: v.rx || 0, ry: v.ry || 0, rz: v.rz || 0,
            pos: [...(v.pos || [0, 0, 0])],
            ...(v.mirror === false ? { mirror: false } : {}),
            ...(v.gunOffset ? { gunOffset: [...v.gunOffset] } : {}),
            ...(v.portrait ? { portrait: { ...v.portrait } } : {})
          },
          mount: m && m.tune ? clone(m.tune) : null,
          ...(ej ? { eject: { r: ej.r, u: ej.u, f: ej.f } } : {}),
          ...(w.def.fix && w.def.fix.muzzle ? { muzzle: { r: w.def.fix.muzzle.r || 0, u: w.def.fix.muzzle.u || 0, f: w.def.fix.muzzle.f || 0 } } : {}),
          ...(cs != null && cs !== 1 ? { caseScale: cs } : {})
        };
      }
      try { localStorage.setItem(STORE, JSON.stringify({ stamp: FILE_STAMP, data: out })); } catch (e) { /* 隐私模式下忽略 */ }
    }, 250);
  }

  // ---------------------------------------------------------------- 读数
  function updateReadout() {
    const el = panel.querySelector('#tuneRead');
    if (!el) return;
    const w = getW();
    if (!w) return;

    const ndcOf = (o) => {
      if (!o) return null;
      w.root.updateMatrixWorld(true);
      viewCamera.updateMatrixWorld();
      const p = new THREE.Vector3();
      o.getWorldPosition(p);
      const q = p.clone().project(viewCamera);
      if (!isFinite(q.x) || !isFinite(q.y)) return null;
      return { x: q.x, y: q.y };
    };
    let hand = null;
    w.root.traverse(o => { if (!hand && /_r_hand$/i.test(o.name)) hand = o; });

    const rows = [];
    const add = (label, o) => {
      const n = ndcOf(o);
      if (!n) { rows.push(`<div><span>${label}</span><b>—</b></div>`); return; }
      const px = Math.round(n.x * window.innerWidth / 2);
      const py = Math.round(-n.y * window.innerHeight / 2);
      rows.push(`<div><span>${label}</span><b>${n.x.toFixed(3)}, ${n.y.toFixed(3)}</b><i>${px > 0 ? '+' : ''}${px}px</i></div>`);
    };
    add('枪口', w.flashBone);
    add('枪身', w.handGun || w.mountNode || w.gunNode);
    add('右手', hand);

    el.innerHTML = rows.join('') +
      `<div class="tune-meta">画布 ${window.innerWidth}×${window.innerHeight} · 视图缩放 ${w.viewScale.toFixed(2)} · 准星在 0, 0</div>`;
  }

  function toast(text) {
    let t = panel.querySelector('.tune-toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'tune-toast';
      panel.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1600);
  }

  // ---------------------------------------------------------------- 枪口对准准星（牛顿迭代）
  function alignMuzzle() {
    const w = getW();
    if (!w || !w.flashBone) return;
    const v = w.def.view || (w.def.view = {});
    const read = () => {
      w.root.updateMatrixWorld(true);
      viewCamera.updateMatrixWorld();
      const p = new THREE.Vector3();
      w.flashBone.getWorldPosition(p);
      const q = p.clone().project(viewCamera);
      return { x: q.x, y: q.y };
    };
    const set = (ry, rx) => { v.ry = ry; v.rx = rx; w.applyViewConfig(); };

    let ry = v.ry || 0, rx = v.rx || 0;
    for (let i = 0; i < 16; i++) {
      const c = read();
      if (!isFinite(c.x) || !isFinite(c.y)) break;
      if (Math.hypot(c.x, c.y) < 0.002) break;
      const h = 1.0;
      set(ry + h, rx); const a = read();
      set(ry, rx + h); const b = read();
      const j11 = (a.x - c.x) / h, j21 = (a.y - c.y) / h;
      const j12 = (b.x - c.x) / h, j22 = (b.y - c.y) / h;
      const det = j11 * j22 - j12 * j21;
      if (Math.abs(det) < 1e-7) break;
      let dry = (-c.x * j22 + c.y * j12) / det;
      let drx = (-c.y * j11 + c.x * j21) / det;
      dry = Math.max(-10, Math.min(10, dry));
      drx = Math.max(-10, Math.min(10, drx));
      ry += dry; rx += drx;
      set(ry, rx);
    }
    const n = read();
    rebuild();
    persist();
    toast(`枪口偏差 ${n.x.toFixed(3)}, ${n.y.toFixed(3)}`);
  }

  // ---------------------------------------------------------------- 导出
  // 单把武器的完整存档（只含可调项，其余功能字段继续用 config.js 的）
  function snapshot(w) {
    const v = w.def.view || {};
    const m = w.def.fix && w.def.fix.handMount;
    const view = {
      scale: +(v.scale || 0).toFixed(5),
      pos: (v.pos || [0, 0, 0]).map(n => +(+n).toFixed(4)),
      rx: +(v.rx || 0).toFixed(2),
      ry: +(v.ry || 0).toFixed(2),
      rz: +(v.rz || 0).toFixed(2)
    };
    if (v.mirror === false) view.mirror = false;
    if (v.gunOffset) view.gunOffset = v.gunOffset.map(n => +(+n).toFixed(3));
    if (v.portrait) {
      view.portrait = {
        k: +(+v.portrait.k).toFixed(3),
        ox: +(+v.portrait.ox).toFixed(4),
        oy: +(+v.portrait.oy).toFixed(4)
      };
      if (v.portrait.oz) view.portrait.oz = +(+v.portrait.oz).toFixed(3);
    }
    const out = { view };
    if (m && m.tune) out.mount = {
      pos: m.tune.pos.map(n => +(+n).toFixed(3)),
      rotDeg: m.tune.rotDeg.map(n => +(+n).toFixed(2)),
      ...(m.tune.scale != null && +m.tune.scale !== 1 ? { scale: +(+m.tune.scale).toFixed(3) } : {})
    };
    const ej = w.def.fix && w.def.fix.eject;
    if (ej) out.eject = {
      r: +(+ej.r).toFixed(3),
      u: +(+ej.u).toFixed(3),
      f: +(+ej.f).toFixed(3)
    };
    const cs = w.def.fix && w.def.fix.casingScale;
    if (cs != null && cs !== 1) out.caseScale = +( +cs ).toFixed(2);
    const mz = w.def.fix && w.def.fix.muzzle;
    if (mz) out.muzzle = { r: +(+mz.r).toFixed(3), u: +(+mz.u).toFixed(3), f: +(+mz.f).toFixed(3) };
    return out;
  }

  function collectAll() {
    const out = {};
    for (const w of weapons.weapons) out[w.def.id] = snapshot(w);
    return out;
  }

  function buildPayload() {
    return {
      version: 2,
      stamp: new Date().toISOString(),
      weapons: collectAll()
    };
  }

  // 数组压成单行，导出的文件更好读
  const compactJson = (v) => JSON.stringify(v, null, 2)
    .replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (m, inner) => '[' + inner.split(/,\s*/).join(', ') + ']');

  // 生成可直接替换 src/view-tune.js 的完整源码
  function buildTuneFile() {
    const payload = buildPayload();
    const when = new Date().toLocaleString('zh-CN', { hour12: false });
    return `/**
 * 持枪视图存档（view-tune.js）
 * ---------------------------------------------------------------------------
 * 由游戏内「调参」面板导出，导出时间：${when}
 * 直接覆盖项目里的 src/view-tune.js，刷新页面即可保留全部调整。
 *
 * 说明：本文件是玩家调参的唯一数据源，里面的 stamp 变了就代表存档被替换，
 * 浏览器里旧的临时缓存会自动作废，不会盖住这份文件。
 */
export const VIEW_TUNE = ${compactJson(payload)};
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

  function exportTuneFile() {
    if (!getW()) return;
    downloadText('view-tune.js', buildTuneFile(), 'text/javascript');
    toast('已导出 view-tune.js，覆盖 src/view-tune.js 即可');
  }

  async function copyConfig() {
    const text = JSON.stringify(buildPayload(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      toast('全部配置已复制');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('全部配置已复制'); }
      catch (e2) { toast('复制失败，请手动选择'); }
      ta.remove();
    }
  }

  // ---------------------------------------------------------------- 事件
  panel.addEventListener('input', (e) => {
    const el = e.target;
    const k = el.dataset && el.dataset.k;
    if (!k) return;
    if (k === 'mir') {
      applyKey('mir', el.checked);
      return;
    }
    if (k === 'muzzlebox') {
      setMuzzleBox(el.checked);
      return;
    }
    const val = parseFloat(el.value);
    if (!isFinite(val)) return;
    applyKey(k, val);
    panel.querySelectorAll(`[data-k="${k}"]`).forEach(o => { if (o !== el) o.value = val; });
  });

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (!act) return;
    const w = getW();
    switch (act) {
      case 'close': setOpen(false); break;
      case 'mini': {
        const mini = panel.classList.toggle('mini');
        toast(mini ? '已收起，再点展开' : '已展开');
        break;
      }
      case 'equip': {
        const i = weapons.weapons.findIndex(x => x.def.id === b.dataset.id);
        if (i >= 0) weapons.equip(i, { instant: true });
        rebuild();
        break;
      }
      case 'aim': alignMuzzle(); break;
      case 'defView': {
        if (!w) break;
        const d = DEFAULTS[w.def.id];
        if (!d) break;
        const keepPortrait = w.def.view.portrait;
        w.def.view = clone(d.view);
        if (keepPortrait && !w.def.view.portrait) w.def.view.portrait = keepPortrait;
        weapons.setViewScale(weapons.viewScale, weapons.viewOX || 0, weapons.viewOY || 0, !!weapons.portraitMode);
        rebuild();
        persist();
        toast('已恢复源码默认');
        break;
      }
      case 'defMount': {
        if (!w) break;
        const cfg = w.def.fix && w.def.fix.handMount;
        if (cfg) cfg.tune = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };
        if (w.mountNode) w._applyMountTune();
        rebuild();
        persist();
        toast('枪体已归零');
        break;
      }
      case 'defMuzzle': {
        if (!w) break;
        if (w.def.fix) w.def.fix.muzzle = { r: 0, u: 0, f: 0 };
        if (w._placeFlash) w._placeFlash();
        rebuild();
        persist();
        toast('枪口火焰位置已归零');
        break;
      }
      case 'defEject': {
        if (!w) break;
        if (w.def.fix) {
          w.def.fix.eject = { ...EJECT_DEFAULT };
          w.def.fix.casingScale = 1;
        }
        rebuild();
        persist();
        toast('抛壳口与弹壳大小已恢复默认');
        break;
      }
      case 'draw': if (w) w.playDraw(); break;
      case 'fire': if (w) w.playFire(false); break;
      case 'reload': if (w) w.playReload(); break;
      case 'copy': copyConfig(); break;
      case 'export': exportTuneFile(); break;
      case 'clear': {
        try { localStorage.removeItem(STORE); } catch (e) {}
        toast('已清除本机保存，刷新页面恢复源码参数');
        break;
      }
      default: break;
    }
  });

  // 展开某一节时：窗口能长高就先长高，再把这一节滚到可视区顶部
  panel.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    const fit = () => {
      const body = panel.querySelector('.tune-body');
      if (!body || !geom) return;
      const vh = window.innerHeight;
      const need = d.getBoundingClientRect().height + 150;
      if (geom.h < Math.min(need, 660) && vh > geom.h + 90) {
        geom.h = Math.min(need, 660, vh - 60);
        applyGeom();
      }
      const br = body.getBoundingClientRect();
      const dr = d.getBoundingClientRect();
      body.scrollTop += dr.top - br.top - 4;
    };
    requestAnimationFrame(() => { fit(); requestAnimationFrame(fit); });
  }, true);   // toggle 不冒泡，用捕获阶段监听

  // 防止面板内的拖拽/滚轮影响游戏视角
  panel.addEventListener('mousedown', e => e.stopPropagation());
  panel.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  panel.addEventListener('wheel', e => e.stopPropagation(), { passive: true });

  // ---------------------------------------------------------------- 拖动 / 缩放窗口
  let win = null;   // { mode, x, y, left, top, w, h, id }

  panel.addEventListener('pointerdown', (e) => {
    const head = e.target.closest('.tune-head');
    const grip = e.target.closest('.tune-resize');
    if (!head && !grip) return;
    if (head && e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    win = {
      mode: grip ? 'size' : 'move',
      x: e.clientX, y: e.clientY,
      left: r.left, top: r.top, w: r.width, h: r.height,
      id: e.pointerId
    };
    if (win.mode === 'size') panel.classList.add('resizing');
    e.preventDefault();
    e.stopPropagation();
    try { panel.setPointerCapture(e.pointerId); } catch (err) {}
  });

  panel.addEventListener('pointermove', (e) => {
    if (!win || e.pointerId !== win.id) return;
    const dx = e.clientX - win.x, dy = e.clientY - win.y;
    if (win.mode === 'move') {
      geom.left = win.left + dx;
      geom.top = win.top + dy;
    } else {
      geom.w = Math.max(MINW, win.w + dx);
      geom.h = Math.max(MINH, win.h + dy);
    }
    applyGeom();
    e.preventDefault();
  });

  function endWin(e) {
    if (!win || (e && e.pointerId !== win.id)) return;
    if (win.mode === 'size') panel.classList.remove('resizing');
    win = null;
    applyGeom(true);
    updateReadout();
  }
  panel.addEventListener('pointerup', endWin);
  panel.addEventListener('pointercancel', endWin);

  // 标题栏双击：恢复默认大小与位置
  panel.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tune-head') || e.target.closest('button')) return;
    geom = defaultGeom();
    panel.classList.remove('mini');
    applyGeom(true);
    updateReadout();
  });

  // ---------------------------------------------------------------- 开关
  function setOpen(v) {
    if (v === open) return;
    open = v;
    panel.classList.toggle('hidden', !open);
    btn.classList.toggle('on', open);
    document.body.classList.toggle('tuning', open);
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      panel.classList.remove('mini');
      lastId = null;
      geom = clampGeom(loadGeom());
      rebuild();
      applyGeom();
    }
    if (onToggle) onToggle(open);
  }

  btn.addEventListener('click', () => setOpen(!open));
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    // 数字输入框里按 P 不切换面板，其余位置（含面板按钮）都可以
    if (t && t.tagName === 'INPUT' && t.type === 'number') return;
    if (e.code === 'KeyP' && !e.repeat) {
      e.preventDefault();
      setOpen(!open);
    } else if (e.code === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  });

  // 切枪 / 尺寸变化时刷新
  setInterval(() => {
    if (!open) return;
    const w = getW();
    const id = w ? w.def.id : null;
    if (id !== lastId) rebuild();
    else updateReadout();
  }, 220);

  window.addEventListener('resize', () => {
    if (!open) return;
    applyGeom();
    updateReadout();
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    isOpen: () => open
  };
}
