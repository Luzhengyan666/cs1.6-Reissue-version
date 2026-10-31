// ---------------------------------------------------------------------------
// AI 系统（r90）
//
// 设计要点：
//   1. 人物模型用玩家提供的 CS 1.6 原版骨骼（char_t.glb / char_ct.glb），
//      每个 bot 一份 SkeletonUtils 式克隆，动作直接播模型自带的 80 个 clip
//      （idle/walk/run/crouch/jump/shoot_*/reload_*/death*）。
//   2. 手上没有武器模型 → 加载 w_<id>.glb（和地上掉落同一套归一化模型），
//      挂到 Bip01 R Hand 骨骼上，按 MOUNT 表逐枪校准位置/朝向/缩放。
//   3. 导航：从地图高度场烘一张 1.5m 的可行走网格，A* 寻路 + 直线拉直，
//      移动仍走 main.js 的真实碰撞（blockedMove / floorOK），撞墙会重算。
//   4. 行为：抢点 → 遇敌交战（点射/换弹/蹲下）→ 扔雷 → T 下包 / CT 拆包。
//   5. 所有动作音效走 audio.playAt（带距离衰减 + 左右声像）。
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

const NAMES_T = ['Ramzi', 'Vitaliy', 'Ivan', 'Oleg', 'Dmitri', 'Yuri', 'Sergei', 'Andrei'];
const NAMES_CT = ['Hawkeye', 'Sledge', 'Rook', 'Viper', 'Ghost', 'Bishop', 'Kane', 'Ward'];

// 每队的常规配置（原版 bot 也是随机买枪）
const LOADOUT_T = ['ak47', 'ak47', 'sg552', 'mac10t', 'mp5', 'm3'];
const LOADOUT_CT = ['m4a1', 'm4a1', 'aug', 'mp5', 'tmp', 'm3'];

// 动画分类：模型里 ref_shoot_<cls> / ref_reload_<cls> / crouch_* 成对出现
function animClass(def) {
  if (!def) return 'rifle';
  if (def.kind === 'c4') return 'c4';
  if (def.kind === 'grenade') return 'grenade';
  if (def.kind === 'melee') return 'knife';
  if (def.kind === 'pistol') return 'onehanded';
  switch (def.id) {
    case 'ak47': return 'ak47';
    case 'sg552':
    case 'aug': return 'carbine';
    case 'mp5':
    case 'tmp':
    case 'ump45':
    case 'mac10t':
    case 'tec9': return 'mp5';
    case 'm3': return 'shotgun';
    case 'm249': return 'm249';
    default: return 'rifle';
  }
}

// ---------------------------------------------------------------------------
// 上下半身分层混合（复刻 GoldSrc 的行为）
//
//   CS 1.6 的人物模型把动作拆成两套：
//     idle1 / walk / run / crouch_idle / crouchrun  —— 只有腿和根骨骼，手臂没有轨道
//     ref_shoot_* / ref_reload_* / crouch_shoot_*   —— 只有上半身（脊椎/双臂/头），没有腿
//   引擎播放时把「下半身来自移动动作 + 上半身来自握枪动作」拼在一起。
//   只播单条剪辑的话：移动时手臂僵成 T-pose，开枪时腿不会动。
//   这里按同样的规则在加载后把两条剪辑合成一条（腿取移动、上半身取握枪）。
// ---------------------------------------------------------------------------
const UPPER_RE = /(clavicle|upperarm|forearm|hand|finger|knuckle|wrist|elbow|bicep|shoulder)/i;
const LOCO = new Set(['idle1', 'walk', 'run', 'crouch_idle', 'crouchrun', 'jump', 'longjump', 'swim', 'treadwater']);
const WEAPON_ANIM_RE = /^(ref_|crouch_)(shoot|reload|aim)/;

function isUpperBone(name) {
  return UPPER_RE.test(name.split('.')[0]);
}

/** 把一条轨道压成「只保留第 0 帧」的常量轨道（用作握枪静姿态） */
function constTrack(t) {
  const stride = t.getValueSize ? t.getValueSize() : t.values.length / t.times.length;
  const n = t.constructor;
  const c = new n(t.name, [0], t.values.slice(0, stride));
  return c;
}

/** 合并：腿/根骨骼取 loco，上半身取 hold */
function mergeClips(locoClip, holdClip, name, staticUpper, dur) {
  const tracks = [];
  const upper = new Set();
  for (const t of holdClip.tracks) {
    if (!isUpperBone(t.name)) continue;
    upper.add(t.name.split('.')[0]);
    tracks.push(staticUpper ? constTrack(t) : t.clone());
  }
  for (const t of locoClip.tracks) {
    if (upper.has(t.name.split('.')[0])) continue;
    tracks.push(t.clone());
  }
  const clip = new THREE.AnimationClip(name, dur, tracks);
  return clip;
}

// ---------------------------------------------------------------------------
// 手上武器挂载参数
//   枪模型（w_ 系列，由 loadWorldGun 归一化）约定：
//     枪管 +X、枪身高度 +Z、厚度 Y、包围盒中心在原点、长度为真实米数
//   grip：模型空间里「握把」的位置，挂到手上时把这一点对到手掌
//   flip：个别模型的 +X 其实是枪托，翻 180° 才朝前
// ---------------------------------------------------------------------------
const MOUNT_DEFAULT = { grip: [-0.10, 0, -0.05], flip: false };
const MOUNT = {
  rifle:   { grip: [-0.13, 0, -0.05] },
  carbine: { grip: [-0.12, 0, -0.05] },
  smg:     { grip: [-0.08, 0, -0.04] },
  shotgun: { grip: [-0.15, 0, -0.04] },
  sniper:  { grip: [-0.16, 0, -0.05] },
  mg:      { grip: [-0.13, 0, -0.06] },
  pistol:  { grip: [-0.05, 0, -0.03] },
  melee:   { grip: [-0.04, 0, 0] },
  grenade: { grip: [-0.03, 0, 0] },
  c4:      { grip: [-0.04, 0, 0] },
};
function mountFor(def) {
  if (!def) return MOUNT_DEFAULT;
  const m = MOUNT[def.id] || MOUNT[def.kind] || MOUNT_DEFAULT;
  return { grip: m.grip || MOUNT_DEFAULT.grip, flip: !!(def.mountFlip || m.flip) };
}

// 人物模型朝向修正：CS 模型面朝 +X，three 里我们用 yaw 转（前进方向 = (-sin, -cos)）
const MODEL_YAW = 90;

// ---------------------------------------------------------------------------
// 骨骼克隆（three 的 SkeletonUtils.clone 精简版，避免额外依赖）
// ---------------------------------------------------------------------------
function parallelTraverse(a, b, cb) {
  cb(a, b);
  for (let i = 0; i < a.children.length; i++) parallelTraverse(a.children[i], b.children[i], cb);
}
function cloneSkinned(source) {
  const clone = source.clone();
  const map = new Map();
  parallelTraverse(source, clone, (s, c) => map.set(s, c));
  source.traverse(srcNode => {
    if (!srcNode.isSkinnedMesh) return;
    const cloneNode = map.get(srcNode);
    const srcSk = srcNode.skeleton;
    const bones = srcSk.bones.map(b => map.get(b) || b);
    cloneNode.bind(new THREE.Skeleton(bones, srcSk.boneInverses), srcNode.bindMatrix);
  });
  return clone;
}

