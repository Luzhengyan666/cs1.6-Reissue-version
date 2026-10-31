import * as THREE from 'three';
import { SMOKE_TEXTS } from '../assets/flash/manifest.js?v=r90';

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;

/** 从一段动画的某一帧提取成单帧静止姿态（默认末帧；保证骨骼全覆盖，不会回到绑定姿势） */
function poseClipFrom(clip, name = 'pose', at = null) {
  const t = at != null ? Math.max(0, Math.min(clip.duration - 0.0001, at)) : Math.max(0, clip.duration - 0.0001);
  const tracks = [];
  for (const tr of clip.tracks) {
    let interp;
    try { interp = tr.createInterpolant(); } catch (e) { continue; }
    const value = interp.evaluate(t);
    const times = new Float32Array([0]);
    const values = new Float32Array(Array.from(value));
    try {
      tracks.push(new tr.constructor(tr.name, times, values));
    } catch (e) { /* ignore exotic track */ }
  }
  return new THREE.AnimationClip(name, 0.001, tracks);
}

/** 把一次性动画叠加在基础姿态上：基础姿态补全所有骨骼，一次性动画覆盖同名轨道 */
/**
 * 程序生成一张星形枪口火焰（六角星芒 + 中心白核 + 橙色外晕）。
 * 不用任何外部图片：canvas 画完直接当纹理用，开火时随机取一张。
 * seed 固定的话，每次刷新页面生成的星形都一样，不会「每局长得不一样」。
 */
function makeStarFlash(size, spikes, rot, seed) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const cx = size / 2, cy = size / 2;
  let rnd = seed || 1;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };

  g.clearRect(0, 0, size, size);
  g.globalCompositeOperation = 'lighter';

  // 外层光晕
  const halo = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
  halo.addColorStop(0.00, 'rgba(255,255,235,0.95)');
  halo.addColorStop(0.12, 'rgba(255,238,175,0.72)');
  halo.addColorStop(0.28, 'rgba(255,178,66,0.34)');
  halo.addColorStop(0.55, 'rgba(255,120,24,0.10)');
  halo.addColorStop(1.00, 'rgba(255,90,0,0)');
  g.fillStyle = halo;
  g.beginPath();
  g.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
  g.fill();

  // 一条星芒：从中心射出的细长三角，带渐变
  const spike = (angle, len, halfW, a0, a1) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(angle);
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, `rgba(255,255,245,${a0})`);
    grad.addColorStop(0.22, `rgba(255,226,140,${a1})`);
    grad.addColorStop(0.62, 'rgba(255,150,40,0.20)');
    grad.addColorStop(1, 'rgba(255,110,10,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, -halfW);
    g.lineTo(len, 0);
    g.lineTo(0, halfW);
    g.closePath();
    g.fill();
    g.restore();
  };

  // 主星芒
  for (let i = 0; i < spikes; i++) {
    const a = (i / spikes) * Math.PI * 2 + rot;
    spike(a, size * (0.40 + rand() * 0.10), size * (0.026 + rand() * 0.013), 1.0, 0.7);
  }
  // 次星芒（错开半个角，让轮廓更碎更像真的火）
  for (let i = 0; i < spikes; i++) {
    const a = ((i + 0.5) / spikes) * Math.PI * 2 + rot;
    spike(a, size * (0.19 + rand() * 0.08), size * (0.011 + rand() * 0.007), 0.82, 0.5);
  }

  // 中心白核
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, size * 0.115);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.45, 'rgba(255,250,225,0.9)');
  core.addColorStop(1, 'rgba(255,235,170,0)');
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, size * 0.115, 0, Math.PI * 2);
  g.fill();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function mergePose(base, over, name) {
  const map = new Map();
  for (const t of base.tracks) map.set(t.name, t);
  for (const t of over.tracks) map.set(t.name, t);
  return new THREE.AnimationClip(name, over.duration, [...map.values()]);
}