// ---------------------------------------------------------------------------
// 导航网格
// ---------------------------------------------------------------------------
class NavGrid {
  constructor(api) {
    this.ok = false;
    this.build(api);
  }
  build(api) {
    const box = api.mapBox;
    if (!box) return;
    const S = 0.9;
    this.S = S;
    this.x0 = box.min.x;
    this.z0 = box.min.z;
    this.nx = Math.max(1, Math.ceil((box.max.x - box.min.x) / S));
    this.nz = Math.max(1, Math.ceil((box.max.z - box.min.z) / S));
    const n = this.nx * this.nz;
    const h = new Float32Array(n);
    const walk = new Uint8Array(n);

    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.x0 + (ix + 0.5) * S;
        const z = this.z0 + (iz + 0.5) * S;
        // 用「最低面」高度场：屋顶/拱门下面的格子最高面是屋顶，会把出生点
        // 判成一座孤岛。最低面 = 真正能走的地板，而且不需要逐格射线（快得多）。
        let hv = api.groundHeightLow ? api.groundHeightLow(x, z, -100) : -100;
        if (hv < -90) hv = api.groundHeightAt(x, z, 200);
        h[iz * this.nx + ix] = hv;
      }
    }
    // 可走：有地面，且至少有一个邻居能上下（差 ≤ 0.70m）
    //   之前要求「2 个邻居都在 0.62m 内」会把出生点的小平台判成孤岛，
    //   结果 A* 永远找不到路（bot 只会朝目标直线撞墙）。
    for (let iz = 1; iz < this.nz - 1; iz++) {
      for (let ix = 1; ix < this.nx - 1; ix++) {
        const k = iz * this.nx + ix;
        const hv = h[k];
        if (hv < -90) continue;
        let near = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const h2 = h[(iz + dz) * this.nx + ix + dx];
          if (h2 < -90) continue;
          // 往上最多 0.7m（台阶）；往下不限（可以跳/掉下去，物理会接住）
          if (h2 - hv <= 0.70) { near++; break; }
        }
        if (near) walk[k] = 1;
      }
    }
    this.h = h; this.walk = walk;
    this.ok = true;
  }
  idx(ix, iz) { return iz * this.nx + ix; }
  cellOf(x, z) {
    return [Math.floor((x - this.x0) / this.S), Math.floor((z - this.z0) / this.S)];
  }
  center(ix, iz) {
    return [this.x0 + (ix + 0.5) * this.S, this.z0 + (iz + 0.5) * this.S];
  }
  heightAt(x, z) {
    const [ix, iz] = this.cellOf(x, z);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -100;
    return this.h[this.idx(ix, iz)];
  }
  /** 找最近的可走格（螺旋外扩） */
  nearestWalkable(ix, iz, maxR = 8) {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return null;
    if (this.walk[this.idx(ix, iz)]) return [ix, iz];
    for (let r = 1; r <= maxR; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = ix + dx, z = iz + dz;
          if (x < 1 || z < 1 || x >= this.nx - 1 || z >= this.nz - 1) continue;
          if (this.walk[this.idx(x, z)]) return [x, z];
        }
      }
    }
    return null;
  }
  /** A*：返回世界坐标点数组（已做拉直） */
  findPath(sx, sz, tx, tz) {
    if (!this.ok) return null;
    const s = this.cellOf(sx, sz), t = this.cellOf(tx, tz);
    const S0 = this.nearestWalkable(s[0], s[1]);
    const T0 = this.nearestWalkable(t[0], t[1]);
    if (!S0 || !T0) return null;
    const nx = this.nx, nz = this.nz;
    const N = nx * nz;
    const gScore = new Float32Array(N).fill(1e9);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const startK = this.idx(S0[0], S0[1]);
    const goalK = this.idx(T0[0], T0[1]);
    const heap = [];
    const push = (k, f) => {
      if (heap.length > 40000) return;
      heap.push([f, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp; i = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp; i = m;
        }
      }
      return top;
    };
    const hDist = (k) => {
      const x = k % nx, z = (k / nx) | 0;
      const dx = Math.abs(x - T0[0]), dz = Math.abs(z - T0[1]);
      return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    gScore[startK] = 0;
    push(startK, hDist(startK));
    let found = false;
    let iter = 0;
    while (heap.length && iter++ < 12000) {
      const [, k] = pop();
      if (closed[k]) continue;
      if (k === goalK) { found = true; break; }
      closed[k] = 1;
      const cx = k % nx, cz = (k / nx) | 0;
      const ch = this.h[k];
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const x = cx + dx, z = cz + dz;
          if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
          const nk = z * nx + x;
          if (closed[nk] || !this.walk[nk]) continue;
          // 对角禁止穿角
          if (dx && dz) {
            if (!this.walk[cz * nx + x] || !this.walk[z * nx + cx]) continue;
          }
          // 只能上 0.7m，往下随便掉（掉落交给物理）
          if (this.h[nk] - ch > 0.70) continue;
          const dh = Math.abs(this.h[nk] - ch);
          const step = (dx && dz ? Math.SQRT2 : 1) * (this.S + dh * 0.8);
          const ng = gScore[k] + step;
          if (ng < gScore[nk]) {
            gScore[nk] = ng;
            from[nk] = k;
            push(nk, ng + hDist(nk));
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    // 兜底：from 链理论上不会成环，但 gScore 反复改进时有可能，加个硬上限
    for (let k = goalK, guard = 0; k >= 0 && guard < N; k = from[k], guard++) {
      cells.push(k);
      if (k === startK) break;
      if (guard === N - 1) return null;
    }
    cells.reverse();
    const pts = cells.map(k => {
      const [x, z] = this.center(k % nx, (k / nx) | 0);
      return new THREE.Vector3(x, this.h[k], z);
    });
    // 拉直：能直连的中间点砍掉
    //   （注意最后一个点必须收尾，否则 i 会停在 len-1 不动 → 死循环把内存撑爆，
    //     表现就是 RangeError: Invalid array length）
    const out = [];
    let i = 0;
    while (i < pts.length - 1) {
      out.push(pts[i]);
      let j = pts.length - 1;
      for (; j > i + 1; j--) {
        if (this.canWalkLine(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) break;
      }
      i = j;
    }
    if (pts.length) out.push(pts[pts.length - 1]);
    return out;
  }
  /** 网格上的直线可达（只看高度突变，不看真实碰撞） */
  canWalkLine(x0, z0, x1, z1) {
    const dx = x1 - x0, dz = z1 - z0;
    const d = Math.hypot(dx, dz);
    const steps = Math.ceil(d / (this.S * 0.8));
    let prev = this.heightAt(x0, z0);
    for (let i = 1; i <= steps; i++) {
      const x = x0 + dx * i / steps, z = z0 + dz * i / steps;
      const h = this.heightAt(x, z);
      if (h < -90) return false;
      if (h - prev > 0.70) return false;     // 只拦「往上爬」，往下走可以
      prev = h;
    }
    return true;
  }
}

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
// aimGun 用（每帧复用，不产生垃圾）
const _awX = new THREE.Vector3(), _awY = new THREE.Vector3(), _awZ = new THREE.Vector3();
const _amBasis = new THREE.Matrix4();
const _aqAim = new THREE.Quaternion(), _aqFlip = new THREE.Quaternion(), _aqHand = new THREE.Quaternion();
// 混合剪辑跨 bot 共享（同一套模型剪辑 → 结果完全一样）
const _blendCache = new Map();
// 双臂 IK 用（每帧复用）
const _ikS = new THREE.Vector3(), _ikE = new THREE.Vector3(), _ikH = new THREE.Vector3();
const _ikT = new THREE.Vector3(), _ikDir = new THREE.Vector3(), _ikPerp = new THREE.Vector3();
const _ikE2 = new THREE.Vector3(), _ikE3 = new THREE.Vector3(), _ikH3 = new THREE.Vector3();
const _abA = new THREE.Vector3(), _abB = new THREE.Vector3();
const _hf = new THREE.Vector3(), _hr = new THREE.Vector3(), _hu = new THREE.Vector3();
const _ikPole = new THREE.Vector3(), _ikTarget = new THREE.Vector3(), _ikFore = new THREE.Vector3();
const _abQ = new THREE.Quaternion(), _abW = new THREE.Quaternion(), _abP = new THREE.Quaternion();

/** 把骨骼转到「从 origin 指向 wantEnd」的方向（保持父级不变） */
function aimBone(bone, origin, curEnd, wantEnd) {
  _abA.copy(curEnd).sub(origin);
  _abB.copy(wantEnd).sub(origin);
  if (_abA.lengthSq() < 1e-8 || _abB.lengthSq() < 1e-8) return;
  _abA.normalize(); _abB.normalize();
  _abQ.setFromUnitVectors(_abA, _abB);
  bone.getWorldQuaternion(_abW);
  _abW.premultiply(_abQ);
  bone.parent.getWorldQuaternion(_abP);
  bone.quaternion.copy(_abP.invert().multiply(_abW));
  bone.updateMatrixWorld(true);
}

// 支撑手相对握持手的前移量（米）；0 表示不做左手 IK
const FOREOFF = {
  rifle: 0.30, carbine: 0.28, smg: 0.22, shotgun: 0.34, sniper: 0.32, mg: 0.30,
  pistol: 0.07, melee: 0, grenade: 0, c4: 0,
};

// ---------------------------------------------------------------------------
// Bot
// ---------------------------------------------------------------------------
export class Bot {
  constructor(mgr, team, index) {
    this.mgr = mgr;
    this.team = team;
    this.index = index;
    this.name = (team === 't' ? NAMES_T : NAMES_CT)[index % 8];
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.health = 100;
    this.armor = 0;
    this.dead = false;
    this.deadAt = 0;
    this.crouch = false;
    this.onGround = true;
    this.eyeH = 1.62;

    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.curAnim = null;
    this.curName = '';
    this.curKey = '';
    this._merged = {};
    this.locoName = 'idle1';
    this.gunLocalQ = null;
    this.lockGunQ = false;
    this.recoil = 0;
    this._ikActive = false;
    this.handBone = null;
    this.gunHolder = null;
    this.gunMesh = null;
    this.gunId = null;

    this.def = null;
    this.ammo = 0;
    this.reserve = 0;
    this.reloadEnd = 0;
    this.nextFire = 0;
    this.burstLeft = 0;
    this.burstPause = 0;

    this.state = 'move';
    this.stateT = 0;
    this.target = null;
    this.targetVisible = false;
    this.lastSeen = null;
    this.alertT = 0;
    this.reactAt = 0;

    this.path = null;
    this.pathI = 0;
    this.goal = null;
    this.repathAt = 0;
    this.stuckT = 0;
    this.lastPos = new THREE.Vector3();

    this.thinkAt = 0;
    this.grenadeCool = 8 + Math.random() * 12;
    this.goalSite = null;
    this.hasBomb = false;
    this.plantT = 0;
    this.defuseT = 0;
    this.wantCrouch = false;
    this.skill = 0.5 + Math.random() * 0.35;
  }

  // ---- 视图 ----
  attach(model) {
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    for (const clip of this.mgr.clips) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      this.actions[clip.name] = a;
    }
    // GLTFLoader 会把节点名里的空格换成下划线（PropertyBinding.sanitizeNodeName）
    this.handBone = model.getObjectByName('Bip01 R Hand') ||
                    model.getObjectByName('Bip01_R_Hand') ||
                    model.getObjectByName('Bip01_RHand');
    if (this.handBone) {
      this.gunHolder = new THREE.Group();
      this.handBone.add(this.gunHolder);
    }
    // 双臂骨骼（IK 用）
    const G = (a, b) => model.getObjectByName(a) || model.getObjectByName(b) || null;
    this.armR = { up: G('Bip01_R_UpperArm', 'Bip01 R UpperArm'),
                  fore: G('Bip01_R_Forearm', 'Bip01 R Forearm'),
                  hand: this.handBone };
    this.armL = { up: G('Bip01_L_UpperArm', 'Bip01 L UpperArm'),
                  fore: G('Bip01_L_Forearm', 'Bip01 L Forearm'),
                  hand: G('Bip01_L_Hand', 'Bip01 L Hand') };
    this.chestBone = G('Bip01_Spine2', 'Bip01 Spine2') || G('Bip01_Spine1', 'Bip01 Spine1');
    this.ikOK = !!(this.armR.up && this.armR.fore && this.armR.hand &&
                   this.armL.up && this.armL.fore && this.armL.hand);
  }

  // ---- 双臂 IK：把两只手压到枪上（握把 + 护木） ----
  /**
   * 两段式 IK：把 upper→fore 的肘位置解出来，再让 forearm 指向目标。
   * 模型自带的 ref_shoot_* 全是「举手」姿态，靠它摆不出持枪，所以自己解。
   */
  ikArm(arm, target, pole) {
    const S = arm.up.getWorldPosition(_ikS);
    const E = arm.fore.getWorldPosition(_ikE);
    const H = arm.hand.getWorldPosition(_ikH);
    const L1 = S.distanceTo(E), L2 = E.distanceTo(H);
    if (L1 < 1e-4 || L2 < 1e-4) return;
    _ikT.copy(target).sub(S);
    let d = _ikT.length();
    if (d < 1e-4) return;
    const lo = Math.abs(L1 - L2) + 0.02, hi = L1 + L2 - 0.02;
    d = Math.min(Math.max(d, lo), hi);
    _ikDir.copy(_ikT).normalize();
    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const A = Math.acos(cosA);
    // 弯曲方向：pole 投影到垂直于 dir 的平面
    _ikPerp.copy(pole).addScaledVector(_ikDir, -pole.dot(_ikDir));
    if (_ikPerp.lengthSq() < 1e-6) _ikPerp.set(0, 0, 1);
    _ikPerp.normalize();
    _ikE2.copy(S).addScaledVector(_ikDir, L1 * Math.cos(A)).addScaledVector(_ikPerp, L1 * Math.sin(A));
    aimBone(arm.up, S, E, _ikE2);
    const E3 = arm.fore.getWorldPosition(_ikE3);
    const H3 = arm.hand.getWorldPosition(_ikH3);
    aimBone(arm.fore, E3, H3, target);
  }

  /**
   * 持枪姿态：右手压在握把上、左手压在护木上。
   * 只在「端着枪」的时候做（换弹/下包/扔雷/死亡交给模型自己的动作）。
   */
  holdIK() {
    if (!this.ikOK || !this.gunMesh || !this.gunMesh.visible) { this.aimGun(); return; }
    _hf.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _hu.set(0, 1, 0);
    _hr.crossVectors(_hu, _hf).normalize();     // 角色右手方向
    // 右手（握把）位置：以胸骨为基准（蹲下、走跑起伏都自动跟随）
    const chest = this.chestBone ? this.chestBone.getWorldPosition(_ikT) : null;
    if (chest) _ikTarget.copy(chest).addScaledVector(_hf, 0.20).addScaledVector(_hr, 0.12);
    else { _ikTarget.copy(this.pos).addScaledVector(_hf, 0.26).addScaledVector(_hr, 0.13); _ikTarget.y += 1.19; }
    _ikTarget.y -= 0.05;
    if (this.recoil > 0) {
      _ikTarget.addScaledVector(_hf, -0.05 * this.recoil);
      _ikTarget.y += 0.025 * this.recoil;
    }
    _ikPole.copy(_hu).multiplyScalar(-0.75).addScaledVector(_hr, 0.55).addScaledVector(_hf, -0.25).normalize();
    this.ikArm(this.armR, _ikTarget, _ikPole);

    this.gunLocalQ = null;      // 手已换位置，重新解一次朝向
    this.lockGunQ = false;
    this.aimGun();

    const def = this.def || {};
    const fo = FOREOFF[def.id] != null ? FOREOFF[def.id] : (FOREOFF[def.kind] || 0);
    if (fo > 0.01) {
      this.gunMesh.getWorldPosition(_ikFore);
      // 护木在握把前方 fo 米、略高
      _ikFore.copy(this.handBone.getWorldPosition(_ikH3)).addScaledVector(_hf, fo);
      _ikFore.y += 0.02;
      _ikPole.copy(_hu).multiplyScalar(-0.55).addScaledVector(_hr, 0.85).addScaledVector(_hf, 0.15).normalize();
      this.ikArm(this.armL, _ikFore, _ikPole);
    }
  }

  /** 当前武器对应的「握枪」上半身动作名 */
  holdName() {
    const cls = animClass(this.def);
    const n = (this.crouch ? 'crouch_shoot_' : 'ref_shoot_') + cls;
    if (this.actions[n]) return n;
    const alt = 'ref_shoot_' + cls;
    return this.actions[alt] ? alt : null;
  }

  /**
   * 取（或建）一条混合后的动作。
   *   holdName 为空 → 移动动作 + 握枪静姿态（上半身取握枪动作第 0 帧）
   *   holdName 有值 → 移动动作 + 指定武器动作（完整播放）
   */
  blend(locoName, holdName) {
    const loco = this.actions[locoName];
    if (!loco) return null;
    const hn = holdName || this.holdName();
    if (!hn || !this.actions[hn]) return loco.getClip();
    const key = hn + (holdName ? '>' : '@') + locoName;
    const gkey = hn + '|' + locoName + '|' + (holdName ? 1 : 0);
    if (_blendCache.has(gkey)) return _blendCache.get(gkey);
    const locoClip = loco.getClip();
    const holdClip = this.actions[hn].getClip();
    const isHold = !holdName;
    const dur = isHold ? locoClip.duration : Math.max(locoClip.duration, holdClip.duration);
    const clip = mergeClips(locoClip, holdClip, 'M:' + key, isHold, dur);
    _blendCache.set(gkey, clip);
    return clip;
  }

  setAnim(name, { loop = true, fade = 0.14, speed = 1, clampEnd = false } = {}) {
    let clip = null;
    let key = name;
    if (LOCO.has(name)) {
      this.locoName = name;
      clip = this.blend(name, null);
      key = 'L:' + name + '@' + (this.holdName() || '-');
    } else if (WEAPON_ANIM_RE.test(name) && this.actions[name]) {
      // 武器动作：腿用当前移动状态，上半身用这条动作
      clip = this.blend(this.locoName || 'idle1', name);
      key = 'W:' + name + '>' + (this.locoName || 'idle1');
    } else if (this.actions[name]) {
      clip = this.actions[name].getClip();
      key = name;
    }
    if (!clip) return null;

    let a = this._merged[key];
    if (!a) {
      a = this.mixer.clipAction(clip);
      a.enabled = true;
      this._merged[key] = a;
    }
    if (this.curKey === key && a.isRunning()) return a;
    if (this.curAnim && this.curAnim !== a) this.curAnim.fadeOut(fade);
    a.reset();
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    a.clampWhenFinished = clampEnd;
    a.timeScale = speed;
    a.fadeIn(fade).play();
    this.curAnim = a;
    this.curKey = key;
    this.curName = name;
    return a;
  }

  animDur(name) {
    const a = this.actions[name];
    return a ? a.getClip().duration : 0.6;
  }

  // ---- 装备 ----
  giveWeapon(def, { ammoMul = 1 } = {}) {
    this.def = def;
    this.ammo = def.magSize || 0;
    this.reserve = Math.round((def.reserve || 0) * ammoMul);
    this.gunId = null;
    this.mgr.equipModel(this, def);
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + (this.crouch ? 1.14 : 1.62), this.pos.z);
  }
  chest(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + (this.crouch ? 0.85 : 1.20), this.pos.z);
  }

  takeDamage(dmg, fromX, fromZ, cause) {
    if (this.dead) return;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.5);
      this.armor -= absorbed;
      dmg -= absorbed * 0.75;
    }
    this.health -= dmg;
    this.alertT = Math.max(this.alertT, 6);
    if (fromX != null) {
      this.lastSeen = new THREE.Vector3(fromX, this.pos.y, fromZ);
      this.yaw = Math.atan2(-(fromX - this.pos.x), -(fromZ - this.pos.z));
    }
    if (this.health <= 0) this.die(cause);
  }

  die(cause) {
    if (this.dead) return;
    this.dead = true;
    this.deadAt = performance.now() / 1000;
    this.health = 0;
    const deaths = ['death1', 'death2', 'death3'];
    const pick = deaths[(Math.random() * deaths.length) | 0];
    this.setAnim(pick, { loop: false, fade: 0.1, clampEnd: true, speed: 1.0 });
    this.mgr.onDeath(this, cause);
    if (this.gunMesh) this.gunMesh.visible = false;
  }

  respawn(sp) {
    this.dead = false;
    this.health = 100;
    this.armor = 0;
    this.pos.set(sp.x, sp.y + 0.05, sp.z);
    this.vel.set(0, 0, 0);
    this.yaw = sp.yaw * DEG;
    this.state = 'move';
    this.stateT = 0;
    this.target = null;
    this.lastSeen = null;
    this.path = null;
    this.alertT = 0;
    this.goalSite = null;
    this.hasBomb = false;
    this.plantT = 0;
    this.defuseT = 0;
    this.crouch = false;
    this.curName = '';
    if (this.gunMesh) this.gunMesh.visible = true;
    if (this.model) this.model.visible = true;
    this.setAnim('idle1', { fade: 0.05 });
  }

  // -------------------------------------------------------------------------
  update(dt, now) {
    if (!this.model) return;
    if (this.dead) {
      // 尸体：播完死亡动作就停着，8~12 秒后重生
      this.mixer.update(dt);
      const age = now - this.deadAt;
      if (age > 9 && !this.respawnAt) this.respawnAt = now + Math.random() * 3;
      if (this.respawnAt && now >= this.respawnAt) {
        this.respawnAt = 0;
        this.mgr.respawnBot(this);
      }
      return;
    }
    if (this.freeze) { this.mixer.update(dt); return; }
    if (this.alertT > 0) this.alertT -= dt;
    this.thinkAt -= dt;
    if (this.thinkAt <= 0) {
      this.thinkAt = 0.22 + Math.random() * 0.08;
      this.think(now);
    }
    this.act(dt, now);
    this.move(dt, now);
    this.mixer.update(dt);
    // 换弹/下包/拆包时手会大幅移动，枪改成跟着手走
    this.lockGunQ = this.reloadEnd > now || this.state === 'plant' || this.state === 'defuse';
    const d0 = this.def || {};
    const fo0 = FOREOFF[d0.id] != null ? FOREOFF[d0.id] : FOREOFF[d0.kind];
    const canIK = !this.lockGunQ && this.ikOK && fo0 > 0.01;
    this._ikActive = canIK;
    if (this.recoil > 0.001) this.recoil *= Math.exp(-dt * 11); else this.recoil = 0;
    if (canIK) this.holdIK(); else this.aimGun();
  }

  /**
   * 手里那把枪的朝向：每帧把「枪的世界朝向」直接锁到角色朝向上。
   * 为什么不靠骨骼相对旋转固定：模型自带的 80 个动作里手的朝向差别很大，
   * 一个固定偏移只能在某个动作下刚好正确（举枪时对了，走路就歪了）。
   * 这里只借手的**位置**，朝向自己算 —— 8 个 bot 每帧一次四元数乘法，代价可以忽略。
   */
  aimGun() {
    if (!this.gunHolder || !this.gunMesh || !this.gunMesh.visible) return;
    this.handBone.getWorldQuaternion(_aqHand);
    if (this.lockGunQ && this.gunLocalQ) {
      // 换弹 / 下包：手在动，枪要跟着手动，不要继续锁世界朝向
      this.gunHolder.quaternion.copy(this.gunLocalQ);
      return;
    }
    const yaw = this.yaw;
    _awX.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _awZ.set(0, 1, 0);
    _awY.crossVectors(_awZ, _awX).normalize();
    _aqAim.setFromRotationMatrix(_amBasis.makeBasis(_awX, _awY, _awZ));
    if (this.gunFlip) _aqFlip.setFromAxisAngle(_awZ, Math.PI), _aqAim.multiply(_aqFlip);
    // 记下「手 → 枪口朝前」的相对旋转：骨架姿态不变时它就是常量，
    // 换弹期间沿用最后一次的值，枪就自然跟着手转
    if (!this.gunLocalQ) this.gunLocalQ = new THREE.Quaternion();
    this.gunLocalQ.copy(_aqHand).invert().multiply(_aqAim);
    this.gunHolder.quaternion.copy(this.gunLocalQ);
  }

  // ---- 决策 ----
  think(now) {
    const mgr = this.mgr;
    this.target = mgr.acquire(this, now);
    this.targetVisible = !!this.target;

    // 交战 / 找包
    if (this.target) {
      if (this.alertT <= 0) this.alertT = 5;
      if (!this.reactAt) this.reactAt = now + (0.22 + (1 - this.skill) * 0.45);
      this.lastSeen = this.target.pos.clone();
    } else {
      this.reactAt = 0;
    }

    // 目标点：包 / 敌人最后位置 / 包点
    if (this.targetVisible) return;
    if (this.state === 'plant' || this.state === 'defuse') return;

    if (this.hasBomb) {
      const site = mgr.bombSiteFor(this);
      if (site) {
        const d = Math.hypot(this.pos.x - site.x, this.pos.z - site.z);
        if (d < site.r * 0.8) {
          this.state = 'plant';
          this.stateT = 0;
          this.plantT = 0;
          this.setAnim('ref_shoot_c4', { loop: false, fade: 0.2 });
          return;
        }
        this.setGoal(site.x, site.z, now);
      }
      return;
    }
    const b = mgr.api.bomb;
    if (this.team === 'ct' && b.phase === 'planted') {
      const d = Math.hypot(this.pos.x - b.pos.x, this.pos.z - b.pos.z);
      if (d < 1.6) {
        this.state = 'defuse';
        this.stateT = 0;
        this.defuseT = 0;
        return;
      }
      this.setGoal(b.pos.x, b.pos.z, now);
      return;
    }
    if (this.lastSeen && this.alertT > 0) {
      this.setGoal(this.lastSeen.x, this.lastSeen.z, now);
      return;
    }
    // 守点 / 推进
    const site = this.goalSite || (this.goalSite = mgr.pickSite(this));
    if (!this.path) this.setGoal(site.x + (Math.random() - 0.5) * site.r, site.z + (Math.random() - 0.5) * site.r, now);
    // 到点后小范围游走（每 3~6 秒换一次目标，不然每个 think 都会重算 A*）
    if (this.path && this.pathI >= this.path.length && now > (this.wanderAt || 0)) {
      this.wanderAt = now + 3 + Math.random() * 3;
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 5;
      this.setGoal(site.x + Math.cos(a) * r, site.z + Math.sin(a) * r, now, true);
    }
  }

  setGoal(x, z, now, force = false) {
    if (!force && this.goal && Math.hypot(this.goal.x - x, this.goal.z - z) < 1.2 && now < this.repathAt) return;
    this.goal = new THREE.Vector3(x, 0, z);
    this.repathAt = now + 1.2;
    const p = this.mgr.nav.findPath(this.pos.x, this.pos.z, x, z);
    if (p && p.length) {
      this.path = p;
      this.pathI = 0;
    } else {
      this.path = [new THREE.Vector3(x, this.pos.y, z)];
      this.pathI = 0;
    }
    this.stuckT = 0;
  }

  /** 卡住时的随机绕路目标：附近 4~12m 的可行走点 */
  wanderGoal(now) {
    const nav = this.mgr.nav;
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 4 + Math.random() * 8;
      const x = this.pos.x + Math.cos(a) * r;
      const z = this.pos.z + Math.sin(a) * r;
      const [ix, iz] = nav.cellOf(x, z);
      if (ix < 1 || iz < 1 || ix >= nav.nx - 1 || iz >= nav.nz - 1) continue;
      if (!nav.walk[nav.idx(ix, iz)]) continue;
      this.detour = { x, z, until: now + 4 };
      this.setGoal(x, z, now, true);
      return true;
    }
    return false;
  }

  // ---- 动作 / 战斗 ----
  act(dt, now) {
    const t = this.target;
    if (t) {
      const tx = t.pos.x, tz = t.pos.z;
      const wantYaw = Math.atan2(-(tx - this.pos.x), -(tz - this.pos.z));
      this.yaw = angleLerp(this.yaw, wantYaw, 8, dt);
      if (this.reactAt && now >= this.reactAt) this.combat(dt, now);
      this.setAnim(this.crouch ? 'crouch_idle' : 'idle1', { fade: 0.16 });
      return;
    }
    // 下包
    if (this.state === 'plant') {
      this.plantT += dt;
      this.crouch = true;
      this.setAnim('ref_shoot_c4', { loop: true, fade: 0.2, speed: 1 });
      if (this.plantT > 3.0) {
        const site = this.mgr.api.bombSiteAt(this.pos.x, this.pos.z);
        if (site) this.mgr.api.plantBombAt(site, this.pos.x, this.pos.z, { auto: true });
        this.hasBomb = false;
        this.state = 'move';
        this.crouch = false;
        this.setAnim('idle1', { fade: 0.2 });
      }
      return;
    }
    if (this.state === 'defuse') {
      this.defuseT += dt;
      this.crouch = true;
      this.setAnim('crouch_idle', { fade: 0.2 });
      if (this.defuseT > 10) {
        if (this.mgr.api.bomb.phase === 'planted') this.mgr.api.defuseBomb();
        this.state = 'move';
        this.crouch = false;
      }
      return;
    }
    if (this.reloadEnd && now < this.reloadEnd) {
      this.setAnim(this.crouch ? 'crouch_idle' : 'idle1', { fade: 0.1 });
      return;
    }
    // 移动动画
    const spd = Math.hypot(this.vel.x, this.vel.z);
    if (!this.onGround) this.setAnim('jump', { fade: 0.12 });
    else if (this.crouch && spd > 0.4) this.setAnim('crouchrun', { fade: 0.18, speed: 1 });
    else if (this.crouch) this.setAnim('crouch_idle', { fade: 0.18 });
    else if (spd > 3.4) this.setAnim('run', { fade: 0.18, speed: clamp(spd / 6.2, 0.7, 1.35) });
    else if (spd > 0.35) this.setAnim('walk', { fade: 0.18, speed: clamp(spd / 3.2, 0.6, 1.3) });
    else this.setAnim('idle1', { fade: 0.2 });
  }

  combat(dt, now) {
    const def = this.def;
    if (!def) return;
    const t = this.target;
    const d = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
    // 蹲下：远距离/换弹时压枪
    this.wantCrouch = d > 14 && Math.random() < 0.02 ? true : (d < 8 ? false : this.wantCrouch);
    this.crouch = this.wantCrouch && this.onGround;

    // 扔手雷
    this.grenadeCool -= dt;
    if (this.grenadeCool <= 0 && d > 7 && d < 26 && Math.random() < 0.5) {
      this.grenadeCool = 20 + Math.random() * 20;
      this.mgr.throwBotGrenade(this, t.pos);
      return;
    }

    if (this.reloadEnd && now < this.reloadEnd) return;
    if (this.ammo <= 0) {
      this.startReload(now);
      return;
    }
    if (now < this.nextFire) return;
    // 点射节奏
    if (this.burstLeft <= 0) {
      if (this.burstPause > now) return;
      this.burstLeft = def.auto ? 3 + ((Math.random() * 5) | 0) : 1 + ((Math.random() * 2) | 0);
      this.burstPause = now + 0.18 + Math.random() * 0.35;
    }
    this.shootAt(t, d, now);
    this.burstLeft--;
    this.nextFire = now + 60 / (def.rpm || 400);
    if (this.burstLeft <= 0) this.nextFire = Math.max(this.nextFire, now + 0.22 + Math.random() * 0.3);
  }

  startReload(now) {
    if (this.reloadEnd && now < this.reloadEnd) return;
    const cls = animClass(this.def);
    const crouch = this.crouch;
    const name = (crouch ? 'crouch_reload_' : 'ref_reload_') + cls;
    const dur = this.animDur(name) || 2.2;
    this.reloadEnd = now + dur * 0.92;
    this.setAnim(name, { loop: false, fade: 0.12, clampEnd: true });
    this.mgr.sfxReload(this, dur);
  }

  shootAt(t, d, now) {
    const mgr = this.mgr;
    const def = this.def;
    const from = this.eye(new THREE.Vector3());
    const to = t.chest(new THREE.Vector3());
    // 精度：距离越远越散，蹲下更准，移动更散
    const moveK = clamp(Math.hypot(this.vel.x, this.vel.z) / 6.2, 0, 1);
    const base = (1.9 - this.skill * 1.15) * (1 + d / 45) * (this.crouch ? 0.62 : 1) + moveK * 1.4;
    const sigma = base * DEG;
    // 随机扰动方向
    const dir = to.clone().sub(from).normalize();
    const up = Math.abs(dir.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    const up2 = new THREE.Vector3().crossVectors(side, dir).normalize();
    const a = Math.random() * Math.PI * 2;
    const r = Math.abs(gauss()) * sigma;
    dir.addScaledVector(side, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r).normalize();

    // 目标角半径：命中判定的唯一依据
    const ang = Math.atan2(t.crouch ? 0.45 : 0.55, Math.max(0.6, d));
    const hit = angleTo(dir, to.clone().sub(from).normalize()) < ang;

    // 墙体遮挡
    mgr.api.rayBlocked(from, dir, d + 2, hit ? (p) => {} : null);

    this.ammo--;
    this.recoil = 1;
    // 手臂由 IK 压住，这时切射击动作反而会把手甩开 —— 用后坐力代替
    if (!this._ikActive) {
      this.setAnim((this.crouch ? 'crouch_shoot_' : 'ref_shoot_') + animClass(def), { loop: false, fade: 0.04, clampEnd: false, speed: 1 });
    }
    mgr.sfxShot(this, def);

    if (hit) {
      const head = Math.random() < 0.10;
      const dmg = def.damage * (head ? 4 : 1) * mgr.difficulty * (0.85 + Math.random() * 0.3);
      mgr.applyHit(this, t, Math.round(dmg), head);
    } else {
      mgr.api.tracer(from, from.clone().addScaledVector(dir, Math.min(d + 2, 40)));
    }
  }

  // ---- 物理 / 路径 ----
  move(dt, now) {
    const api = this.mgr.api;
    let wishX = 0, wishZ = 0;
    const speedBase = this.crouch ? 2.7 : (this.alertT > 0 ? 6.1 : 5.2);

    if (this.target) {
      // 交战时站定（远距离）或小范围横移
      const d = Math.hypot(this.target.pos.x - this.pos.x, this.target.pos.z - this.pos.z);
      if (d < 6) {
        // 太近就后撤一点
        const bx = this.pos.x - this.target.pos.x, bz = this.pos.z - this.target.pos.z;
        const bl = Math.hypot(bx, bz) || 1;
        wishX = bx / bl; wishZ = bz / bl;
      } else {
        this.strafeT = (this.strafeT || 0) - dt;
        if (this.strafeT <= 0) { this.strafeT = 0.6 + Math.random() * 0.9; this.strafeDir = Math.random() < 0.5 ? -1 : 1; }
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        wishX = -fz * this.strafeDir * 0.55;
        wishZ = fx * this.strafeDir * 0.55;
      }
    } else if (this.path && this.pathI < this.path.length) {
      const p = this.path[this.pathI];
      const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.75) {
        this.pathI++;
      } else {
        wishX = dx / d; wishZ = dz / d;
        const wantYaw = Math.atan2(-dx, -dz);
        this.yaw = angleLerp(this.yaw, wantYaw, 6, dt);
      }
    }

    const sp = Math.hypot(wishX, wishZ);
    const speed = sp > 0.01 ? speedBase : 0;
    if (sp > 0.01) { wishX /= sp; wishZ /= sp; }

    const accel = this.onGround ? 12 : 2.5;
    this.vel.x = damp(this.vel.x, wishX * speed, accel, dt);
    this.vel.z = damp(this.vel.z, wishZ * speed, accel, dt);

    // 水平移动（真实碰撞）
    const nx = this.pos.x + this.vel.x * dt;
    const nz = this.pos.z + this.vel.z * dt;
    const feet = this.pos.y;
    if (!api.blockedMove(this.pos.x, this.pos.z, nx, nz, feet) && api.floorOK(nx, nz, feet)) {
      this.pos.x = nx;
      this.pos.z = nz;
    } else {
      // 卡住：跳一下 / 重算路径
      this.stuckT += dt;
      this.vel.x *= 0.2; this.vel.z *= 0.2;
      if (this.stuckT > 0.6) {
        this.stuckT = 0;
        if (this.onGround && Math.random() < 0.35) this.vel.y = 5.4;
        // 撞墙撞久了就别再朝同一个点硬顶：随机挑一个附近的可行点绕一下
        // （A* 在这张图上跨区不可靠，靠这种「随机探路」把 bot 带出死角）
        this.escapeT = (this.escapeT || 0) + 1;
        if (this.escapeT >= 2) {
          this.escapeT = 0;
          this.wanderGoal(now);
        } else if (this.goal) {
          this.setGoal(this.goal.x, this.goal.z, now, true);
        } else if (this.path) this.path = null;
      }
    }
    // 与队友分离（避免叠在一起）
    for (const o of this.mgr.bots) {
      if (o === this || o.dead) continue;
      const dx = this.pos.x - o.pos.x, dz = this.pos.z - o.pos.z;
      const dd = dx * dx + dz * dz;
      if (dd > 0.0001 && dd < 0.55) {
        const dl = Math.sqrt(dd);
        this.pos.x += dx / dl * (0.62 - dl) * 0.5;
        this.pos.z += dz / dl * (0.62 - dl) * 0.5;
      }
    }

    // 垂直
    this.vel.y -= 18 * dt;
    this.pos.y += this.vel.y * dt;
    const fromY = this.pos.y + 1.2;
    const g = api.groundHeightAt(this.pos.x, this.pos.z, fromY);
    if (g > -90 && this.pos.y <= g) {
      this.pos.y = g;
      this.vel.y = 0;
      this.onGround = true;
    } else if (this.pos.y > g + 0.4) {
      this.onGround = false;
    }
    if (this.pos.y < -20) {
      const sp2 = this.mgr.spawnFor(this.team);
      this.pos.set(sp2.x, sp2.y, sp2.z);
      this.vel.set(0, 0, 0);
    }

    // 模型跟随（yOff 让模型脚底正好落在 pos 上）
    this.model.position.set(this.pos.x, this.pos.y + (this.yOff || 0), this.pos.z);
    this.model.rotation.y = this.yaw + MODEL_YAW * DEG;
    // 蹲下：整体压低（骨骼动画自带蹲姿，这里只补一点整体高度）
    this.model.position.y -= this.crouch ? 0.06 : 0;
  }
}

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function angleTo(a, b) { return Math.acos(clamp(a.dot(b), -1, 1)); }
function angleLerp(a, b, k, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-k * dt));
}

// ---------------------------------------------------------------------------
// BotManager
// ---------------------------------------------------------------------------
export class BotManager {
  constructor(api) {
    this.api = api;
    this.bots = [];
    this.clips = [];
    this.ready = false;
    this.difficulty = 0.55;
    this.nav = new NavGrid(api);
    this.teamGoal = { t: null, ct: null };
    this.bombOwner = null;
  }

  async load(loader, onProgress) {
    const loadOne = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
    const [t, ct] = await Promise.all([
      loadOne('./assets/models/char_t.glb?v=r90'),
      loadOne('./assets/models/char_ct.glb?v=r90'),
    ]);
    this.srcT = t; this.srcCT = ct;
    this.clips = t.animations;
    // 统一缩放到 1.78m 高。
    // 注意：不能靠 Group.scale 缩放 —— 蒙皮的 bindMatrix / boneInverses 是按原始
    // 绑定姿势算的，外层再乘一次缩放会让顶点被缩放 k²（实测人物只有 4cm 高，
    // 在屏幕上就一个小红点）。这里直接把「顶点 + 骨骼静止位置 + 动画位置轨道」
    // 三处一起乘 k，模型本身就变成米制，层级上不再有任何缩放。
    for (const g of [t, ct]) this.prepareSource(g);
    this.ready = true;
    if (onProgress) onProgress();
  }