/** 把一个蒙皮网格的某个 group 烘焙成静态几何（世界/绑定姿势下的形状） */
function bakeSkinnedRange(mesh, start, count) {
  const src = mesh.geometry;
  const pos = src.attributes.position;
  const uv = src.attributes.uv;
  const idx = src.index;
  if (!pos) return null;
  const positions = [];
  const uvs = [];
  const v = new THREE.Vector3();
  const end = Math.min(start + count, idx ? idx.count : pos.count);
  for (let i = start; i < end; i++) {
    const vi = idx ? idx.getX(i) : i;
    v.fromBufferAttribute(pos, vi);
    mesh.applyBoneTransform(vi, v);
    positions.push(v.x, v.y, v.z);
    if (uv) uvs.push(uv.getX(vi), uv.getY(vi));
  }
  if (!positions.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (uvs.length) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

export class Weapon {
  constructor(def, gltf, viewScene, viewCamera, donor) {
    this.def = def;
    this.root = gltf.scene;
    this._stripTracksFor = null;
    this.viewScene = viewScene;
    this.viewCamera = viewCamera || null;

    this.ammo = def.magSize;
    this.reserve = def.reserve;
    this.state = 'idle';          // idle | draw | reload | fire
    this.active = null;           // 当前一次性动作
    this.nextFire = 0;
    this.fireIndex = 0;
    this.stabIndex = 0;
    this.cocking = false;         // 单动左轮：扳完击锤前锁定开火
    this._pendingCasing = null;   // 延迟抛壳（AWP 拉栓 / 霰弹泵动时才抛壳）
    this.flashTimer = 0;
    this.onEvent = null;          // 供外部监听（换弹完成等）
    this.audio = null;            // 由 WeaponSystem 注入
    this.sfxCues = [];            // 与动画时间轴对齐的音效 cue
    this.viewScale = 1;           // 竖屏整体缩放（只缩放尺寸与横向偏移，保持距离）
    this.viewOffset = new THREE.Vector3(); // 竖屏构图微调

    this._buildRig();
    // 记录模型自己的静止姿态（骨骼 local transform），供 view.restPose 的武器补全缺失轨道
    this.restClip = this._captureRest();
    this._graftArms(donor);
    // 消音器：模型里是一个独立材质部件，没装的时候直接隐藏
    // 注意：只有「可拆装消音器」的枪（M4A1 / USP）才收集这类部件。
    // TMP 的消音器是原版模型自带的固定件（材质也叫 silencer.bmp），
    // 如果照样收集，show() 里 _setSilencerParts(this.silenced=false) 会把它藏掉。
    this.silenced = !!(def.silencer && def.silencer.default);
    // 自带消音器的枪（TMP）：消音器是固定件，不能拆，但开火同样不该有枪口焰
    this.noFlash = !!def.noFlash;
    this.silencerParts = [];
    if (def.silencer) {
      this.root.traverse(o => {
        if (!o.isMesh) return;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        if (ms.some(m => m && /silencer/i.test(m.name || ''))) this.silencerParts.push(o);
      });
      // 先切到对应状态的动画表，再建动画（换弹/射击动作都不一样）
      Object.assign(def.anims, this.silenced ? def.silencer.on : def.silencer.off);
      this._setSilencerParts(this.silenced);
    }
    const vv = this.def.view || {};
    this.gunOffset = vv.gunOffset ? new THREE.Vector3().fromArray(vv.gunOffset) : null;
    this.gunNode = vv.gunNode ? this.root.getObjectByName(vv.gunNode) : null;
    // fix.boneScale：{ 骨骼名: 倍数 }，每帧在动画之后重设（见 update）
    this.boneScales = (def.fix && def.fix.boneScale) ? Object.entries(def.fix.boneScale) : null;
    // fix.boneTune：{ 骨骼名: { scale, rotDeg:[x,y,z], pos:[x,y,z] } }，同样每帧在动画之后叠加
    this.boneTune = null;
    if (def.fix && def.fix.boneTune) {
      this.boneTune = [];
      for (const [name, t] of Object.entries(def.fix.boneTune)) {
        const q = t.rotDeg ? new THREE.Quaternion().setFromEuler(
          new THREE.Euler(t.rotDeg[0] * Math.PI / 180, t.rotDeg[1] * Math.PI / 180, t.rotDeg[2] * Math.PI / 180, 'XYZ')
        ) : null;
        this.boneTune.push({
          name, k: t.scale || 0, q,
          p: t.pos ? new THREE.Vector3().fromArray(t.pos) : null,
        });
      }
    }
    const strip = this._stripTracksFor;
    this.clips = new Map((this.animSource || gltf.animations).map(c => {
      if (!strip) return [c.name, c];
      const tracks = c.tracks.filter(t => !t.name.startsWith(strip + '.'));
      return [c.name, new THREE.AnimationClip(c.name, c.duration, tracks)];
    }));
    this._applyTrackOffset();
    this._applyDamp();
    if (def.silencer) this._setupSilencerBone();
    this._buildSingleShotClip();
    this._bindGunToHand();
    this._buildAnimations();
    this._buildFlash();
    // 模型里有些零件在绑定姿势下是「飘在镜头附近」的（比如 R8 的装填口），
    // 直接把这些骨骼缩到 0：顶点会塌到一起，看不见，也不影响别的零件
    // 有些零件在绑定姿势下会飘到镜头附近（R8 的装填口），把它们从蒙皮网格里拆出来单独隐藏，
    // 换弹时再显示（那时动画会把它摆回枪身上）
    if (this.def.fix && this.def.fix.splitBones) {
      this.splitParts = [];
      for (const re of this.def.fix.splitBones) {
        this._splitSkinned(new RegExp(re, 'i'), this.splitParts);
      }
    }
    if (this.def.fix && this.def.fix.boneOffset) {
      for (const [name, v] of Object.entries(this.def.fix.boneOffset)) this.offsetBone(name, v);
    }
    this._setupHandPivot();
    this._seatInHand();

    this.sway = { x: 0, y: 0 };
    this.kick = 0;
    this.kickRot = 0;
    this.kickYaw = 0;
    this.kickRoll = 0;
    this.bob = 0;
    this.rig.visible = false;
  }

  _applyFixups() {
    const fix = this.def.fix;
    if (!fix) return;
    if (fix.nodes) {
      for (const [name, t] of Object.entries(fix.nodes)) {
        const node = this.root.getObjectByName(name);
        if (!node) continue;
        if (t.pos) node.position.set(t.pos[0], t.pos[1], t.pos[2]);
        if (t.rot) node.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
        if (t.scale) node.scale.setScalar(t.scale);
      }
    }
    if (fix.reparent) {
      for (const [child, parent] of fix.reparent) {
        const c = this.root.getObjectByName(child);
        const p = this.root.getObjectByName(parent);
        if (c && p) p.add(c);
      }
    }
    if (fix.wrap) {
      const { node, pos, quat, rotDeg, scale } = fix.wrap;
      const c = this.root.getObjectByName(node);
      if (c && c.parent) {
        const g = new THREE.Group();
        if (pos) g.position.fromArray(pos);
        if (quat) g.quaternion.fromArray(quat);
        if (rotDeg) {
          const e = new THREE.Euler(rotDeg[0] * Math.PI / 180, rotDeg[1] * Math.PI / 180, rotDeg[2] * Math.PI / 180, 'XYZ');
          g.quaternion.setFromEuler(e);
        }
        if (scale) g.scale.setScalar(scale);
        c.parent.add(g);
        g.add(c);
      }
    }
    if (fix.strip) {
      this._stripTracksFor = fix.strip;
    }
    if (fix.bindToHand) {
      const { gun, hand } = fix.bindToHand;
      const g = this.root.getObjectByName(gun);
      const h = this.root.getObjectByName(hand);
      if (g && h) {
        this.root.updateMatrixWorld(true);
        const m = new THREE.Matrix4().copy(h.matrixWorld).invert().multiply(g.matrixWorld);
        h.add(g);
        m.decompose(g.position, g.quaternion, g.scale);
        this._stripTracksFor = gun;
      }
    }
  }

  _buildRig() {
    const v = this.def.view;
    this._applyFixups();
    this.rig = new THREE.Group();
    this.rig.position.set(v.pos[0], v.pos[1], v.pos[2]);

    // 整个枪械模型镜像翻转：左手持枪 -> 右手持枪
    // 部分模型（如刀）本身已是右手持械，可单独关闭镜像
    this.mirror = new THREE.Group();
    this.mirror.scale.x = v.mirror === false ? 1 : -1;

    // 翻滚（rz）单独放一层：如果和 rx/ry 塞进同一个 Euler，
    // 在 ry=90° 的情况下绕局部 Z 的旋转会被偏航转成「俯仰」，
    // 调参面板上就会出现「翻滚和俯仰一模一样」的问题。
    this.roll = new THREE.Group();
    this.roll.rotation.set((v.pitch || 0) * DEG, 0, (v.rz || 0) * DEG);

    this.orient = new THREE.Group();
    this.orient.rotation.set((v.rx || 0) * DEG, (v.ry || 0) * DEG, 0);
    this.orient.scale.setScalar(v.scale);

    this.basePos = this.rig.position.clone();

    this.rig.add(this.roll);
    this.roll.add(this.mirror);
    this.mirror.add(this.orient);
    this.orient.add(this.root);

    this.root.traverse(o => {
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = false;
        o.receiveShadow = false;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          // 镜像后三角形绕序翻转，双面渲染可同时修正剔除与法线
          m.side = THREE.DoubleSide;
          m.shadowSide = THREE.DoubleSide;
        }
      }
    });

    this.viewScene.add(this.rig);
  }

  /**
   * 消音器骨骼处理：
   * 拆装动画本身带 v_weaponxxx_Silencer 的位移/旋转轨道，会把手上的消音器带到枪口；
   * 但其它动画（draw/reload/...）没有这条轨道，于是 basePose 会把消音器拉回绑定位置
   * ——这就是「装完动画后消音器又跑掉」的原因。
   * 处理办法：把其它动画里的消音器轨道剥掉，由这里手动锁定在「装上 / 卸下」两个姿态之一。
   */
  _setupSilencerBone() {
    const cfg = this.def.silencer;
    const at = this.clips.get(cfg.attach);
    const dt = this.clips.get(cfg.detach);
    let nodeName = null;
    for (const c of [at, dt]) {
      if (!c) continue;
      const t = c.tracks.find(tr => /silencer/i.test(tr.name));
      if (t) { nodeName = t.name.split('.')[0]; break; }
    }
    // 新模型（T已编译）骨骼名是通用 BoneNN：消音器骨骼只在拆装动画里有轨道，
    // 其它动画全都没有 —— 用这个特征把它找出来（M4A1=Bone48，USP=Bone56）。
    if (!nodeName && at) {
      const silBones = new Set();
      for (const c of [at, dt]) {
        if (!c) continue;
        for (const tr of c.tracks) {
          if (tr.name.endsWith('.position')) silBones.add(tr.name.split('.')[0]);
        }
      }
      const other = new Set();
      for (const [name, c] of this.clips) {
        if (name === cfg.attach || name === cfg.detach) continue;
        for (const tr of c.tracks) other.add(tr.name.split('.')[0]);
      }
      for (const n of silBones) {
        if (!other.has(n) && !/hand|finger|arm/i.test(n)) { nodeName = n; break; }
      }
    }
    if (!nodeName) return;
    this.silNode = this.root.getObjectByName(nodeName);
    if (!this.silNode) return;

    const poseAt = (clip) => {
      if (!clip) return null;
      const t = Math.max(0, clip.duration - 0.0001);
      const pos = clip.tracks.find(tr => tr.name === nodeName + '.position');
      const quat = clip.tracks.find(tr => tr.name === nodeName + '.quaternion');
      const out = {};
      if (pos) {
        try { out.p = new THREE.Vector3().fromArray(Array.from(pos.createInterpolant().evaluate(t))); } catch (e) {}
      }
      if (quat) {
        try { out.q = new THREE.Quaternion().fromArray(Array.from(quat.createInterpolant().evaluate(t))); } catch (e) {}
      }
      return out;
    };

    this.silPoseOn = poseAt(at) || {};
    this.silPoseOff = poseAt(dt) || {};

    // 其它动画不再驱动消音器骨骼
    for (const [name, c] of this.clips) {
      if (name === cfg.attach || name === cfg.detach) continue;
      c.tracks = c.tracks.filter(tr => !tr.name.startsWith(nodeName + '.'));
    }
    this._lockSilencerBone();
  }

  /** 把消音器骨骼钉在「当前状态」对应的姿态上 */
  _lockSilencerBone() {
    const n = this.silNode;
    if (!n) return;
    const pose = this.silenced ? this.silPoseOn : this.silPoseOff;
    if (pose && pose.p) n.position.copy(pose.p);
    if (pose && pose.q) n.quaternion.copy(pose.q);
  }

  /**
   * Glock 等带三连发的枪：模型里的 shoot/shoot2/shoot3 都是「三发连打、滑套挂后位」
   * 的整段动画，单发模式下打一枪播一整段就变成三连发。
   * 这里克隆 shoot 合成一个 shoot_single：滑套只打一次循环就回前位，其它轨道截短。
   */
  _buildSingleShotClip() {
    const fix = this.def.fix || {};
    const outName = this.def.anims.fireSingle;
    if (!outName || this.clips.has(outName)) return;
    const src = this.clips.get(fix.singleSource || 'shoot');
    if (!src) return;
    const DUR = Math.min(0.4, src.duration);
    const slide = fix.slideBone;
    const itemSize = (tr) => tr.values.length / tr.times.length;
    const tracks = [];
    for (const tr of src.tracks) {
      const node = tr.name.split('.')[0];
      if (slide && node === slide && tr.name.endsWith('.position')) {
        // 一次滑套循环：起点 → 后位 → 前位 → 保持到结束
        const v = tr.values, times = tr.times, n = v.length / 3;
        // 只在前 0.25s 里找极值（后面是挂后位的静止段）
        let front = -1e9, back = 1e9;
        for (let i = 0; i < n; i++) {
          if (times[i] > 0.25) break;
          const y = v[i*3+1];
          if (y > front) front = y;
          if (y < back) back = y;
        }
        let tBack = null, tFront = null;
        for (let i = 0; i < n; i++) {
          if (times[i] > 0.25) break;
          const y = v[i*3+1];
          if (tBack === null && y <= back + (front - back) * 0.3) tBack = times[i];
          else if (tBack !== null && tFront === null && y >= front - (front - back) * 0.3) { tFront = times[i]; break; }
        }
        if (tBack == null || tFront == null || tFront <= tBack) { tracks.push(tr); continue; }
        const x0 = v[0], z0 = v[2];
        const yStart = v[1];
        const ts = [0, tBack, tFront, DUR];
        const ys = [yStart, back, front, front];
        const vals = [];
        for (const y of ys) vals.push(x0, y, z0);
        tracks.push(new THREE.VectorKeyframeTrack(tr.name, ts, vals));
      } else {
        // 其它轨道：截到 DUR，之后的姿态由「保持末值 → fade 回 idle」过渡
        const is = itemSize(tr);
        let cut = tr.times.length;
        for (let i = 0; i < tr.times.length; i++) {
          if (tr.times[i] > DUR) { cut = i; break; }
        }
        if (cut <= 0 || cut >= tr.times.length) { tracks.push(tr); continue; }
        tracks.push(new THREE.VectorKeyframeTrack(tr.name,
          tr.times.slice(0, cut), tr.values.slice(0, cut * is)));
      }
    }
    const clip = new THREE.AnimationClip(outName, DUR, tracks);
    this.clips.set(outName, clip);
  }

  /** 只控制消音器部件的显隐（不动骨骼，装上时由动画把手带过去） */
  _setSilencerParts(on) {
    for (const m of this.silencerParts) m.visible = !!on;
  }

  /** 当前该用的枪声 */
  getSound() {
    const cfg = this.def.silencer;
    if (cfg) return this.silenced ? cfg.soundOn : cfg.soundOff;
    return this.def.sound;
  }

  /**
   * 装 / 卸消音器。
   * animate=false 时立刻切换（初始化用），true 时播放 add_silencer / detach_silencer，
   * 动画播到一半时再切换部件显隐，看起来就像手把消音器拧上去 / 拔下来。
   */
  setSilencer(on, { animate = true } = {}) {
    const cfg = this.def.silencer;
    if (!cfg) return false;
    on = !!on;
    if (on === this.silenced) return false;

    this.silenced = on;
    Object.assign(this.def.anims, on ? cfg.on : cfg.off);

    const name = on ? cfg.attach : cfg.detach;
    if (animate && this.clips.has(name)) {
      this._silencerPending = null;
      // 装：一开始就显示，让消音器跟着手被端上去（动画轨道会带着它走）
      // 卸：整段动画期间都保留，直到播完才隐藏
      if (on) this._setSilencerParts(true);
      this.play(name, { state: 'silencer', fade: 0.06, timeScale: 1, force: true });
      const sfx = this.def.sfx || {};
      const cfg = this.def.silencer;
      if (this.active) {
        // 拆装音落在「手碰到枪口 / 拔下」那一帧，不是固定 45%
        const at = on ? (cfg.cueOn != null ? cfg.cueOn : 0.2)
                      : (cfg.cueOff != null ? cfg.cueOff : 0.45);
        this._queueCues([[at, on ? sfx.silencerOn : sfx.silencerOff]], this.active.getClip().duration);
      }
      return true;
    }
    this._setSilencerParts(on);
    this._lockSilencerBone();
    this._silencerPending = null;
    return true;
  }

  _applyTrackOffset() {
    const off = this.def.fix && this.def.fix.trackOffset;
    if (!off) return;
    const { node, translation, rotation, rotDeg } = off;
    let qd = rotation ? new THREE.Quaternion().fromArray(rotation) : null;
    if (rotDeg) {
      const e = new THREE.Euler(rotDeg[0] * Math.PI / 180, rotDeg[1] * Math.PI / 180, rotDeg[2] * Math.PI / 180, 'XYZ');
      const q2 = new THREE.Quaternion().setFromEuler(e);
      qd = qd ? q2.multiply(qd) : q2;
    }
    const q = new THREE.Quaternion();
    for (const clip of this.clips.values()) {
      for (const tr of clip.tracks) {
        if (!tr.name.startsWith(node + '.')) continue;
        if (translation && tr.name.endsWith('.position')) {
          for (let i = 0; i < tr.values.length; i += 3) {
            tr.values[i] += translation[0];
            tr.values[i + 1] += translation[1];
            tr.values[i + 2] += translation[2];
          }
        } else if (qd && tr.name.endsWith('.quaternion')) {
          for (let i = 0; i < tr.values.length; i += 4) {
            q.fromArray(tr.values, i);
            q.premultiply(qd);
            q.toArray(tr.values, i);
          }
        }
      }
    }
  }

  // 个别动作位移过大（如刀的突刺会甩出画面），按比例压缩位移轨道
  _applyDamp() {
    const damp = this.def.view && this.def.view.damp;
    if (!damp) return;
    for (const [clipName, s] of Object.entries(damp)) {
      const clip = this.clips.get(clipName);
      if (!clip) continue;
      for (const tr of clip.tracks) {
        if (!tr.name.endsWith('.position')) continue;
        const v = tr.values;
        const v0 = [v[0], v[1], v[2]];
        for (let i = 0; i < v.length; i += 3) {
          for (let k = 0; k < 3; k++) v[i + k] = v0[k] + (v[i + k] - v0[k]) * s;
        }
      }
    }
  }

  // 个别模型的枪体骨骼与手部骨骼在层级上断开（如 MP5 多套了一层 mp7_parent），
  // 这里按动画末帧的相对姿态把枪体锁定到手上，并剥离枪体自身的轨道，
  // 之后无论手怎么动（拔枪/换弹/开火）枪体都严丝合缝地跟着手
  _bindGunToHand() {
    const cfg = this.def.fix && this.def.fix.handMount;
    if (!cfg || cfg.pivot) return;          // pivot 是通用微调枢轴，不做轨道剥离
    const gun = this.root.getObjectByName(cfg.gun);
    const hand = this.root.getObjectByName(cfg.hand);
    if (!gun || !hand) return;

    const clip = this.clips.get(cfg.pose || (this.def.view && this.def.view.poseFrom) || this.def.anims.draw);
    if (clip) {
      const tmp = new THREE.AnimationMixer(this.root);
      const act = tmp.clipAction(clip);
      act.play();
      tmp.update(Math.max(0, clip.duration - 0.0001));
      this.root.updateMatrixWorld(true);
    }

    const m = new THREE.Matrix4().copy(hand.matrixWorld).invert().multiply(gun.matrixWorld);
    hand.add(gun);
    m.decompose(gun.position, gun.quaternion, gun.scale);

    // 直接指定相对手的局部变换（用于同套骨骼、但导出时父级挂错的模型）
    if (cfg.localPos) gun.position.fromArray(cfg.localPos);
    if (cfg.localQuat) gun.quaternion.fromArray(cfg.localQuat);

    // 指定枪体骨骼在模型根空间的朝向（同套 CS 骨骼标准是绕 X 轴 90°），
    // 反解出相对手的局部旋转，这样枪口方向与其它武器完全一致
    if (cfg.rootRotDeg) {
      // 沿父链累乘局部四元数，避开镜像节点的负缩放污染
      const qHandRoot = new THREE.Quaternion();
      const chain = [];
      for (let o = hand; o && o !== this.root; o = o.parent) chain.push(o);
      for (let i = chain.length - 1; i >= 0; i--) qHandRoot.multiply(chain[i].quaternion);
      const e = new THREE.Euler(cfg.rootRotDeg[0] * DEG, cfg.rootRotDeg[1] * DEG, cfg.rootRotDeg[2] * DEG, 'XYZ');
      const targetQ = new THREE.Quaternion().setFromEuler(e);
      gun.quaternion.copy(qHandRoot.invert().multiply(targetQ));
    }

    if (cfg.rotDeg) {
      const e = new THREE.Euler(cfg.rotDeg[0] * DEG, cfg.rotDeg[1] * DEG, cfg.rotDeg[2] * DEG, 'XYZ');
      gun.quaternion.multiply(new THREE.Quaternion().setFromEuler(e));
    }
    if (cfg.pos) gun.position.add(new THREE.Vector3().fromArray(cfg.pos));
    if (cfg.scale) gun.scale.multiplyScalar(cfg.scale);

    for (const c of this.clips.values()) {
      c.tracks = c.tracks.filter(t => !t.name.startsWith(cfg.gun + '.'));
    }
    gun.userData.baseQ = gun.quaternion.clone();
    gun.userData.baseP = gun.position.clone();
    // 记录基准，供调参面板在基准之上叠加微调
    this.mountNode = gun;
    this.mountBaseP = gun.position.clone();
    this.mountBaseQ = gun.quaternion.clone();
    this.mountBaseS = gun.scale.x;
    this.root.updateMatrixWorld(true);
  }

  /**
   * 通用「枪体相对手」枢轴。
   *
   * 绝大多数 CS 模型里枪体骨骼本来就挂在右手骨下面，动画只驱动手臂/手指，
   * 枪体相对手的局部变换写死在绑定姿势里（XM1014 就是偏出去一大截，看起来像浮在半空）。
   * 这里在「手骨 → 枪体根骨骼」之间插一个空 Group：枪体骨骼的局部变换原样保留，
   * 动画轨道一条都不用改；调参面板改的是这个 Group 的位移 / 旋转 / 缩放，
   * 于是可以单独把枪摆进手里、放大缩小枪身，而不会带着手臂一起动。
   */
  _setupHandPivot() {
    const cfg0 = this.def.fix && this.def.fix.handMount;
    if (cfg0 && cfg0.bind) return;          // 旧模型里走专用绑定的武器

    // 枪体根骨骼：优先 handMount.gunRoot，其次 fix.gunBone
    let gun = null;
    if (cfg0 && cfg0.gunRoot) gun = this.root.getObjectByName(cfg0.gunRoot);
    if (!gun && this.def.fix && this.def.fix.gunBone) gun = this.root.getObjectByName(this.def.fix.gunBone);
    if (!gun || !gun.parent) return;

    // 右手骨：支持新命名 Bone_Righthand 与旧命名 v_weaponBip01_R_Hand
    let hand = null;
    this.root.traverse(o => {
      if (hand || !o.isBone) return;
      const n = o.name.toLowerCase();
      if (n === 'bone_righthand' || n === 'v_weaponbip01_r_hand' || /_r_hand$/.test(n)) hand = o;
    });
    this._makePivot(hand, gun);
  }

  /** 在「枪体根骨骼」与它的父节点之间插一个枢轴，面板改的就是这个 Group */
  _makePivot(hand, gun) {
    const pivot = new THREE.Group();
    pivot.name = 'gunPivot_' + this.def.id;
    this.root.updateMatrixWorld(true);
    const pcfg = (this.def.fix && this.def.fix.handMount) || {};
    let baseP = new THREE.Vector3(0, 0, 0), baseQ = new THREE.Quaternion(), baseS = 1;
    if (pcfg.pivotAtGun) {
      // 枢轴原点放在枪体骨骼自身位置：绕枪体自身转，不会因为父骨骼原点很远把枪甩飞
      baseP = gun.position.clone();
      baseQ = gun.quaternion.clone();
      baseS = gun.scale.x;
      pivot.position.copy(baseP);
      pivot.quaternion.copy(baseQ);
      pivot.scale.copy(gun.scale);
      gun.parent.add(pivot);
      gun.position.set(0, 0, 0);
      gun.quaternion.identity();
      gun.scale.set(1, 1, 1);
    } else {
      gun.parent.add(pivot);
    }
    pivot.add(gun);                          // 局部变换不变，画面完全等价
    this.handPivot = pivot;
    this.handGun = gun;
    this.handBone = hand;

    const fix = this.def.fix || (this.def.fix = {});
    const cfg = fix.handMount || (fix.handMount = {});
    cfg.gun = gun.name;
    cfg.hand = hand ? hand.name : null;
    cfg.pivot = true;
    if (!cfg.tune) cfg.tune = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };
    if (!cfg.tune.pos) cfg.tune.pos = [0, 0, 0];
    if (!cfg.tune.rotDeg) cfg.tune.rotDeg = [0, 0, 0];
    if (cfg.tune.scale == null) cfg.tune.scale = 1;

    this.mountNode = pivot;
    this.mountBaseP = baseP;
    this.mountBaseQ = baseQ;
    this.mountBaseS = baseS;
    this.seatPos = null;
    this._applyMountTune();
  }

  /**
   * 换上别的武器的手臂。
   * R8 这张模型自带的是 CT 玩家的手臂（蓝袖子 + FBI 手套），和其它枪的视模型手臂完全不同；
   * 而且它的手臂是跟着「枪体骨骼」一起动的（蒙皮权重几乎全在 deagle_parent 上）。
   *
   * 做法：把自己的手臂藏起来，把供体（默认沙鹰）的整棵骨架挂到本模型的枪体骨骼下面，
   * 再把供体骨架的变换算到「供体的枪体骨骼 == 本模型的枪体骨骼」为止。
   * 这样供体的双手正好握在这把枪的握把上，枪怎么动（拔枪/换弹/后坐）手就怎么跟，
   * 和原模型「手臂跟着枪走」的表现一致。
   */
  _graftArms(donorGltf) {
    const cfg = this.def.fix && this.def.fix.graftArms;
    if (!cfg || !donorGltf) return;
    if (cfg.bake) { this._graftBaked(donorGltf, cfg); return; }

    const hide = (cfg.hide || []).map(s => s.toLowerCase());
    const keep = (cfg.keep || []).map(s => s.toLowerCase());
    const matNames = (o) => (Array.isArray(o.material) ? o.material : [o.material])
      .map(m => ((m && m.name) || '').toLowerCase());

    // 1) 藏掉自己身上那两条 CT 手臂（枪身部件保留）
    this.root.traverse(o => {
      if (!o.isMesh) return;
      const names = matNames(o);
      if (names.length && names.every(n => hide.some(h => n.includes(h)))) o.visible = false;
    });

    // 2) 供体只留手臂，枪身部件全部隐藏
    const donor = donorGltf.scene;
    donor.traverse(o => {
      if (!o.isMesh) return;
      const names = matNames(o);
      const isArm = names.length > 0 && names.every(n => keep.some(k => n.includes(k)));
      o.visible = isArm;
      if (!isArm) return;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        m.side = THREE.DoubleSide;           // 镜像后三角形绕序翻转
        m.shadowSide = THREE.DoubleSide;
      }
    });

    // 3) 供体骨架挂到本模型的枪体骨骼下面，并让两边的「枪体骨骼」重合
    // 供体自己的「持枪姿势」：把手摆成握枪的样子（绑定姿势是张开的，直接挂上去像举手）
    const poseName = cfg.pose || 'draw';
    const poseSrc = donorGltf.animations.find(a => a.name === poseName) || donorGltf.animations[0];
    if (poseSrc) {
      const mixer = new THREE.AnimationMixer(donor);
      const act = mixer.clipAction(poseClipFrom(poseSrc, 'graftpose'));
      act.play();
      mixer.update(0);
      this.graftMixer = mixer;               // 留住引用，别被 GC
    }

    const gunName = cfg.gunBone || (this.def.fix.handMount && this.def.fix.handMount.gunRoot) || 'v_weapondeagle_parent';
    const myGun = this.root.getObjectByName(gunName);
    const doGun = donor.getObjectByName(gunName);
    if (!myGun || !doGun) return;

    // 供体的骨骼名字和本模型完全一样，挂进来以后动画按名字会绑到「先找到的那根」，
    // 两套骨架互相打架。这里给供体骨骼统一加前缀；蒙皮用的是对象引用，改名不影响变形。
    donor.traverse(o => { if (o.isBone) o.name = 'graft_' + o.name; });
    // 注意：要刷整条 rig 链（mirror/orient/rig），只刷 root 会拿到过期的父矩阵
    (this.rig || this.root).updateMatrixWorld(true);
    donor.updateMatrixWorld(true);

    const target = new THREE.Matrix4().copy(myGun.matrixWorld);
    target.multiply(new THREE.Matrix4().copy(doGun.matrixWorld).invert());
    // 供体的手比这把枪小一圈：按 cfg.scale 放大，手掌才包得住握把
    const k = cfg.scale || 1;
    if (k !== 1) {
      const sv = new THREE.Vector3(k, k, k);
      const sm = new THREE.Matrix4().makeScale(sv.x, sv.y, sv.z);
      // 以「枪体骨骼」为原点缩放，枪不会跑位
      target.multiply(sm);
      target.copy(new THREE.Matrix4().copy(myGun.matrixWorld).multiply(sm).multiply(
        new THREE.Matrix4().copy(doGun.matrixWorld).invert()));
    }

    (this.rig || this.root).updateMatrixWorld(true);
    myGun.add(donor);
    // 直接写矩阵：这一步里带镜像 + 旋转，decompose 会丢掉剪切分量，摆出来就会偏
    const local = new THREE.Matrix4().copy(myGun.matrixWorld).invert().multiply(target);
    donor.matrixAutoUpdate = false;
    donor.matrix.copy(local);
    donor.matrixWorldNeedsUpdate = true;
    donor.updateMatrixWorld(true);

    this.graftRoot = donor;
    this.graftGun = myGun;
  }



  /**
   * 「烘焙」方案：模型自己的骨架和网格对不上（转轮、装填口飘在枪身外，手臂是玩家模型的尺寸），
   * 所以不要它的骨架：
   *   1. 把枪体各部件按「未蒙皮的原始几何」取出来（这个姿势是完整的），
   *      转轮/弹巢按 cfg.cylOffset 挪回枪身里，坏掉的装填口零件直接丢掉；
   *   2. 静态枪挂在供体（沙鹰）的枪体骨骼下，按「两边枪体包围盒」对齐大小和中心；
   *   3. 供体只留手臂，动画也换成供体的（draw/reload/shoot），手臂就会正常做动作。
   * 结果是「沙鹰的手臂 + R8 的左轮」：枪跟着手走，拔枪/换弹时一起动。
   */
  _graftBaked(donorGltf, cfg) {
    const donor = donorGltf.scene;
    const partRE = cfg.partRE ? new RegExp(cfg.partRE, 'i') : /revolver/i;
    const skipRE = cfg.skipRE ? new RegExp(cfg.skipRE, 'i') : null;
    const cylRE = cfg.cylRE ? new RegExp(cfg.cylRE, 'i') : null;
    const cylOff = cfg.cylOffset || [0, 0, 0];
    const matName = (o) => ((o.material && o.material.name) || '');

    // 1) 烤枪
    const gunGroup = new THREE.Group();
    gunGroup.name = 'bakedGun';
    this.root.traverse(o => {
      if (!o.isSkinnedMesh || !partRE.test(matName(o))) return;
      const joints = this._meshBones(o);
      if (skipRE && joints.some(n => skipRE.test(n))) return;
      const geo = o.geometry.clone();
      for (const k of Object.keys(geo.attributes)) if (/^skin/i.test(k)) geo.deleteAttribute(k);
      const m = new THREE.Mesh(geo, o.material);
      m.userData.bones = joints;
      if (cylRE && joints.some(n => cylRE.test(n))) m.position.fromArray(cylOff);
      // 有些零件的绑定位置和枪身差一截：按三角面数指定补偿
      if (cfg.partOffsets) {
        const key = String(geo.attributes.position.count);
        if (cfg.partOffsets[key]) m.position.add(new THREE.Vector3().fromArray(cfg.partOffsets[key]));
      }
      gunGroup.add(m);
    });
    if (!gunGroup.children.length) return;

    // 2) 本模型的蒙皮网格全部隐藏
    this.root.traverse(o => { if (o.isSkinnedMesh) o.visible = false; });

    // 3) 供体只留手臂
    const keep = (cfg.keep || []).map(s => s.toLowerCase());
    donor.traverse(o => {
      if (!o.isMesh) return;
      const names = (Array.isArray(o.material) ? o.material : [o.material])
        .map(m => ((m && m.name) || '').toLowerCase());
      const isArm = names.length > 0 && names.every(n => keep.some(k => n.includes(k)));
      o.visible = isArm;
      if (!isArm) return;
      o.frustumCulled = false;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue;
        m.side = THREE.DoubleSide;            // 镜像后绕序翻转
        m.shadowSide = THREE.DoubleSide;
      }
    });

    // 3.5) 先把供体摆成「持枪待机」的姿势：绑定姿势是张开的手，
    //      按绑定姿势算出来的枪位会偏出一大截。
    const poseSrc = donorGltf.animations.find(a => a.name === (cfg.pose || 'draw')) || donorGltf.animations[0];
    if (poseSrc) {
      const mixer = new THREE.AnimationMixer(donor);
      const act = mixer.clipAction(poseClipFrom(poseSrc, 'graftpose'));
      act.play();
      mixer.update(0);
      this.graftMixer = mixer;               // 留住引用，别被 GC
    }

    // 4) 供体挂进来；本模型骨骼改名让位，动画就只会绑到供体的骨架上
    this.root.add(donor);
    const myBones = [];
    this.root.traverse(o => { if (o.isBone && !this._isUnder(o, donor)) myBones.push(o); });
    for (const b of myBones) b.name = 'x_' + b.name;

    // 5) 静态枪对齐到供体的枪体骨骼
    donor.updateMatrixWorld(true);
    const boneName = cfg.gunBone || 'v_weapondeagle_parent';
    const bone = donor.getObjectByName(boneName);
    if (!bone) return;
    const bInv = new THREE.Matrix4().copy(bone.matrixWorld).invert();

    // 沙鹰枪体（在枪骨局部空间）的包围盒
    const refBox = new THREE.Box3();
    const v = new THREE.Vector3();
    const refPts = [];
    donor.traverse(o => {
      if (!o.isSkinnedMesh) return;
      if (!/de_handle|de_slide/.test(matName(o).toLowerCase())) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 2) {
        // 用蒙皮后的真实位置（直接读顶点拿到的是绑定姿势，会偏一大截）
        v.fromBufferAttribute(pos, i);
        o.applyBoneTransform(i, v);
        v.applyMatrix4(o.matrixWorld).applyMatrix4(bInv);
        refBox.expandByPoint(v);
        refPts.push(v.clone());
      }
    });
    gunGroup.updateMatrixWorld(true);
    const myBox = new THREE.Box3().setFromObject(gunGroup);
    if (refBox.isEmpty() || myBox.isEmpty()) return;

    const refSize = refBox.getSize(new THREE.Vector3());
    const mySize = myBox.getSize(new THREE.Vector3());
    const k = (refSize.z || 1) / (mySize.z || 1);
    const refC = refBox.getCenter(new THREE.Vector3());
    const myC = myBox.getCenter(new THREE.Vector3());

    const mount = new THREE.Group();
    mount.name = 'bakedGunMount';
    gunGroup.position.copy(myC).multiplyScalar(-1);      // 先把枪挪到自身中心
    mount.add(gunGroup);
    mount.scale.setScalar(k);

    // 朝向：两把枪都按「主轴」对齐。
    // 各把枪在模型空间里的朝向千奇百怪（有的 +Y 是枪管、有的 +Z），
    // 这里对「烘焙枪」和「供体枪体」分别做一次 PCA，把长轴对长轴、次轴对次轴，
    // 再按 cfg.pcaFlip 决定两端的方向（不同模型需要翻某个轴）。
    {
      const flip = cfg.pcaFlip || [1, 1, 1];
      const mine = this._pca(gunGroup, 1);
      const ref = this._pcaFromPoints(refPts);

      const a0 = mine[0].clone().multiplyScalar(flip[0]);
      const a1 = mine[1].clone().multiplyScalar(flip[1]);
      const a2 = new THREE.Vector3().crossVectors(a0, a1).normalize();
      const b0 = ref[0].clone();
      const b1 = ref[1].clone();
      const b2 = new THREE.Vector3().crossVectors(b0, b1).normalize();

      const ma = new THREE.Matrix4().makeBasis(a0, a1, a2);
      const mb = new THREE.Matrix4().makeBasis(b0, b1, b2);
      const q = new THREE.Quaternion().setFromRotationMatrix(
        mb.multiply(ma.transpose())
      );
      if (cfg.extraRotDeg) {
        // 模型自身的枪管轴和供体的枪管轴不一致时的微调（绕枪自身轴）
        const e = new THREE.Euler(cfg.extraRotDeg[0] * DEG, cfg.extraRotDeg[1] * DEG, cfg.extraRotDeg[2] * DEG, 'XYZ');
        q.multiply(new THREE.Quaternion().setFromEuler(e));
      }
      mount.quaternion.copy(q);
      mount.userData.baseQ = q.clone();
    }
    mount.position.copy(refC);
    if (cfg.gunPos) mount.position.add(new THREE.Vector3().fromArray(cfg.gunPos));
    mount.userData.baseP = refC.clone();
    mount.userData.baseS = k;

    // 挂点：默认挂到手骨上（枪永远跟着手握，不会因为枪骨自己的动画飞出去）
    mount.updateMatrix();
    let host = bone;
    if (cfg.mountTo === 'hand') {
      let p = bone.parent;
      while (p && !/_hand$/i.test(p.name)) p = p.parent;
      if (p) {
        const keep = new THREE.Matrix4().copy(p.matrixWorld).invert()
          .multiply(new THREE.Matrix4().copy(bone.matrixWorld).multiply(mount.matrix));
        host = p;
        keep.decompose(mount.position, mount.quaternion, mount.scale);
      }
    }
    host.add(mount);
    this.bakedGun = mount;

    // 6) 动画换成供体的
    this.animSource = donorGltf.animations;
  }

  /** 对一组点（或某个 Group 的顶点）做 PCA，返回按方差从大到小排列的三个单位轴 */
  _pca(obj, stride = 1) {
    const pts = [];
    const v = new THREE.Vector3();
    obj.updateMatrixWorld(true);
    obj.traverse(o => {
      if (!o.isMesh) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += stride) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        pts.push(v.clone());
      }
    });
    return this._pcaFromPoints(pts);
  }

  _pcaFromPoints(pts) {
    const c = new THREE.Vector3();
    for (const p of pts) c.add(p);
    c.multiplyScalar(1 / Math.max(1, pts.length));
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) {
      const x = p.x - c.x, y = p.y - c.y, z = p.z - c.z;
      m[0] += x * x; m[1] += x * y; m[2] += x * z;
      m[3] += y * x; m[4] += y * y; m[5] += y * z;
      m[6] += z * x; m[7] += z * y; m[8] += z * z;
    }
    // 幂迭代求前三个特征向量（数值上够用，只关心方向）
    const M = new THREE.Matrix3().fromArray(m);
    const axes = [];
    const work = M.clone();
    for (let k = 0; k < 3; k++) {
      let vec = new THREE.Vector3(k === 0 ? 1 : 0, k === 1 ? 1 : 0.2, k === 2 ? 1 : 0.4);
      for (let it = 0; it < 60; it++) {
        vec.applyMatrix3(work);
        if (vec.lengthSq() < 1e-12) break;
        vec.normalize();
      }
      axes.push(vec.clone());
      // 收缩：去掉这个方向上的分量
      const outer = new THREE.Matrix3();
      const e = vec;
      outer.set(
        e.x * e.x, e.x * e.y, e.x * e.z,
        e.y * e.x, e.y * e.y, e.y * e.z,
        e.z * e.x, e.z * e.y, e.z * e.z
      );
      const lam = vec.clone().applyMatrix3(work).dot(vec);
      const arr = work.toArray();
      const oa = outer.toArray();
      for (let i = 0; i < 9; i++) arr[i] -= lam * oa[i];
      work.fromArray(arr);
    }
    return axes;
  }

  /** 某个蒙皮网格受哪些骨骼影响（按蒙皮索引取骨骼名） */
  _meshBones(mesh) {
    const out = new Set();
    const si = mesh.geometry.attributes.skinIndex;
    if (!si || !mesh.skeleton) return [];
    for (let i = 0; i < si.count; i += 7) {
      for (let k = 0; k < 4; k++) {
        const ix = si.getComponent(i, k);
        const b = mesh.skeleton.bones[ix];
        if (b && ix < mesh.skeleton.bones.length) out.add(b.name);
      }
    }
    return [...out];
  }

  _isUnder(o, root) {
    let p = o;
    while (p) { if (p === root) return true; p = p.parent; }
    return false;
  }

  /** 握把点：从扳机骨骼沿枪管反方向退 back（占枪长比例）、向下偏移 down */
  _gripPoint(trig, back = 0.12, down = 0.03) {
    const p = trig.getWorldPosition(new THREE.Vector3());
    if (!this.handGun || !this.flashBone) return p;
    const root = this.handGun.getWorldPosition(new THREE.Vector3());
    const muzzle = this.flashBone.getWorldPosition(new THREE.Vector3());
    const fwd = muzzle.clone().sub(root);
    const len = fwd.length() || 1;
    fwd.normalize();
    p.addScaledVector(fwd, -len * back);
    p.y -= len * down;
    return p;
  }

  /** 调试用：按给定参数重算握持（不重建武器）；mode='root' 时把枪体根骨骼对准掌心 */
  reseat(back, down, mode) {
    const cfg = this.def.fix && this.def.fix.seat;
    if (!cfg) return 'no seat';
    const ap = this.root.getObjectByName('armPivot_' + (cfg.armR || 'v_weaponBip01_R_Forearm'));
    if (ap) ap.position.set(0, 0, 0);
    this.seatPos = this.seatPos || new THREE.Vector3();
    this.seatPos.set(0, 0, 0);
    this._applyMountTune();
    this.root.updateMatrixWorld(true);
    const trig = this.root.getObjectByName(cfg.trigger);
    const palm = this._palmPoint('R');
    if (!trig || !palm) return 'no bone';
    const T0 = mode === 'root'
      ? this.handGun.getWorldPosition(new THREE.Vector3())
      : this._gripPoint(trig, back, down);
    const delta = palm.clone().sub(T0);
    const lin = new THREE.Matrix3().setFromMatrix4(this.handBone.matrixWorld).invert();
    this.seatPos.copy(delta.clone().applyMatrix3(lin));
    this._applyMountTune();
    this.root.updateMatrixWorld(true);
    this._shiftArm(cfg.armR || 'v_weaponBip01_R_Forearm', delta.clone().multiplyScalar(-1));
    this.root.updateMatrixWorld(true);
    return 'ok';
  }

  /** 掌心世界坐标：取食指/中指/无名指根部的平均值，比手骨原点更接近握把 */
  _palmPoint(side) {
    const names = [1, 2, 3].map(i => 'v_weaponBip01_' + side + '_Finger' + i);
    const pts = names.map(n => this.root.getObjectByName(n)).filter(Boolean);
    if (!pts.length) return null;
    const p = new THREE.Vector3();
    for (const o of pts) p.add(o.getWorldPosition(new THREE.Vector3()));
    return p.multiplyScalar(1 / pts.length);
  }

  /** 给某根骨骼套一个平移枢轴（world 向量按父空间换算成局部），用于修正模型里错位的零件 */
  offsetBone(boneName, worldVec) {
    const bone = this.root.getObjectByName(boneName);
    if (!bone || !bone.parent) return null;
    let pivot = bone.parent.children.find(o => o.name === 'offPivot_' + boneName);
    if (!pivot) {
      pivot = new THREE.Group();
      pivot.name = 'offPivot_' + boneName;
      const parent = bone.parent;
      parent.add(pivot);
      pivot.add(bone);
      pivot.position.set(0, 0, 0);
    }
    this.root.updateMatrixWorld(true);
    const lin = new THREE.Matrix3().setFromMatrix4(pivot.parent.matrixWorld).invert();
    pivot.position.copy(new THREE.Vector3().fromArray(worldVec).applyMatrix3(lin));
    return pivot;
  }

  /** 取（或创建）某根骨骼的平移枢轴 */
  _armPivot(boneName) {
    const bone = this.root.getObjectByName(boneName);
    if (!bone || !bone.parent) return null;
    let pivot = bone.parent.children.find(o => o.name === 'armPivot_' + boneName);
    if (!pivot) {
      pivot = new THREE.Group();
      pivot.name = 'armPivot_' + boneName;
      const parent = bone.parent;
      parent.add(pivot);
      pivot.add(bone);
      pivot.position.set(0, 0, 0);
    }
    return pivot;
  }

  /** 在骨骼与父节点之间插一个空 Group，用来整段平移这条手臂（动画轨道不受影响） */
  _shiftArm(boneName, worldDelta) {
    const pivot = this._armPivot(boneName);
    if (!pivot) return;
    const lin = new THREE.Matrix3().setFromMatrix4(pivot.parent.matrixWorld).invert();
    pivot.position.add(worldDelta.clone().applyMatrix3(lin));
  }

  /** 直接把某条手臂设到「相对原位的世界偏移」（绝对值，不累加） */
  _setArmOffset(boneName, worldDelta) {
    const pivot = this._armPivot(boneName);
    if (!pivot) return;
    const lin = new THREE.Matrix3().setFromMatrix4(pivot.parent.matrixWorld).invert();
    pivot.position.copy(worldDelta).applyMatrix3(lin);
  }

  /**
   * 手雷的左手：切枪 / 待机时把左臂收到画面外（这张模型的 deploy 动画没有左臂轨道，
   * 留着就是一只僵在半空的张开的手），拉环和投掷时再让它回到动画位置。
   */
  _updateLeftArm(dt) {
    const cfg = this.def.fix && this.def.fix.leftArm;
    if (!cfg) return;
    const want = (this.state === 'idle' || this.state === 'draw') ? 1 : 0;
    this._leftK = this._leftK == null ? want : this._leftK + (want - this._leftK) * Math.min(1, dt * 9);
    const h = cfg.hide || [0.05, -0.55, 0.1];
    this._setArmOffset(cfg.arm || 'v_weaponBip01_L_Forearm',
      new THREE.Vector3(h[0] * this._leftK, h[1] * this._leftK, h[2] * this._leftK));
  }

  /** 绕骨骼自身（父空间里的某个点）旋转一段：用来给左手找朝向 */
  _turnBone(boneName, rotDeg) {
    const bone = this.root.getObjectByName(boneName);
    if (!bone || !bone.parent) return null;
    let pivot = bone.parent.children.find(o => o.name === 'turnPivot_' + boneName);
    if (!pivot) {
      pivot = new THREE.Group();
      pivot.name = 'turnPivot_' + boneName;
      const parent = bone.parent;
      parent.add(pivot);
      pivot.add(bone);
    }
    const e = new THREE.Euler(rotDeg[0] * DEG, rotDeg[1] * DEG, rotDeg[2] * DEG, 'XYZ');
    pivot.quaternion.setFromEuler(e);
    return pivot;
  }

  /**
   * 把手「抬到枪上」，而不是把枪拽到手上。
   *
   * XM1014 这类模型的枪体骨骼虽然挂在右手下面，但绑定姿势里离手心有 20cm，
   * 又没有枪体轨道把它拉回来 —— 看上去就是枪飘在空中、手在下面张着。
   * 做法：先把枪体挪到掌心，再把整条手臂反向平移同样距离，
   * 枪的画面位置一点不变，手刚好握在握把上；左手同理扶到护木。
   */
  _seatInHand() {
    const cfg = this.def.fix && this.def.fix.seat;
    if (!cfg || !this.handBone || !this.handGun) return;
    // 先用「持枪基准姿势」摆一次，量出来的掌心位置才和游戏里看到的一致
    if (this.basePose) {
      const tmp = new THREE.AnimationMixer(this.root);
      tmp.clipAction(this.basePose).play();
      tmp.update(0);
    }
    this.root.updateMatrixWorld(true);

    const trig = this.root.getObjectByName(cfg.trigger);
    const palmR = this._palmPoint('R');
    if (!trig || !palmR) return;

    // 说明：试过把枪管强行扳成水平（绕手腕转 30°），换弹时枪身会跟着甩到镜头前糊住半个屏幕，
    // 所以这里只做平移，朝向保持模型原本的持枪角度。
    this.seatQuat = null;
    this.seatPos = new THREE.Vector3();
    this.root.updateMatrixWorld(true);

    // 2) 枪体平移到掌心。锚点不是扳机本身，而是「扳机往枪托方向退一点」的握把位置，
    //    否则枪身会从手心里穿过去，手指全戳在机匣上。
    const back = cfg.gripBack != null ? cfg.gripBack : 0.12;
    const down = cfg.gripDown != null ? cfg.gripDown : 0.03;
    // 默认把「枪体根骨骼」对准掌心（和 M3 等正常模型一致）；需要时可用 gripBack/gripDown 微调
    const T0 = (cfg.seatAt === 'trigger')
      ? this._gripPoint(trig, back, down)
      : this.handGun.getWorldPosition(new THREE.Vector3());
    const palm2 = this._palmPoint('R') || palmR;
    const delta = palm2.clone().sub(T0);
    const lin = new THREE.Matrix3().setFromMatrix4(this.handBone.matrixWorld).invert();
    this.seatPos = delta.clone().applyMatrix3(lin);
    this._applyMountTune();
    this.root.updateMatrixWorld(true);

    // 3) 整条右臂反向平移，枪回到原来的画面位置
    this._shiftArm(cfg.armR || 'v_weaponBip01_R_Forearm', delta.multiplyScalar(-1));
    this.root.updateMatrixWorld(true);

    // 3) 左手：模型这张左手在持枪姿势里是张开的手指（怎么摆都像抽筋），
    //    玩家选择直接收起来，只留右手握枪；需要时把 leftHide 关掉即可恢复支撑手
    if (cfg.leftHide) {
      const h = cfg.leftHideOffset || [0.05, -0.6, 0.12];
      this._shiftArm(cfg.armL || 'v_weaponBip01_L_Forearm', new THREE.Vector3(h[0], h[1], h[2]));
      this.root.updateMatrixWorld(true);
    } else {
      // 手指已经借用 M3 的握拳姿势，不再强行扭手腕（大幅扭腕会把腕部蒙皮拉成尖刺）
      this.seatLeft({ autoRot: false });
    }

  }

  /**
   * 左手支撑姿势：先按枪管方向给手找朝向（张开的五指顺着护木往前才不像抽筋），
   * 再把整条左臂平移到护木下方。参数可覆盖，调参时方便单步试。
   */
  seatLeft(opt = {}) {
    const cfg = this.def.fix && this.def.fix.seat;
    if (!cfg || !this.handGun) return null;
    const handL = cfg.handL || 'v_weaponBip01_L_Hand';
    const armL = cfg.armL || 'v_weaponBip01_L_Forearm';
    const sup = this.root.getObjectByName(cfg.support);
    if (!sup) return null;

    // 复位上一次的姿态，保证可重复调用
    const tp = this.root.getObjectByName('turnPivot_' + handL);
    if (tp) tp.quaternion.identity();
    const ap = this.root.getObjectByName('armPivot_' + armL);
    if (ap) ap.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);

    const lerp = opt.lerp != null ? opt.lerp : (cfg.supportLerp || 0);
    const drop = opt.drop != null ? opt.drop : (cfg.supportDrop || 0);

    // 朝向
    if (opt.rot) {
      this._turnBone(handL, opt.rot);
    } else if (opt.autoRot !== false) {
      const lh = this.root.getObjectByName(handL);
      const lf = this.root.getObjectByName('v_weaponBip01_L_Finger2');
      if (lh && lf && this.flashBone) {
        this.root.updateMatrixWorld(true);
        const handPos = lh.getWorldPosition(new THREE.Vector3());
        const fingerDir = lf.getWorldPosition(new THREE.Vector3()).sub(handPos).normalize();
        const barrel = this.flashBone.getWorldPosition(new THREE.Vector3())
          .sub(this.handGun.getWorldPosition(new THREE.Vector3())).normalize();
        fingerDir.y *= (opt.flat != null ? opt.flat : 0.25);
        barrel.y *= (opt.flat != null ? opt.flat : 0.25);
        const qFix = new THREE.Quaternion().setFromUnitVectors(fingerDir.normalize(), barrel.normalize());
        const pq = lh.parent.getWorldQuaternion(new THREE.Quaternion());
        const qLocal = pq.clone().invert().multiply(qFix).multiply(pq);
        const e = new THREE.Euler().setFromQuaternion(qLocal, 'XYZ');
        this._turnBone(handL, [e.x / DEG, e.y / DEG, e.z / DEG]);
      }
    }
    this.root.updateMatrixWorld(true);

    // 位置
    const palm = this._palmPoint('L');
    const target = sup.getWorldPosition(new THREE.Vector3());
    if (lerp > 0 && this.flashBone) target.lerp(this.flashBone.getWorldPosition(new THREE.Vector3()), lerp);
    target.y -= drop;
    const delta = palm ? target.sub(palm) : new THREE.Vector3();

    // 记住这套「待机握法」：待机/拔枪时生效，换弹/开火时淡出，
    // 交还给动画自己的左臂轨迹（否则手会偏离装填口一截）
    const tp2 = this.root.getObjectByName('turnPivot_' + handL);
    this.leftSeat = {
      arm: armL,
      hand: handL,
      delta: delta.clone(),
      turn: tp2 ? tp2.quaternion.clone() : null
    };
    this._seatK = 1;
    this._applySeatPose(1);
    this.root.updateMatrixWorld(true);
    return { lerp, drop };
  }

  /** 左手「待机握法」与动画之间的淡入淡出 */
  _applySeatPose(k) {
    const s = this.leftSeat;
    if (!s) return;
    // k=1 扶在护木上；k=0 时不是回到动画（那条轨迹在镜头后面，会把手臂穿进镜头），
    // 而是把整条左臂收到画面外——这个模型的换弹动画本来就不该看到左手
    const hide = (this.def.fix && this.def.fix.seat && this.def.fix.seat.hideOnReload) || [0.1, -0.9, 0.25];
    const off = s.delta.clone().multiplyScalar(k)
      .add(new THREE.Vector3(hide[0], hide[1], hide[2]).multiplyScalar(1 - k));
    this._setArmOffset(s.arm, off);
    const tp = this.root.getObjectByName('turnPivot_' + s.hand);
    if (tp) {
      tp.quaternion.set(0, 0, 0, 1);
      if (s.turn) tp.quaternion.slerp(s.turn, k);
    }
    this._seatHideK = 1 - k;
  }

  _updateSeatPose(dt) {
    const s = this.leftSeat;
    if (!s) return;
    const want = (this.state === 'idle' || this.state === 'draw') ? 1 : 0;
    const cur = this._seatK == null ? want : this._seatK;
    const next = cur + (want - cur) * Math.min(1, dt * 7);
    if (Math.abs(next - cur) > 1e-4) {
      this._seatK = next;
      this._applySeatPose(next);
    }
  }

  /** 把当前（GLTF 静止）骨骼变换抓成一个单帧 clip，用来补全动画缺的轨道 */
  _captureRest() {
    const tracks = [];
    this.root.traverse(o => {
      if (!o.isBone) return;
      const n = o.name;
      tracks.push(new THREE.VectorKeyframeTrack(n + '.position', [0], Array.from(o.position)));
      tracks.push(new THREE.QuaternionKeyframeTrack(n + '.quaternion', [0], Array.from(o.quaternion)));
    });
    return new THREE.AnimationClip('rest', 0.001, tracks);
  }

  _buildAnimations() {
    this.mixer = new THREE.AnimationMixer(this.root);

    const poseName = (this.def.view && this.def.view.poseFrom) || this.def.anims.draw;
    const drawClip = this.clips.get(poseName);
    this.basePose = drawClip ? poseClipFrom(drawClip, 'basepose') : new THREE.AnimationClip('basepose', 0.001, []);
    if (this.def.view && this.def.view.restPose) {
      // R8 这类的 draw 不动转轮/击锤：用「静止姿态」补这些骨骼。
      // 不能像别的枪那样借轨道最多的动画（会借到换弹末帧，把转轮卡在甩开的状态）。
      // 如果模型导出的静止姿势本身就不是「握好枪」的样子（R8 的转轮是甩开的），
      // 可以写成 restPose: 'shoot1' —— 用这段动画的首帧代替静止姿势。
      const rp = this.def.view.restPose;
      let base = this.restClip;
      if (typeof rp === 'string') {
        // "reload@0" = 取这段动画第 0 秒的姿态（模型导出的静止姿势里零件是「炸开」的，
        // 用换弹首帧这种「枪是合拢的」姿态来补）
        const [cname, atStr] = rp.split('@');
        const c = this.clips.get(cname);
        if (c) base = poseClipFrom(c, 'restpose', atStr != null ? parseFloat(atStr) : 0);
      }
      this.basePose = mergePose(base, this.basePose, 'basepose');
    } else if (drawClip && !(this.def.view && this.def.view.noRichPose)) {
      let richest = null;
      for (const c of this.clips.values()) {
        if (c === drawClip) continue;
        if (!richest || c.tracks.length > richest.tracks.length) richest = c;
      }
      if (richest && richest.tracks.length > drawClip.tracks.length) {
        const richPose = poseClipFrom(richest, 'richpose');
        this.basePose = mergePose(richPose, this.basePose, 'basepose');
      }
    }

    // 待机：优先使用模型自带的 idle 循环，否则用拔枪动画末帧静止姿态
    const idleName = this.def.anims.idle;
    if (idleName && this.clips.has(idleName)) {
      this.idleClip = mergePose(this.basePose, this.clips.get(idleName), 'idleMerged');
      this.idleClip.duration = this.clips.get(idleName).duration;
    } else {
      this.idleClip = this.basePose;
    }

    this.idleAction = this.mixer.clipAction(this.idleClip);
    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
    this.idleAction.clampWhenFinished = false;
    this.idleAction.setEffectiveWeight(1);
    this.idleAction.play();

    this._cache = new Map();
    this._activeName = null;
    this._staged = null;
    this._stageName = null;
    this._stageTime = 0;
    this.mixer.addEventListener('finished', (e) => {
      if (e.action !== this.active) return;
      const name = this._activeName;
      // 分段换弹由 _watchReload 的节拍器统一推进（按时间，不依赖事件），
      // 这里只负责不把 state 复位成 idle
      if (this._staged) return;
      // 装/卸消音器结束：落到最终姿态（装好就一直留在枪上）
      if (this.def.silencer && this.state === 'silencer') {
        this._setSilencerParts(this.silenced);
        this._lockSilencerBone();
        this._silencerPending = null;
      }
      const finished = this.active;
      this.active = null;
      this._activeName = null;
      this.state = 'idle';
      this.cocking = false;                       // 左轮击锤已扳到位，可以再开枪
      this._pendingCasing = null;                 // 动作结束但延迟抛壳没触发就丢弃
      finished.fadeOut(0.16);
      this.idleAction.reset();
      this.idleAction.setEffectiveTimeScale(1);
      this.idleAction.setEffectiveWeight(1);
      this.idleAction.fadeIn(0.16);
      this.idleAction.play();
      if (name === this.def.anims.reload) this._finishReload();
      if (this.onEvent) this.onEvent('actionEnd', name);
    });
  }

  /** 普通换弹收尾：一次性把整匣补满 */
  _finishReload() {
    const take = Math.min(this.def.magSize - this.ammo, this.reserve);
    if (take > 0) {
      this.ammo += take;
      this.reserve -= take;
    }
    if (this.onEvent) this.onEvent('reloadEnd');
  }

  /**
   * 分段换弹推进：开仓(start) → 每发一次压弹(loop × 需要补充的弹数) → 收仓(end)。
   * 返回 true 表示已经接了下一段动作，不要走 idle 收尾。
   */
  _beginStage(name) {
    const clip = this.clips.get(name);
    if (!clip) return false;
    this._stageName = name;
    this._stageTime = 0;
    this._stageDur = Math.max(0.12, clip.duration);

    // 每一发都用「独立的动作实例」播放：
    // 三次里同一个 action 重复 play() 有时不会真正重头播，这里干脆每次新建，
    // 保证 8 发就是 8 次完整的压弹动作。
    this._stageSeq = (this._stageSeq | 0) + 1;
    const merged = mergePose(this.basePose, clip, `stage_${name}_${this._stageSeq}`);
    const act = this.mixer.clipAction(merged);
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;

    if (this.active && this.active !== act) {
      this.active.stop();
      this.active.setEffectiveWeight(0);
    }
    this.idleAction.stop();
    act.reset();
    act.setEffectiveTimeScale(1);
    act.setEffectiveWeight(1);
    act.enabled = true;
    act.play();

    this.active = act;
    this._activeName = name;
    this.state = 'reload';

    // 霰弹枪：每压一发响一次 insertshell，收仓时泵动（发数可变，不能预先拼成一段）
    const st = this._staged;
    const stageSfx = this.def.sfx && this.def.sfx.stage;
    if (st && stageSfx) {
      const key = name === st.seq.start ? 'start' : name === st.seq.loop ? 'loop' : name === st.seq.end ? 'end' : null;
      this.sfxCues.length = 0;
      if (key) this._queueCues(stageSfx[key], this._stageDur);
    }
    return true;
  }

  _advanceStage() {
    const st = this._staged;
    if (!st) return false;
    const seq = st.seq;

    if (this._stageName === seq.start) return this._beginStage(seq.loop);

    if (this._stageName === seq.loop) {
      // 每次压弹只补 1 发，补多少发就播多少次
      const room = this.def.magSize - this.ammo;
      const take = Math.min(seq.perLoop || 1, st.left, this.reserve, room);
      if (take > 0) {
        this.ammo += take;
        this.reserve -= take;
        st.left -= take;
        if (this.onEvent) this.onEvent('reloadShell', take);
      }
      if (st.left > 0 && this.reserve > 0 && this.ammo < this.def.magSize) return this._beginStage(seq.loop);
      return this._beginStage(seq.end);
    }

    if (this._stageName === seq.end) {
      this._staged = null;
      this._stageName = null;
      if (this.onEvent) this.onEvent('reloadEnd');
      return false;
    }
    return false;
  }

  /**
   * 霰弹枪换弹节拍器。
   * 完全按「这一段的动画时长」计时推进：开仓 → 每 0.43s 压一发 → 收仓。
   * 不依赖 mixer 的 finished 事件，所以掉帧、切后台、事件丢失都不会跳段或卡死；
   * 也绝不会出现「动画只播一次、弹药却瞬间补满」的情况——每发严格隔一段动画时长。
   */
  _watchReload(dt) {
    if (!this._staged || this.state !== 'reload') { this._stageTime = 0; return; }
    this._stageTime += dt;
    const dur = this._stageDur || 0.43;
    // 动作被外部打断（比如被 stop 掉）时，给一个最短等待，避免瞬间连跳
    if (this._stageTime < dur) return;
    if (!this._advanceStage()) {
      this._staged = null;
      this._stageName = null;
      this._activeName = null;
      // 关键：把最后一段动作停掉并清权重，否则它会一直 clamp 在末帧，
      // 下一次换弹时和新动作叠加，就出现「第二次换弹不正常」
      if (this.active) {
        this.active.stop();
        this.active.setEffectiveWeight(0);
      }
      this.active = null;
      this.state = 'idle';
      this.idleAction.reset();
      this.idleAction.setEffectiveWeight(1);
      this.idleAction.play();
      if (this.onEvent) this.onEvent('reloadEnd');
    }
    this._stageTime = 0;
  }

  /**
   * 枪口骨骼查找 + 抛壳口。
   * 玩家要求彻底去掉枪口火焰，所以这里只保留骨骼引用（枪口骨骼还用来定位抛壳 / 调参读数），
   * 火焰贴图、Sprite、点光源一律不再创建。
   */
  _buildFlash() {
    this.flashBone = null;
    this.root.traverse(o => {
      if (!this.flashBone && /flash/i.test(o.name)) this.flashBone = o;
    });
    // 这批视模型里没有 muzzle/flash 骨骼，枪口位置运行时再找（见 _findMuzzleBone）
    this.muzzleRoot = (this.def.fix && this.def.fix.gunBone)
      ? this.root.getObjectByName(this.def.fix.gunBone) : null;
    if (!this.muzzleRoot) {
      this.root.traverse(o => { if (!this.muzzleRoot && o.isBone) this.muzzleRoot = o; });
    }
    this.flashGroups = [];
    this.flashSprite = null;
    this.flashLight = null;
    this.flashGroup = null;
    this.flashFrame = 0;
    this.flashTimer = 0;
    this._initFlashFx();
    if (!this.flashBone) { this._setupCasings(); return; }
    this._flashPos = new THREE.Vector3();
    this._flashQ = new THREE.Quaternion();
    this._flashDir = new THREE.Vector3();
    this._flashRoot = new THREE.Vector3();
    this._AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    this.flashOutBase = this._measureMuzzle();
    this._setupCasings();
  }

  /**
   * 枪口火焰 + 烟雾的资源：两张火团、三张烟雾纹理。
   * 都挂在 viewScene 下（相机空间），位置由 flashBone 的世界坐标算出，
   * 所以不会跟着 rig 的走路抖动一起抖。
   */
  _initFlashFx() {
    if (!this.viewScene) return;
    const loader = new THREE.TextureLoader();
    // 枪口焰：不再用图片，改用 canvas 现画的星芒（每次开火随机挑一张）
    this.flashGroups = [];
    for (let i = 0; i < 4; i++) {
      const tex = makeStarFlash(256, 5 + (i % 3), (i * 1.21) % 1.57, 1013 + i * 7919);
      this.flashGroups.push([{ tex, w: 1, h: 1 }]);
    }

    const mat = new THREE.SpriteMaterial({
      map: null, transparent: true, opacity: 1,
      // 参与深度测试：枪身该遮住的地方就遮住（不再整体浮在枪上面）
      depthTest: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sp = new THREE.Sprite(mat);
    sp.visible = false;
    sp.renderOrder = 995;          // 压在枪身上面
    this.viewScene.add(sp);
    this.flashSprite = sp;

    const light = new THREE.PointLight(0xffb35a, 0, 3.0, 2);
    light.position.set(0, 0, 0);
    light.color.setHex(0xffb066);
    this.viewScene.add(light);
    this.flashLight = light;

    // 烟雾对象池：6 团循环用，各自固定一张纹理
    const smokeTex = SMOKE_TEXTS.map(p => {
      const t = loader.load(p);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    this.smokePuffs = [];
    for (let i = 0; i < 6; i++) {
      const sm = new THREE.SpriteMaterial({
        map: smokeTex[i % smokeTex.length],
        transparent: true, opacity: 0,
        depthTest: true, depthWrite: false,
        blending: THREE.NormalBlending,
        color: 0x9da2a8,
      });
      const s = new THREE.Sprite(sm);
      s.visible = false;
      s.renderOrder = 985;
      this.viewScene.add(s);
      this.smokePuffs.push({
        sp: s, t: 0, life: 1, vx: 0, vy: 0, vz: 0, spin: 0, size: 0, op: 0
      });
    }
  }

  /** 收掉这把枪身上的所有枪口特效（烟雾 + 火光），切枪/换弹时用 */
  _clearFx() {
    if (this.smokePuffs) {
      for (const p of this.smokePuffs) {
        p.t = 0;
        p.sp.visible = false;
        p.sp.material.opacity = 0;
      }
    }
    if (this.flashSprite) {
      this.flashSprite.visible = false;
      this.flashTimer = 0;
    }
    if (this.flashLight) this.flashLight.intensity = 0;
  }

  /**
   * 真正的枪口点：沿「枪体根 → 最深骨骼」的方向，找**蒙皮后**最远的那个顶点。
   * 骨骼位置和枪管末端经常对不上（AWP 的骨骼只到枪身中段），但顶点不会骗人。
   * 只算一次，结果存成 root 的局部坐标，之后每帧跟着枪一起动。
   */
  _computeMuzzleLocal() {
    // 算出来是 null 说明当时整把枪还是隐藏的（构造期间 rig.visible=false），
    // 不能把 null 当成结果缓存下来，否则永远退回到「最远的骨头」那条老路。
    if (this._muzzleLocal !== undefined && this._muzzleLocal !== null) return this._muzzleLocal;
    this.root.updateMatrixWorld(true);
    const tmp = new THREE.Vector3();

    let deepest = null, dz = 1e9;
    this.root.traverse(o => {
      if (!o.isBone) return;
      o.getWorldPosition(tmp);
      if (tmp.z < dz) { dz = tmp.z; deepest = o; }
    });
    const dir = new THREE.Vector3(0, 0, -1);
    if (this.muzzleRoot && deepest) {
      const r = new THREE.Vector3();
      this.muzzleRoot.getWorldPosition(r);
      deepest.getWorldPosition(tmp);
      dir.copy(tmp).sub(r);
      if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1); else dir.normalize();
    }

    let bestD = -1e9;
    const best = new THREE.Vector3();
    const v = new THREE.Vector3();
    // 隐藏的部件（比如 TMP 那个没装上的消音器）还在蒙皮骨架上，
    // 顶点位置可能离枪身很远，会把「最远顶点」算到枪口外面去 → 火焰飘在空中。
    const shown = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
    this.root.traverse(o => {
      if (!o.isSkinnedMesh || !shown(o)) return;
      const pos = o.geometry.attributes.position;
      if (!pos) return;
      const step = Math.max(1, Math.floor(pos.count / 400));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i);
        if (typeof o.applyBoneTransform === 'function') o.applyBoneTransform(i, v);
        else v.applyMatrix4(o.matrixWorld);
        o.localToWorld(v);
        const d = v.dot(dir);
        if (d > bestD) { bestD = d; best.copy(v); }
      }
    });
    this._muzzleLocal = (bestD > -1e8) ? this.root.worldToLocal(best.clone()) : null;
    return this._muzzleLocal;
  }

  /**
   * 枪口骨骼：这批模型的骨骼命名没有规律，但「离相机最远的那根骨头」
   * 基本就是枪管末端（AK 上实测是 Bone29，屏幕位置正好在枪口附近）。
   * 只在第一次开火时算一次，之后缓存。
   */
  _findMuzzleBone() {
    if (this.flashBone) return this.flashBone;
    this.root.updateMatrixWorld(true);
    let best = null, bz = 1e9;
    const p = new THREE.Vector3();
    this.root.traverse(o => {
      if (!o.isBone) return;
      o.getWorldPosition(p);
      if (p.z < bz) { bz = p.z; best = o; }
    });
    this.flashBone = best || this.root;
    return this.flashBone;
  }

  /** 按枪口骨骼算出火焰位置（沿枪管推到枪口外），火焰和烟雾都用它 */
  /** 调参用：在枪口画一个红框，里面放一把真实的火焰贴图，方便对着微调 */
  _setMuzzleMarker(on) {
    if (!this.viewScene) return;
    if (!this.muzzleMarker) {
      const g = new THREE.Group();
      const tex = (this.flashGroups && this.flashGroups[0] && this.flashGroups[0][0])
        ? this.flashGroups[0][0].tex : null;
      const mat = new THREE.SpriteMaterial({
        map: tex, transparent: true, opacity: 0.95,
        depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const sp = new THREE.Sprite(mat);
      sp.renderOrder = 1002;
      const box = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
        new THREE.LineBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.95, depthTest: false })
      );
      box.renderOrder = 1003;
      g.add(sp); g.add(box);
      g.visible = false;
      this.viewScene.add(g);
      this.muzzleMarker = g;
      this.muzzleMarkerSprite = sp;
      this.muzzleMarkerBox = box;
      this.muzzleMarkerCam = this.viewScene.userData.viewCamera || null;
    }
    this.muzzleMarker.visible = !!on;
    if (on) this._placeFlash();
  }

  _placeFlash() {
    if (!this.flashSprite) return;
    // 没有 muzzle 骨骼时，这些临时向量要在这里补建（原先是跟着 flashBone 一起建的）
    if (!this._flashPos) {
      this._flashPos = new THREE.Vector3();
      this._flashQ = new THREE.Quaternion();
      this._flashDir = new THREE.Vector3();
      this._flashRoot = new THREE.Vector3();
      this._AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    }
    const mLocal = this._computeMuzzleLocal();
    if (mLocal) {
      this._flashPos.copy(mLocal);
      this.root.localToWorld(this._flashPos);
    } else {
      if (!this.flashBone) this._findMuzzleBone();
      if (!this.flashBone) return;
      this.flashBone.getWorldPosition(this._flashPos);
    }
    // 枪管方向 = 枪体根 → 枪口骨；比猜骨骼轴向可靠（这批模型的轴很乱）
    if (this.muzzleRoot) {
      this.muzzleRoot.getWorldPosition(this._flashRoot);
      this._flashDir.copy(this._flashPos).sub(this._flashRoot);
    } else {
      this._flashDir.set(0, 0, -1);
    }
    if (this._flashDir.lengthSq() < 1e-8) this._flashDir.set(0, 0, -1);
    this._flashDir.normalize();

    // 调参面板里的「枪口火焰位置」微调（相机空间：r 右正 / u 上正 / f 前正）
    const mz = this.def.fix && this.def.fix.muzzle;
    if (mz) {
      this._flashPos.x += mz.r || 0;
      this._flashPos.y += mz.u || 0;
      this._flashPos.z -= mz.f || 0;
    }

    const base = FLASH_SCALE[this.def.kind] || 0.1;
    const out = (base * 0.42 + (FLASH_OUT[this.def.kind] || 0) * 0.6) * this.viewScale;
    this.flashSprite.position.copy(this._flashPos).addScaledVector(this._flashDir, out);

    // 火焰尺寸按「到相机的距离」补偿：枪口在 1m 外时按 0.16m 的尺寸会被缩成小点。
    // 0.33 是经验值：AK 枪口约 0.95m 深，屏幕上火焰直径约 120px。
    const dist = Math.max(0.18, -this.flashSprite.position.z);
    const w = base * this.viewScale * (dist / 0.30) * (0.92 + Math.random() * 0.16);
    const h = w * (this._flashAspect || 1);
    this.flashSprite.scale.set(w, h, 1);

    if (this.flashLight) {
      this.flashLight.position.copy(this.flashSprite.position);
      this.flashLight.distance = dist * 2.2 + 0.4;
    }
    // 调参红框：跟着火焰位置/大小走，里面放真实火焰贴图
    if (this.muzzleMarker && this.muzzleMarker.visible) {
      this.muzzleMarker.position.copy(this.flashSprite.position);
      this.muzzleMarkerSprite.scale.copy(this.flashSprite.scale);
      const s = Math.max(w, h) * 1.12;
      this.muzzleMarkerBox.scale.set(s, s, 1);
    }
  }

  /** 开火后从枪口吐一团烟：先快后慢地上升、扩散、淡出 */
  _spawnSmoke() {
    if (!this.smokePuffs || !this.smokePuffs.length || !this.flashSprite) return;
    const p = this.smokePuffs.find(x => x.t <= 0) || this.smokePuffs[0];
    p.sp.position.copy(this.flashSprite.position);
    p.sp.position.addScaledVector(this._flashDir, 0.012 * this.viewScale);
    p.life = 0.55 + Math.random() * 0.40;
    p.t = p.life;
    p.size = (0.058 + Math.random() * 0.032) * this.viewScale;
    p.vy = 0.055 + Math.random() * 0.035;
    p.vx = (Math.random() - 0.5) * 0.025;
    p.vz = (Math.random() - 0.5) * 0.025;
    p.spin = (Math.random() - 0.5) * 1.4;
    p.op = 0.36 + Math.random() * 0.20;
    p.sp.visible = true;
    p.sp.scale.set(p.size, p.size, 1);
    p.sp.material.opacity = 0;
    p.sp.material.rotation = Math.random() * 6.283;
  }

  /**
   * 把一个蒙皮网格按「骨骼权重」拆成两块：受指定骨骼影响的三角面单独成 mesh。
   * 只影响渲染，不动骨架和动画；拆出来的那块默认隐藏。
   */
  _splitSkinned(re, out) {
    const meshes = [];
    this.root.traverse(o => { if (o.isSkinnedMesh) meshes.push(o); });
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const idx = geo.index;
      const pos = geo.attributes.position;
      const si = geo.attributes.skinIndex;
      if (!idx || !si) continue;
      mesh.skeleton.bones.forEach(() => {});
      const boneHit = (vi) => {
        for (let k = 0; k < 4; k++) {
          const bi = si.getComponent(vi, k);
          const bone = mesh.skeleton.bones[bi];
          if (bone && re.test(bone.name.replace(/^x_/, ''))) return true;
        }
        return false;
      };
      const keep = [];
      const drop = [];
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        (boneHit(a) || boneHit(b) || boneHit(c) ? drop : keep).push(a, b, c);
      }
      if (!drop.length) continue;
      const copy = (arr) => {
        const g = new THREE.BufferGeometry();
        for (const name of Object.keys(geo.attributes)) {
          const attr = geo.attributes[name];
          const n = attr.itemSize;
          const data = new Float32Array(arr.length * n);
          for (let i = 0; i < arr.length; i++) {
            for (let k = 0; k < n; k++) data[i * n + k] = attr.array[arr[i] * n + k];
          }
          g.setAttribute(name, new THREE.BufferAttribute(data, n));
        }
        g.setIndex(arr);
        g.computeBoundingSphere();
        return g;
      };
      const dropped = new THREE.SkinnedMesh(copy(drop), mesh.material);
      dropped.bind(mesh.skeleton, mesh.bindMatrix);
      dropped.bindMode = mesh.bindMode;
      dropped.frustumCulled = false;
      dropped.name = mesh.name + '_split';
      dropped.visible = false;
      mesh.parent.add(dropped);
      mesh.geometry = copy(keep);
      out.push(dropped);
    }
  }

  /** 抛壳口骨骼（弹壳实体在世界里生成，见 main.js 的 spawnCasing） */
  _setupCasings() {
    if (this.def.kind === 'grenade' || this.def.kind === 'melee') return;
    let bone = null;
    this.root.traverse(o => {
      if (!bone && /shell.?eject/i.test(o.name)) bone = o;
    });
    // 没有独立抛壳口骨骼时，用 fix.casingBone / fix.gunBone 指一根靠近抛壳口的骨骼；
    // 实在没有就退回整把枪的根骨骼（getWorldPosition 拿到的正是握在眼前的枪体世界坐标）。
    const fix = this.def.fix || {};
    const alt = fix.casingBone || fix.gunBone;
    if (!bone && alt) bone = this.root.getObjectByName(alt);
    if (!bone) bone = this.root.getObjectByName(this.def.model) || this.root;
    if (!bone) return;
    this.ejectBone = bone;
  }

  /**
   * 开火抛壳：把「枪体在世界的真实坐标」交给 main.js，
   * 由 spawnCasing 在相机空间叠加一个很小的偏移（右侧 + 略上方）作为抛壳口。
   * 这样不依赖任何离线猜的局部坐标，保证弹壳永远从枪的右侧、贴近枪身飞出。
   */
  _ejectShell() {
    if (this.def.noCasing) return;       // 左轮这类不抛壳
    if (!this.ejectBone || !this.onCasing) return;
    // 只有「开火动作进行中」才允许抛壳：拔枪/待机/换弹过程中任何回调
    // 都不该把弹壳甩出来（否则一切到这把枪就凭空掉一枚弹壳）
    if (this.state !== 'fire') return;
    const delay = (this.def.fix && this.def.fix.ejectDelay) || 0;
    if (delay > 0 && this.active) {
      // AWP / 霰弹枪：拉栓或泵动时才抛壳，按动作时间轴延后
      this._pendingCasing = { at: this.active.time + delay };
      return;
    }
    this._emitCasing();
  }

  _emitCasing() {
    // 开火切动作的瞬间，three 会把上一段动画的骨骼恢复成「绑定姿势」
    // （AnimationBinding.restoreOriginalState），而新动作要到下一帧 mixer.update
    // 才求值——这时直接读骨骼拿到的是绑定姿势，弹壳会生成在完全错误的位置
    // （AK 上能偏出一米多，直接飞出屏幕）。先补一次零时长求值，把骨骼拉回当前动画姿势。
    this.mixer.update(0);
    const pos = new THREE.Vector3();
    this.ejectBone.updateWorldMatrix(true, false);
    this.ejectBone.getWorldPosition(pos);
    this.onCasing(pos, this.def);
  }

  /**
   * 借用参考枪（M3）的手指姿势。
   * XM1014 这张模型的待机姿势里，两只手的五指都是张开的，握在枪上像抽筋；
   * 而同一套 CS 骨骼的 M3 是握拳。这里把 M3 的手指局部旋转搬过来，
   * 只在待机/拔枪时生效，开火和换弹仍然用本枪自己的动画。
   */
  copyFingerPose(ref) {
    if (!ref) return;
    const names = [];
    for (const side of ['R', 'L']) {
      names.push('Hand');
      for (const f of ['0', '1', '2', '3', '4']) {
        names.push('Finger' + f, 'Finger' + f + '0', 'Finger' + f + '1', 'Finger' + f + '2');
      }
    }
    this.handPose = [];
    for (const side of ['R', 'L']) {
      for (const n of names) {
        const boneName = 'v_weaponBip01_' + side + '_' + n;
        if (n === 'Hand') continue;              // 手本身不搬：会带着枪一起转
        const src = ref.root.getObjectByName(boneName);
        const dst = this.root.getObjectByName(boneName);
        if (src && dst) this.handPose.push({ bone: dst, q: src.quaternion.clone() });
      }
    }
    this._applyHandPose();
  }

  _applyHandPose() {
    if (!this.handPose || !this.handPose.length) return;
    if (this.state !== 'idle') return;   // 开火/换弹/拔枪都用自己的动画
    for (const it of this.handPose) it.bone.quaternion.copy(it.q);
  }

  /**
   * 手雷投掷物用的「真模型」。
   * 视模型里手雷只是整块蒙皮网格的一部分（按材质分 6 个 group：手套/手指/皮肤/顶盖/拉环/弹体），
   * 这里把 top / spoon / body 三个 group 的顶点按当前骨骼姿势烘焙成静态网格，
   * 归一化到 0.16m 高、原点居中，扔出去就是手雷本来的样子，而不是一个球。
   */
  buildProjectile() {
    if (!this.def.grenade) return null;
    const out = [];
    this.root.updateMatrixWorld(true);
    this.root.traverse(o => {
      if (!o.isSkinnedMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const groups = o.geometry.groups && o.geometry.groups.length
        ? o.geometry.groups
        : [{ start: 0, count: o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count, materialIndex: 0 }];
      if (o.skeleton) o.skeleton.update();
      for (const g of groups) {
        const mat = mats[g.materialIndex];
        const mn = ((mat && mat.name) || '').toLowerCase();
        if (!/top|spoon|body/.test(mn)) continue;
        const geo = bakeSkinnedRange(o, g.start, g.count);
        if (geo) out.push({ geo, mat });
      }
    });
    if (!out.length) return null;

    // 合并包围盒，居中 + 缩放到真实手雷尺寸（最长边 0.16m）
    const box = new THREE.Box3();
    for (const part of out) {
      part.geo.computeBoundingBox();
      box.union(part.geo.boundingBox);
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const k = 0.16 / Math.max(size.x, size.y, size.z, 1e-6);
    for (const part of out) {
      part.geo.translate(-center.x, -center.y, -center.z);
      part.geo.scale(k, k, k);
      part.geo.computeBoundingSphere();
    }
    return { parts: out, radius: 0.5 * Math.max(size.x, size.y, size.z) * k };
  }

  /** 量出枪口骨骼到枪身最前端的距离（沿枪管方向） */
  _measureMuzzle() {
    if (!this.flashBone) return 0;
    this.root.updateMatrixWorld(true);
    const bone = this.flashBone.getWorldPosition(new THREE.Vector3());
    const q = new THREE.Quaternion();
    this.flashBone.getWorldQuaternion(q);
    let dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    const rootNode = this.handGun || this.mountNode || this.gunNode || this.flashBone.parent;
    if (rootNode) {
      const rp = rootNode.getWorldPosition(new THREE.Vector3());
      const ref = bone.clone().sub(rp);
      let best = null, bestDot = 0;
      for (const axis of this._AXES) {
        const v = axis.clone().applyQuaternion(q);
        const d = v.dot(ref);
        if (Math.abs(d) > Math.abs(bestDot)) { bestDot = d; best = v; }
      }
      if (best) dir = best.multiplyScalar(Math.sign(bestDot) || 1);
    }
    dir.normalize();

    const box = new THREE.Box3().setFromObject(this.root);
    const c = new THREE.Vector3();
    let ext = 0;
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      ext = Math.max(ext, c.clone().sub(bone).dot(dir));
    }
    // 夹一下，避免把手臂的包围盒算进去导致火焰飞出去
    return Math.min(Math.max(ext, 0), 0.16);
  }

  _action(name) {
    if (!name) return null;
    if (this._cache.has(name)) return this._cache.get(name);
    const clip = this.clips.get(name);
    if (!clip) return null;
    const merged = mergePose(this.basePose, clip, 'oneshot_' + name);
    const act = this.mixer.clipAction(merged);
    act.setLoop(THREE.LoopOnce, 1);
    act.clampWhenFinished = true;
    this._cache.set(name, act);
    return act;
  }

  show() {
    this.rig.visible = true;
    this._setSilencerParts(this.silenced);
    this.idleAction.reset();
    this.idleAction.setEffectiveWeight(1);
    this.idleAction.play();
    this.state = 'idle';
    this.active = null;
  }

  hide() {
    this.rig.visible = false;
    this._clearFx();                 // 切枪时把残留的枪口烟/火光一起收掉
    this.mixer.stopAllAction();
    this.state = 'idle';
    this.active = null;
    this._activeName = null;
    this._staged = null;
    this._stageName = null;
    this.sfxCues.length = 0;
    if (this.audio) { this.audio.stopKey('reload'); this.audio.stopKey('deploy'); }
    // 拆装动画被切枪打断时，直接把部件落到最终状态
    if (this._silencerPending != null) {
      this._setSilencerParts(this._silencerPending);
      this._silencerPending = null;
    }
    if (this.flashSprite) this.flashSprite.visible = false;
    if (this.flashLight) this.flashLight.intensity = 0;
  }

  /**
   * 音效 cue：按动画进度触发，而不是拍脑袋写死 setTimeout。
   * list 里的时间都是「占整段动作时长的比例」，dur 用动作片段的真实时长。
   */
  _queueCues(list, dur, lead = 0) {
    if (!list || !list.length) return;
    const d = Math.max(0.05, dur || 0);
    // 第 4 个元素可选：这条音效最多播多久（秒）。整段拟音要掐尾巴时用。
    for (const [f, name, _g, cd] of list) {
      if (!name) continue;
      this.sfxCues.push({ t: Math.max(0, f * d - lead), name, dur: cd || 0 });
    }
    this.sfxCues.sort((a, b) => a.t - b.t);
  }

  _playSfx(name, dur = 0) {
    if (!name || !this.audio) return;
    // 切枪音挂 deploy 键：切到别的枪要立刻掐掉，不然新枪都拿出来了旧的还在响
    const isDeploy = name === ((this.def.sfx && this.def.sfx.deploy) || '');
    const gain = this._cueGain && this._cueGain[name];
    const opt = {};
    if (isDeploy) opt.key = 'deploy';
    if (gain != null) opt.gain = gain;
    if (dur > 0) opt.dur = dur;
    this.audio.play(name, Object.keys(opt).length ? opt : undefined);
  }

  /** 每帧检查是否有 cue 到点（动作时间由 mixer 驱动，帧级精确） */
  _tickSfx() {
    if (!this.sfxCues.length) return;
    if (!this.active) { this.sfxCues.length = 0; return; }
    const t = this.active.time;
    while (this.sfxCues.length && t >= this.sfxCues[0].t) {
      const c = this.sfxCues.shift();
      this._playSfx(c.name, c.dur);
    }
  }

  /** 播放一次性动作（拔枪/换弹/开火） */
  play(name, { timeScale = 1, state = 'busy', fade = 0.05, force = false } = {}) {
    timeScale = 1;   // 统一原速
    this.sfxCues.length = 0;
    const act = this._action(name);
    if (!act) return false;

    if (this.active === act && !force) {
      act.reset();
      act.setEffectiveTimeScale(timeScale);
      act.setEffectiveWeight(1);
      act.play();
      this.state = state;
      this._activeName = name;
      return true;
    }

    if (this.active && this.active !== act) {
      this.active.stop();
      this.active.setEffectiveWeight(0);
    }
    this.idleAction.stop();

    act.reset();
    act.setEffectiveTimeScale(timeScale);
    act.setEffectiveWeight(1);
    act.enabled = true;
    act.play();
    this.active = act;
    this._activeName = name;
    this.state = state;
    return true;
  }

  /**
   * 从「当前姿势」淡入一个一次性动作，并可以直接从动作的某一秒开始。
   * 下包用：pressbutton 开头 0~0.8s 是抬手/翻包的大动作（手会扫到镜头前，看着像闪一下），
   * 直接跳过、从「手指按在键盘上」的姿势淡进来。
   */
  playBlended(name, { at = 0, fade = 0.16, state = 'busy' } = {}) {
    const act = this._action(name);
    if (!act) return false;
    const from = this.active || this.idleAction;
    const blend = fade > 0 && from && from !== act && from.isRunning();

    this.sfxCues.length = 0;
    if (this.active && this.active !== act) {
      this.active.stop();
      this.active.setEffectiveWeight(0);
    }
    if (!blend) this.idleAction.stop();

    act.reset();
    act.time = Math.max(0, at);
    act.setEffectiveTimeScale(1);
    act.setEffectiveWeight(1);
    act.enabled = true;
    act.play();
    if (blend) {
      // crossFadeFrom：旧的从 1→0、新的从 0→1，权重和始终是 1，不会掉到绑定姿势
      act.crossFadeFrom(from, fade, false);
      this._blendOut = { act: from, at: performance.now() + fade * 1000 + 60 };
    }
    this.active = act;
    this._activeName = name;
    this.state = state;
    return true;
  }

  playDraw() {
    this._pendingCasing = null;   // 切枪中断上一枪的延迟抛壳
    const name = this.def.anims.draw;
    this.play(name, { state: 'draw', fade: 0 });

    // 切枪音不跟着切枪瞬间响：等拨枪动画把枪抬到持枪位（默认 66% 处）再响。
    // 用动作时间轴 cue，掉帧也只会跟动画一起慢，不会跑在动作前面。
    const sfx = this.def.sfx || {};
    if (!this.audio || !this.active) return;
    const dur = this.active.getClip().duration;
    const lead = this.audio.latency ? this.audio.latency() : 0;
    // 切枪时除了「掏枪」那一下，还有可能有别的机械动作（左轮会顺手扳一下击锤）。
    // deployCues 用秒作单位，和 reloadCues 一致；可以和多条 deployCues 共存。
    if (sfx.deployCues && sfx.deployCues.length) {
      for (const [at, names] of sfx.deployCues) {
        if (!names) continue;
        this._queueCues([[at / Math.max(0.1, dur), names]], dur, lead);
      }
    }
    if (!sfx.deploy) return;
    const at = Math.max(0, (sfx.deployAt != null ? sfx.deployAt : 0.56) - lead / Math.max(0.1, dur));
    this._queueCues([[at, sfx.deploy]], dur);
  }

  /**
   * 换弹音：每个枪一段已经按它的换弹动画排好节拍的整段音频（<id>_reload）。
   * 空仓时优先用 <id>_reload_empty（套筒已经挂机，最后一步是释放而不是拉）。
   */
  _playReloadSfx() {
    if (!this.audio) return;
    const sfx = this.def.sfx || {};
    // 跳过开头 latency 秒：抵消系统/蓝牙耳机的输出延迟，听起来才和动作同时
    const lead = this.audio.latency ? this.audio.latency() : 0;
    // 分段换弹（reloadCues）：每一下机械声单独发、各自放完整，
    // 不会像整段合成那样被后一段盖掉/截断，也不会串味。
    if (sfx.reloadCues && sfx.reloadCues.length) {
      const clip = this.clips.get(this.def.anims.reload);
      const dur = clip ? clip.duration : 1;
      for (const [at, names, gain, clipDur] of sfx.reloadCues) {
        if (!names) continue;
        // 先按时间轴排好队，真正的播放交给 _tickSfx（帧级精确）
        this._queueCues([[at / dur, names, 0, clipDur]], dur, lead);
        if (gain != null) {
          // 需要单独音量的那条记下来，_playSfx 时按名字查
          this._cueGain = this._cueGain || {};
          const n = Array.isArray(names) ? names[0] : names;
          this._cueGain[n] = gain;
        }
      }
      return;
    }
    if (sfx.reload) { this.audio.play(sfx.reload, { key: 'reload', startAt: lead }); return; }
    const id = this.def.id;
    if (this.ammo === 0 && this.audio.has(id + '_reload_empty')) {
      this.audio.play(id + '_reload_empty', { key: 'reload', startAt: lead });
      return;
    }
    this.audio.play(id + '_reload', { key: 'reload', startAt: lead });
  }

  playReload() {
    this._pendingCasing = null;   // 换弹中断上一枪的延迟抛壳
    const seq = this.def.reloadSeq;
    if (seq) {
      this._playReloadSfx();
      // 霰弹枪：逐发压弹，有几发压几发
      const take = Math.min(this.def.magSize - this.ammo, this.reserve);
      if (take <= 0) return;
      this._staged = { seq, left: take };
      this._stageName = null;
      this._beginStage(seq.start);
      return;
    }
    const name = this.def.anims.reload;
    if (!name) return;
    this._staged = null;
    this.play(name, { state: 'reload', fade: 0.08 });
    // 注意：必须排在 play() 之后——play() 会清空 cue 队列
    this._playReloadSfx();
  }

  playEmpty() {
    const name = this.def.anims.empty;
    if (!name) return;
    this.play(name, { state: 'idle', fade: 0.03 });
  }

  playFire(meleeStab = false, { burst = false } = {}) {
    const fire = this.def.anims.fire;
    let name;
    if (this.def.kind === 'melee' && meleeStab && this.def.anims.stab) {
      // 重击只播一种动画，不再命中/落空轮流播
      name = this.def.anims.stab;
    } else if (burst) {
      // 三连发：整段 burst 动画只播一次（新模型的 shoot 本身就是三发连打）
      name = Array.isArray(fire) ? fire[0] : fire;
    } else if (this.def.anims.fireSingle && this.clips.has(this.def.anims.fireSingle)) {
      // 单发：用「打一发就回膛」的合成动画，不用模型里的三连发动画
      name = this.def.anims.fireSingle;
    } else if (Array.isArray(fire)) {
      name = fire[this.fireIndex % fire.length];
      this.fireIndex++;
    } else {
      name = fire;
    }
    // 所有动作一律按原速播放，不做任何变速
    this.play(name, { state: 'fire', fade: 0.02, force: true, timeScale: 1 });
    if (this.active) {
      this.active.setLoop(THREE.LoopOnce, 1);
      // 枪声之后跟着动作走的机械音（AWP 拉栓、左轮扳击锤等）：
      // fireCuesByClip 按实际播的那段 clip 取时间表（用秒，和 reloadCues 一致），
      // shoot1/shoot2 长度不同也能各自对齐；fireCues 沿用旧的比例写法。
      const sfx = this.def.sfx || {};
      const dur = this.active.getClip().duration;
      const byClip = sfx.fireCuesByClip && sfx.fireCuesByClip[name];
      if (byClip) {
        this._queueCues(byClip.map(([t, n]) => [t / Math.max(0.1, dur), n]), dur);
      } else {
        this._queueCues(sfx.fireCues, dur);
      }
    }
    return name;
  }

  triggerFlash() {
    this._ejectShell();
    if (!this.flashSprite) return;
    // 装了消音器的枪（M4A1 / USP）和自带消音器的枪（TMP）都不闪火
    if (this.silenced || this.noFlash) {
      this.flashSprite.visible = false;
      if (this.flashLight) this.flashLight.intensity = 0;
      this.flashTimer = 0;
      return;
    }
    const groups = this.flashGroups;
    const g = groups[(Math.random() * groups.length) | 0] || groups[0];
    this.flashGroup = g;
    this.flashFrame = -1;
    // 3 帧，总时长 0.06s（约 3~4 帧画面），够短才有 CS 那种「一闪」
    this.flashTimer = 0.06;
    this.flashFrameDur = 0.06 / g.length;
    this._flashFrameTimer = 0;
    this._applyFlashFrame(0);
    this._placeFlash();              // 先把枪口位置算出来，火焰第一帧就不会在原点闪
    this.flashSprite.visible = true;
    this.flashSprite.material.opacity = 1;
    if (this.flashLight) { this.flashLight.intensity = 0.45; this.flashLight.distance = 1.2; }
    this._spawnSmoke();
  }

  /** 切到第 i 帧，并按该帧的比例设置世界尺寸 */
  _applyFlashFrame(i) {
    const g = this.flashGroup;
    if (!g || !this.flashSprite) return;
    const f = g[Math.min(i, g.length - 1)];
    if (!f) return;
    const mat = this.flashSprite.material;
    mat.map = f.tex;
    mat.needsUpdate = true;
    this._flashAspect = f.h / Math.max(1, f.w);
    this.flashFrame = i;
  }

  addRecoil(scale = 1) {
    // CS 1.6 的枪体后坐：一格瞬间到位（后挫 + 上跳 + 轻微翻滚），然后再快速回位
    this.kick += 0.014 * scale;
    this.kickRot += 2.6 * DEG * scale * (0.85 + Math.random() * 0.30);
    this.kickYaw += (Math.random() - 0.5) * 2.2 * DEG * scale;
    this.kickRoll += (Math.random() - 0.5) * 3.4 * DEG * scale;
  }

  // 竖屏缩放：尺寸缩放，z 距离保持不变，避免「缩放后被拉近」导致视觉尺寸不变
  setViewScale(k, ox = 0, oy = 0, usePortrait = false) {
    const v = this.def.view || {};
    const p = usePortrait ? v.portrait : null;
    let oz = 0;
    if (p) {
      if (p.k != null) k *= p.k;
      if (p.ox != null) ox = p.ox;
      if (p.oy != null) oy = p.oy;
      if (p.oz != null) oz = p.oz;
    }
    this.viewScale = k;
    // 偏移按景深等比换算，保证不同武器在竖屏下的构图角度一致
    const dz = Math.abs((v.pos && v.pos[2]) || 0.09) / 0.09;
    this.viewOffset.set(ox * dz, oy * dz, oz);
    this.applyViewConfig();
  }

  /** 按 def.view 重新套用整体构图（位置 / 旋转 / 缩放 / 镜像），调参面板实时修改用 */
  applyViewConfig() {
    const v = this.def.view || {};
    const p = v.pos || [0, 0, 0];
    this.basePos.set(p[0], p[1], p[2]);
    this.rig.position.copy(this.basePos);
    this.orient.rotation.set((v.rx || 0) * DEG, (v.ry || 0) * DEG, 0);
    if (this.roll) this.roll.rotation.set((v.pitch || 0) * DEG, 0, (v.rz || 0) * DEG);
    this.orient.scale.setScalar((v.scale || 1) * this.viewScale);
    this.mirror.scale.x = v.mirror === false ? 1 : -1;
  }

  /** 枪体相对手骨的微调（每帧在动画之后按基准值重算） */
  _applyMountTune() {
    const g = this.mountNode;
    if (!g) return;
    if (this.mountBaseP) g.position.copy(this.mountBaseP);
    if (this.seatPos) g.position.add(this.seatPos);      // 自动握持的基准偏移
    if (this.mountBaseQ) g.quaternion.copy(this.mountBaseQ);
    if (this.seatQuat) g.quaternion.multiply(this.seatQuat);
    const cfg = this.def.fix && this.def.fix.handMount;
    const t = cfg && cfg.tune;
    const baseScale = this.mountBaseS == null ? 1 : this.mountBaseS;
    g.scale.setScalar(baseScale * ((t && t.scale) || 1));
    if (!t) return;
    if (t.pos) g.position.add(new THREE.Vector3().fromArray(t.pos));
    if (t.rotDeg) {
      const e = new THREE.Euler(t.rotDeg[0] * DEG, t.rotDeg[1] * DEG, t.rotDeg[2] * DEG, 'XYZ');
      g.quaternion.multiply(new THREE.Quaternion().setFromEuler(e));
    }
  }

  update(dt, lookDX = 0, lookDY = 0, moveAmt = 0, time = 0, bobPhase = null) {
    if (this.gunNode && this.gunOffset) this.gunNode.position.sub(this.gunOffset);
    this.mixer.update(dt);
    // 淡入结束后把上一条动作停掉，别让它一直挂在 mixer 里空转
    if (this._blendOut && performance.now() >= this._blendOut.at) {
      const o = this._blendOut.act;
      this._blendOut = null;
      if (o !== this.active) { o.stop(); o.setEffectiveWeight(0); }
    }
    if (this.splitParts && this.splitParts.length) {
      const want = this.state === 'reload';
      for (const p of this.splitParts) p.visible = want;
    }
    this._applyHandPose();

    // 骨骼缩放：有的模型枪体和手臂的比例本身就不对（M12 的枪只有手臂的 1/3 大），
    // 只能把枪体那根骨骼放大。动画里若有 scale 轨道会在 mixer.update 之后覆盖，
    // 所以每帧都在动画之后再设一次。
    if (this.boneScales) {
      for (const [name, k] of this.boneScales) {
        const b = this.root.getObjectByName(name);
        if (b) b.scale.setScalar(k);
      }
    }
    if (this.boneTune) {
      for (const t of this.boneTune) {
        const b = this.root.getObjectByName(t.name);
        if (!b) continue;
        if (t.k) b.scale.setScalar(t.k);
        if (t.q) b.quaternion.multiply(t.q);
        if (t.p) b.position.add(t.p);
      }
    }

    // 音效 cue（跟着动作时间走）
    this._tickSfx();

    // 延迟抛壳（AWP 拉栓 / 霰弹泵动时才抛壳，跟着动作时间轴）
    if (this._pendingCasing && this.active && this.active.time >= this._pendingCasing.at) {
      this._pendingCasing = null;
      this._emitCasing();
    }


    // 消音器骨骼锁定（拆装动画期间交给动画驱动）
    if (this.silNode && this.state !== 'silencer') this._lockSilencerBone();

    // 分段换弹看门狗
    this._watchReload(dt);


    if (this.gunNode && this.gunOffset) this.gunNode.position.add(this.gunOffset);
    // 枪体挂到手上之后，动画可能不再驱动它的局部变换，这里按基准 + 微调重算
    if (this.mountNode) this._applyMountTune();
    this._updateLeftArm(dt);
    this._updateSeatPose(dt);

    // 挥枪跟随视角的滞后
    const tx = clamp(-lookDX * 0.00035, -0.05, 0.05);
    const ty = clamp(lookDY * 0.00035, -0.05, 0.05);
    this.sway.x += (tx - this.sway.x) * Math.min(1, dt * 9);
    this.sway.y += (ty - this.sway.y) * Math.min(1, dt * 9);

    // 弹簧式后坐：CS 的节奏是先硬后软，枪口快速回位
    this.kick += (0 - this.kick) * Math.min(1, dt * 12);
    this.kickRot += (0 - this.kickRot) * Math.min(1, dt * 13);
    this.kickYaw += (0 - this.kickYaw) * Math.min(1, dt * 12);
    this.kickRoll += (0 - this.kickRoll) * Math.min(1, dt * 12);

    // 行走晃动：只做简单的前后移动（手臂/枪随步伐轻微前送后收），
    // 不做上下弹跳、左右摆或随步 roll，走起来更干净。
    this.bob += dt * (6.0 + moveAmt * 4.2) * moveAmt;            // 兜底自累加（无 bobPhase 时）
    const bp = (bobPhase != null && bobPhase !== 0) ? bobPhase : this.bob;
    // 走路：手臂和枪只做前后送收（不做左右/上下晃）。
    // 频率系数 0.8：比「每两步一个来回」再慢一点，前后送收更沉。
    // 幅度再乘一把枪自己的系数（view.bob，缺省 1）：
    // 前后摆动的视觉强度取决于「枪在屏幕上占多大」，刀/AWP 这种大块头
    // 同样的 3cm 位移看起来比 AK 夸张得多，所以按屏幕占位归一化过。
    const bobK = (this.def.view && this.def.view.bob != null) ? this.def.view.bob : 1;
    // 每把枪还能单独改快慢（view.bobFreq，缺省 1）。刀这类在画面里横跨很宽的武器，
    // 同样的节奏看起来会更「抽」，所以给它单独放慢。
    const bobFK = (this.def.view && this.def.view.bobFreq != null) ? this.def.view.bobFreq : 1;
    const bobZ = Math.sin(bp * 0.8 * bobFK) * 0.0330 * moveAmt * bobK;

    this.rig.position.set(
      (this.basePos.x + this.sway.x) * this.viewScale + this.viewOffset.x,
      (this.basePos.y + this.sway.y * 0.6) * this.viewScale + this.viewOffset.y,
      this.basePos.z + this.kick + bobZ + this.viewOffset.z
    );
    this.rig.rotation.set(
      this.kickRot + this.sway.y * 0.5,
      this.sway.x * 0.8 + this.kickYaw,
      this.sway.x * 0.35 + this.kickRoll
    );

    // 枪口火光（已按玩家要求关闭，保留这段以便以后恢复）
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      const g = this.flashGroup;
      if (g && g.length > 1) {
        this._flashFrameTimer += dt;
        const idx = Math.min(g.length - 1, Math.floor(this._flashFrameTimer / Math.max(0.001, this.flashFrameDur)));
        if (idx !== this.flashFrame) this._applyFlashFrame(idx);
      }
      this._placeFlash();
      if (this.flashTimer <= 0) {
        this.flashSprite.visible = false;
        if (this.flashLight) this.flashLight.intensity = 0;
      }
    }

    // 枪口烟雾：上升 + 扩散 + 淡出，最后收掉
    if (this.smokePuffs) {
      for (const p of this.smokePuffs) {
        if (p.t <= 0) continue;
        p.t -= dt;
        const k = 1 - Math.max(0, p.t) / p.life;      // 0 -> 1
        p.sp.position.x += p.vx * dt;
        p.sp.position.y += p.vy * dt;
        p.sp.position.z += p.vz * dt;
        // 上飘时越升越慢，像真的烟
        p.vy *= Math.exp(-1.6 * dt);
        const sc = p.size * (1 + k * 2.8);
        p.sp.scale.set(sc, sc, 1);
        const fade = k < 0.12 ? k / 0.12 : 1 - (k - 0.12) / 0.88;
        p.sp.material.opacity = p.op * Math.max(0, Math.min(1, fade));
        p.sp.material.rotation += p.spin * dt;
        if (p.t <= 0) { p.sp.visible = false; p.sp.material.opacity = 0; }
      }
    }
  }
}