  /**
   * 人物模型已经在离线阶段烘焙好了（tools/bake-char.py）：
   *   原始 CS 1.6 模型是 Z-up、单位是英寸（身高 69.45），根节点用一个 matrix
   *   做 Z-up→Y-up 的旋转。烘焙脚本把「顶点 / 骨骼静止位置 / 动画 position 轨道
   *   / inverseBindMatrices 平移列 / 根节点 matrix 平移」一起乘 k=0.0256，并把脚底
   *   钉到 y=0，得到 1.78m、Y-up、面朝 +Z 的模型。
   * 蒙皮网格不能在父级 Group 上 scale/rotate（bindMatrix + boneInverses 会二次
   * 变换），所以这里不再做任何缩放，直接用。
   */
  prepareSource(g) {
    const box = new THREE.Box3();
    g.scene.updateMatrixWorld(true);
    // 用骨骼世界位置兜一个高度，纯诊断用（不要用 Box3.setFromObject 量 SkinnedMesh）
    let lo = Infinity, hi = -Infinity;
    g.scene.traverse(o => {
      if (!o.isBone) return;
      const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
      if (p.y < lo) lo = p.y;
      if (p.y > hi) hi = p.y;
    });
    g.userData.yOff = 0;
    g.userData.height = 1.78;
    g.userData.boneY = [lo, hi];
    void box;
  }