// 各枪型的枪口焰世界尺寸 / 沿枪管外移量
const FLASH_SCALE = {
  melee: 0, pistol: 0.075, smg: 0.092, rifle: 0.112, shotgun: 0.142, sniper: 0.158
};
const FLASH_OUT = {
  melee: 0, pistol: 0.010, smg: 0.012, rifle: 0.016, shotgun: 0.018, sniper: 0.020
};

export class WeaponSystem {
  constructor({ viewScene, viewCamera, audio, onEvent }) {
    this.viewScene = viewScene;
    this.viewCamera = viewCamera;
    this.viewCamera = viewCamera || null;
    this.audio = audio;
    this.weapons = [];
    this.index = -1;
    this.onEvent = onEvent || (() => {});
    this.lastIndex = -1;
    this.busy = false;
    this.viewScale = 1;
    this.owned = null;          // 物品栏（Set<defId>），由 main.js 注入；为空表示不过滤
  }

  // 当前武器。同一把枪可能有「阵营变体」（mac10t：CT 手里是双手模型），
  // 按手里的阵营挑一个实例返回；没有变体时就是原实例。
  get current() {
    const w = this.weapons[this.index] || null;
    return w ? this.variantOf(w) : null;
  }

  variantOf(w) {
    if (!w || !w.variants) return w;
    return w.variants[this.team] || w;
  }

  add(def, gltf, donor) {
    const w = new Weapon(def, gltf, this.viewScene, this.viewCamera, donor);
    w.audio = this.audio;
    w.onEvent = (type, name) => {
      if (type === 'reloadEnd' || type === 'reloadShell') {
        this.onEvent(type, { weapon: w, name });
        return;
      }
      if (type === 'actionEnd') this.onEvent('actionEnd', { weapon: w, name });
    };
    this.weapons.push(w);
    w.setViewScale(this.viewScale, this.viewOX || 0, this.viewOY || 0, !!this.portraitMode);
    return w;
  }

  /**
   * 给某把枪加一份「阵营变体」：模型 / 构图 / 后坐力可以不同，
   * 弹药、备弹、换弹状态跟本体共用（同一把枪，不该因为换模型变成两套子弹）。
   */
  addVariant(w, team, gltf) {
    const v = (w.def.teamVariant && w.def.teamVariant[team]) || {};
    const def = {
      ...w.def,
      model: v.model || w.def.model,
      view: { ...w.def.view, ...(v.view || {}) },
      recoil: { ...w.def.recoil, ...(v.recoil || {}) },
      anims: { ...w.def.anims },
      // fix 里带 handMount.tune（枪相对手的握持偏移），两份模型各用各的，不能共用同一个对象
      fix: v.fix ? { ...(w.def.fix || {}), ...v.fix } : w.def.fix,
    };
    const w2 = new Weapon(def, gltf, this.viewScene, this.viewCamera, null);
    w2.audio = this.audio;
    w2.onEvent = (type, name) => {
      if (type === 'reloadEnd' || type === 'reloadShell') {
        this.onEvent(type, { weapon: w2, name });
        return;
      }
      if (type === 'actionEnd') this.onEvent('actionEnd', { weapon: w2, name });
    };
    // 弹药与本体共享：两个实例读写同一份数值
    Object.defineProperty(w2, 'ammo', {
      configurable: true, get: () => w.ammo, set: (n) => { w.ammo = n; },
    });
    Object.defineProperty(w2, 'reserve', {
      configurable: true, get: () => w.reserve, set: (n) => { w.reserve = n; },
    });
    w2.setViewScale(this.viewScale, this.viewOX || 0, this.viewOY || 0, !!this.portraitMode);
    w2.primary = w;            // 变体 → 本体（调试 / 排错用，弹药本来就是同一份）
    w.variants = w.variants || {};
    w.variants[team] = w2;
    return w2;
  }