  makeBot(team, i) {
    const b = new Bot(this, team, i);
    const src = team === 't' ? this.srcT : this.srcCT;
    const root = cloneSkinned(src.scene);
    root.traverse(o => {
      if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
    });
    const holder = new THREE.Group();
    holder.add(root);
    this.api.scene.add(holder);
    b.attach(holder);
    b.model = holder;
    // attach 里拿的是 holder 下的 model；动画 mixer 要绑 root
    b.mixer = new THREE.AnimationMixer(root);
    b.actions = {};
    for (const clip of this.clips) b.actions[clip.name] = b.mixer.clipAction(clip);
    b.root = root;
    b.yOff = src.userData.yOff || 0;
    // 脚下阴影贴片
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 18),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.02;
    holder.add(disc);
    b.shadow = disc;
    return b;
  }

  /** 每回合重置：全部重生 + 重新发枪 */
  resetRound(playerTeam) {
    if (!this.ready) return;
    if (!this.bots.length) {
      for (let i = 0; i < 4; i++) this.bots.push(this.makeBot('t', i));
      for (let i = 0; i < 4; i++) this.bots.push(this.makeBot('ct', i));
    }
    this.teamGoal.t = this.pickSiteTeam('t');
    this.teamGoal.ct = this.pickSiteTeam('ct');
    this.bombOwner = null;
    for (const b of this.bots) {
      this.spawnBot(b, true);
    }
    // 出生点如果和包点不在同一块连通区（这张 de_dust2 的 T 家平台在导航图上
    // 是一座孤岛），bot 会在家里原地打转，永远到不了包点。遇到这种情况把它们
    // 直接挪到「和包点连通」的战术站位上。
    for (const b of this.bots) {
      const site = this.teamGoal[b.team] || this.pickSite(b);
      if (!site) continue;
      if (this.nav.findPath(b.pos.x, b.pos.z, site.x, site.z)) continue;
      const st = this.stagingNear(site, b.team, b.index);
      if (!st) continue;
      b.pos.set(st.x, st.y + 0.05, st.z);
      b.yaw = st.yaw;
      b.path = null;
      b.goalSite = site;
      b.setGoal(site.x, site.z, performance.now() / 1000, true);
    }
    // 玩家是 CT 时，随机一个 T 背 C4
    if (playerTeam === 'ct') {
      const ts = this.bots.filter(b => b.team === 't' && !b.dead);
      if (ts.length) {
        this.bombOwner = ts[(Math.random() * ts.length) | 0];
        this.bombOwner.hasBomb = true;
      }
    }
  }

  spawnBot(b, fresh) {
    const sp = this.spawnFor(b.team, b.index);
    b.respawn(sp);
    b.goalSite = this.teamGoal[b.team] || this.pickSite(b);
    b.path = null;
    if (fresh) {
      const pool = b.team === 't' ? LOADOUT_T : LOADOUT_CT;
      const id = pool[(Math.random() * pool.length) | 0];
      const def = this.api.weaponById(id) || this.api.weaponById(b.team === 't' ? 'glock18' : 'usp');
      b.giveWeapon(def);
      b.armor = Math.random() < 0.5 ? 100 : 0;
      b.skill = 0.5 + Math.random() * 0.35;
    }
  }

  respawnBot(b) {
    this.spawnBot(b, false);
    if (b.hasBomb || this.bombOwner === b) {
      b.hasBomb = false;
      if (this.bombOwner === b) this.bombOwner = null;
    }
  }

  /** 包点周边「和包点连通」的一批站位（缓存，每张图只算一次） */
  stagingNear(site, team, index = 0) {
    const nav = this.nav;
    if (!nav.ok) return null;
    if (!this._stage) this._stage = new Map();
    const key = site.x.toFixed(0) + ',' + site.z.toFixed(0);
    let list = this._stage.get(key);
    if (!list) {
      const [cx, cz] = nav.cellOf(site.x, site.z);
      const start = nav.nearestWalkable(cx, cz);
      list = [];
      if (start) {
        const nx = nav.nx, nz = nav.nz;
        const seen = new Uint8Array(nx * nz);
        const q = [nav.idx(start[0], start[1])];
        seen[q[0]] = 1;
        while (q.length) {
          const k = q.pop();
          const ix = k % nx, iz = (k / nx) | 0;
          const x = nav.x0 + (ix + 0.5) * nav.S, z = nav.z0 + (iz + 0.5) * nav.S;
          const d = Math.hypot(x - site.x, z - site.z);
          if (d > 12 && d < 30) list.push({ x, z, y: nav.h[k], d });
          const ch = nav.h[k];
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dz) continue;
              const X = ix + dx, Z = iz + dz;
              if (X < 1 || Z < 1 || X >= nx - 1 || Z >= nz - 1) continue;
              const nk = Z * nx + X;
              if (seen[nk] || !nav.walk[nk]) continue;
              if (nav.h[nk] - ch > 0.70) continue;
              seen[nk] = 1;
              q.push(nk);
            }
          }
        }
        list.sort((a, b) => a.d - b.d);
      }
      this._stage.set(key, list);
    }
    if (!list.length) return null;
    // 每队取不同角度的一圈站位，尽量散开
    const pick = list[(index * 37 + (team === 'ct' ? 11 : 0)) % list.length];
    const yaw = Math.atan2(-(site.x - pick.x), -(site.z - pick.z));
    return { x: pick.x, y: pick.y, z: pick.z, yaw };
  }

  spawnFor(team, index = 0) {
    const sp = this.api.spawnPoint(team);
    if (!sp) return { x: 0, y: 0, z: 0, yaw: 0 };
    const a = (index / 4) * Math.PI * 2 + Math.random() * 0.4;
    for (let k = 0; k < 8; k++) {
      const r = 1.2 + k * 0.9;
      const x = sp.x + Math.cos(a) * r;
      const z = sp.z + Math.sin(a) * r;
      if (this.api.floorOK(x, z, sp.y) && !this.api.blockedMove(sp.x, sp.z, x, z, sp.y)) {
        const y = this.api.groundHeightAt(x, z, sp.y + 2);
        return { x, y: y > -90 ? y : sp.y, z, yaw: sp.yaw };
      }
    }
    return sp;
  }

  pickSiteTeam(team) {
    const sites = this.api.BOMB_SITES || [];
    if (!sites.length) return null;
    return sites[(Math.random() * sites.length) | 0];
  }
  pickSite(bot) { return this.teamGoal[bot.team] || this.pickSiteTeam(bot.team); }
  bombSiteFor(bot) {
    return this.api.bombSiteAt(bot.pos.x, bot.pos.z) || this.teamGoal.t || this.pickSiteTeam('t');
  }

  // ---- 武器模型 ----
  equipModel(bot, def) {
    if (!bot.gunHolder) return;
    if (bot.gunId === def.id && bot.gunMesh) { bot.gunMesh.visible = true; return; }
    bot.gunId = def.id;
    const put = (mesh) => {
      if (!mesh) return;
      if (bot.gunMesh) bot.gunHolder.remove(bot.gunMesh);
      bot.gunMesh = mesh;
      const m = mountFor(def);
      // 位置/朝向由 aimGun() 每帧算，这里只把「握把」挪到模型原点
      mesh.position.set(-m.grip[0], -m.grip[1], -m.grip[2]);
      mesh.rotation.set(0, 0, 0);
      if (!mesh.userData.baseScale) mesh.userData.baseScale = mesh.scale.x || 1;
      mesh.scale.setScalar(mesh.userData.baseScale);
      bot.gunFlip = m.flip;
      bot.gunHolder.position.set(0, 0, 0);
      mesh.visible = !bot.dead;
      bot.gunHolder.add(mesh);
      if (bot.handBone) bot.aimGun();
    };
    const cached = this.api.gunModel(def.id);
    if (cached) { put(cached.clone()); return; }
    this.api.loadGun(def.id).then(g => {
      if (!g) return;
      const mesh = g.clone();
      if (bot.gunId === def.id) put(mesh);
    });
  }

  // ---- 感知 ----
  acquire(bot, now) {
    const from = bot.eye(new THREE.Vector3());
    const fwd = new THREE.Vector3(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
    const cands = [];
    for (const t of this.targets(bot)) {
      if (!t || t.dead) continue;
      const p = t.chest(_v1);
      const d = from.distanceTo(p);
      if (d > 60) continue;
      const dir = _v2.copy(p).sub(from).normalize();
      // FOV 120°；近身（3.5m 内）不看朝向，被打过之后 25m 内回头也能发现
      if (d > 3.5 && dir.dot(fwd) < 0.5 && !(bot.alertT > 0 && d < 25)) continue;
      cands.push({ t, d, dir: dir.clone() });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    // 只对最近的 2 个做视线射线：一次 raycast 要遍历整张地图的三角形，
    // 8 个 bot × 5 个目标 × 每 0.2s 会把主线程彻底压死（实测直接卡成不响应）。
    for (let i = 0; i < Math.min(2, cands.length); i++) {
      const c = cands[i];
      if (this.api.rayBlocked(from, c.dir, c.d - 0.35)) continue;
      return c.t;
    }
    return null;
  }

  targets(bot) {
    const out = [];
    const P = this.api.player;
    const pt = this.api.playerTeam();
    if (pt && pt !== bot.team && !this.api.playerDead()) out.push({
      pos: P.pos, crouch: !!P.crouch, dead: false,
      chest: (v) => v.set(P.pos.x, P.pos.y + (P.crouch ? 0.85 : 1.2), P.pos.z),
      takeDamage: (dmg, x, z, cause) => this.api.damagePlayer(dmg, x, z, cause || `${bot.name}`),
      isPlayer: true,
    });
    for (const b of this.bots) {
      if (b === bot || b.dead || b.team === bot.team) continue;
      out.push(b);
    }
    return out;
  }

  applyHit(from, target, dmg, head) {
    const pos = target.pos;
    if (target.isPlayer) this.api.damagePlayer(dmg, from.pos.x, from.pos.z, `${from.name} · ${from.def ? from.def.name : ''}`);
    else target.takeDamage(dmg, from.pos.x, from.pos.z, from.name);
    this.api.hitFx && this.api.hitFx(pos, head);
  }

  // ---- 音效 ----
  sfxShot(bot, def) {
    const sfx = def.sfx || {};
    const name = sfx.shot;
    if (name) this.api.audio.playAt(name, bot.pos, { ref: 9, maxDist: 75, gain: 0.95, rate: 0.97 + Math.random() * 0.06 });
    // 枪口焰（复用弹孔系统的轻量版：直接给一个小 sprite）
    this.api.muzzleFx && this.api.muzzleFx(bot);
  }
  sfxReload(bot, dur) {
    const def = bot.def, sfx = def && def.sfx;
    if (!sfx) return;
    const cues = sfx.reloadCues;
    if (cues && cues.length) {
      for (const c of cues) {
        setTimeout(() => {
          if (bot.dead || bot.def !== def) return;
          this.api.audio.playAt(c[1], bot.pos, { ref: 4, maxDist: 22, gain: 0.85 });
        }, c[0] * 1000);
      }
    } else if (sfx.deploy) {
      this.api.audio.playAt(sfx.deploy, bot.pos, { ref: 4, maxDist: 20, gain: 0.7 });
    }
  }
  sfxStep(bot) {
    const n = 1 + ((Math.random() * 4) | 0);
    this.api.audio.playAt('pl_step' + n, bot.pos, { ref: 3, maxDist: 18, gain: 0.55, rate: 0.95 + Math.random() * 0.1 });
  }

  throwBotGrenade(bot, targetPos) {
    if (bot.dead) return;
    const list = ['hegrenade', 'flashbang'];
    const id = list[(Math.random() * list.length) | 0];
    const def = this.api.weaponById(id);
    if (!def) return;
    bot.setAnim('ref_shoot_grenade', { loop: false, fade: 0.12, clampEnd: true });
    const from = bot.eye(new THREE.Vector3());
    setTimeout(() => {
      if (bot.dead) return;
      this.api.spawnBotGrenade(def, from, targetPos);
    }, 620);
  }

  onDeath(bot, cause) {
    this.api.onKill && this.api.onKill(bot, cause);
  }

  update(dt, now) {
    if (!this.ready) return;
    const P = this.api.player;
    for (const b of this.bots) {
      if (b.dead) { b.update(dt, now); continue; }
      const d = Math.hypot(b.pos.x - P.pos.x, b.pos.z - P.pos.z);
      // 远处 bot 降频（每两帧一次），近处全速
      b._acc = (b._acc || 0) + dt;
      if (d > 45) {
        if (b._acc < 0.1) { b.mixer.update(dt); continue; }
        b.update(b._acc, now);
        b._acc = 0;
      } else {
        b.update(dt, now);
        b._acc = 0;
      }
      // 脚步
      if (!b.dead && b.onGround && Math.hypot(b.vel.x, b.vel.z) > 1.6) {
        b.stepAcc = (b.stepAcc || 0) + dt * Math.hypot(b.vel.x, b.vel.z);
        if (b.stepAcc > 2.2) { b.stepAcc = 0; this.sfxStep(b); }
      }
      if (b.shadow) b.shadow.position.y = 0.02;
    }
  }

  /** 调试：把某个 bot 摆到玩家面前（验证模型/挂枪，不参与 AI） */
  pose(idx, { dist = 3.2, anim = 'idle1', yaw = null } = {}) {
    const b = this.bots[idx];
    if (!b) return null;
    const P = this.api.player;
    const fx = -Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    b.freeze = true;
    b.dead = false;
    b.pos.set(P.pos.x + fx * dist, P.pos.y, P.pos.z + fz * dist);
    b.yaw = yaw == null ? P.yaw + Math.PI : yaw;
    b.vel.set(0, 0, 0);
    b.model.position.set(b.pos.x, b.pos.y + (b.yOff || 0), b.pos.z);
    b.model.rotation.y = b.yaw + MODEL_YAW * DEG;
    b.setAnim(anim, { fade: 0.05 });
    b.mixer.update(0.016);
    return b.pos.toArray();
  }

  // 调试：热改手上武器的挂载参数（校准 MOUNT 表用）
  setMount(grip, rotDeg, scale = 1) {
    // grip=[x,y,z]：模型空间里握把的位置（米），会把这个点对到手掌
    for (const b of this.bots) {
      if (!b.gunMesh) continue;
      if (grip) b.gunMesh.position.set(-grip[0], -grip[1], -grip[2]);
      if (rotDeg) b.gunMesh.rotation.set(rotDeg[0] * DEG, rotDeg[1] * DEG, rotDeg[2] * DEG);
      const s0 = b.gunMesh.userData.baseScale || 1;
      b.gunMesh.scale.setScalar(s0 * scale);
      b.aimGun();
    }
  }

  debug() {
    return this.bots.map(b => ({
      t: b.team, name: b.name, p: [+b.pos.x.toFixed(1), +b.pos.y.toFixed(1), +b.pos.z.toFixed(1)],
      hp: Math.round(b.health), dead: b.dead, st: b.state, anim: b.curName,
      path: b.path ? b.path.length : 0, gun: b.gunId, vis: !!(b.model && b.model.visible),
      kid: b.model ? b.model.children.length : 0, hand: !!b.handBone, holder: !!b.gunHolder, clipN: Object.keys(b.actions).length,
      dist: +Math.hypot(b.pos.x - this.api.player.pos.x, b.pos.z - this.api.player.pos.z).toFixed(1),
    }));
  }

  onGunshot(pos, team) {
    for (const b of this.bots) {
      if (b.dead || b.team === team) continue;
      const d = Math.hypot(b.pos.x - pos.x, b.pos.z - pos.z);
      if (d < 28) {
        b.alertT = Math.max(b.alertT, 4);
        if (!b.target) {
          b.lastSeen = new THREE.Vector3(pos.x, b.pos.y, pos.z);
          b.yaw = Math.atan2(-(pos.x - b.pos.x), -(pos.z - b.pos.z));
        }
      }
    }
  }
}