  /** 换阵营：把每个变体的可见性、动画状态对齐到新阵营 */
  setTeam(team) {
    const old = this.current;                 // 换之前的（旧阵营）实例
    const wasVisible = !!(old && old.rig.visible);
    this.team = team;
    for (const w of this.weapons) {
      if (!w.variants) continue;
      // 两份模型全都先收起来，最后只把新阵营那份放出来
      w.rig.visible = false;
      w.state = 'idle';
      for (const v of Object.values(w.variants)) {
        v.rig.visible = false;
        v.state = 'idle';
      }
    }
    const cur = this.weapons[this.index];
    if (cur && cur.variants && wasVisible) this.current.show();
  }

  setViewScale(k, ox = 0, oy = 0, usePortrait = false) {
    this.viewScale = k;
    this.viewOX = ox;
    this.viewOY = oy;
    this.portraitMode = usePortrait;
    for (const w of this.weapons) {
      w.setViewScale(k, ox, oy, usePortrait);
      if (w.variants) {
        for (const v of Object.values(w.variants)) v.setViewScale(k, ox, oy, usePortrait);
      }
    }
  }

  equip(index, { instant = false } = {}) {
    if (index < 0 || index >= this.weapons.length) return;
    if (index === this.index && !instant) return;
    const prev = this.current;
    if (prev) prev.hide();
    this.lastIndex = this.index;
    this.index = index;
    const w = this.current;
    w.show();
    if (instant) {
      w.state = 'idle';
    } else {
      w.playDraw();
    }
    this.onEvent('equip', { weapon: w });
  }

  switchNext() {
    if (!this.weapons.length) return;
    const n = this.weapons.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.index + k + n) % n;
      if (this.allows(this.weapons[i])) { this.equip(i); return; }
    }
  }

  switchToSlot(slot) {
    const i = this.weapons.findIndex(w => w.def.slot === slot && this.allows(w));
    if (i >= 0) this.equip(i);
  }

  /** 这把武器当前能不能切到（阵营相符 + 在物品栏里；手雷还要有剩） */
  allows(w) {
    const def = w && w.def ? w.def : w;
    if (!def) return false;
    if (!this.team) return true;                 // 还没选阵营：全部放开
    const t = def.teams;
    // 物品栏里的枪优先：敌阵营的枪只要捡到了也能用（CS 原版就能捡对面的枪）。
    // 没捡到的敌枪仍然不让切（避免数字键直接掏出对面武器）。
    const held = !!(this.owned && this.owned.has(def.id));
    if (!held && t && !t.includes(this.team)) return false;
    if (this.owned && !held) return false;
    if (def.kind === 'grenade') {
      const wobj = this.weapons.find(x => x.def.id === def.id);
      if (!wobj || wobj.ammo <= 0) return false; // 扔完了就退出武器栏
    }
    return true;
  }

  switchLast() {
    if (this.lastIndex >= 0 && this.allows(this.weapons[this.lastIndex])) this.equip(this.lastIndex);
  }

  canFire(now) {
    const w = this.current;
    if (!w || !w.rig.visible) return false;
    if (w.state === 'draw' || w.state === 'reload' || w.state === 'silencer') return false;
    if (w.def.kind !== 'melee' && w.ammo <= 0) return false;
    if (w.cocking) return false;                     // 左轮还没扳完击锤
    if (now < w.nextFire) return false;
    return true;
  }

  fire(now, { stab = false, silent = false, noAnim = false } = {}) {
    const w = this.current;
    if (!w) return null;
    w.nextFire = now + 60 / w.def.rpm;
    if (w.def.kind === 'melee') {
      w.playFire(stab);
      this.audio.melee(w.def, { stab });
      w.addRecoil(0.5);
      return { melee: true, weapon: w };
    }
    w.ammo--;
    if (!noAnim) w.playFire(false);
    w.triggerFlash();
    if (w.def.cock) w.cocking = true;                 // 单动左轮：打完进入待扳机状态
    if (!silent) this.audio.shot(w.def, w.silenced);
    return { weapon: w };
  }

  reload() {
    const w = this.current;
    if (!w || w.def.kind === 'melee') return false;
    if (w.state === 'reload' || w.state === 'draw' || w.state === 'silencer') return false;
    if (w.ammo >= w.def.magSize || w.reserve <= 0) return false;
    w.playReload();
    this.onEvent('reloadStart', { weapon: w });
    return true;
  }

  /** 装 / 卸消音器（只有配置了 silencer 的枪有） */
  toggleSilencer() {
    const w = this.current;
    if (!w || !w.def.silencer) return false;
    if (w.state === 'draw' || w.state === 'reload' || w.state === 'silencer') return false;
    const on = !w.silenced;
    if (!w.setSilencer(on)) return false;
    this.onEvent('silencer', { weapon: w, on });
    return true;
  }

  update(dt, lookDX, lookDY, moveAmt, time, bobPhase) {
    const w = this.current;
    if (w) w.update(dt, lookDX, lookDY, moveAmt, time, bobPhase);
  }
}
