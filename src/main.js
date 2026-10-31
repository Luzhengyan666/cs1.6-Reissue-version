import * as THREE from 'three';
import { GLTFLoader } from '../vendor/GLTFLoader.js?v=r90';
import { WEAPONS, WEAPON_BY_ID, DEV, BOMB_SITES, BOMB_RULES } from './config.js?v=r90';
import { WeaponSystem } from './viewmodel.js?v=r90';
import { AudioEngine } from './audio.js?v=r90';
import { BotManager } from './bots.js?v=r90';
import { applySavedTuning, initTuner } from './tuner.js?v=r90';
import { initSiteTuner } from './site-tuner.js?v=r90';

const DEG = Math.PI / 180;
const clamp = THREE.MathUtils.clamp;
const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

const qs = new URLSearchParams(location.search);
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const DEBUG = qs.has('tune') || qs.has('w');

// ---------------------------------------------------------------- 渲染器
const canvas = document.getElementById('view');
// 抗锯齿：像素比 >= 1.5 的高分屏（Retina / 2K、4K）本身已经是超采样了，
// 再开 4x MSAA 只是白烧带宽 —— 这种屏幕直接关掉 MSAA，画面看不出差别，帧率能上一个台阶。
const DPR0 = window.devicePixelRatio || 1;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: DPR0 < 1.5, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
// 阴影：PCFSoft 边缘比较软，接近 CS 那种「一条清楚的影子」但不生硬
renderer.shadowMap.enabled = !!DEV.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// 场景是完全静态的（地图不动、太阳不动、第一人称看不到自己的影子），
// 所以阴影贴图只要在地图加载完烘一次就够，之后每帧直接采样现成的 ——
// 不这样的话每一帧都要把 9000 多面的地图再画进阴影贴图一遍，
// 软件渲染下 FPS 直接从 11 掉到 3.7。
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9dc0dd);   // 原始天空色（取消黄色调色）
scene.fog = new THREE.Fog(0xc6d8e6, 90, 340);   // 原始雾色

const FOV = 65;
// 天空穹顶：渐变底色 + 程序化生成的云（不占资源，也不用外部贴图）
function makeSkyTexture() {
  const W = 1024, H = 512;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.00, '#5f8fbe');
  grd.addColorStop(0.42, '#94b9d8');
  grd.addColorStop(0.66, '#c3d6e2');
  grd.addColorStop(0.82, '#dfe3d8');
  grd.addColorStop(1.00, '#cfc4a8');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);

  // 云团：一堆模糊的白色圆，横向重复画一遍消除接缝
  const puffs = [];
  for (let i = 0; i < 150; i++) {
    puffs.push({
      x: Math.random() * W,
      y: Math.pow(Math.random(), 0.75) * H * 0.56,
      r: 16 + Math.random() * 86,
      a: 0.05 + Math.random() * 0.22,
    });
  }
  g.filter = 'blur(9px)';
  for (const p of puffs) {
    for (const dx of [-W, 0, W]) {
      const rg = g.createRadialGradient(p.x + dx, p.y, 0, p.x + dx, p.y, p.r);
      rg.addColorStop(0, `rgba(255,255,255,${p.a})`);
      rg.addColorStop(0.55, `rgba(255,255,255,${p.a * 0.55})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(p.x + dx, p.y, p.r, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.filter = 'none';
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}
const skyDome = new THREE.Mesh(
  new THREE.SphereGeometry(460, 32, 18),
  new THREE.MeshBasicMaterial({ map: makeSkyTexture(), side: THREE.BackSide, depthWrite: false, fog: false })
);
skyDome.renderOrder = -10;
scene.add(skyDome);

const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.05, 600);
camera.rotation.order = 'YXZ';
scene.add(camera);

// 武器视图独立场景（避免穿模、近裁剪）
const viewScene = new THREE.Scene();
const viewCamera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.01, 20);

// 抛壳口位置标记（调参时显示，帮玩家对准抛壳点）：实心小方块 + 外框线。
// 放在视图场景里渲染（和枪同一层），这样它就是个真实物体：
// 会被枪模型正常遮挡（不再透视），埋进枪里就看不见、露在枪外才显示——
// 正好用"能不能看见"判断抛壳点在枪身表面还是陷进了金属里。
const ejectMarker = new THREE.Mesh(
  new THREE.BoxGeometry(0.08, 0.08, 0.08),
  new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: false, opacity: 1, depthTest: true })
);
ejectMarker.visible = false;
ejectMarker.renderOrder = 999;
viewScene.add(ejectMarker);
const ejectMarkerBox = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(0.08, 0.08, 0.08)),
  new THREE.LineBasicMaterial({ color: 0x00262f, transparent: false, opacity: 1, depthTest: true })
);
ejectMarkerBox.renderOrder = 1000;
ejectMarker.add(ejectMarkerBox);
let ejectMarkerVisible = false;


// 弹壳渲染层：世界先画 → 手里的枪第二画 → 弹壳最后单独画一遍。
// 这样弹壳的层级永远高于枪模型，不会一离膛就被枪身盖住看不见
//（原来弹壳和世界一起画，而枪是后画并清深度缓冲的，等于永远压在弹壳上面）。
const CASE_LAYER = 2;

// ---------------------------------------------------------------- 灯光
// 天光压低、阳光加强：不这么调阴影会被环境光填平，看着像没开
const hemi = new THREE.HemisphereLight(0xcfe2f5, 0xc0a887, 0.72);   // 天光（r73 提亮 → r81 再抬一点）
scene.add(hemi);
// 全局暖黄环境光：让阴影面也带一层 dust2 的沙漠黄
const sun = new THREE.DirectionalLight(0xfff2d8, 2.98);            // 阳光（r73 提亮 → r81 整体再亮一档）
sun.position.set(38, 62, 24);
sun.castShadow = !!DEV.shadows;
// 阴影贴图尺寸按设备能力选：8192² 的深度图要 260MB+ 显存，手机/集显上
// 会把后面要加载的枪模贴图挤掉（表现就是「丢出去的枪没有世界模型」），
// 所以这里回到 4096（手机 2048）。墙根细缝靠收紧 bias 解决，不靠堆分辨率。
const _maxTexSize = (renderer.capabilities && renderer.capabilities.maxTextureSize) || 4096;
const SHADOW_SIZE = Math.min(IS_TOUCH ? 2048 : 4096, _maxTexSize);
sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
// 正交范围要盖住整张地图的「光照投影」（138x163m，沿斜光方向的对角更大）：
// 之前 ±112 贴着地图边缘，边上的物体落在阴影相机外 → 没有影子
const SHADOW_RANGE = 128;
sun.shadow.camera.left = -SHADOW_RANGE;
sun.shadow.camera.right = SHADOW_RANGE;
sun.shadow.camera.top = SHADOW_RANGE;
sun.shadow.camera.bottom = -SHADOW_RANGE;
sun.shadow.camera.near = 20;
sun.shadow.camera.far = 400;
// normalBias 过大会让影子整体“缩水”，墙根就露出一道细缝；
// 但压太狠（0.018）地面自己会遮自己，整片地面浮出一层斜向细条纹
// ——就是「地上像有网格」的来源。合理的量级是「一两个阴影贴图像素」：
// 这里按贴图分辨率算（4096 时 ≈ 0.08，2048 手机 ≈ 0.16），既压住自遮挡，
// 也不会把影子从物体底下拽开（实测墙根仍贴着墙脚）。
// 掠射角的斜面（屋顶、斜坡）最吃这个值，0.045 时那儿还是一条条斑马纹。
// r77：深度 bias 从 -0.00038 收到 -0.00002。这个值是「归一化深度」，
// 阴影相机 near..far 跨度 380m，0.00038 相当于把投影体沿光方向推开了 14cm
// ——墙根那道「影子离墙一条缝」就是它造成的。自遮挡交给 normalBias 处理。
sun.shadow.bias = -0.00002;
sun.shadow.normalBias = +((SHADOW_RANGE * 2) / SHADOW_SIZE * 1.28).toFixed(4);
sun.shadow.needsUpdate = true;
sun.position.set(60, 130, 40);
scene.add(sun);
sun.target.position.set(0, 0, 0);
scene.add(sun.target);
const fill = new THREE.DirectionalLight(0xdfe9f5, 0.18);
fill.position.set(-30, 18, -40);
scene.add(fill);
// 爆炸灯常驻（强度 0）：爆炸时如果临时往场景里加灯，three 会给全部材质重编 shader，
// SwiftShader 上就是 300ms 级的卡顿。常驻一盏，爆炸只改强度/颜色/位置。
const fxLight = new THREE.PointLight(0xff9a2e, 0, 20, 2);
fxLight.position.set(0, -50, 0);   // 平时放远处，不影响画面
scene.add(fxLight);
// 弹壳最后是用 layer 2 单独渲染的，灯光也要照得到那一层
hemi.layers.enable(CASE_LAYER);
sun.layers.enable(CASE_LAYER);
fill.layers.enable(CASE_LAYER);
fxLight.layers.enable(CASE_LAYER);

viewScene.add(new THREE.AmbientLight(0xffffff, 1.25));
const vh = new THREE.HemisphereLight(0xffffff, 0xcfd4db, 0.85);
viewScene.add(vh);
const vd1 = new THREE.DirectionalLight(0xffffff, 1.35);
vd1.position.set(0.7, 1.2, 1.4);
viewScene.add(vd1);
const vd2 = new THREE.DirectionalLight(0xffffff, 0.55);
vd2.position.set(-1.2, 0.3, 0.6);
viewScene.add(vd2);

// ---------------------------------------------------------------- 地图（de_dust2）
// 兜底平面：地图还没加载完（或加载失败）时先踩在 y=0 上，加载好就隐藏。
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.0 })
);
ground.rotation.x = -Math.PI / 2;
ground.name = 'ground';
scene.add(ground);

const mapMeshes = [];
let mapReady = false;
let mapDoneResolve = () => {};
const mapDone = new Promise(r => { mapDoneResolve = r; });
let mapBox = null;      // 缩放后的地图世界包围盒（用来挡「走出地图边界」）

// 地图整体放大系数：原始模型 95x112m 是按 CS 单位折算的真实大小，
// 但玩家眼高只有 1.62m，走起来会觉得「几步就到头」。
// 放大 1.45 倍后是 138x163m，空间感和门洞高度都更像原版。
const MAP_SCALE = 1.45;
const MAP_CENTER = new THREE.Vector3(-7.0, 2.4, -23.35);   // 原始包围盒中心
// 贴图各向异性：8 倍足够救回斜视角的地面细节，老显卡/手机也扛得住
const mapAniso = Math.max(1, Math.min(8, renderer.capabilities.getMaxAnisotropy() || 1));

{
  const loader = new GLTFLoader();
  loader.load('./assets/models/de_dust_2.glb', (g) => {
    const map = g.scene;
    map.name = 'de_dust2';
    // 以包围盒中心为基准等比放大（位置补偿见 MAP_CENTER 说明）
    map.scale.setScalar(MAP_SCALE);
    map.position.copy(MAP_CENTER).multiplyScalar(1 - MAP_SCALE);
    map.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;        // 墙、箱子、建筑都投影子
      o.receiveShadow = true;     // 地面/墙面接收影子
      // 双面：有些面在导出时朝向反了，单面会出现「透视墙」
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.side = THREE.DoubleSide;
          m.metalness = 0.0;
          m.roughness = Math.min(1, (m.roughness ?? 0.9) + 0.05);
          // 影子贴图两侧都渲染：单薄面/围栏从背光面看也要有影子
          // （之前只渲染正面，导致一部分物体完全没有影子）
          m.shadowSide = THREE.DoubleSide;
          // 地图贴图都很小（64~256px），anisotropy 默认 1 时斜着看地面会糊成一片，
          // 沙子全糊平成色块，远处的细小凹凸也没了。开到 8 够用又不费带宽。
          for (const key of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'emissiveMap']) {
            const tex = m[key];
            if (tex && tex.anisotropy !== mapAniso) { tex.anisotropy = mapAniso; tex.needsUpdate = true; }
          }
        }
      }
      // 地图是纯静态的：关掉每帧的 matrix 自动更新，省掉 80 多次矩阵重算
      o.matrixAutoUpdate = false;
      o.updateMatrix();
      mapMeshes.push(o);
    });
    scene.add(map);
    map.updateMatrixWorld(true);
    mapBox = new THREE.Box3().setFromObject(map);
    // 太阳和阴影相机对准地图中心，然后烘一次阴影
    const cx = (mapBox.min.x + mapBox.max.x) / 2;
    const cz = (mapBox.min.z + mapBox.max.z) / 2;
    sun.target.position.set(cx, 0, cz);
    sun.target.updateMatrixWorld();
    sun.position.set(cx + 62, 132, cz + 44);
    renderer.shadowMap.needsUpdate = true;
    ground.visible = false;
    mapReady = true;
    mapDoneResolve();
    console.log('[map] de_dust2 已加载：' + mapMeshes.length + ' 个网格，缩放 ' + MAP_SCALE + 'x');
  }, undefined, (err) => {
    console.error('[map] de_dust2 加载失败，退回空地图', err);
    mapDoneResolve();
  });
}

// ---------------------------------------------------------------- 包点标记
// A / B 两块地贴：地面上一圈半透明黄线 + 中间一个大字母，从远处就能看清区域边界。
//
// 这些标记要跟着调试面板实时变（拖滑杆改位置 / 半径），所以重建必须够快：
//   · 原来每重建一次都要 new 一堆 BufferGeometry + 满地图打射线。一圈贴地采样
//     就是 96×2 + 90×4 ≈ 550 条射线，两个包点上千条；滑杆一秒几十个 input 事件
//     → 每秒几万条 raycast，页面直接卡死。
//   · 现在地面高度按 2m 网格缓存（地形是静态的，一格里取一次就够），之后只是
//     查表 + 双线性插值；顶点数固定，几何体只建一次，改位置时原地写 position。
const siteMarkers = new Map();      // site.key -> { ring, disc, letter }
const SITE_SEG = 96;                // 环带角向分段
const SITE_DN = 90, SITE_DR = 4;    // 染色盘：角向 90 段 × 径向 4 圈

// 包点标记用的地面高度场
// ---------------------------------------------------------------------------
// 为什么不用 groundHeightAt（raycast）：它一次要把地图全部 9000 多个三角形
// 过一遍，实测 3.7ms 一条射线；包点圈重建一次要上千个采样点，拖动滑杆时
// 一秒几十次 → 主线程直接堵死（就是「滑一下整个网页卡死」的原因）。
//
// 这里换个做法：把地图三角形正交投影到一张 2m 网格上，每个三角形只处理
// 一次，9000 面几毫秒烘完；之后所有采样都是数组查表 + 双线性插值（亚毫秒）。
const GL_STEP = 2;
let _hf = null;               // { ix0, iz0, nx, nz, data: Float32Array }

function bakeHeightField() {
  if (_hf || !mapMeshes.length || !mapBox) return;
  const S = GL_STEP;
  const ix0 = Math.floor(mapBox.min.x / S) - 1;
  const iz0 = Math.floor(mapBox.min.z / S) - 1;
  const nx = Math.ceil(mapBox.max.x / S) - ix0 + 2;
  const nz = Math.ceil(mapBox.max.z / S) - iz0 + 2;
  const data = new Float32Array(nx * nz).fill(-100);
  // 同一张网格再记一份「最低面」：屋顶/拱门下面的格子，最高面是屋顶，
  // 最低面才是真正能走的地板。AI 导航要用最低面，否则出生点会被判成孤岛。
  const dataLow = new Float32Array(nx * nz).fill(1e9);

  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (const mesh of mapMeshes) {
    const geo = mesh.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) continue;
    mesh.updateMatrixWorld(true);
    const pos = geo.attributes.position;
    const idx = geo.index;
    const triCount = ((idx ? idx.count : pos.count) / 3) | 0;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      A.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      B.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      C.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      // 竖直面（投影成一条线）跳过
      const den = (C.x - A.x) * (B.z - A.z) - (B.x - A.x) * (C.z - A.z);
      if (Math.abs(den) < 1e-6) continue;

      const minx = Math.min(A.x, B.x, C.x), maxx = Math.max(A.x, B.x, C.x);
      const minz = Math.min(A.z, B.z, C.z), maxz = Math.max(A.z, B.z, C.z);
      const gx0 = Math.max(0, Math.ceil((minx - ix0 * S) / S - 0.5));
      const gx1 = Math.min(nx - 1, Math.floor((maxx - ix0 * S) / S - 0.5));
      const gz0 = Math.max(0, Math.ceil((minz - iz0 * S) / S - 0.5));
      const gz1 = Math.min(nz - 1, Math.floor((maxz - iz0 * S) / S - 0.5));
      for (let gz = gz0; gz <= gz1; gz++) {
        const pz = (iz0 + gz) * S + S * 0.5;
        for (let gx = gx0; gx <= gx1; gx++) {
          const px = (ix0 + gx) * S + S * 0.5;
          // 格中心落在三角形内？（重心坐标）
          const v2x = px - A.x, v2z = pz - A.z;
          const u = (v2x * (B.z - A.z) - (B.x - A.x) * v2z) / den;   // C 的权重
          const v = ((C.x - A.x) * v2z - v2x * (C.z - A.z)) / den;   // B 的权重
          if (u < 0 || v < 0 || u + v > 1) continue;
          const y = A.y + (C.y - A.y) * u + (B.y - A.y) * v;
          const k = gz * nx + gx;
          if (y > data[k]) data[k] = y;      // 取最高面，和「从上往下打射线」一致
          if (y < dataLow[k]) dataLow[k] = y;
        }
      }
    }
  }

  // 补洞：小三角形可能盖不到格中心，用周围 3×3 的最高值填一下，
  // 否则圈在这几格会退回圆心高度，出现一小段悬空/穿地。
  const src = data.slice();
  for (let gz = 1; gz < nz - 1; gz++) {
    for (let gx = 1; gx < nx - 1; gx++) {
      const k = gz * nx + gx;
      if (src[k] > -90) continue;
      let best = -100;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = src[(gz + dz) * nx + gx + dx];
          if (v > best) best = v;
        }
      }
      if (best > -90) data[k] = best;
    }
  }

  for (let i = 0; i < dataLow.length; i++) if (dataLow[i] > 1e8) dataLow[i] = -100;
  _hf = { ix0, iz0, nx, nz, data, dataLow };
}

/** 取格 (ix,iz) 中心的地面高度；-100 = 没有数据 */
function _glCellLow(ix, iz) {
  if (!_hf) return -100;
  const gx = ix - _hf.ix0, gz = iz - _hf.iz0;
  if (gx < 0 || gx >= _hf.nx || gz < 0 || gz >= _hf.nz) return -100;
  return _hf.dataLow[gz * _hf.nx + gx];
}

/** 同一位置「最低面」的高度（屋顶下面就是地板）；查不到返回 fb */
function groundHeightLow(x, z, fb = 0) {
  const gx = x / GL_STEP - 0.5, gz = z / GL_STEP - 0.5;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const h00 = _glCellLow(ix, iz), h10 = _glCellLow(ix + 1, iz);
  const h01 = _glCellLow(ix, iz + 1), h11 = _glCellLow(ix + 1, iz + 1);
  if (h00 < -90 || h10 < -90 || h01 < -90 || h11 < -90) return fb;
  const tx = gx - ix, tz = gz - iz;
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

function _glCell(ix, iz) {
  if (!_hf) return -100;
  const gx = ix - _hf.ix0, gz = iz - _hf.iz0;
  if (gx < 0 || gx >= _hf.nx || gz < 0 || gz >= _hf.nz) return -100;
  return _hf.data[gz * _hf.nx + gx];
}

/** 双线性插值的地面高度；查不到就用 fb 兜底 */
function groundHeightFast(x, z, fb = 0) {
  const gx = x / GL_STEP - 0.5, gz = z / GL_STEP - 0.5;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const h00 = _glCell(ix, iz), h10 = _glCell(ix + 1, iz);
  const h01 = _glCell(ix, iz + 1), h11 = _glCell(ix + 1, iz + 1);
  if (h00 < -90 || h10 < -90 || h01 < -90 || h11 < -90) return fb;
  const tx = gx - ix, tz = gz - iz;
  const a = h00 + (h10 - h00) * tx;
  const b = h01 + (h11 - h01) * tx;
  return a + (b - a) * tz;
}

function makeSiteLetter(key) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.font = 'bold 96px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 7;
  g.strokeStyle = 'rgba(30, 22, 8, .38)';
  g.strokeText(key, S / 2, S / 2 + 4);
  g.fillStyle = 'rgba(236, 196, 74, .72)';
  g.fillText(key, S / 2, S / 2 + 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** 清掉所有包点标记（整个释放，只在退出/热重载这种场景用） */
function clearSiteMarkers() {
  for (const pack of siteMarkers.values()) {
    for (const o of [pack.ring, pack.disc, pack.letter]) {
      scene.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    }
  }
  siteMarkers.clear();
}

/** 建一个包点的三个物件（环带 / 染色盘 / 字母），顶点数固定，之后只改 position */
function makeSiteMarker(site) {
  // 环带：(SITE_SEG+1) × 2 个顶点，外径 = 半径，内径 = 半径 - 0.28
  const rgeo = new THREE.BufferGeometry();
  rgeo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array((SITE_SEG + 1) * 6), 3)
      .setUsage(THREE.DynamicDrawUsage));
  const ridx = [];
  for (let i = 0; i < SITE_SEG; i++) {
    const a = i * 2;
    ridx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  rgeo.setIndex(ridx);
  const ring = new THREE.Mesh(rgeo, new THREE.MeshBasicMaterial({
    color: 0xffd23c, transparent: true, opacity: 0.7,
    side: THREE.DoubleSide, depthWrite: false
  }));
  ring.renderOrder = 3;
  // 顶点是原地改的，包围球不会跟着更新，开着视锥剔除会整块消失
  ring.frustumCulled = false;
  scene.add(ring);

  // 圈里再铺一层很淡的地面染色：站在包点正中间时看不清远处的环，
  // 一脚踩进来就能从地面颜色变化知道自己已经在点里了。
  const dgeo = new THREE.BufferGeometry();
  dgeo.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array((1 + SITE_DN * SITE_DR) * 3), 3)
      .setUsage(THREE.DynamicDrawUsage));
  const didx = [];
  for (let i = 0; i < SITE_DN; i++) {
    const a = 1 + i, b = 1 + (i + 1) % SITE_DN;
    didx.push(0, b, a);
  }
  for (let r = 1; r < SITE_DR; r++) {
    const base = 1 + (r - 1) * SITE_DN, next = 1 + r * SITE_DN;
    for (let i = 0; i < SITE_DN; i++) {
      const i2 = (i + 1) % SITE_DN;
      didx.push(base + i, next + i, base + i2);
      didx.push(base + i2, next + i, next + i2);
    }
  }
  dgeo.setIndex(didx);
  const disc = new THREE.Mesh(dgeo, new THREE.MeshBasicMaterial({
    color: 0xffc832, transparent: true, opacity: 0.16,
    side: THREE.DoubleSide, depthWrite: false
  }));
  disc.renderOrder = 2;
  disc.frustumCulled = false;
  scene.add(disc);

  // 圈中间的大字母
  const letter = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 2.1),
    new THREE.MeshBasicMaterial({ map: makeSiteLetter(site.key), transparent: true, depthWrite: false })
  );
  letter.rotation.x = -Math.PI / 2;
  letter.rotation.z = Math.PI;
  letter.renderOrder = 4;
  scene.add(letter);

  const pack = { ring, disc, letter };
  siteMarkers.set(site.key, pack);
  return pack;
}

/** 把已有标记摊到新的位置 / 半径上：只写顶点，不 new 任何东西 */
function layoutSiteMarker(pack, site) {
  // 圆心高度当整体基准（高度场里查不到时退回 0，包点都在户外，正常查得到）
  const y = groundHeightFast(site.x, site.z, 0);

  // ---- 环带：沿圆周逐点采样地面，做成一圈贴地的带子 ----
  // （原来整块平放，A 点地面高低差快 1m，环有一半埋进地里根本看不见）
  const inner = Math.max(0.3, site.r - 0.28);
  const rp = pack.ring.geometry.attributes.position.array;
  let o = 0;
  for (let i = 0; i <= SITE_SEG; i++) {
    const a = i / SITE_SEG * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let k = 0; k < 2; k++) {
      const rr = k ? site.r : inner;
      const x = site.x + ca * rr, z = site.z + sa * rr;
      const g = groundHeightFast(x, z, y);
      // 夹在地面附近 ±0.5m：跨过台子/箱子时不要整圈飞起来
      rp[o++] = x;
      rp[o++] = (g > -90 ? clamp(g, y - 0.45, y + 0.5) : y) + 0.05;
      rp[o++] = z;
    }
  }
  pack.ring.geometry.attributes.position.needsUpdate = true;

  // ---- 染色盘 ----
  const dp = pack.disc.geometry.attributes.position.array;
  dp[0] = site.x; dp[1] = y + 0.03; dp[2] = site.z;
  o = 3;
  for (let r = 1; r <= SITE_DR; r++) {
    for (let i = 0; i < SITE_DN; i++) {
      const a = i / SITE_DN * Math.PI * 2;
      const rr = site.r * r / SITE_DR;
      const x = site.x + Math.cos(a) * rr, z = site.z + Math.sin(a) * rr;
      const g = groundHeightFast(x, z, y);
      dp[o++] = x;
      dp[o++] = (g > -90 ? clamp(g, y - 0.45, y + 0.5) : y) + 0.03;
      dp[o++] = z;
    }
  }
  pack.disc.geometry.attributes.position.needsUpdate = true;

  pack.letter.position.set(site.x, y + 0.07, site.z);
}

function buildSiteMarkers() {
  // 调试面板关掉时，A/B 点的黄圈、地面染色和字母一个都不画（保持原版干净的地面）
  if (!DEV.siteTuner) return;
  if (!mapMeshes.length) return;
  bakeHeightField();          // 第一次调用时烘一遍，之后全是查表
  for (const site of BOMB_SITES) {
    const pack = siteMarkers.get(site.key) || makeSiteMarker(site);
    layoutSiteMarker(pack, site);
  }
}

// 调试面板拖动时一秒几十个事件：合并到下一帧，一帧最多重建一次
let _siteRebuildRaf = 0;
function requestSiteRebuild() {
  if (!DEV.siteTuner) return;
  if (_siteRebuildRaf) return;
  _siteRebuildRaf = requestAnimationFrame(() => {
    _siteRebuildRaf = 0;
    buildSiteMarkers();
  });
}
if (DEV.siteTuner) mapDone.then(() => { buildSiteMarkers(); });

// ---------------------------------------------------------------- 碰撞
// 玩家按「圆柱体」算：半径 0.34m、身高 1.75m。
// 之前是拿一个点当玩家：贴墙时相机能钻进墙里、走到门洞下会被头顶横梁
// 顶到梁上（向下射线从脚底 +2.2m 起打，第一个交点就是梁顶）。
const PLAYER_R = 0.34;
const STEP_H = 0.48;      // 能直接迈上去的台阶高度（CS 是 18 单位 ≈ 0.46m）
const STEP_UP = 0.62;     // 自动登踏（玩家口中的「自动跳跃」）的最大高差。
                          // 原来 1.45m 等于走到大箱子/围栏边就被托上去，太离谱；
                          // 收到 0.62m 只保留台阶、马路牙、矮台沿，箱子/围栏都得自己跳。
const PLAYER_H = 1.75;

const _FOOT_OFFS = [[0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]];
const _mapRay = new THREE.Raycaster();
const _downDir = new THREE.Vector3(0, -1, 0);
const _rayFrom = new THREE.Vector3();
const _moveDir = new THREE.Vector3();
const _hitN = new THREE.Vector3();
// 弹壳落地朝向用的临时向量（复用，避免每次落地 new Vector3）
const _upY = new THREE.Vector3(0, 1, 0);
const _caseAxis = new THREE.Vector3();
// 相机防穿墙：留出比玩家碰撞半径更大的余量。
// 玩家半径 0.34m，贴墙走时相机中心离墙只有 0.34m；近裁剪面在屏幕边缘
// 还会再向外扩 ~0.12m，所以 0.16m 的旧余量根本不够，边上会露出墙外。
const CAM_CLEAR = 0.46;
let camClipNext = 0, camClipTarget = 0, camClipAmt = 0, camClipDX = 0, camClipDZ = 0;
let camScopeFwd = 0;    // AUG / SG552 开镜时相机往前探的距离（平滑）
let stepUpBudget = 1;   // 每帧登踏探测次数（撞墙时不至于打出上百条射线）
let stepUpCool = 0;     // 登踏探测失败后的冷却（秒）：顶着墙时不必每帧都探

/** 从 (x,z) 上方 fromY 处向下打，返回第一个交点高度（找不到返回 -100） */
function groundHeightAt(x, z, fromY = 200) {
  if (!mapMeshes.length) return 0;
  _rayFrom.set(x, fromY, z);
  _mapRay.set(_rayFrom, _downDir);
  _mapRay.far = fromY + 140;
  const hits = _mapRay.intersectObjects(mapMeshes, false);
  if (hits.length) return hits[0].point.y;
  // 中心射线没打中：地图网格在台阶/接缝处有细小的面片间隙，
  // 单点采样会漏 → 脚下一帧"没有地面"，人就一路掉出地图（楼梯上最常见）。
  // 往四周 0.18m 再采 4 个点，取最高的那个：只要脚下确实有面，就判为有地面。
  let best = -100;
  for (const [ox, oz] of [[0.18, 0], [-0.18, 0], [0, 0.18], [0, -0.18]]) {
    _rayFrom.set(x + ox, fromY, z + oz);
    _mapRay.set(_rayFrom, _downDir);
    _mapRay.far = fromY + 140;
    const h2 = _mapRay.intersectObjects(mapMeshes, false);
    if (h2.length && h2[0].point.y > best) best = h2[0].point.y;
  }
  return best;
}

/**
 * 脚下「能站上去」的那层地面：从脚底 + 可迈台阶高度往下打。
 * 这样站在门洞里（头顶有横梁）不会被顶到梁上；走到箱子边也不会误判成地面。
 */
function floorUnder(x, z, feetY) {
  if (!mapMeshes.length) return 0;
  _rayFrom.set(x, feetY + STEP_H + 0.04, z);
  _mapRay.set(_rayFrom, _downDir);
  _mapRay.far = STEP_H + 12;
  const hits = _mapRay.intersectObjects(mapMeshes, false);
  return hits.length ? hits[0].point.y : -100;
}

/**
 * 地图边界：模型边缘外是空的，走出去就会掉进虚空。
 * 在包围盒内缩 0.4m 处当墙（CS 里地图四周本来就有看不见的边界）。
 */
function inBounds(x, z) {
  if (!mapBox) return true;
  return x > mapBox.min.x + 0.4 && x < mapBox.max.x - 0.4 &&
         z > mapBox.min.z + 0.4 && z < mapBox.max.z - 0.4;
}

/** 脚下高差是否允许走（台阶太高就不让走；悬崖允许，会掉下去） */
let _fokKey = '', _fokVal = true;
function floorOK(x, z, feetY) {
  if (!mapMeshes.length || window.__noCollide) return true;
  // 同一帧里同一个落点会被反复询问（多个分支都调），缓存一下省射线
  const key = x + ',' + z + ',' + feetY;
  if (key === _fokKey) return _fokVal;
  _fokKey = key;
  _fokVal = _floorOK(x, z, feetY);
  return _fokVal;
}
function _floorOK(x, z, feetY) {
  if (!inBounds(x, z)) return false;
  const fy = floorUnder(x, z, feetY);
  if (fy < -90) return true;
  return fy - feetY <= STEP_H;
}

/**
 * 前方 (x,z) 相对脚底的可登踏高差。
 * 从「脚底 + 最大登踏高度」纯向下找第一个平台：那就是台阶/箱子/岩石沿的顶面。
 * 不能用 floorUnder：它的起始偏移（STEP_H+0.04）会把半米高的沿「看穿」，
 * 直接命中沿后面的地面，高差算成 0，就永远发现不了要登的台阶。
 * 返回 ≤0 表示前方是平路/下坡/高墙，不用登踏。
 */
function stepRise(x, z, feetY) {
  if (!mapMeshes.length || window.__noCollide) return 0;
  const fy = groundHeightAt(x, z, feetY + STEP_UP + 0.5);
  if (fy < -90) return 0;
  return fy - feetY;
}

/**
 * 从 (x0,z0) 朝 (x1,z1) 走，路上有没有竖立面挡着。
 * 在膝盖(0.55m)和胸口(1.25m)两个高度各打一条射线，长度 = 位移 + 玩家半径。
 * 只看竖立面（法线接近水平）—— 地面和台阶顶面不算墙。
 */
let _bmKey = '', _bmVal = false;
function blockedMove(x0, z0, x1, z1, feetY) {
  if (!mapMeshes.length || window.__noCollide) return false;
  // 贴墙时同一小段会被反复问（滑行分支 + 多个子步），命中缓存能省掉大半射线
  const k = x0 + ',' + z0 + ',' + x1 + ',' + z1 + ',' + feetY;
  if (k === _bmKey) return _bmVal;
  _bmKey = k;
  _bmVal = _blockedMove(x0, z0, x1, z1, feetY);
  return _bmVal;
}
function _blockedMove(x0, z0, x1, z1, feetY) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-5) return false;
  _moveDir.set(dx / len, 0, dz / len);
  for (const h of [0.55, 1.25]) {
    _rayFrom.set(x0, feetY + h, z0);
    _mapRay.set(_rayFrom, _moveDir);
    _mapRay.far = len + PLAYER_R;
    const hits = _mapRay.intersectObjects(mapMeshes, false);
    for (const hit of hits) {
      if (!hit.face) return true;
      _hitN.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (Math.abs(_hitN.y) < 0.72) return true;   // 竖立面 = 墙
    }
  }
  return false;
}

/** 兼容旧调用：这个点能不能站人 */
function canStandAt(x, z, feetY) {
  if (!floorOK(x, z, feetY)) return false;
  return !blockedMove(x, z, x, z, feetY);
}

// ---------------------------------------------------------------- 雷达（左上角，CS 风格）
const radarEl = document.getElementById('radar');
const radarCtx = radarEl ? radarEl.getContext('2d') : null;
let radarNextAt = 0;
/** 只画点位、不画地图：中心是玩家，队友是绿点（北向上） */
function updateRadar(now) {
  if (!radarCtx || !gameStarted) return;
  if (now < radarNextAt) return;
  radarNextAt = now + 100;          // 10fps 足够
  const S = radarEl.width, C = S / 2;
  const RANGE = 62;                  // 半径显示 62 米
  const k = (S / 2 - 12) / RANGE;
  const g = radarCtx;
  g.clearRect(0, 0, S, S);
  // 圆形雷达：画布本身裁成圆，绿底限制在圆内（外边由 CSS 圆形黑色边框收口）
  g.save();
  g.beginPath();
  g.arc(C, C, C - 1, 0, Math.PI * 2);
  g.clip();
  // 纯绿底：不要网格、不要内圈、不要十字线（用户要求只留绿底 + 黑边 + 人物定位）
  g.fillStyle = '#1d4a1f';
  g.fillRect(0, 0, S, S);

  // 队友（AI）：绿点；敌人不显示（原版雷达也只画队友）
  const px = player.pos.x, pz = player.pos.z;
  if (botMgr && botMgr.ready) {
    g.fillStyle = '#7cf07c';
    for (const b of botMgr.bots) {
      if (b.dead || b.team !== playerTeam) continue;
      const dx = (b.pos.x - px) * k, dz = (b.pos.z - pz) * k;
      if (Math.hypot(dx, dz) > S / 2 - 12) continue;
      g.beginPath(); g.arc(C + dx, C + dz, 3.2, 0, Math.PI * 2); g.fill();
    }
  }
  if (Array.isArray(window.__mates)) {
    g.fillStyle = '#7cf07c';
    for (const m of window.__mates) {
      const dx = (m.x - px) * k, dz = (m.z - pz) * k;
      if (Math.hypot(dx, dz) > S / 2 - 12) continue;
      g.beginPath(); g.arc(C + dx, C + dz, 3.2, 0, Math.PI * 2); g.fill();
    }
  }

  // 包点：A / B 两个字母（超出雷达范围就贴边显示）
  g.font = 'bold 11px monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const site of BOMB_SITES) {
    let dx = (site.x - px) * k, dz = (site.z - pz) * k;
    const dist = Math.hypot(dx, dz);
    const lim = S / 2 - 14;
    if (dist > lim) { dx = dx / dist * lim; dz = dz / dist * lim; }
    g.fillStyle = 'rgba(255, 216, 60, .92)';
    g.fillText(site.key, C + dx, C + dz);
  }
  // C4 位置
  if (bomb.phase === 'planted' || bomb.phase === 'ground') {
    let dx = (bomb.pos.x - px) * k, dz = (bomb.pos.z - pz) * k;
    const dist = Math.hypot(dx, dz);
    const lim = S / 2 - 10;
    if (dist > lim) { dx = dx / dist * lim; dz = dz / dist * lim; }
    g.fillStyle = '#ff3b2a';
    g.beginPath(); g.arc(C + dx, C + dz, 3.4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1; g.stroke();
  }

  // 玩家：中心黄色小三角，朝向 = 视线方向（北向上）
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const a = Math.atan2(fz, fx);
  g.save();
  g.translate(C, C);
  g.rotate(a);
  g.beginPath();
  g.moveTo(9, 0); g.lineTo(-6, 5.5); g.lineTo(-6, -5.5);
  g.closePath();
  g.fillStyle = '#ffe14a';
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,.65)'; g.lineWidth = 1.2; g.stroke();
  g.restore();     // 恢复玩家三角的 translate/rotate
  g.restore();     // 解除圆形裁剪
}

// ---------------------------------------------------------------- 弹孔
function makeHoleTexture() {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(18,18,20,0.95)');
  g.addColorStop(0.42, 'rgba(30,30,34,0.78)');
  g.addColorStop(0.62, 'rgba(60,60,66,0.30)');
  g.addColorStop(1, 'rgba(90,90,96,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const holeTex = makeHoleTexture();
const holeGeo = new THREE.PlaneGeometry(0.075, 0.075);
const holeMat = new THREE.MeshBasicMaterial({
  map: holeTex, transparent: true, depthWrite: false, opacity: 0.9,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
});
const holes = [];
for (let i = 0; i < 48; i++) {
  const m = new THREE.Mesh(holeGeo, holeMat);
  m.rotation.x = -Math.PI / 2;
  m.visible = false;
  m.renderOrder = 2;
  scene.add(m);
  holes.push(m);
}
let holeIdx = 0;
const _holeN = new THREE.Vector3(0, 0, 1);
const _holeQ = new THREE.Quaternion();
const _holeQ2 = new THREE.Quaternion();
const _holeUp = new THREE.Vector3(0, 0, 1);
/** 弹孔贴在命中面上：位置 = 命中点沿法线抬起一点，平面朝向 = 命中面法线。
 *  之前固定放在 y=0.008 的水平面上——地图地面高度各不相同，弹孔全浮在空中。 */
function addHole(p, n) {
  const m = holes[holeIdx % holes.length];
  holeIdx++;
  const nor = (n && n.isVector3) ? n : _holeN.set(0, 1, 0);
  m.position.set(p.x + nor.x * 0.008, p.y + nor.y * 0.008, p.z + nor.z * 0.008);
  // 平面默认面向 +Z：转到位（法线方向），再绕法线随机转个角度
  _holeQ.setFromUnitVectors(_holeUp, nor.clone().normalize());
  _holeQ2.setFromAxisAngle(nor.clone().normalize(), Math.random() * Math.PI * 2);
  m.quaternion.copy(_holeQ2.multiply(_holeQ));
  const s = 0.8 + Math.random() * 0.6;
  m.scale.set(s, s, s);
  m.visible = true;
}

// ---------------------------------------------------------------- 弹着点粒子
// 子弹打墙：先是一个很短的白色火花点，再溅出一小撮灰尘 + 几颗火星。
// 全部复用爆炸那套 sprite 池（grenadeEffects），不额外建几何体。
const _hitN2 = new THREE.Vector3();
function impactFx(p, n, kind = 'wall') {
  if (!p) return;
  initFxTextures();
  const nor = (n && n.isVector3) ? _hitN2.copy(n).normalize() : _hitN2.set(0, 1, 0);
  // 命中闪光
  const fl = sprite(TEX.glow, 0xfff1c4, THREE.AdditiveBlending);
  fl.position.copy(p).addScaledVector(nor, 0.02);
  fl.scale.setScalar(0.21);
  fl.material.opacity = 0.9;
  grenadeEffects.push({ kind: 'fire', s: fl, t: 0, dur: 0.09, from: 0.21, to: 0.03, a0: 0.95, rise: 0 });
  // 灰尘：沿法线喷出，受重力下落一点
  const dustN = kind === 'metal' ? 3 : 5;
  for (let i = 0; i < dustN; i++) {
    const sm = sprite(TEX.smoke, kind === 'metal' ? 0x9aa0a6 : 0xcbb896);
    sm.position.copy(p).addScaledVector(nor, 0.03 + Math.random() * 0.04);
    const a = Math.random() * Math.PI * 2;
    const sp = 0.35 + Math.random() * 0.8;
    grenadeEffects.push({
      kind: 'puff', s: sm, t: -Math.random() * 0.03, dur: 0.35 + Math.random() * 0.35,
      from: 0.06 + Math.random() * 0.05, to: 0.30 + Math.random() * 0.22,
      a0: 0.38 + Math.random() * 0.22, rise: 0.25,
      drift: 0.1
    });
    sm.position.x += Math.cos(a) * 0.02 * sp;
    sm.position.z += Math.sin(a) * 0.02 * sp;
  }
  // 火星：2~4 颗，弹开后落下
  const sparks = 3 + ((Math.random() * 3) | 0);
  for (let i = 0; i < sparks; i++) {
    const sp = sprite(TEX.spark, 0xffd27a, THREE.AdditiveBlending);
    sp.position.copy(p).addScaledVector(nor, 0.02);
    sp.scale.setScalar(0.035 + Math.random() * 0.035);
    const vx = (Math.random() - 0.5) * 2.4 + nor.x * 1.4;
    const vy = Math.random() * 1.8 + 0.4 + nor.y * 1.2;
    const vz = (Math.random() - 0.5) * 2.4 + nor.z * 1.4;
    grenadeEffects.push({
      kind: 'spark', s: sp, t: 0, dur: 0.22 + Math.random() * 0.25,
      vel: new THREE.Vector3(vx, vy, vz), a0: 0.9
    });
  }
}

// ---------------------------------------------------------------- 玩家
const player = {
  pos: new THREE.Vector3(0, 0, 0),
  vel: new THREE.Vector3(),
  yaw: 0,
  pitch: 0,
  eye: 1.62,
  crouch: false,
  onGround: true,
  bobPhase: 0,
  bobAmt: 0,
  stepPhase: -1,      // 上一次落地的步序号（bobPhase 每过 π 是一步）
  lastStepSfx: 0,     // 脚步声上次播放的时间戳，防止卡顿时连响
  // ---- CS 1.6 式玩家状态 ----
  health: 100,
  armor: 0,
  money: 18000,       // 开局金额
  dead: false,
  defuseKit: false,   // 拆弹钳（CT 装备，拆包 10s → 5s）
  respawnAt: 0        // 阵亡时刻 + 3s = 重生时刻
};
const input = {
  forward: 0, right: 0,
  firing: false, fireQueued: false,
  walk: false,
  crouch: false,      // 手机上的蹲是开关，键盘是按住 Ctrl
  use: false,         // 手机上的「下包 / 拆弹」按住
  sens: 1.0
};

// ---------------------------------------------------------------- CS 1.6 式后坐力
// CS 里开枪不是简单地“把视角往上推一点”，而是往视角上叠加一个 punchangle：
// 命中瞬间硬上抬（1 帧到位），之后按指数衰减回正；连发时每一发按弹道表取值，
// 所以前几发几乎笔直上抬，后面开始左右摆。视角真正被改变了，因此子弹也跟着走。
const punch = { p: 0, y: 0 };
// 爆炸震屏（独立于后坐力，衰减更快）
const shake = { amp: 0, t: 0, seed: Math.random() * 10 };
function addShake(amount = 1, dur = 0.5) {
  shake.amp = Math.max(shake.amp, amount);
  shake.t = Math.max(shake.t, dur);
}
let sprayCount = 0;
let sprayLast = 0;
const SPRAY_RESET = 0.32;   // 停火多久后重新从第一发开始算

// AWP 开镜：0=无，1/2=两级倍率
let zoomLevel = 0;
let zoomTargetFov = FOV;
// 开火退镜后，等拉拴动作播完要自动回到的镜位
let pendingZoom = 0;

// ---------------------------------------------------------------- 音频 / 武器
const audio = new AudioEngine();
// AI / 世界音源的听者：相机位置 + 右向量（用于左右声像）
const _audioRight = new THREE.Vector3();
audio.listener = () => ({ pos: camera.position, right: _audioRight.setFromMatrixColumn(camera.matrixWorld, 0) });
let weapons = null;
let botMgr = null;          // AI 系统（地图就绪后创建）

const ui = {
  loader: document.getElementById('loader'),
  barFill: document.getElementById('barFill'),
  loadText: document.getElementById('loadText'),
  menu: document.getElementById('menu'),
  menuTip: document.getElementById('menuTip'),
  btnStart: document.getElementById('btnStart'),
  sens: document.getElementById('sens'),
  sensVal: document.getElementById('sensVal'),
  crosshair: document.getElementById('crosshair'),
  hitmark: document.getElementById('hitmark'),
  scope: document.getElementById('scope'),
  bZoom: document.getElementById('bZoom'),
  wname: document.getElementById('wname'),
  mag: document.getElementById('mag'),
  res: document.getElementById('res'),
  ammoBox: document.getElementById('ammoBox'),
  slots: document.getElementById('slots'),
  hint: document.getElementById('hint'),
  mobile: document.getElementById('mobile'),
  bSil: document.getElementById('bSil'),
  bBurst: document.getElementById('bBurst'),
  flash: document.getElementById('flash'),
  bCrouch: document.getElementById('bCrouch'),
  // ---- HUD：血量/护甲/金钱/计时/信息 ----
  vitals: document.getElementById('vitals'),
  hpNum: document.getElementById('hpNum'),
  apNum: document.getElementById('apNum'),
  moneyNum: document.getElementById('moneyNum'),
  tClock: document.getElementById('tClock'),
  tTeam: document.getElementById('tTeam'),
  feed: document.getElementById('feed'),
  dmgDir: document.getElementById('dmgDir'),
  hurt: document.getElementById('hurt'),
  death: document.getElementById('death'),
  dCause: document.getElementById('dCause'),
  dCount: document.getElementById('dCount'),
  // ---- 购买菜单 ----
  buyMenu: document.getElementById('buyMenu'),
  bmCats: document.getElementById('bmCats'),
  bmItems: document.getElementById('bmItems'),
  bmMoney: document.getElementById('bmMoney'),
  bmClose: document.getElementById('bmClose'),
  hint: document.getElementById('hint'),
  bBuy: document.getElementById('bBuy'),
  // ---- C4 ----
  bombInfo: document.getElementById('bombInfo'),
  bombInfoTxt: document.getElementById('bombInfoTxt'),
  bombWarn: document.getElementById('bombWarn'),
  actBar: document.getElementById('actBar'),
  abText: document.getElementById('abText'),
  abTime: document.getElementById('abTime'),
  abFill: document.getElementById('abFill'),
  bUse: document.getElementById('bUse'),
  roundEnd: document.getElementById('roundEnd'),
  reTitle: document.getElementById('reTitle'),
  reSub: document.getElementById('reSub'),
};

let playerTeam = null;
// 已拥有的武器（CS：只有买过的枪才会出现在武器栏里）。刀和初始手枪永远有。
const owned = new Set(['knife']);
function renderSlots() {
  // 原版槽位顺序：主武器 → 副武器 → 刀 → 投掷物 → C4
  const order = { primary: 0, secondary: 1, melee: 2, grenade: 3, c4: 4 };
  const list = WEAPONS.filter(w => {
    // C4 不是「武器」，但身上真的有包时要占一格（没有包就不显示）——
    // 其它 hidden 武器（纯数据/预留）继续不进物品栏
    if (w.hidden && !(w.kind === 'c4' && owned.has(w.id))) return false;
    // 本阵营武器，或者从地上捡到的敌阵营武器（捡到就能用、也要能切回来）
    if (playerTeam && w.teams && w.teams.length && !w.teams.includes(playerTeam) && !owned.has(w.id)) return false;
    if (w.kind === 'grenade') {
      // 手雷：买了才会出现在武器栏（颗数 > 0）
      const wobj = weapons && weapons.weapons.find(x => x.def.id === w.id);
      return wobj && wobj.ammo > 0;
    }
    return owned.has(w.id);
  }).sort((a, b) => (order[catOf(a)] ?? 9) - (order[catOf(b)] ?? 9));
  let html = list.map(w => {
    const key = w.kind === 'c4' ? 'X' : (w.slot === 10 ? 0 : w.slot);
    return `<div class="slot" data-slot="${w.slot}" title="${w.name} · 按 ${key}">${w.short}</div>`;
  }).join('');
  ui.slots.innerHTML = html;
  // 当前武器的高亮跟着刷新（重建 DOM 会把 active 类清掉）
  const cur = weapons && weapons.current;
  if (cur) {
    [...ui.slots.children].forEach(el => {
      el.classList.toggle('active', +el.dataset.slot === cur.def.slot);
    });
  }
}
renderSlots();

/** 重置所有武器的弹药：拥有的满配，没有的/手雷清空 */
function resetAmmo() {
  if (!weapons) return;
  for (const w of weapons.weapons) {
    if (w.def.kind === 'grenade') { w.ammo = 0; w.reserve = 0; }
    else if (owned.has(w.def.id)) { w.ammo = w.def.magSize; w.reserve = w.def.reserve; }
    else { w.ammo = 0; w.reserve = 0; }
  }
}

// 双方出生点（de_dust2，对齐原版站位）：
//  T：台地南段、去中门下坡路的正前方（下坡实测 x -46..-41 可一路走到低地），
//     yaw 0 朝北正对下坡；CT：A 包点旁坡道下面的隧道里（桥洞通道），
//     yaw 180；under: true 表示出生点在顶板下方，找地面要从顶板底下找。
const TEAM_SPAWN_BASE = {
  // T：台地前沿正对北边的下坡路（r66 的位置，按用户要求回退）
  t:  { x: -32.52, z: 10.69,  yaw: 0 },
  ct: { x: 2.66,   z: -46.55, yaw: 180, under: true },
};

/** 算出某阵营在世界里的出生点（含地面高度） */
function spawnPoint(team) {
  const b = TEAM_SPAWN_BASE[team];
  if (!b) return null;
  const x = MAP_CENTER.x + (b.x - MAP_CENTER.x) * MAP_SCALE;
  const z = MAP_CENTER.z + (b.z - MAP_CENTER.z) * MAP_SCALE;
  let gy = groundHeightAt(x, z, 260);
  if (b.under) {
    // 隧道/桥洞出生点：高空射线命中的是顶板，往顶板底下再找一层才是地面
    const top = gy;
    gy = top > -90 ? groundHeightAt(x, z, top - 0.1) : -90;
  }
  return { x, y: (gy > -90 ? gy : 0) + 0.06, z, yaw: b.yaw };
}

/** 选定阵营：传送、过滤武器栏、换成该阵营的出生手枪 */
function applyTeam(team) {
  playerTeam = team;
  if (weapons) weapons.setTeam(team);
  const sp = spawnPoint(team);
  if (sp) {
    player.pos.set(sp.x, sp.y, sp.z);
    player.vel.set(0, 0, 0);
    player.yaw = sp.yaw * DEG;
    player.pitch = 0;
  }
  // 开局只带刀 + 本阵营初始手枪，钱 $800
  owned.clear();
  owned.add('knife');
  const startId = team === 't' ? 'glock18' : 'usp';
  owned.add(startId);
  player.money = 18000;
  player.health = 100;
  player.armor = 0;
  player.dead = false;
  player.defuseKit = false;
  resetAmmo();
  renderSlots();
  preloadWorldGuns();          // 后台预热 14 把丢地图模型（防止丢枪时只有低模）
  const idx = WEAPONS.findIndex(w => w.id === startId);
  if (idx >= 0 && weapons) weapons.equip(idx, { instant: true });
  if (ui.tTeam) {
    ui.tTeam.textContent = team === 't' ? 'T 恐怖分子' : 'CT 反恐精英';
    ui.tTeam.className = team === 't' ? 't' : 'ct';
  }
  startRound();              // 进场即开局：3 秒准备 → 15 分钟倒数
  refreshVitals(true);
  const tp = document.getElementById('teamPick');
  if (tp) tp.classList.remove('on');
}
window.__applyTeam = applyTeam;
window.__vitals = () => ({ health: player.health, armor: player.armor, money: player.money, dead: player.dead, owned: [...owned], team: playerTeam });
window.__buy = (id) => buyItem(id);
window.__money = (n) => { player.money = Math.max(0, n|0); refreshVitals(); return player.money; };
window.__openBuy = () => openBuy();
window.__closeBuy = () => closeBuy();
window.__damage = (n, x, z, cause) => damagePlayer(n, x, z, cause || '测试');
window.__kill = (cause) => killPlayer(cause || '测试');
window.__resetRound = () => resetRound();
window.__dropped = () => DROPPED.map(d => ({ id: d.id, p: d.mesh.position.toArray().map(n => +n.toFixed(2)), rest: d.rest, rot: d.mesh.rotation.y.toFixed(2), low: !!d.low, model: !!d.model }));
window.__drop = () => dropCurrentWeapon();
window.__dropId = (id) => dropWeaponWorld(id);
// 截图/调试用：在指定世界坐标直接摆一把平躺的掉落枪
window.__dropAt = (id, x, z, yawDeg = 0) => {
  const def = WEAPON_BY_ID[id];
  if (!def || def.kind === 'melee' || def.kind === 'grenade') return false;
  const mesh = buildDropMesh(id);
  const y = groundHeightAt(x, z, 160);
  if (y < -90) return false;
  mesh.position.set(x, y + 0.045, z);
  mesh.rotation.set(0, yawDeg * DEG, 0);
  scene.add(mesh);
  const d = {
    mesh, vel: new THREE.Vector3(), rest: true, t: 0, life: 9999, id,
    model: true, low: !WGEN_W.has(id), groundY: y,
    ammo: def.magSize, reserve: def.reserve     // 调试摆的枪按满弹算
  };
  DROPPED.push(d);
  upgradeDrop(d, id, 0);
  return [x, +y.toFixed(2), z];
};
window.__holes = () => holes.filter(h => h.visible).map(h => ({ p: h.position.toArray().map(n => +n.toFixed(2)), q: h.quaternion.toArray().map(n => +n.toFixed(2)) }));
window.__wbox = (id) => loadWorldGun(id).then(s => {
  if (!s) return 'no-model';
  const box = new THREE.Box3().setFromObject(s);
  const size = box.getSize(new THREE.Vector3()).toArray().map(n => +n.toFixed(3));
  const center = box.getCenter(new THREE.Vector3()).toArray().map(n => +n.toFixed(3));
  return { ry: s.children[0] ? +s.children[0].rotation.y.toFixed(3) : null,
           q: s.children[0] ? s.children[0].quaternion.toArray().map(v => +v.toFixed(3)) : null,
           ex: s.children[0] ? new THREE.Vector3(1,0,0).applyQuaternion(s.children[0].quaternion).toArray().map(v=>+v.toFixed(2)) : null,
           size, center, children: s.children.length, skinned: s.getObjectByProperty('isSkinnedMesh', true) ? true : false };
});
window.__feedKill = (a, b, c, m) => feedKill(a, b, c, m);

// 物品栏：点一下就切到对应武器。
// 用 pointerdown 而不是 click —— 手机上「一根手指压着屏幕转视角、另一根手指点物品栏」时，
// click 要等抬手才合成（有些浏览器甚至直接不派发），表现就是「点了没反应 / 很迟钝」。
function slotPick(e) {
  const el = e.target.closest && e.target.closest('.slot');
  if (!el || !weapons || !el.dataset.slot) return;
  if (e.cancelable) e.preventDefault();
  e.stopPropagation();
  const slot = +el.dataset.slot;
  if (weapons.current && weapons.current.def.slot === slot) return;
  weapons.switchToSlot(slot);
}
ui.slots.addEventListener('pointerdown', slotPick);
ui.slots.addEventListener('touchstart', slotPick, { passive: false });

// ---------------------------------------------------------------- 加载模型
const loader = new GLTFLoader();
const progressMap = new Map();

function loadAll() {
  let done = 0;
  return Promise.all(WEAPONS.map(def => new Promise((resolve, reject) => {
    const finish = (gltf, donor, alts) => {
      progressMap.set(def.id, 1);
      done++;
      updateProgress();
      resolve({ def, gltf, donor, alts });
    };
    // 阵营变体（目前只有 mac10t：CT 捡到时换双手模型）：主模型读完再补读变体模型
    const afterMain = (gltf, donor) => {
      const tv = def.teamVariant;
      if (!tv) { finish(gltf, donor); return; }
      const teams = Object.keys(tv);
      const alts = {};
      let left = teams.length;
      const one = (team, g) => {
        alts[team] = g;
        if (--left === 0) finish(gltf, donor, alts);
      };
      for (const team of teams) {
        const m = tv[team] && tv[team].model;
        if (!m) { one(team, null); continue; }
        loader.load(`./assets/models/${m}.glb?v=r90`,
          g => one(team, g),
          undefined,
          err => reject(err));
      }
    };
    loader.load(`./assets/models/${def.model}.glb`,
      gltf => {
        const graft = def.fix && def.fix.graftArms;
        if (!graft) { afterMain(gltf); return; }
        // 手臂移植：再读一份供体模型（浏览器缓存里已有，不会重复下载）
        loader.load(`./assets/models/${graft.from}.glb`,
          donor => afterMain(gltf, donor),
          undefined,
          err => reject(err));
      },
      evt => {
        if (evt && evt.total) progressMap.set(def.id, evt.loaded / evt.total);
        else progressMap.set(def.id, Math.min(0.95, (evt.loaded || 0) / 2200000));
        updateProgress();
      },
      err => reject(err)
    );
  })));
}

function updateProgress() {
  let sum = 0;
  for (const def of WEAPONS) sum += progressMap.get(def.id) || 0;
  const p = Math.min(1, sum / WEAPONS.length);
  setLoadProgress(p * 0.55, `正在载入武器模型… ${Math.round(p * 100)}%`);
}

/** 统一的加载进度（0~1），加载页会把所有素材都过一遍 */
function setLoadProgress(p, text) {
  const pc = Math.max(0, Math.min(1, p));
  ui.barFill.style.width = (pc * 100).toFixed(1) + '%';
  if (text) ui.loadText.textContent = text;
}

/** 预载全部地面枪模型（丢枪用的 w_ 系列） */
async function preloadAllWorldGuns() {
  const ids = [...WGEN_W];
  let done = 0;
  for (const id of ids) {
    try { await loadWorldGun(id); } catch (e) { /* 单把失败不影响整体 */ }
    done++;
    setLoadProgress(0.55 + 0.15 * (done / ids.length), `正在载入地面模型… ${done}/${ids.length}`);
  }
}

// ---------------------------------------------------------------- AI 接口
/** AI 的视线检测：一条射线打到地图就算被挡 */
function rayBlocked(from, dir, far) {
  raycaster.set(from, dir);
  raycaster.far = Math.max(0.2, far);
  const hits = raycaster.intersectObjects(mapMeshes.length ? mapMeshes : [ground], false);
  for (const h of hits) {
    if (h.distance <= 0.12) continue;            // 起点贴墙
    if (h.face) {
      _hitN.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (Math.abs(_hitN.y) > 0.9) continue;     // 地板/台阶顶不算遮挡
    }
    return true;
  }
  return false;
}

/** AI 扔出去的手雷：直接进 projectiles 队列，物理/爆炸和玩家的完全同一条路径 */
function spawnBotGrenade(def, from, to) {
  const g = def.grenade;
  if (!g) return;
  const pos = from.clone();
  const dx = to.x - pos.x, dz = to.z - pos.z;
  const dist = Math.max(1, Math.hypot(dx, dz));
  const t = clamp(dist / (g.speed || 14), 0.55, 2.6);
  const vy = (to.y + 0.25 - pos.y) / t + 0.5 * 9.8 * t;

  const group = new THREE.Group();
  group.add(new THREE.Mesh(G_SPHERE, G_MATS[g.type] || G_MATS.he));
  group.position.copy(pos);
  scene.add(group);

  projectiles.push({
    mesh: group,
    vel: new THREE.Vector3(dx / t, vy, dz / t),
    def, w: null,
    spin: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10),
    radius: 0.085,
    expireAt: performance.now() / 1000 + g.fuse,
  });
}

/** 人物模型 / 世界枪模型缓存（给 AI 挂手用） */
const GUN_CACHE = new Map();
function gunModel(id) {
  return GUN_CACHE.get(id) || null;
}

function initBots() {
  botMgr = new BotManager({
    scene, loader, audio, camera,
    mapMeshes, mapBox,
    groundHeightAt, groundHeightFast, groundHeightLow, blockedMove, floorOK, inBounds,
    player, BOMB_SITES, bomb,
    playerTeam: () => playerTeam,
    playerDead: () => player.dead || !gameStarted,
    spawnPoint,
    weaponById: (id) => WEAPON_BY_ID[id] || null,
    damagePlayer,
    bombSiteAt, plantBombAt, defuseBomb,
    loadGun: (id) => loadWorldGun(id),
    gunModel,
    rayBlocked,
    spawnBotGrenade,
    onKill: (bot, cause) => {
      // 击杀提示：只有玩家相关的才播
      if (bot.isPlayer) return;
      if (playerTeam && bot.team !== playerTeam) feedKill('你', bot.name, 'AI');
    },
    hitFx: () => {},
    muzzleFx: () => {},
    tracer: () => {},
  });
  // 世界枪模型（挂手用）：复用手上掉落的同一份，clone 出去
  const origLoad = loadWorldGun;
  botMgr.api.loadGun = (id) => origLoad(id).then(g => {
    if (g && !GUN_CACHE.has(id)) GUN_CACHE.set(id, g);
    return g;
  });
  window.__botMgr = botMgr;
  return botMgr.load(loader, () => {});
}

function boot() {
  // 先把本机保存的调参结果套回配置，再创建武器
  applySavedTuning(WEAPONS);
  // 调试：?pose=reload 指定待机基础姿态来源
  if (DEBUG && qs.get('pose')) {
    const d = WEAPON_BY_ID[qs.get('w') || 'mp5'];
    if (d) { d.view = d.view || {}; d.view.poseFrom = qs.get('pose'); }
  }
  loadAll().then(async list => {
    weapons = new WeaponSystem({
      viewScene,
      viewCamera,
      audio,
      onEvent: (type, data) => {
        if (type === 'equip') { exitZoom(); pendingZoom = 0; burst.left = 0; refreshHUD(true); }
        if (type === 'actionEnd') {
          refreshHUD();
          // AWP：射击（含拉拴）动作播完，自动回到开镜状态
          const w = data && data.weapon;
          if (w && w.def.zoom && w.def.anims.fire && isFireAnim(w, data.name)) {
            restoreZoomAfterBolt(w);
          }
        }
        if (type === 'reloadStart') {
          const rw = data && data.weapon;
          // AUG / SG552：换弹自动退镜，但记住镜位，换完自动回镜
          pendingZoom = (zoomLevel > 0 && rw && rw.def.kind === 'rifle') ? zoomLevel : 0;
          exitZoom();
          refreshHUD();
        }
        if (type === 'reloadShell') refreshHUD(true);
        if (type === 'silencer') refreshHUD(true);
        if (type === 'reloadEnd') {
          refreshHUD(true);
          const rw = data && data.weapon;
          if (rw && rw.def.kind === 'rifle' && pendingZoom) {
            setTimeout(() => restoreZoomAfterBolt(rw), 0);
          }
        }
      }
    });
    // 切枪只切物品栏里有的枪（数字键 / [ ] / Q / 手机切换按钮都走这套过滤）
    weapons.owned = owned;
    for (const { def, gltf, donor, alts } of list) {
      const w = weapons.add(def, gltf, donor);
      // 抛壳：视图空间的抛壳口位置 → 世界里的实体弹壳
      w.onCasing = (viewPos, def) => spawnCasing(viewPos, caseTypeOf(def), def);
      // 手雷：把视模型里的弹体/顶盖/拉环烘焙成投掷用的静态模型
      if (def.grenade) w.projectile = w.buildProjectile();
      // 阵营变体：同一把枪在不同阵营下换模型（MAC-10 的 T 方单手版）
      if (alts) {
        for (const [team, g] of Object.entries(alts)) {
          if (!g) continue;
          const v = weapons.addVariant(w, team, g);
          v.onCasing = w.onCasing;
        }
      }
    }
    weapons.setTeam(playerTeam);
    precompileWorldFx();
    onResize();
    const wantId = qs.get('w');
    let startIdx = 0;
    if (wantId) {
      const i = WEAPONS.findIndex(x => x.id === wantId);
      if (i >= 0) startIdx = i;
    }
    weapons.equip(startIdx, { instant: true });

    // 武器位置调参面板：右上角按钮 / P 键 / ?tune 自动打开
    // 开关在 config.js 的 DEV.tuner（0 关 / 1 开），平时关掉，需要时再打开。
    const tuner = DEV.tuner ? initTuner({
      weapons,
      viewCamera,
      onToggle: (on) => {
        ejectMarkerVisible = !!on;
        if (on) {
          input.firing = false;
          dragging = false;
        } else if (gameStarted && !IS_TOUCH) {
          // 关掉面板后直接回到锁定状态，省一次点击
          tryLock();
        }
      }
    }) : null;
    if (tuner) {
      window.__tuner = tuner;
      if (qs.has('tune')) tuner.open();
    } else {
      // 关掉调参面板时，右上角按钮和 P 键也一起隐藏
      const tb = document.getElementById('tuneBtn');
      if (tb) tb.style.display = 'none';
    }

    // 包点现场调试：独立按钮（在「调参」按钮正上方），开关 DEV.siteTuner（0 / 1）。
    // 改 x / z / r 会立刻重建地面上的黄圈，并同时改掉下包判定用的半径。
    const siteTuner = DEV.siteTuner ? initSiteTuner({
      onChanged: () => requestSiteRebuild(),
      teleport: (x, z) => {
        const gy = groundHeightAt(x, z, 160);
        player.pos.set(x, (gy > -90 ? gy : 0) + 0.06, z);
        player.vel.set(0, 0, 0);
      },
      getPlayer: () => ({ x: player.pos.x, z: player.pos.z }),
      onToggle: (on) => { if (on) { input.firing = false; } },
    }) : null;
    if (siteTuner) {
      window.__siteTuner = siteTuner;
      // 调试用：量重建耗时（只在 ?w= / ?tune 下注册）
      if (DEBUG) {
        window.__siteRebuildMs = (n = 1) => {
          const t0 = performance.now();
          for (let i = 0; i < n; i++) buildSiteMarkers();
          return +((performance.now() - t0) / n).toFixed(3);
        };
      }
      if (qs.has('sites')) siteTuner.open();
    } else {
      const sb = document.getElementById('siteBtn');
      if (sb) sb.style.display = 'none';
    }

    // ★ 加载页把剩下的素材也一次加载完：地图 + 地面枪模型 + 全部音效
    setLoadProgress(0.56, '正在等待地图…');
    await mapDone;
    await preloadAllWorldGuns();
    setLoadProgress(0.62, '正在载入人物模型…');
    await initBots();
    setLoadProgress(0.66, '正在载入音效…');
    try { audio.init(); } catch (e) { /* 没有音频设备也不能卡住加载 */ }
    if (!qs.has('fast')) {
      await audio.preloadAll((d, t) => setLoadProgress(0.70 + 0.29 * (d / t), `正在载入音效… ${d}/${t}`));
    }
    setLoadProgress(1, '载入完成');

    ui.loader.classList.add('done');
    setTimeout(() => ui.loader.style.display = 'none', 500);

    // ---- 阵营选择 ----
    const tpEl = document.getElementById('teamPick');
    if (tpEl) {
      tpEl.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-team]');
        if (!btn) return;
        e.stopPropagation();
        applyTeam(btn.dataset.team);
        input.firing = false;
        startGame(false);          // 选完阵营立刻进游戏
      });
    }
    const qsTeam = qs.get('team');
    if (qsTeam === 't' || qsTeam === 'ct') applyTeam(qsTeam);
    else if (tpEl) tpEl.classList.remove('on');   // 等点「开始游戏」再弹

    if (qs.has('auto')) {
      startGame(true);
    } else {
      ui.menu.classList.remove('hidden');
      if (!pendingStart) ui.btnStart.textContent = '开始游戏';
    }
    window.__ready = true;
    if (!qs.has('auto') && pendingStart) {
      pendingStart = false;
      requestStart();               // 加载中提前点过「开始」：就绪后自动继续
    }
  }).catch(err => {
    console.error(err);
    ui.loadText.textContent = '模型加载失败：' + (err && err.message ? err.message : err);
  });
}

// ---------------------------------------------------------------- HUD
const isFireAnim = (w, name) => {
  const f = w.def.anims && w.def.anims.fire;
  if (!f) return false;
  return Array.isArray(f) ? f.includes(name) : f === name;
};

let lastHud = '';
function refreshHUD(force) {
  const w = weapons && weapons.current;
  if (!w) return;
  const key = w.def.id + '|' + w.ammo + '|' + w.reserve + '|' + w.state;
  if (!force && key === lastHud) return;
  lastHud = key;
  ui.wname.textContent = w.def.name + (w.silenced ? ' · 消音' : '') + (w.def.burst && w.burstMode ? ' · 三连发' : '');
  if (w.def.kind === 'melee' || w.def.kind === 'c4') {
    ui.mag.textContent = '—';
    ui.res.textContent = '';
    ui.ammoBox.classList.remove('low');
  } else if (w.def.kind === 'grenade') {
    // 手雷只显示剩余颗数
    ui.mag.textContent = w.ammo;
    ui.res.textContent = '';
    ui.ammoBox.classList.toggle('low', w.ammo <= 0);
  } else {
    ui.mag.textContent = w.ammo;
    ui.res.textContent = '/ ' + w.reserve;
    ui.ammoBox.classList.toggle('low', w.ammo <= Math.max(1, Math.floor(w.def.magSize * 0.25)));
  }
  [...ui.slots.children].forEach(el => {
    el.classList.toggle('active', +el.dataset.slot === w.def.slot);
  });
  if (ui.bZoom) {
    const can = !!w.def.zoom;
    ui.bZoom.style.display = can ? '' : 'none';
    ui.bZoom.classList.toggle('off', can && zoomLevel === 0);
  }
  if (ui.bSil) {
    const can = !!w.def.silencer;
    ui.bSil.classList.toggle('hide', !can);
    ui.bSil.classList.toggle('on', can && !!w.silenced);
  }
  if (ui.bBurst) {
    const can = !!w.def.burst;
    ui.bBurst.classList.toggle('hide', !can);
    ui.bBurst.classList.toggle('on', can && !!w.burstMode);
  }
}

// ---------------------------------------------------------------- 血量 / 护甲 / 金钱
let lastVitals = '';
function refreshVitals(force) {
  const key = Math.ceil(player.health) + '|' + Math.ceil(player.armor) + '|' + player.money;
  if (!force && key === lastVitals) return;
  lastVitals = key;
  if (ui.hpNum) ui.hpNum.textContent = Math.max(0, Math.ceil(player.health));
  if (ui.apNum) ui.apNum.textContent = Math.max(0, Math.ceil(player.armor));
  if (ui.moneyNum) ui.moneyNum.textContent = player.money;
  if (ui.bmMoney) ui.bmMoney.textContent = player.money;
  if (ui.vitals) ui.vitals.classList.toggle('low', player.health <= 35);
  // 低血量常驻红晕；高于 35 血且没有受击脉冲时撤掉
  if (ui.hurt) {
    const low = player.health > 0 && player.health <= 35 && gameStarted;
    ui.hurt.classList.toggle('low', low);
    if (!low && !ui.hurt.classList.contains('pulse')) ui.hurt.style.opacity = '0';
  }
}

/** 右上角击杀信息（CS 1.6 的死亡通知） */
function feedKill(killer, victim, weaponName, mine = false) {
  if (!ui.feed) return;
  const row = document.createElement('div');
  row.className = 'feed-row' + (mine ? ' mine' : '');
  row.innerHTML = `<span class="fk">${killer}</span><span class="fw">${weaponName}</span><span class="fv">${victim}</span>`;
  ui.feed.appendChild(row);
  while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
  setTimeout(() => { row.classList.add('out'); setTimeout(() => row.remove(), 320); }, 4500);
}

// ---------------------------------------------------------------- 伤害 / 阵亡 / 重生
const dmgFwd = new THREE.Vector3();
const dmgRight = new THREE.Vector3();
const dmgTo = new THREE.Vector3();

/** 受击：护甲吸收一半，血量掉完就阵亡 */
function damagePlayer(amount, fromX, fromZ, cause = '世界') {
  if (player.dead || !gameStarted || amount <= 0) return;
  let dmg = amount;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, dmg);
    dmg = Math.max(1, dmg - absorbed * 0.5);   // 护甲减半
    player.armor -= absorbed;
  }
  player.health -= dmg;
  refreshVitals();
  // 受击脉冲 + 方向指示
  if (ui.hurt) {
    ui.hurt.classList.remove('pulse');
    void ui.hurt.offsetWidth;
    ui.hurt.classList.add('pulse');
    setTimeout(() => ui.hurt && ui.hurt.classList.remove('pulse'), 520);
  }
  if (fromX !== undefined) showDmgDir(fromX, fromZ);
  if (player.health <= 0) killPlayer(cause);
}

/** 方向指示：把红弧转到「伤害来源相对视角」的方向 */
function showDmgDir(x, z) {
  if (!ui.dmgDir) return;
  camera.getWorldDirection(dmgFwd);
  dmgFwd.y = 0;
  if (dmgFwd.lengthSq() < 1e-6) return;
  dmgFwd.normalize();
  dmgTo.set(x - player.pos.x, 0, z - player.pos.z);
  if (dmgTo.lengthSq() < 1e-6) return;
  dmgTo.normalize();
  dmgRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  dmgRight.y = 0;
  dmgRight.normalize();
  const ang = Math.atan2(dmgTo.dot(dmgRight), dmgTo.dot(dmgFwd));  // 0=正前，正=右侧
  ui.dmgDir.style.transform = `rotate(${ang.toFixed(3)}rad)`;
  ui.dmgDir.classList.remove('show');
  void ui.dmgDir.offsetWidth;
  ui.dmgDir.classList.add('show');
}

/** 阵亡：冻结操作，3 秒后重生（钱保留，枪全丢） */
function killPlayer(cause) {
  if (player.dead) return;
  player.dead = true;
  player.health = 0;
  player.vel.set(0, 0, 0);
  input.firing = false;
  input.fireQueued = false;
  keys.clear();
  refreshVitals(true);
  feedKill('世界', '你', cause, true);
  if (ui.dCause) ui.dCause.textContent = cause;
  if (ui.death) ui.death.classList.remove('hidden');
  player.respawnAt = performance.now() + 3000;
}

/**
 * 重生：回出生点、满血、钱保留。
 *
 * opts.keep = true  → 保留上一局的家当：武器列表、每把枪的弹药、手上正拿的枪、
 *                      护甲、拆弹钳全都不动。回合结束进入下一局用这条路径，
 *                      和原版一致 —— 活下来的人下一局还是这套装备。
 * opts.keep = false → 真正被打死后重生：只剩刀 + 初始手枪，护甲清零。
 */
function respawnPlayer(opts) {
  const keep = !!(opts && opts.keep);
  player.dead = false;
  player.health = 100;
  if (!keep) {
    player.armor = 0;
    player.defuseKit = false;
  }
  const sp = spawnPoint(playerTeam || 't');
  if (sp) {
    player.pos.set(sp.x, sp.y, sp.z);
    player.yaw = sp.yaw * DEG;
    player.pitch = 0;
  }
  player.vel.set(0, 0, 0);
  if (keep) {
    // 装备原样留着：不 clear / 不 resetAmmo / 不切枪，只把槽位刷新一遍
    renderSlots();
  } else {
    owned.clear();
    owned.add('knife');
    const pistolId = playerTeam === 'ct' ? 'usp' : 'glock18';
    owned.add(pistolId);
    resetAmmo();
    renderSlots();
    if (weapons) {
      const w = weapons.weapons.find(x => x.def.id === pistolId);
      if (w) weapons.equip(weapons.weapons.indexOf(w), { instant: true });
    }
  }
  if (ui.death) ui.death.classList.add('hidden');
  startRound();              // 重生 = 新的一局：准备阶段 + 计时器回 15:00
  refreshVitals(true);
  refreshHUD(true);
}

/** 重置本局（菜单按钮）：钱/血/甲全重置，回出生点 */
function resetRound() {
  player.money = 18000;
  player.dead = false;
  if (ui.death) ui.death.classList.add('hidden');
  respawnPlayer();
}

// ---------------------------------------------------------------- C4 / 炸弹回合
// 规则全部照 CS 1.6：T 才能下包、A/B 两个包点、3 秒安放、40 秒引信、10 秒拆弹
//（有拆弹钳 5 秒）、爆炸半径 500 单位（≈12.7m）中心 500 伤害。
const bomb = {
  phase: 'none',        // none | carried | ground | planted | defused | exploded
  site: null,           // 安放所在包点
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),   // 掉落时的速度（抛物线）
  rest: true,                 // 是否已落地停稳
  prevY: null,
  yaw: 0,                     // 掉落/安放后的朝向
  mesh: null,           // 世界里的 C4 模型（掉落 / 已安放）
  marker: null,         // 已安放时头顶的闪灯
  led: null,            // 贴在 C4 上的红色指示灯（和滴滴声同步闪）
  ledPulse: 0,          // 指示灯亮度包络 1→0
  liftY: 0,             // 模型底面到中心的距离（贴地用）
  topY: 0,              // 模型顶面高度（红灯/闪灯挂在这里）
  light: null,
  plantProg: 0,
  plantStage: 'none',   // none | type（按密码）| drop（把 C4 放到地上）
  plantBeepAt: 0,       // 下一声键盘「滴」的进度点
  plantReleased: false, // drop 阶段是否已经撒手（C4 已落到地上）
  plantSite: null,
  defuseProg: 0,
  timer: 0,
  beepAt: 0,
  beepStage: -1,
  dropAt: 0,
  pickAt: 0,
  endAt: 0,
  roundEnded: false,
  winner: null,
  warnAt: 0,
};
let bombMsg = '';
let bombMsgT = 0;

function bombSiteAt(x, z) {
  for (const s of BOMB_SITES) {
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz <= s.r * s.r) return s;
  }
  return null;
}
function c4Weapon() {
  return weapons ? weapons.weapons.find(w => w.def.id === 'c4') : null;
}
function isHoldingC4() {
  return !!(weapons && weapons.current && weapons.current.def.kind === 'c4');
}

/** 上方黄色提示（下包位置不对、拆弹提示等） */
function bombWarn(msg, dur = 2.2) {
  bombMsg = msg;
  bombMsgT = dur;
  if (ui.bombWarn) { ui.bombWarn.textContent = msg; ui.bombWarn.classList.add('on'); }
}

/** 安放 / 拆除进度条 */
function setActBar(on, text = '', k = 0, remain = null) {
  if (!ui.actBar) return;
  ui.actBar.classList.toggle('hidden', !on);
  if (!on) return;
  ui.abText.textContent = text;
  ui.abFill.style.width = Math.max(0, Math.min(1, k)) * 100 + '%';
  ui.abTime.textContent = remain != null ? remain.toFixed(1) + 's' : '';
}

/** 给玩家发 C4（T 方每局一名携带者；单人时必然是自己） */
function givePlayerBomb() {
  const w = c4Weapon();
  if (!w) return;
  w.ammo = 1;
  w.reserve = 0;
  owned.add('c4');
  bomb.phase = 'carried';
  bomb.roundEnded = false;
  bomb.timer = 0;
  refreshHUD(true);
  renderSlots();
}

function clearBombWorld() {
  if (bomb.mesh) { scene.remove(bomb.mesh); bomb.mesh = null; }
  if (bomb.marker) { scene.remove(bomb.marker); bomb.marker = null; }
  if (bomb.led) { scene.remove(bomb.led); bomb.led = null; }
  if (bomb.light) { scene.remove(bomb.light); bomb.light = null; }
}

/** 新回合：重置 C4 并重新分配（T 方玩家拿包 / CT 方等 T 自动下包） */
function beginBombRound() {
  clearBombWorld();
  bomb.phase = 'none';
  bomb.site = null;
  bomb.plantProg = 0;
  bomb.plantStage = 'none';
  bomb.plantBeepAt = 0;
  bomb.plantReleased = false;
  bomb.plantSite = null;
  bomb.defuseProg = 0;
  bomb.timer = 0;
  bomb.beepAt = 0;
  bomb.beepStage = -1;
  bomb.roundEnded = false;
  bomb.winner = null;
  owned.delete('c4');
  if (ui.roundEnd) ui.roundEnd.classList.add('hidden');
  if (ui.bombInfo) ui.bombInfo.classList.add('hidden');
  if (ui.actBar) ui.actBar.classList.add('hidden');
  if (bombMsg) { bombMsg = ''; bombMsgT = 0; if (ui.bombWarn) ui.bombWarn.classList.remove('on'); }
  setC4PartsVisible(true);     // 上一局如果死在「撒手」那一下，手里的 C4 可能是藏着的
  renderSlots();

  if (playerTeam === 't') {
    // 玩家是 T：由玩家拿包（AI 不抢）
    givePlayerBomb();
  }
  if (botMgr && botMgr.ready) botMgr.resetRound(playerTeam);
  // CT 单人时不再「过一会自动冒出一个包」：场上没有 T 就没有人下包。
  // （旧版这里会排一个 14 秒后的模拟安放，看着像被看不见的人装了包。）
}

/** 安放：把 C4 摆到世界上，开始 40 秒倒计时。
 *  keepHand = true 时不动手里的枪（下包动作还在播「把 C4 放到地上」的后半段）。 */
function plantBombAt(site, x, z, { auto = false, keepHand = false } = {}) {
  if (bomb.phase === 'planted') return;
  const y = groundHeightAt(x, z, 120);
  const py = y > -90 ? y : 0;
  bomb.phase = 'planted';
  bomb.site = site;
  bomb.pos.set(x, py + 0.02, z);
  // 安放后 C4 的朝向：键盘面朝安放者（自动下包就随便摆一个）
  bomb.yaw = auto ? Math.random() * Math.PI * 2 : player.yaw + Math.PI;
  bomb.rest = true;
  bomb.vel.set(0, 0, 0);
  bomb.timer = BOMB_RULES.timer;
  bomb.beepAt = 0;
  bomb.beepStage = -1;
  bomb.defuseProg = 0;
  bomb.roundEnded = false;
  owned.delete('c4');
  renderSlots();
  const w = c4Weapon();
  if (w) w.ammo = 0;

  // 手里的 C4 换回上一把枪
  if (!keepHand && isHoldingC4()) {
    const w2 = weapons.current;
    if (w2) { if (w2.active) { w2.active.stop(); w2.active = null; } w2.state = 'idle'; }
    weapons.switchLast();
    if (isHoldingC4()) weapons.switchNext();
  }
  // C4 落到地上的那一下（原来用的 c4_plant 是不对的素材，已经删掉）
  audio.play('c4_click', { gain: 0.75 });
  buildBombWorld();
  // r90：下包后不再有红色倒计时条（原版也没有），只留一句黄色提示，几秒后自动淡出
  bombWarn(auto ? 'C4 已安装' : 'C4 已安装', 3.2);
}

/** C4 本体那几块网格（机身/计时器/电线/按钮）：撒手以后要把它们藏掉，
 *  只留下手。注意要按 def.id 找 C4 那一份视图 —— 下包过程中手上可能已经换成别的枪了。 */
function setC4PartsVisible(vis, view = null) {
  const w = view || (weapons && weapons.weapons.find(x => x.def.id === 'c4'));
  if (!w) return;
  w.root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const name = mats.map(m => (m && m.name) || '').join('|');
    if (/^(c4|cbase)/i.test(name)) o.visible = vis;
  });
}

/** 开始下包：掏包动作播完之后才能按键盘（否则会从拔枪姿势硬切过去，手臂闪一下） */
function startPlantSequence(w) {
  bomb.plantStage = 'type';
  bomb.plantProg = 0;
  bomb.plantBeepAt = 0.05;
  bomb.plantReleased = false;
  bomb.plantSite = bombSiteAt(player.pos.x, player.pos.z);
  const anim = (w.def.anims && w.def.anims.plant) || 'pressbutton';
  // 跳过 pressbutton 开头抬手翻包那 0.8s（手会扫到镜头前），从按键盘的姿势淡进来
  if (w.playBlended) {
    w.playBlended(anim, { at: BOMB_RULES.plantAnimStart, fade: 0.16, state: 'busy' });
  } else {
    w.play(anim, { state: 'busy', fade: 0.05, force: true });
  }
}

/** 输完密码：接「把 C4 放到地上」的 drop 动画 */
function beginBombDrop(site) {
  bomb.plantStage = 'drop';
  bomb.plantSite = site || bomb.plantSite;
  const w = weapons.current;
  if (w && w.def.kind === 'c4') {
    const anim = (w.def.anims && w.def.anims.plantDrop) || 'drop';
    w.play(anim, { state: 'busy', fade: 0.03, force: true });
  }
}

/** drop 动画里手松开的那一帧：C4 真正出现在地上，手里那块藏掉 */
function placeBombFromHand() {
  const site = bomb.plantSite || bomb.site || bombSiteAt(player.pos.x, player.pos.z);
  if (!site) return;
  // 包放在身前 0.55m，别埋在脚底下（自己站在上面会挡住整个屏幕）
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  let bx = player.pos.x + fx * 0.55, bz = player.pos.z + fz * 0.55;
  if (!bombSiteAt(bx, bz)) { bx = player.pos.x; bz = player.pos.z; }
  plantBombAt(site, bx, bz, { keepHand: true });
  setC4PartsVisible(false);
}

/** 下包动作收尾：手收回来以后再把武器切回上一把 */
function endPlantSequence() {
  setActBar(false);
  const c4 = (weapons && weapons.current && weapons.current.def.kind === 'c4') ? weapons.current : null;
  bomb.plantStage = 'none';
  bomb.plantProg = 0;
  bomb.plantBeepAt = 0;
  bomb.plantReleased = false;
  bomb.plantSite = null;
  if (c4) {
    if (c4.active) { c4.active.stop(); c4.active = null; }
    c4.state = 'idle';
    weapons.switchLast();
    if (isHoldingC4()) weapons.switchNext();
    // 切走以后再恢复可见，避免这一帧手里的 C4 又闪出来
    setC4PartsVisible(true, c4);
  }
}

/** 松手 / 走出包点：取消（drop 阶段已经撒手，收不回来） */
function cancelPlant() {
  if (bomb.plantStage === 'drop') return;
  if (bomb.plantStage === 'type') {
    const w = weapons.current;
    if (w && w.def.kind === 'c4' && w.active) {
      w.active.stop();
      w.active = null;
      w.state = 'idle';
      w.idleAction.reset();
      w.idleAction.setEffectiveWeight(1);
      w.idleAction.play();
    }
  }
  bomb.plantStage = 'none';
  bomb.plantProg = 0;
  bomb.plantBeepAt = 0;
  bomb.plantReleased = false;
  bomb.plantSite = null;
  setActBar(false);
}

/** C4 的兜底低模：一个带键盘和天线的深绿色方块（GLB 没加载完时先顶上） */
function buildC4LowModel() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.11, 0.23),
    new THREE.MeshStandardMaterial({ color: 0x2b3324, roughness: 0.82, metalness: 0.05 })
  );
  g.add(body);
  const pad = new THREE.Mesh(
    new THREE.BoxGeometry(0.13, 0.012, 0.10),
    new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.6 })
  );
  pad.position.set(-0.05, 0.058, 0.03);
  g.add(pad);
  const led = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.014, 0.02),
    new THREE.MeshStandardMaterial({ color: 0xff2a12, emissive: 0xff2a12, emissiveIntensity: 2 })
  );
  led.position.set(0.12, 0.058, 0.06);
  g.add(led);
  const wire = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.008, 6, 20, Math.PI * 1.2),
    new THREE.MeshStandardMaterial({ color: 0xb8b0a0, roughness: 0.7 })
  );
  wire.rotation.x = Math.PI / 2.6;
  wire.position.set(0.06, 0.06, -0.10);
  g.add(wire);
  return g;
}
/** 把 C4 摆到 bomb.pos 上：包围盒最低点对地、键盘面朝固定方向 */
function seatBomb(obj) {
  obj.position.set(bomb.pos.x, bomb.pos.y, bomb.pos.z);
  obj.rotation.set(0, bomb.yaw, 0);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  // 模型是「以中心为原点」归一出来的：直接摆在 bomb.pos 上会有一半埋进地面，
  // 看起来就是一张薄片贴在地上。这里把包围盒底面抬到 bomb.pos.y。
  const minL = box.min.y - obj.position.y;        // 底面相对中心（负值）
  const maxL = box.max.y - obj.position.y;        // 顶面相对中心（正值）
  obj.position.y -= minL;
  bomb.liftY = -minL;                             // 底面到中心的距离
  bomb.topY = obj.position.y + maxL;              // 顶面的世界高度
  return obj;
}

/** w_c4 的计时器屏幕在模型的侧面上（面朝水平方向，直接摆在地上屏幕对着墙）：
 *  套一层绕 X 转 -90°，把屏幕那面翻到朝上。包一层 Group 是为了不破坏
 *  loadWorldGun 的归一化结果，seatBomb 只管外层的 yaw。 */
function orientC4Model(m) {
  const g = new THREE.Group();
  m.rotation.x = -Math.PI / 2;
  g.add(m);
  return g;
}

/** 安放完成的 C4 世界模型 + 闪灯 */
function buildBombWorld() {
  clearBombWorld();
  const place = (obj) => {
    seatBomb(obj);
    scene.add(obj);
    bomb.mesh = obj;
    if (bomb.led) bomb.led.position.set(bomb.pos.x, bomb.topY + 0.014, bomb.pos.z);
  };
  place(buildC4LowModel());
  loadWorldGun('c4').then(m => {
    if (!m || bomb.phase !== 'planted') return;
    if (bomb.mesh) scene.remove(bomb.mesh);
    place(orientC4Model(m));
  });
  // 指示灯：贴在 C4 本体上的小红点，每响一声滴就闪一下（见 updateBomb）
  const led = sprite(TEX.glow, 0xff2a12, THREE.AdditiveBlending);
  led.visible = true;                 // sprite() 默认是隐藏的
  led.scale.setScalar(0.16);
  led.position.set(bomb.pos.x, bomb.topY + 0.012, bomb.pos.z);
  led.material.opacity = 0.1;
  led.renderOrder = 6;
  bomb.led = led;
  bomb.ledPulse = 0;
  // 闪灯：红色小光点 + 一盏很小的点光，远处也能看见
  const dot = sprite(TEX.glow, 0xff2a1a, THREE.AdditiveBlending);
  dot.visible = true;
  dot.scale.setScalar(0.22);
  dot.position.set(bomb.pos.x, bomb.topY + 0.09, bomb.pos.z);
  dot.material.opacity = 0.9;
  bomb.marker = dot;
  const li = new THREE.PointLight(0xff2a12, 1.2, 3.2, 2);
  li.position.set(bomb.pos.x, bomb.topY + 0.18, bomb.pos.z);
  scene.add(li);
  bomb.light = li;
}

/** 丢出 C4：手里有包时随时可以丢（和丢枪一样走抛物线） */
function dropBomb() {
  if (bomb.phase !== 'carried') return;
  if (bomb.plantStage !== 'none') return;      // 正在按密码 / 正在放包：先松手取消
  if (!gameStarted || player.dead || buyOpen) return;
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  const fx = -sin, fz = -cos;
  bomb.phase = 'ground';
  bomb.dropAt = elapsed;
  // 从胸口高度、略偏右出手，带一个向前的速度 —— 原来直接摆在脚前 0.5m 的地上，
  // 看着像「凭空出现然后垂直掉下去」
  bomb.pos.set(player.pos.x + fx * 0.45 + cos * 0.16,
               player.pos.y + 1.15,
               player.pos.z + fz * 0.45 - sin * 0.16);
  bomb.vel.set(fx * 2.9, 1.7, fz * 2.9);
  bomb.rest = false;
  bomb.bounces = 0;
  bomb.prevY = bomb.pos.y;
  // 正面朝出手方向：掉在地上时键盘那面朝着丢包的人，不是随机转
  bomb.yaw = player.yaw + Math.PI;
  owned.delete('c4');
  const w = c4Weapon();
  if (w) { w.ammo = 0; if (w.active) { w.active.stop(); w.active = null; } w.state = 'idle'; }
  renderSlots();
  weapons.switchLast();
  if (isHoldingC4() || !weapons.current) weapons.switchNext();
  const low = seatBomb(buildC4LowModel());
  scene.add(low);
  bomb.mesh = low;
  loadWorldGun('c4').then(m => {
    if (!m || bomb.phase !== 'ground') return;
    if (bomb.mesh) scene.remove(bomb.mesh);
    const o = seatBomb(orientC4Model(m));   // 屏幕朝上 + 按包围盒贴地，别半截埋着
    scene.add(o);
    bomb.mesh = o;
  });
  audio.play('c4_click', { gain: 0.8 });
  showHint('丢下了 C4（走过去可以捡回来）');
  refreshHUD(true);
}

function pickupBomb() {
  if (bomb.phase !== 'ground') return;
  clearBombWorld();
  bomb.phase = 'carried';
  const w = c4Weapon();
  if (w) w.ammo = 1;
  owned.add('c4');
  renderSlots();
  audio.play('gunpickup', { gain: 0.8 });
  showHint('捡起了 C4');
  refreshHUD(true);
}

/** 切出 C4（左侧按钮 / 数字键 5） */
function switchToC4() {
  if (bomb.phase !== 'carried' || !weapons) { showHint('你身上没有 C4'); return; }
  const i = weapons.weapons.findIndex(w => w.def.id === 'c4');
  if (i < 0) return;
  // 再按一次切回上一把枪（和数字键切枪一个手感），不用非要去按别的槽位
  if (weapons.current && weapons.current.def.id === 'c4') {
    weapons.switchLast();
    if (isHoldingC4()) weapons.switchNext();
    return;
  }
  weapons.equip(i);
}

/** 爆炸：冲击波 + 火焰 + 烟 + 伤害 */
function explodeBomb() {
  if (bomb.phase === 'exploded' || bomb.phase === 'defused') return;
  const pos = bomb.pos.clone();
  bomb.phase = 'exploded';
  bomb.winner = 't';
  clearBombWorld();
  audio.stopKey('c4beep');
  audio.play('c4_explode1', { gain: 1 });
  spawnBombExplosion(pos);

  // 伤害：CS 的 500 伤害 / 500 单位，线性衰减；只认竖面遮挡
  const feet = player.pos;
  const d = Math.hypot(feet.x - pos.x, feet.z - pos.z, (feet.y + 0.5) - pos.y);
  if (gameStarted && !player.dead && d < BOMB_RULES.radius) {
    const chest = feet.clone().add(new THREE.Vector3(0, 0.55, 0));
    const hdir = pos.clone().sub(chest).normalize();
    const reach = chest.distanceTo(pos);
    raycaster.set(chest, hdir);
    raycaster.far = reach;
    const wh = raycaster.intersectObjects(mapMeshes.length ? mapMeshes : [ground], false);
    const n = new THREE.Vector3();
    let blocked = false;
    for (const h of wh) {
      if (h.distance <= 0.35 || h.distance >= reach - 0.25) continue;
      if (!h.face) continue;
      n.copy(h.face.normal).transformDirection(h.object.matrixWorld);
      if (Math.abs(n.y) < 0.7) { blocked = true; break; }
    }
    if (!blocked) {
      const dmg = Math.round(BOMB_RULES.maxDamage * (1 - d / BOMB_RULES.radius));
      if (dmg > 0) damagePlayer(dmg, pos.x, pos.z, 'C4 爆炸');
    }
  }
  endBombRound('t', 'C4 已爆炸');
  // 爆炸后 1 秒再补一次强震（冲击波传到脚下的感觉）
  setTimeout(() => addShake(1.2, 0.9), 260);
}

function defuseBomb() {
  if (bomb.phase !== 'planted') return;
  bomb.phase = 'defused';
  bomb.winner = 'ct';
  audio.stopKey('c4beep');
  audio.play('c4_disarmed', { gain: 1 });
  audio.play('c4_disarm', { gain: 0.9 });
  clearBombWorld();
  endBombRound('ct', 'C4 已被拆除');
}

function endBombRound(winner, sub) {
  bomb.roundEnded = true;
  bomb.endAt = elapsed + 5;
  bomb.winner = winner;
  if (ui.bombInfo) ui.bombInfo.classList.add('hidden');
  setActBar(false);
  if (ui.roundEnd) {
    ui.roundEnd.classList.remove('hidden', 't', 'ct');
    ui.roundEnd.classList.add(winner);
    ui.reTitle.textContent = winner === 't' ? '恐怖分子获胜' : '反恐精英获胜';
    ui.reSub.textContent = sub;
  }
  if (ui.bombWarn) ui.bombWarn.classList.remove('on');
  bombMsgT = 0;
}

/** C4 爆炸特效：比手雷大一圈的火球 + 冲击波（球面 + 地面环）+ 黑烟 + 碎屑 */
function spawnBombExplosion(pos) {
  initFxTextures();
  const S = TEX;
  // 1) 火球四层：白核 → 橙焰 → 暗红余焰 → 翻滚的火团
  //    每层起始时间和寿命都错开，看起来是「轰」一下涨开再慢慢熄，
  //    而不是一张贴图闪一下就没。
  const core = sprite(S.glow, 0xfffbe8, THREE.AdditiveBlending);
  core.position.copy(pos).add(new THREE.Vector3(0, 1.4, 0));
  core.scale.setScalar(3);
  grenadeEffects.push({ kind: 'fire', s: core, t: 0, dur: 0.62, from: 3, to: 14, a0: 1, rise: 2.6 });
  const mid = sprite(S.glow, 0xffb14a, THREE.AdditiveBlending);
  mid.position.copy(pos).add(new THREE.Vector3(0, 2.0, 0));
  mid.scale.setScalar(4);
  grenadeEffects.push({ kind: 'fire', s: mid, t: -0.03, dur: 1.10, from: 4, to: 21, a0: 0.85, rise: 3.4 });
  const outer = sprite(S.glow, 0xff5f16, THREE.AdditiveBlending);
  outer.position.copy(pos).add(new THREE.Vector3(0, 3.0, 0));
  outer.scale.setScalar(6);
  grenadeEffects.push({ kind: 'fire', s: outer, t: -0.08, dur: 1.70, from: 6, to: 31, a0: 0.48, rise: 4.6 });
  // 火团：用烟雾贴图染成橙色，一团团往上翻，压住「纯发光球」的塑料感
  for (let i = 0; i < 9; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 2.4;
    const f = sprite(S.smoke, i % 3 ? 0xff9a3c : 0xff6a1e, THREE.AdditiveBlending);
    f.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * r, 1.0 + Math.random() * 2.4, Math.sin(a) * r));
    grenadeEffects.push({
      kind: 'puff', s: f, t: -0.05 - Math.random() * 0.18, dur: 1.1 + Math.random() * 0.7,
      from: 2.5, to: 8 + Math.random() * 5, a0: 0.42, rise: 3.2 + Math.random() * 2,
      drift: 1.6, spin: (Math.random() - 0.5) * 1.2
    });
  }

  // 2) 球面冲击波：一个快速膨胀、迅速变淡的球
  const shock = new THREE.Mesh(
    new THREE.SphereGeometry(1, 28, 18),
    new THREE.MeshBasicMaterial({
      color: 0xffe2a8, transparent: true, opacity: 0.42, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    })
  );
  shock.position.copy(pos).add(new THREE.Vector3(0, 1.2, 0));
  scene.add(shock);
  grenadeEffects.push({ kind: 'ring', mesh: shock, t: 0, dur: 0.55, from: 0.6, to: 15, a0: 0.42, sphere: true });

  // 3) 地面冲击环（两道，快的白、慢的橙）
  for (const [col, to, dur, a0] of [[0xfff4d0, 26, 0.75, 0.75], [0xff8a2a, 34, 1.5, 0.4]]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1.0, 72),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: a0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.06, 0));
    scene.add(ring);
    grenadeEffects.push({ kind: 'ring', mesh: ring, t: 0, dur, from: 1, to, a0 });
  }

  // 4) 火星碎屑
  for (let i = 0; i < 60; i++) {
    const sp = sprite(S.spark, i % 3 ? 0xffc46a : 0xff7a22, THREE.AdditiveBlending);
    sp.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
    const a = Math.random() * Math.PI * 2;
    const up = 4 + Math.random() * 13;
    const r = 4 + Math.random() * 15;
    sp.scale.setScalar(0.12 + Math.random() * 0.16);
    grenadeEffects.push({
      kind: 'spark', s: sp, t: -Math.random() * 0.12, dur: 0.7 + Math.random() * 0.9,
      vel: new THREE.Vector3(Math.cos(a) * r, up, Math.sin(a) * r), a0: 1
    });
  }

  // 5) 地面扬尘（向外滚）
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + Math.random() * 0.3;
    const d = 1 + Math.random() * 3.4;
    const sm = sprite(S.smoke, 0xd8cbb2);
    sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * d, 0.3 + Math.random() * 0.8, Math.sin(a) * d));
    grenadeEffects.push({
      kind: 'puff', s: sm, t: -i * 0.02, dur: 4.4 + Math.random() * 2.2,
      from: 1.4, to: 7.5 + Math.random() * 3.5, a0: 0.34, rise: 0.8, drift: 2.6,
      spin: (Math.random() - 0.5) * 0.5
    });
  }
  // 6) 中央黑烟柱（活最久）—— 两层：外层淡、内层浓，叠出体积感
  for (let i = 0; i < 26; i++) {
    const inner = i % 2 === 0;
    const sm = sprite(S.smoke, i % 4 === 0 ? 0x16120e : i % 4 === 1 ? 0x453f39 : 0x5d574e);
    const a = Math.random() * Math.PI * 2, r = Math.random() * (inner ? 1.6 : 3.0);
    sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * r, 1 + Math.random() * (inner ? 2.4 : 3.6), Math.sin(a) * r));
    grenadeEffects.push({
      kind: 'puff', s: sm, t: -0.15 - i * 0.08, dur: 7.5 + Math.random() * 2.8,
      from: inner ? 2.4 : 3.4, to: (inner ? 9 : 13) + Math.random() * 4,
      a0: inner ? 0.44 : 0.26, rise: 1.45 + Math.random() * 0.6, drift: 0.9,
      spin: (Math.random() - 0.5) * 0.35
    });
  }
  // 6.5) 地面焦痕：留下来，让人一眼看出「这儿炸过」
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(4.2, 28),
    new THREE.MeshBasicMaterial({
      map: TEX.scorch, color: 0x1c1712, transparent: true, opacity: 0.62,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
    })
  );
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.copy(pos).add(new THREE.Vector3(0, 0.035, 0));
  scene.add(scorch);
  grenadeEffects.push({ kind: 'scorch', mesh: scorch, t: 0, dur: 26, a0: 0.62 });

  // 7) 灯光 + 白闪 + 屏幕震动
  fxLight.color.setHex(0xffb35a);
  fxLight.distance = 34;
  fxLight.position.copy(pos).add(new THREE.Vector3(0, 2.2, 0));
  fxLight.intensity = 55;
  grenadeEffects.push({ kind: 'light', light: fxLight, pooled: true, t: 0, dur: 1.25, from: 55 });
  flashScreen('#ffdca8', 0.46, 400);
  addShake(4.0, 1.5);
}

/** 每帧推进 C4：安放 / 引信 / 滴滴声 / 拆弹 / 拾取 / 回合重置 */
function updateBomb(dt) {
  if (!gameStarted) return;
  // 「按住」只用于拆弹（CT）：桌面 E / 手机上的「拆弹」键。
  // 下包不走这个键 —— 只有按住开火才会安放，切 C4 的按钮不会误触发。
  const holdUse = !!(input.use || keys.has('KeyE'));

  // ---- 回合结束后的收尾：5 秒后开新一局 ----
  if (bomb.roundEnded) {
    if (elapsed >= bomb.endAt) {
      if (ui.roundEnd) ui.roundEnd.classList.add('hidden');
      bomb.roundEnded = false;
      // 回合间不没收装备：上一局的枪、剩余的子弹、手里拿的那把都带进下一局
      respawnPlayer({ keep: true });   // 内部会 startRound → beginBombRound
    }
    return;
  }

  // ---- 下包动作后半段：把 C4 放到地上 ----
  // 这一段跟 phase 无关：撒手那一刻 phase 已经变成 planted，但手里的动作还得收尾。
  if (bomb.plantStage === 'drop') {
    bomb.plantProg += dt;
    const t = bomb.plantProg - BOMB_RULES.plantTime;
    if (!bomb.plantReleased && t >= BOMB_RULES.plantReleaseAt) {
      bomb.plantReleased = true;
      placeBombFromHand();
      // 手一撒开就把枪切回来：drop 剩下那半段是手往回抬，会整个糊到镜头前
      endPlantSequence();
    } else if (t >= BOMB_RULES.plantDropTime) {
      endPlantSequence();
    } else {
      const total = BOMB_RULES.plantTime + BOMB_RULES.plantReleaseAt;
      const site = bomb.site || bomb.plantSite;
      setActBar(true, `正在安放 C4${site ? ' · ' + site.name : ''}`,
        Math.min(1, bomb.plantProg / total), Math.max(0, total - bomb.plantProg));
    }
  }

  // ---- 携带中 ----
  if (bomb.phase === 'carried') {
    const inSite = bombSiteAt(player.pos.x, player.pos.z);
    const w = weapons.current;
    const holding = !!(w && w.def.kind === 'c4');
    // 只有「手里拿着 C4 + 站在包点里 + 按住开火」才会下包。
    // E / 手机上的按钮只用来切出 C4，不参与下包。
    const canStart = holding && input.firing && !!inSite && player.onGround && !player.dead
      // 刚切出 C4 时拔枪动画还在播：等它播完再开始按键盘，
      // 否则会从「拔枪姿势」硬切到「按键盘姿势」，画面上就是手臂闪一下
      && (!w.active || w.state === 'idle');

    if (bomb.plantStage === 'type') {
      if (!input.firing || !holding || !inSite || !player.onGround || player.dead) {
        cancelPlant();
      } else {
        bomb.plantProg += dt;
        // 键盘「滴」：按时间轴排，掉帧也不会漏成一片
        while (bomb.plantProg >= bomb.plantBeepAt) {
          if (bomb.plantProg - bomb.plantBeepAt < 0.2) {
            audio.keypad({ gain: 0.28 + Math.random() * 0.07, rate: 0.96 + Math.random() * 0.08 });
          }
          bomb.plantBeepAt += BOMB_RULES.plantBeepGap;
        }
        const site = bomb.plantSite || inSite;
        const total = BOMB_RULES.plantTime + BOMB_RULES.plantReleaseAt;
        setActBar(true, `正在安放 C4 · ${site.name}`, Math.min(1, bomb.plantProg / total),
          Math.max(0, total - bomb.plantProg));
        if (bomb.plantProg >= BOMB_RULES.plantTime) {
          audio.keypad({ gain: 0.40, rate: 0.84 });   // 最后一下确认音，比按键音低一点
          beginBombDrop(site);
        }
      }
    } else if (bomb.plantStage === 'none' && canStart) {
      startPlantSequence(w);
    } else if (holding && !inSite && input.firing && bombMsgT <= 0) {
      bombWarn('这里不能安放 C4 · 请到 A 点或 B 点', 1.6);
    }
  }

  // ---- 掉在地上：先走抛物线，落地后再让 T 走过去捡 ----
  if (bomb.phase === 'ground') {
    if (!bomb.rest) {
      bomb.vel.y -= 11 * dt;
      bomb.pos.addScaledVector(bomb.vel, dt);
      // 起点抬到「上一帧高度的上方」，快速下落/飞进斜坡时才不会穿地
      const startY = Math.max(bomb.pos.y, bomb.prevY == null ? bomb.pos.y : bomb.prevY) + 0.5;
      const g = groundHeightAt(bomb.pos.x, bomb.pos.z, startY);
      if (g > -90 && bomb.pos.y <= g + 0.05) {
        bomb.pos.y = g + 0.05;
        if (Math.abs(bomb.vel.y) > 1.6 && bomb.bounces < 1) {
          bomb.vel.y *= -0.2;
          bomb.vel.x *= 0.55; bomb.vel.z *= 0.55;
          bomb.bounces++;
        } else {
          bomb.vel.set(0, 0, 0);
          bomb.rest = true;
        }
      }
      bomb.prevY = bomb.pos.y;
      // 保持底面贴地（pos.y 是落地接触点，里面含 0.05 的落地余量，要扣掉）
      if (bomb.mesh) bomb.mesh.position.set(bomb.pos.x, bomb.pos.y + (bomb.liftY || 0) - 0.05, bomb.pos.z);
      // 掉到地图外（理论上不会）：放回最后有效地面
      if (bomb.pos.y < -80) { bomb.pos.y = player.pos.y + 0.05; bomb.rest = true; }
    }
    if (playerTeam === 't' && !player.dead) {
      const dx = player.pos.x - bomb.pos.x, dz = player.pos.z - bomb.pos.z;
      const dy = player.pos.y - bomb.pos.y;
      if (dx * dx + dz * dz < 1.1 && dy > -1.4 && dy < 1.4 && elapsed - bomb.dropAt > 0.5) {
        pickupBomb();
      }
    }
  }

  // ---- 已安放：倒计时 + 滴滴 + 拆弹 ----
  if (bomb.phase === 'planted') {
    bomb.timer -= dt;
    // 指示灯衰减：约 0.22s 从满亮掉到熄灭，下一次滴再点亮。
    // 放在「滴滴」判定之前 —— 否则这一帧刚点亮的 1 会立刻被本帧的 dt 削掉一截，
    // 帧率低的时候（丢帧到 10fps）看着就只是半亮。
    if (bomb.led) {
      bomb.ledPulse = Math.max(0, bomb.ledPulse - dt * 4.6);
      const k = bomb.ledPulse;
      bomb.led.material.opacity = 0.06 + k * 0.94;
      bomb.led.scale.setScalar(0.15 + k * 0.12);
    }
    // 滴滴声：越往后越急
    if (elapsed >= bomb.beepAt) {
      const t = bomb.timer;
      const stage = t > 30 ? 0 : t > 20 ? 1 : t > 12 ? 2 : t > 6 ? 3 : 4;
      // 每个素材本身就是一段 1.5s 的完整节奏（beep1 一短滴 → beep5 长鸣），
      // 所以按素材长度整段接播；间隔比它短会几条叠在一起，糊成噪音。
      if (stage !== bomb.beepStage) {
        bomb.beepStage = stage;
        bomb.beepAt = 0;                 // 换段立刻切到更急的那一段
      }
      bomb.beepAt = elapsed + 1.46;
      audio.play('c4_beep' + (stage + 1), { gain: 0.55 + stage * 0.09, key: 'c4beep' });
      // C4 本体上的红灯：这一声滴的同时点亮，和声音同一个触发点，永远不会错拍
      bomb.ledPulse = 1;
      if (bomb.led) {
        bomb.led.material.opacity = 1;
        bomb.led.scale.setScalar(0.27);
      }
      if (bomb.marker) {
        bomb.marker.scale.setScalar(0.26 + stage * 0.03);
        bomb.marker.material.opacity = 1;
      }
      if (bomb.light) bomb.light.intensity = 1.4 + stage * 0.5;
    }
    // 闪灯回落
    if (bomb.marker) bomb.marker.material.opacity = Math.max(0.18, bomb.marker.material.opacity - dt * 2.6);
    if (bomb.light) bomb.light.intensity = Math.max(0.25, bomb.light.intensity - dt * 4.5);

    // 拆弹：CT 站在包旁边按住 E
    const dx = player.pos.x - bomb.pos.x, dz = player.pos.z - bomb.pos.z;
    const near = dx * dx + dz * dz < 2.4 && Math.abs(player.pos.y - bomb.pos.y) < 2.0;
    const canDefuse = playerTeam === 'ct' && !player.dead && near;
    if (canDefuse && holdUse) {
      if (bomb.defuseProg <= 0) audio.play('c4_disarm', { gain: 0.7 });
      bomb.defuseProg += dt;
      const need = player.defuseKit ? BOMB_RULES.defuseKitTime : BOMB_RULES.defuseTime;
      setActBar(true, `正在拆除 C4${player.defuseKit ? '（拆弹钳）' : ''}`, bomb.defuseProg / need, Math.max(0, need - bomb.defuseProg));
      if (bomb.defuseProg >= need) {
        setActBar(false);
        defuseBomb();
        return;
      }
    } else if (bomb.defuseProg > 0) {
      bomb.defuseProg = 0;
      setActBar(false);
    }
    if (bomb.defuseProg <= 0 && canDefuse && !holdUse && bombMsgT <= 0 && elapsed - bomb.warnAt > 6) {
      bomb.warnAt = elapsed;
      bombWarn('按住 E 拆除 C4', 2.4);
    }
    if (bomb.timer <= 0) { explodeBomb(); return; }
  }

  // 黄色提示淡出
  if (bombMsgT > 0) {
    bombMsgT -= dt;
    if (bombMsgT <= 0 && ui.bombWarn) ui.bombWarn.classList.remove('on');
  }

  updateBombHUD();
}

let lastBombHud = '';
let lastSiteHint = '';       // 上一次提示「按住开火」的包点（避免每帧刷屏）
function updateBombHUD() {
  const w = weapons && weapons.current;
  const holding = !!(w && w.def.kind === 'c4');
  if (ui.bUse) {
    let show = false, label = '切C4';
    if (!player.dead && gameStarted) {
      // 这个键只管「切出 C4」和「按住拆弹」；
      // 下包一律用开火键（按住开火才会按密码），所以手里已经拿着 C4 时就把它收起来。
      if (bomb.phase === 'carried' && playerTeam === 't' && !holding &&
          bombSiteAt(player.pos.x, player.pos.z) && bomb.plantStage === 'none') {
        show = true;
        label = '切C4';
      }
      if (bomb.phase === 'planted' && playerTeam === 'ct') {
        const dx = player.pos.x - bomb.pos.x, dz = player.pos.z - bomb.pos.z;
        if (dx * dx + dz * dz < 2.4) { show = true; label = '拆弹'; }
      }
    }
    ui.bUse.classList.toggle('show', show);
    const s = ui.bUse.firstElementChild;
    if (s && s.textContent !== label) s.textContent = label;
  }

  // 拿着 C4 走进包点：提示一次「按住开火安放」（手机上开火键就是下包键）
  if (bomb.phase === 'carried' && holding && playerTeam === 't' && !player.dead) {
    const site = bombSiteAt(player.pos.x, player.pos.z);
    const tag = site ? site.key : '';
    if (tag !== lastSiteHint) {
      lastSiteHint = tag;
      if (site) showHint(`按住「开火」安放 C4 · 松手取消`);
    }
  } else if (lastSiteHint) {
    lastSiteHint = '';
  }
  if (!ui.bombInfo) return;
  let txt = '';
  if (bomb.phase === 'ground') txt = 'C4 掉在地上';
  if (!txt) { ui.bombInfo.classList.add('hidden'); lastBombHud = ''; return; }
  ui.bombInfo.classList.remove('hidden');
  if (txt !== lastBombHud) { lastBombHud = txt; ui.bombInfoTxt.textContent = txt; }
  ui.bombInfo.style.color = '#ffd08a';
}


// ---------------------------------------------------------------- 购买菜单（B 键）
// 分类和价格对应 CS 1.6：1 手枪 / 2 霰弹 / 3 冲锋枪 / 4 步枪（含 AWP）/ 5 机枪 / 6 装备
const BUY_CATS = [
  { key: 1, name: '手枪', items: ['glock18', 'usp', 'beretta92', 'deagle', 'fiveseven', 'revolver'] },
  { key: 2, name: '霰弹枪', items: ['m3'] },
  { key: 3, name: '冲锋枪', items: ['mac10t', 'mp5', 'tec9', 'tmp', 'ump45'] },
  { key: 4, name: '步枪', items: ['ak47', 'sg552', 'm4a1', 'aug', 'scout', 'remington', 'awp'] },
  { key: 5, name: '机枪', items: ['m249'] },
  { key: 6, name: '装备', items: ['kevlar', 'kevlarhelmet', 'defusekit', 'hegrenade', 'flashbang', 'smokegrenade'] },
  { key: 7, name: '弹药', items: ['ammo_primary', 'ammo_secondary'] },
];

/** 武器分类（原版槽位）：主武器 / 副武器 / 近战 / 投掷物。同分类只能带一把 */
function catOf(def) {
  if (!def) return null;
  if (def.kind === 'c4') return 'c4';        // C4 不占武器槽：买主/副武器都不能把它顶掉
  if (def.kind === 'grenade') return 'grenade';
  if (def.kind === 'melee') return 'melee';
  if (def.kind === 'pistol') return 'secondary';
  return 'primary';
}
const EQUIP_INFO = {
  kevlar:       { name: '防弹衣', sub: '受到伤害减半', price: 650 },
  kevlarhelmet: { name: '防弹衣 + 头盔', sub: '受到伤害减半', price: 1000 },
  // 拆弹钳：CS 1.6 原价 $200，拆包 10 秒 → 5 秒（只有 CT 能买）
  defusekit:    { name: '拆弹钳', sub: '拆包时间 10s → 5s', price: 200, team: 'ct' },
};
let buyCat = 1;
let buyOpen = false;

// ---- 购买规则：只能在本方出生点附近买，且只在开局购买时限内（CS 规则） ----
const BUY_ZONE_R = 16;      // 距本方出生点多远以内能买（米）
const BUY_TIME = 120;       // 开局（含准备阶段）多少秒内能买，过了就不能买了
function canBuyNow() {
  if (roundState === 'idle') return false;
  if (elapsed - roundT0 > PREP_TIME + BUY_TIME) return false;   // 购买时限已过
  const sp = spawnPoint(playerTeam || 't');
  if (!sp) return false;
  const dx = player.pos.x - sp.x, dz = player.pos.z - sp.z;
  return dx * dx + dz * dz <= BUY_ZONE_R * BUY_ZONE_R;          // 出生点范围
}
function buyDenied() {
  if (!canBuyNow()) {
    showHint(elapsed - roundT0 > PREP_TIME + BUY_TIME
      ? `购买时间已过（开局后 ${BUY_TIME} 秒内才能买）`
      : '走回本方出生点附近才能购买');
    return true;
  }
  return false;
}

let hintTimer = 0;
function showHint(msg) {
  if (!ui.hint) return;
  ui.hint.textContent = msg;
  ui.hint.classList.add('on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => ui.hint.classList.remove('on'), 2400);
}

/** 某一行购买项当前的状态（能否买 / 价格 / 标签） */
function buyItemInfo(id) {
  const eq = EQUIP_INFO[id];
  if (eq) {
    const wrong = eq.team && playerTeam && eq.team !== playerTeam;
    const has = id === 'defusekit' ? player.defuseKit : player.armor >= 100;
    return {
      name: eq.name, sub: has ? '已装备' : eq.sub, price: eq.price,
      dis: has || !!wrong || player.money < eq.price,
      tag: wrong ? '仅 CT' : ''
    };
  }
  // 弹药：给当前主武器 / 手枪补一匣备弹（价格按原版，每把枪有自己的弹匣价）
  if (id === 'ammo_primary' || id === 'ammo_secondary') {
    const slotNum = id === 'ammo_primary' ? 'primary' : 'secondary';
    const wobj = weapons && weapons.weapons.find(x => x.def.slot !== undefined && catOf(x.def) === slotNum && owned.has(x.def.id));
    const label = id === 'ammo_primary' ? '主武器弹药' : '副武器弹药';
    if (!wobj) return { name: label, sub: id === 'ammo_primary' ? '没有主武器' : '没有手枪', price: 0, dis: true, tag: '' };
    const full = wobj.reserve >= wobj.def.reserve;
    const price = wobj.def.ammoPrice || (id === 'ammo_primary' ? 60 : 30);
    return {
      name: label, sub: full ? '备弹已满' : `${wobj.def.name} · 备弹 ${wobj.reserve}/${wobj.def.reserve}`,
      price, dis: full || player.money < price, tag: '',
    };
  }
  const def = WEAPON_BY_ID[id];
  if (!def) return { name: id, sub: '', price: 0, dis: true, tag: '' };
  const wrongTeam = playerTeam && def.teams && def.teams.length && !def.teams.includes(playerTeam);
  const tag = wrongTeam ? (def.teams[0] === 't' ? '仅 T' : '仅 CT') : '';
  if (def.kind === 'grenade') {
    const wobj = weapons && weapons.weapons.find(x => x.def.id === id);
    const ammo = wobj ? wobj.ammo : 0;
    const max = def.max || def.magSize || 1;
    const full = ammo >= max;
    return {
      name: def.name, sub: `携带 ${ammo} / ${max}`,
      price: def.price || 0,
      dis: full || wrongTeam || player.money < (def.price || 0), tag
    };
  }
  const has = owned.has(id);
  if (has) {
    // 已拥有的枪：补满弹药收半价（CS 不允许重复买枪，这里为了能续命给了补弹入口）
    const wobj = weapons && weapons.weapons.find(x => x.def.id === id);
    const full = wobj && wobj.ammo >= wobj.def.magSize && wobj.reserve >= wobj.def.reserve;
    const price = Math.max(1, Math.round((def.price || 0) / 2));
    return {
      name: def.name, sub: full ? '弹药已满' : '补满弹药',
      price, dis: full || player.money < price, tag
    };
  }
  return {
    name: def.name, sub: def.kind === 'melee' ? '免费' : '',
    price: def.price || 0,
    dis: !!wrongTeam || player.money < (def.price || 0), tag
  };
}

function renderBuy() {
  if (!ui.bmCats) return;
  ui.bmMoney.textContent = player.money;
  ui.bmCats.innerHTML = BUY_CATS.map(c =>
    `<button class="bm-cat${c.key === buyCat ? ' on' : ''}" data-cat="${c.key}"><span class="k">${c.key}</span>${c.name}</button>`
  ).join('');
  const cat = BUY_CATS.find(c => c.key === buyCat) || BUY_CATS[0];
  // 只显示本阵营能买的（带「仅 T / 仅 CT」标签的敌阵营武器直接不出现）
  ui.bmItems.innerHTML = cat.items.filter(id => {
    const def = WEAPON_BY_ID[id];
    if (!def) return true;   // 装备类（护甲/手雷）不分阵营
    if (def.hidden) return false;
    return !playerTeam || !def.teams || !def.teams.length || def.teams.includes(playerTeam);
  }).map(id => {
    const it = buyItemInfo(id);
    const priceTxt = it.dis && it.sub === '已装备' ? '已装备'
      : (it.dis && it.sub === '弹药已满' ? '弹药已满' : '$' + it.price);
    return `<button class="bm-item${it.dis ? ' dis' : ''}" data-buy="${id}">
      <span><span class="bi-name">${it.name}${it.tag ? `<span class="bi-tag">${it.tag}</span>` : ''}</span>
      <span class="bi-sub">${it.sub}</span></span>
      <span class="bi-price">${priceTxt}</span>
    </button>`;
  }).join('');
}

/** 买一件。返回 true 表示成交 */
function buyItem(id) {
  if (!gameStarted || player.dead) return false;
  if (buyDenied()) { audio.click(); return false; }
  const info = buyItemInfo(id);
  if (info.dis) { audio.click(); return false; }
  if (player.money < info.price) { audio.click(); return false; }
  const eq = EQUIP_INFO[id];
  if (eq) {
    player.money -= info.price;
    if (id === 'defusekit') player.defuseKit = true;
    else player.armor = 100;
    refreshVitals();
    renderBuy();
    audio.click();
    if (id === 'defusekit') showHint('已购买拆弹钳：拆包只需 5 秒');
    return true;
  }
  // 弹药：买一次 = 把「备用弹」补满；弹匣里的子弹一律不动
  //（哪怕弹匣和备弹都空了，也只补备弹，换弹还得自己按 R）
  if (id === 'ammo_primary' || id === 'ammo_secondary') {
    const cat = id === 'ammo_primary' ? 'primary' : 'secondary';
    const wobj = weapons && weapons.weapons.find(x => catOf(x.def) === cat && owned.has(x.def.id));
    if (!wobj) return false;
    player.money -= info.price;
    wobj.reserve = wobj.def.reserve;
    refreshHUD(true);
    renderBuy();
    audio.click();
    return true;
  }
  const def = WEAPON_BY_ID[id];
  const wobj = weapons && weapons.weapons.find(x => x.def.id === id);
  if (!def || !wobj) return false;
  player.money -= info.price;
  if (def.kind === 'grenade') {
    wobj.ammo = Math.min(def.max || def.magSize || 1, wobj.ammo + 1);
    wobj.reserve = 0;
    owned.add(id);
    renderSlots();
  } else {
    // 原版槽位规则：同分类（主武器/副武器）只能带一把，
    // 再买就把旧的那把丢到地上，新枪直接入栏
    const oldId = [...owned].find(oid => oid !== id && catOf(WEAPON_BY_ID[oid]) === catOf(def));
    if (oldId) {
      // 旧枪连它剩下的子弹一起丢出去（换枪不白送满弹）
      const oldW = weapons.weapons.find(x => x.def.id === oldId);
      dropWeaponWorld(oldId, oldW ? { ammo: oldW.ammo, reserve: oldW.reserve } : null);
      owned.delete(oldId);
    }
    wobj.ammo = wobj.def.magSize;
    wobj.reserve = wobj.def.reserve;
    owned.add(id);
    loadWorldGun(id);        // 预热地面模型：丢枪时零延迟
    renderSlots();
  }
  // 买完直接切到新枪（装备除外）
  weapons.equip(weapons.weapons.indexOf(wobj));
  refreshVitals();
  refreshHUD(true);
  renderBuy();
  audio.click();
  return true;
}

function openBuy() {
  if (!gameStarted || buyOpen || player.dead) return;
  if (buyDenied()) { audio.click(); return; }
  buyOpen = true;
  buyCat = 1;
  input.firing = false;
  input.fireQueued = false;
  keys.clear();
  ui.buyMenu.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  renderBuy();
}

function closeBuy() {
  if (!buyOpen) return;
  buyOpen = false;
  ui.buyMenu.classList.add('hidden');
  if (gameStarted && !IS_TOUCH && !player.dead) tryLock();
}

// ---------------------------------------------------------------- 输入
let pointerLocked = false;
let dragging = false;
let gameStarted = false;
// 刚锁定指针时浏览器会把光标拉回屏幕中心，可能送来一个巨大的 movementX/Y，
// 不忽略的话「点画面任意处开始」会一进游戏就猛地转头。锁定的头 250ms 不吃视角。
let lookIgnoreUntil = 0;

function zoomSens() {
  const w = weapons && weapons.current;
  if (!zoomLevel || !w || !w.def.zoom) return 1;
  return w.def.zoom.sens[zoomLevel - 1] || 1;
}

function addLook(dx, dy) {
  const base = 0.0022 * input.sens * zoomSens();
  player.yaw -= dx * base;
  player.pitch -= dy * base;
  player.pitch = clamp(player.pitch, -89 * DEG, 89 * DEG);
  weaponLookDX += dx;
  weaponLookDY += dy;
}
let weaponLookDX = 0, weaponLookDY = 0;

function tryLock() {
  if (IS_TOUCH) return;
  const el = document.documentElement;
  if (document.pointerLockElement) return;
  if (el.requestPointerLock) {
    try { el.requestPointerLock(); } catch (e) {}
  }
}

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement != null;
  if (pointerLocked) lookIgnoreUntil = performance.now() + 250;
  ui.menuTip.textContent = pointerLocked ? 'ESC 释放鼠标' : '点击画面锁定鼠标';
  // 购买菜单打开时会主动退出指针锁定，这时候不要弹出暂停菜单
  if (buyOpen) return;
  if (!pointerLocked && gameStarted && !IS_TOUCH && !document.body.classList.contains('tuning')) {
    ui.menu.classList.remove('hidden');
    input.firing = false;
    ui.btnStart.textContent = '继续游戏';
  }
});

document.addEventListener('mousemove', e => {
  if (performance.now() < lookIgnoreUntil) return;
  if (pointerLocked || (dragging && !IS_TOUCH)) {
    addLook(e.movementX || 0, e.movementY || 0);
  }
});

// 绑在 window 上：指针锁定后鼠标事件的目标会变成 documentElement，
// 绑在 lookLayer 上会收不到，导致锁定状态下点不了开火
window.addEventListener('mousedown', e => {
  if (!gameStarted) return;
  if (document.body.classList.contains('tuning')) return;
  const t = e.target;
  // UI 层（购买菜单/死亡画面/选队页/调参器/物品栏…）上的点击不开枪
  if (t && t.closest && t.closest('#tuner, #tuneBtn, #siteTuner, #siteBtn, #menu, #mobile, #slots, #buyMenu, #teamPick, #death, #hint')) return;
  if (e.button === 0) {
    if (!pointerLocked) { tryLock(); dragging = true; }
    input.firing = true;
    input.fireQueued = false;
    // 直接触发一次，避免极快点击（按下与抬起落在同一帧）被主循环的队列清理吃掉
    shoot(false);
  } else if (e.button === 2) {
    const w = weapons && weapons.current;
    if (w && w.def.kind === 'melee') meleeStab();
    else if (w && w.def.burst) {
      w.burstMode = !w.burstMode;
      burst.left = 0;
      audio.click();
      refreshHUD(true);
    }
    else if (w && w.def.silencer) { exitZoom(); pendingZoom = 0; weapons.toggleSilencer(); refreshHUD(true); }
    else toggleZoom();
  }
});
window.addEventListener('mouseup', e => {
  if (e.button === 0) { input.firing = false; dragging = false; }
});
window.addEventListener('contextmenu', e => e.preventDefault());

// 键盘
const keys = new Set();
window.addEventListener('keydown', e => {
  // 设置弹窗打开时：ESC 先关它
  if (e.code === 'Escape' && !settingsEl.classList.contains('hidden')) {
    closeSettings();
    e.preventDefault();
    return;
  }

  // 调参面板打开时不响应游戏快捷键（面板内的输入框也不能带动角色）
  if (document.body.classList.contains('tuning')) return;
  if (e.target && e.target.closest && e.target.closest('#tuner, #siteTuner')) return;
  if (e.repeat) return;
  keys.add(e.code);
  // ---- 购买菜单（B）----
  if (e.code === 'KeyB') {
    if (buyOpen) closeBuy(); else openBuy();
    e.preventDefault();
    return;
  }
  // F1：CS 1.6 的 impulse 101 —— 练习打钱，直接补到 $16000。
  // （现在还没有回合奖励，想试买枪按这个；购买菜单开着也管用）
  if (e.code === 'F1') {
    player.money = 16000;
    refreshVitals(true);
    if (buyOpen) renderBuy();
    e.preventDefault();
    return;
  }
  if (buyOpen) {
    // 菜单打开时：1-6 切分类，0/ESC 关闭，其它键不带动游戏
    const m = /^Digit([1-6])$/.exec(e.code);
    if (m) { buyCat = +m[1]; renderBuy(); }
    if (e.code === 'Digit0' || e.code === 'Escape') closeBuy();
    e.preventDefault();
    return;
  }
  if (!gameStarted) return;
  if (e.code === 'KeyR') weapons.reload();
  if (e.code === 'KeyG') dropCurrentWeapon();     // 原版 drop：丢掉手里的枪（C4 也能丢）
  if (e.code === 'KeyX' && bomb.phase === 'carried') { switchToC4(); e.preventDefault(); return; }
  if (e.code === 'KeyQ') weapons.switchLast();
  if (e.code === 'KeyV') { exitZoom(); pendingZoom = 0; if (weapons.toggleSilencer()) refreshHUD(true); }
  if (/^Digit[0-9]$/.test(e.code)) weapons.switchToSlot(e.code === 'Digit0' ? 10 : +e.code.slice(5));
  // [ ] 在「已拥有 + 当前阵营可用」的武器间循环（第 11 把以后没有数字键）
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const list = WEAPONS.filter(w => weapons.allows(w));
    if (list.length) {
      const curId = weapons.current ? weapons.current.def.id : null;
      let cur = list.findIndex(w => w.id === curId);
      if (cur < 0) cur = 0;
      const dir = e.code === 'BracketRight' ? 1 : -1;
      const next = list[(cur + dir + list.length) % list.length];
      if (next) weapons.switchToSlot(next.slot);
    }
  }
  if (e.code === 'Space') jump();
  if (e.code === 'KeyC') {
    input.crouch = !input.crouch;
    if (ui.bCrouch) ui.bCrouch.classList.toggle('on', input.crouch);
  }
  if (['Space', 'KeyR', 'KeyF', 'KeyQ', 'KeyV', 'KeyC', 'KeyE', 'BracketLeft', 'BracketRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e => keys.delete(e.code));

function jump() {
  if (inPrep() || player.dead) return;   // 准备阶段不能跳
  if (player.onGround) {
    player.vel.y = 6.0;
    player.onGround = false;
  }
}

// 触摸视角
const lookLayer = document.getElementById('lookLayer');
let lookTouchId = null, lookLast = { x: 0, y: 0 };
lookLayer.addEventListener('touchstart', e => {
  if (!gameStarted) return;
  const t = e.changedTouches[0];
  lookTouchId = t.identifier;
  lookLast.x = t.clientX; lookLast.y = t.clientY;
  e.preventDefault();
}, { passive: false });
lookLayer.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === lookTouchId) {
      const dx = t.clientX - lookLast.x;
      const dy = t.clientY - lookLast.y;
      lookLast.x = t.clientX; lookLast.y = t.clientY;
      const base = 0.0032 * input.sens * zoomSens();
      player.yaw -= dx * base;
      player.pitch = clamp(player.pitch - dy * base, -89 * DEG, 89 * DEG);
      weaponLookDX += dx;
      weaponLookDY += dy;
    }
  }
  e.preventDefault();
}, { passive: false });
lookLayer.addEventListener('touchend', e => {
  for (const t of e.changedTouches) if (t.identifier === lookTouchId) lookTouchId = null;
}, { passive: false });

// 摇杆
const stick = document.getElementById('stick');
const knob = document.getElementById('knob');
let stickId = null, stickCenter = { x: 0, y: 0 }, stickRadius = 46;
function stickStart(e) {
  const t = e.changedTouches[0];
  stickId = t.identifier;
  const r = stick.getBoundingClientRect();
  stickCenter.x = r.left + r.width / 2;
  stickCenter.y = r.top + r.height / 2;
  stickRadius = r.width * 0.34;
  stickMove(e);
  e.preventDefault();
}
function stickMove(e) {
  for (const t of e.changedTouches) {
    if (t.identifier !== stickId) continue;
    let dx = t.clientX - stickCenter.x;
    let dy = t.clientY - stickCenter.y;
    const len = Math.hypot(dx, dy);
    const max = stickRadius;
    if (len > max) { dx = dx / len * max; dy = dy / len * max; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / max, ny = dy / max;
    const dead = 0.14;
    const mag = Math.hypot(nx, ny);
    if (mag < dead) { input.right = 0; input.forward = 0; }
    else {
      const k = (mag - dead) / (1 - dead) / mag;
      input.right = nx * k;
      input.forward = -ny * k;
    }
  }
  e.preventDefault();
}
function stickEnd(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === stickId) {
      stickId = null;
      input.right = 0; input.forward = 0;
      knob.style.transform = 'translate(0,0)';
    }
  }
}
stick.addEventListener('touchstart', stickStart, { passive: false });
stick.addEventListener('touchmove', stickMove, { passive: false });
stick.addEventListener('touchend', stickEnd, { passive: false });
stick.addEventListener('touchcancel', stickEnd, { passive: false });

// 按钮
// 指针事件同时覆盖触屏与鼠标，手机/平板/桌面调试都能按
function bindBtn(el, onDown, onUp) {
  if (!el) return;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.add('press');
    onDown && onDown();
  });
  el.addEventListener('pointerup', e => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('press');
    onUp && onUp();
  });
  el.addEventListener('pointercancel', () => {
    el.classList.remove('press');
    onUp && onUp();
  });
  el.addEventListener('pointerleave', () => {
    if (!el.classList.contains('press')) return;
    el.classList.remove('press');
    onUp && onUp();
  });
}
const bFire = document.getElementById('bFire');
bindBtn(bFire, () => { input.firing = true; input.fireQueued = false; shoot(false); }, () => { input.firing = false; });
bindBtn(document.getElementById('bReload'), () => weapons && weapons.reload());
bindBtn(document.getElementById('bSwitch'), () => weapons && weapons.switchNext());
bindBtn(document.getElementById('bJump'), () => jump());
bindBtn(document.getElementById('bZoom'), () => toggleZoom());
bindBtn(ui.bSil, () => { exitZoom(); pendingZoom = 0; if (weapons && weapons.toggleSilencer()) refreshHUD(true); });
// 手机：三连发开关（Glock）
bindBtn(ui.bBurst, () => {
  const w = weapons && weapons.current;
  if (!w || !w.def.burst) return;
  w.burstMode = !w.burstMode;
  burst.left = 0;
  audio.click();
  refreshHUD(true);
});
// 手机：蹲下是开关（按住两个键太别扭），桌面仍然是按住 Ctrl
bindBtn(ui.bCrouch, () => {
  input.crouch = !input.crouch;
  ui.bCrouch.classList.toggle('on', input.crouch);
});
// 手机：丢枪（屏幕左侧按钮）
bindBtn(document.getElementById('bDrop'), () => dropCurrentWeapon());
// 手机：购买菜单
bindBtn(ui.bBuy, () => { if (buyOpen) closeBuy(); else openBuy(); });
// 手机「切 C4 / 拆弹」：切 C4 是点一下，拆弹是按住。
// 下包不走这个键 —— 手里拿着 C4 时它会被收起来，按住开火键才是安放。
bindBtn(ui.bUse, () => {
  if (bomb.phase === 'planted') { input.use = true; return; }
  if (bomb.phase === 'carried' && !isHoldingC4()) switchToC4();
}, () => { input.use = false; });

// 购买菜单：分类 / 购买（事件委托）
if (ui.bmCats) ui.bmCats.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  audio.click();
  buyCat = +b.dataset.cat;
  renderBuy();
});
if (ui.bmItems) ui.bmItems.addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy]');
  if (!b) return;
  buyItem(b.dataset.buy);
});
// 购买菜单右上角 ✕
if (ui.bmClose) ui.bmClose.addEventListener('click', () => { audio.click(); closeBuy(); });
// 暂停菜单：重置本局（按钮已从主菜单移除，保留调试入口 __resetRound）

// ---------------------------------------------------------------- 射击
const raycaster = new THREE.Raycaster();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
let spreadBloom = 0;
let lastShotTime = 0;

function currentSpread(w) {
  if (zoomLevel > 0) return 0;
  const speed = Math.hypot(player.vel.x, player.vel.z);
  const moveK = clamp(speed / 6.5, 0, 1);
  let s = w.def.spread.base + w.def.spread.move * moveK + spreadBloom;
  // 和 CS 1.6 一样：腾空时额外加一大截散布，蹲下时收得更紧
  if (!player.onGround) s = s * 1.6 + 0.018;
  else if (player.crouch) s *= 0.50;
  return clamp(s, 0, w.def.spread.max || 0.06);
}

/** 按 CS 1.6 的弹道表叠加一发后坐力（视角 punch + 枪体后坐） */
function applyRecoil(w, scale = 1) {
  const r = w.def.recoil || {};
  const pat = r.pattern || [[1, 0]];
  const i = Math.min(sprayCount, pat.length - 1);
  const [pm, ym] = pat[i];

  // 纵向：几乎竖直上抬；横向：按弹道表 + 一点点随机抖动
  punch.p += (r.pitch || 0) * pm * DEG * scale;
  punch.y += ((r.yaw || 0) * ym + (Math.random() - 0.5) * (r.yaw || 0) * 0.45) * DEG * scale;

  // 枪体贴图本身的后坐（枪身后挫 + 上跳 + 轻微翻滚）
  w.addRecoil((r.kick || 1) * scale);
  sprayCount++;
}

/** 一发子弹（霰弹枪会有多颗），返回落点 */
function firePellet(spread, holeChance = 1) {
  camera.getWorldDirection(tmpV);
  if (spread > 0) {
    const ang = Math.random() * Math.PI * 2;
    const rad = Math.sqrt(Math.random()) * spread;
    tmpV2.set(1, 0, 0).applyQuaternion(camera.quaternion);
    tmpV3.set(0, 1, 0).applyQuaternion(camera.quaternion);
    tmpV.addScaledVector(tmpV2, Math.cos(ang) * rad).addScaledVector(tmpV3, Math.sin(ang) * rad).normalize();
  }
  raycaster.set(camera.position, tmpV);
  raycaster.far = 300;
  const hits = raycaster.intersectObjects(mapMeshes.length ? mapMeshes : [ground], false);
  if (hits.length && Math.random() <= holeChance) {
    // 命中面法线（局部→世界），弹孔要贴着这个面放
    const h = hits[0];
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    addHole(h.point, n);
    impactFx(h.point, n, (h.object.material && /metal/i.test(h.object.material.name || '')) ? 'metal' : 'wall');
  }
  return hits.length ? hits[0].point : null;
}

// ---------------------------------------------------------------- 抛壳
// 弹壳是实体：在世界里按重力飞出去、落地反弹、停在地上（不再跟着镜头走）
const CASES = [];
const CASE_KIT = {};

function caseMaterial(color, metalness, roughness) {
  // 纯金属材质在只有一盏平行光的场景里会发黑，加一点自发光让铜色看得出来
  return new THREE.MeshStandardMaterial({
    color, metalness, roughness, envMapIntensity: 1,
    emissive: 0x2a1e06, emissiveIntensity: 0.9
  });
}

/**
 * 弹壳规格（真实口径，单位米）。玩家反馈 AK 的壳偏大，所以步枪类整体收了一档，
 * 口径之间也做出区分：手枪短粗、5.56 细长、7.62 更短更粗、.50AE 最粗、.338 最长。
 */
const CASE_SPECS = {
  '9mm':    { len: 0.0190, r: 0.0046, head: 0.0030, neck: 0 },
  '45':     { len: 0.0225, r: 0.0055, head: 0.0032, neck: 0 },
  '57':     { len: 0.0225, r: 0.0047, head: 0.0030, neck: 0 },
  '556':    { len: 0.0390, r: 0.0042, head: 0.0031, neck: 0.0105 },
  '762':    { len: 0.0345, r: 0.0053, head: 0.0034, neck: 0.0080 },
  '50ae':   { len: 0.0290, r: 0.0066, head: 0.0034, neck: 0 },
  '338':    { len: 0.0580, r: 0.0066, head: 0.0042, neck: 0.0160 },
  'shotgun':{ len: 0.0420, r: 0.0067, head: 0.0076, neck: 0, shell: true }
};

/** 武器用哪种弹壳：没写 caseType 就按大类推断 */
function caseTypeOf(def) {
  if (!def) return '9mm';
  if (def.caseType) return def.caseType;
  if (def.noCasing) return null;
  if (def.kind === 'shotgun') return 'shotgun';
  if (def.kind === 'sniper') return '338';
  if (def.kind === 'pistol') return '9mm';
  if (def.kind === 'smg') return '9mm';
  return '556';
}

function buildCaseKit(type) {
  if (CASE_KIT[type]) return CASE_KIT[type];
  const spec = CASE_SPECS[type] || CASE_SPECS['9mm'];
  const L = spec.len;
  const R = spec.r;
  const g = new THREE.Group();
  const brass = caseMaterial(0xdcb057, 0.55, 0.34);
  const brassDark = caseMaterial(0xb98f38, 0.5, 0.40);
  const red = new THREE.MeshStandardMaterial({ color: 0xa8262a, roughness: 0.60, metalness: 0.05 });

  if (spec.shell) {
    // 12 号霰弹：红色塑料壳 + 黄铜底火座 + 大底缘
    const headH = L * 0.26;
    const bodyH = L - headH;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.965, R, bodyH, 14, 1, false), red);
    body.position.y = headH + bodyH / 2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.01, R * 1.01, headH, 14, 1, false), brass);
    base.position.y = headH / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(spec.head / 2, spec.head / 2, L * 0.035, 14, 1, false), brassDark);
    rim.position.y = L * 0.0175;
    g.add(body, base, rim);
    CASE_KIT[type] = { group: g, len: L, radius: R };
  } else {
    // 黄铜药筒：主体 + 收口（步枪）+ 底缘
    const rimH = L * 0.05;
    const neckH = spec.neck;
    const bodyH = L - rimH - neckH;
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(R * (neckH ? 0.88 : 0.96), R, bodyH, 12, 1, false), brass);
    body.position.y = rimH + bodyH / 2;
    g.add(body);
    if (neckH) {
      const neck = new THREE.Mesh(
        new THREE.CylinderGeometry(R * 0.60, R * 0.82, neckH, 12, 1, false), brass);
      neck.position.y = L - neckH / 2;
      g.add(neck);
    }
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.head / 2, spec.head / 2, rimH, 12, 1, false), brassDark);
    rim.position.y = rimH / 2;
    g.add(rim);
    CASE_KIT[type] = { group: g, len: L, radius: spec.head / 2 };
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return CASE_KIT[type];
}

let caseSeq = 0;

/** 抛壳口偏移（单位米，相对相机：r 右正左负 / u 上正下负 / f 前正后负） */
function ejectOffset(def) {
  return (def && def.fix && def.fix.eject) || { r: -0.06, u: 0.02, f: 0.0 };
}

/** 把「视图场景里的抛壳骨坐标」换算成主世界的抛壳点（含 r/u/f 偏移） */
function ejectWorldPoint(gunWorld, def) {
  const right0 = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up0 = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const fwd0 = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const e = ejectOffset(def);
  return gunWorld.clone()
    .applyQuaternion(camera.quaternion)
    .add(camera.position)
    .addScaledVector(right0, e.r)
    .addScaledVector(up0, e.u)
    .addScaledVector(fwd0, e.f);
}

/** 在抛壳口（枪体世界坐标 + 相机空间小偏移）生成一枚实体弹壳 */
function spawnCasing(gunWorld, type, def) {
  if (!type) return;
  const kit = buildCaseKit(type);
  const mesh = kit.group.clone(true);
  // 弹壳大小（调参面板可调，1 = 原始尺寸）
  const cs = (def && def.fix && def.fix.casingScale);
  if (cs != null && cs !== 1) mesh.scale.setScalar(cs);
  const world = ejectWorldPoint(gunWorld, def);
  mesh.position.copy(world);
  mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
  caseSeq++;
  mesh.renderOrder = 2;
  // 整棵子树都搬到弹壳层（layer 2）：最后单独渲染，层级高于枪模型
  mesh.traverse(o => o.layers.set(CASE_LAYER));
  scene.add(mesh);

  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  // 抛壳方向固定往左（还原原版）：不管抛壳点被调到枪身哪一侧，
  // 弹壳一律从视角左侧横向甩出，不再跟着抛壳点左右横跳。
  const side = -1;
  // 往「视角左侧」甩出去：主要是横抛，只有一点点向前
  const vel = right.multiplyScalar(side * (1.05 + Math.random() * 0.45))
    .add(up.multiplyScalar(0.55 + Math.random() * 0.35))
    .add(fwd.multiplyScalar(0.10 + Math.random() * 0.20));

  CASES.push({
    mesh, kit, vel,
    spin: new THREE.Vector3((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30),
    rest: false,
    bounces: 0,
    t: 0,
    life: 28 + Math.random() * 8
  });

  // 地上的弹壳别无限堆积：超过 56 枚先回收最旧的
  if (CASES.length > 56) {
    const old = CASES.shift();
    scene.remove(old.mesh);
  }
}

/** 调参时把青色方框贴到抛壳口位置（跟着枪走），关掉面板就隐藏 */
function updateEjectMarker() {
  if (!ejectMarkerVisible) { ejectMarker.visible = false; return; }
  const w = weapons && weapons.current;
  if (!w || !w.ejectBone || w.def.noCasing) { ejectMarker.visible = false; return; }
  const p = new THREE.Vector3();
  w.ejectBone.updateWorldMatrix(true, false);
  w.ejectBone.getWorldPosition(p);
  // ejectBone 挂在 rig 上，getWorldPosition 直接就是视图场景坐标
  // （viewCamera 在原点、朝 -Z，所以前方是 -Z 方向）
  const e = ejectOffset(w.def);
  ejectMarker.position.set(p.x + e.r, p.y + e.u, p.z - e.f);
  // 真实物体：固定 8cm 实体盒，尺寸不随视角/距离变化——
  // 离得近就按透视自然放大、离得远自然缩小，和世界里摆个真盒子一样。
  ejectMarker.scale.setScalar(1);
  ejectMarker.visible = true;
}

let lastShellSfx = 0;
/**
 * 弹壳落地声。strength 0~1（按撞击速度归一），连发时用 45ms 限流，
 * 否则一批弹壳同时落地会叠成一团噪声。
 */
function playShellLand(strength) {
  const now = performance.now();
  if (now - lastShellSfx < 45) return;
  lastShellSfx = now;
  audio.play('pl_shell1', {
    gain: Math.max(0.08, Math.min(0.42, 0.42 * strength)),
    rate: 0.92 + Math.random() * 0.18
  });
}

/** 弹壳落定后回到普通渲染层：
 *  飞行中弹壳挂在 CASE_LAYER 上「最后单独画」，为的是不被枪身盖住；
 *  但落在地上以后还留在那一层，就会连手臂/枪一起盖过去（穿手）。
 *  落地即归位到 layer 0，让深度测试恢复正常遮挡关系。 */
function settleCasing(mesh) {
  mesh.renderOrder = 0;
  mesh.traverse(o => o.layers.set(0));
}

function updateCasings(dt) {
  if (!CASES.length) return;
  for (let i = CASES.length - 1; i >= 0; i--) {
    const c = CASES[i];
    c.t += dt;
    if (!c.rest) {
      c.vel.y -= 9.8 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;

      const p = c.mesh.position;
      // 落点贴真实地面：斜坡/高台上的弹壳落点有高有低（之前是固定水平面）。
      // 射线从「上一帧位置之上」起打（防穿地：快速下落时 p.y+0.4 可能已在地面之下，
      // 向下的射线打不到头顶地形，弹壳会整颗穿进地里）
      const startY = Math.max(p.y, c.prevY == null ? p.y : c.prevY) + 0.4;
      const g = groundHeightAt(p.x, p.z, startY);
      const floor = (g > -90 ? g : 0) + c.kit.radius * 0.5;
      if (p.y <= floor) {
        c.mesh.position.y = floor;
        // 躺平：圆柱原来的 Y 轴直接对到随机水平方向。
        // 之前用 Euler(PI/2, randomYaw, 0)：默认 XYZ 顺序会先绕自身 Y 转（等于自转），
        // 再绕世界 X 倒下去 —— 所有弹壳最后都朝着同一个方向。改成四元数后每颗朝向都不同。
        const flatA = Math.random() * Math.PI * 2;
        _caseAxis.set(Math.cos(flatA), 0, Math.sin(flatA));
        c.mesh.quaternion.setFromUnitVectors(_upY, _caseAxis);
        c.mesh.rotateY(Math.random() * Math.PI * 2);     // 绕弹壳自身轴随机滚一点
        if (Math.abs(c.vel.y) > 0.8) {
          // 弹壳砸到地上：按撞击速度决定音量，越弹越轻；最多响 3 次
          const vy = Math.abs(c.vel.y);
          if (c.bounces < 3) playShellLand(vy / 3.5);
          c.bounces++;
          c.vel.y *= -0.32;
          c.vel.x *= 0.55;
          c.vel.z *= 0.55;
          c.spin.multiplyScalar(0.35);
        } else {
          c.vel.set(0, 0, 0);
          c.spin.set(0, 0, 0);
          if (!c.rest) settleCasing(c.mesh);   // 落定 → 交回普通深度层
          c.rest = true;
        }
      }
      c.prevY = p.y;
    }
    if (c.t > c.life) {
      scene.remove(c.mesh);
      CASES.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- 丢枪（原版 drop）
// CS1.6 的地面枪本来就是 w_ 低模：这里按武器类型程序化生成同风格的低模
// （枪管沿 +X、厚度沿 Y——落地把旋转归零就是「侧面向上平躺在地上」）。
const WGEN = {
  ak47: { L: 0.82, body: 0x3a3d42, acc: 0x6b4a2f },   // 木护木
  m4a1: { L: 0.80, body: 0x2e3238, acc: 0x2e3238 },
  sg552: { L: 0.66, body: 0x33383e, acc: 0x24272c },
  aug: { L: 0.66, body: 0x4a5340, acc: 0x39402f },
  awp: { L: 1.05, body: 0x46584a, acc: 0x2e3238 },
  scout: { L: 0.94, body: 0x3f4a3c, acc: 0x2b2f33 },
  m3: { L: 0.92, body: 0x33363b, acc: 0x5c4530 },     // 木托
  mp5: { L: 0.55, body: 0x2b2e33, acc: 0x1f2226 },
  mac10: { L: 0.45, body: 0x33363b, acc: 0x26292e },
  mac10t: { L: 0.45, body: 0x33363b, acc: 0x26292e },   // 单手版：地面低模沿用 MAC-10 的
  tec9: { L: 0.30, body: 0x2b2e33, acc: 0x1f2226 },
  tmp: { L: 0.42, body: 0x2f3237, acc: 0x24272b },
  ump45: { L: 0.52, body: 0x33373c, acc: 0x1f2226 },
  m249: { L: 0.95, body: 0x3c4046, acc: 0x2b2e33 },
  deagle: { L: 0.25, body: 0x8e959c, acc: 0x2b2e33 },
  glock18: { L: 0.20, body: 0x2b2e33, acc: 0x222529 },
  usp: { L: 0.21, body: 0x33363b, acc: 0x26292e },
  fiveseven: { L: 0.22, body: 0x33383e, acc: 0x26292e },
  revolver: { L: 0.24, body: 0x777d84, acc: 0x5c4530 },
};
const _dropMats = new Map();
function dropMat(c) {
  if (!_dropMats.has(c)) _dropMats.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: .8, metalness: .25 }));
  return _dropMats.get(c);
}
function buildDropMesh(id) {
  const def = WEAPON_BY_ID[id];
  const spec = WGEN[id] || { L: 0.7, body: 0x33363b, acc: 0x26292e };
  const pistol = def && def.kind === 'pistol';
  const L = spec.L, t = Math.max(0.022, L * 0.10), h = L * 0.16;
  const g = new THREE.Group();
  const add = (sx, sy, sz, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), dropMat(c));
    m.position.set(x, y, z);
    g.add(m);
  };
  add(L * 0.40, t, h, -L * 0.05, 0, 0, spec.body);              // 机匣
  add(L * 0.46, t * 0.5, h * 0.28, L * 0.38, h * 0.10, 0, 0x1c1e21);  // 枪管
  add(L * 0.10, t * 0.7, h * 0.55, -L * 0.16, -h * 0.40, 0, spec.acc); // 握把
  if (!pistol) {
    add(L * 0.16, t * 0.6, h * 0.5, 0, -h * 0.45, 0, 0x1c1e21);       // 弹匣
    add(L * 0.30, t * 0.6, h * 0.42, -L * 0.36, -h * 0.05, 0, spec.acc); // 枪托
  }
  if (def && def.kind === 'rifle' && id === 'm249') add(L * 0.24, t * 0.9, h * 0.5, -L * 0.05, -h * 0.55, 0, 0x2b2e33); // 弹箱
  return g;
}

const DROPPED = [];
const KIND_HEAVY = { rifle: 1, sniper: 1, shotgun: 1, mg: 1, smg: 1 };
// ---- 地面枪模型：用 w_ 系列（CS1.6 的 w_ 世界模型，单位≈2.54cm，枪口沿 +X）----
// 缺模型的枪自动退回程序化低模（MAC-10 的地面模型复用 w_mac10）。
const WGLB = {};   // id -> Promise<gltf> | null（null = 没有 w_ 模型）
const WGRETRY = {}; // id -> 已重试次数
const WGEN_W = new Set(['ak47', 'aug', 'awp', 'deagle', 'fiveseven', 'glock18',
  'm249', 'm3', 'm4a1', 'mac10', 'mac10t', 'mp5', 'revolver', 'scout', 'sg552', 'usp',
  'tec9', 'tmp', 'ump45', 'c4', 'remington', 'beretta92']);
// 各把 w_ 模型在 XZ 平面上的「歪斜」角度（度）。这批 CS1.6 世界模型导出来每把枪
// 绕 Y 的朝向都不一样，不转正的话：摆在地上是斜的，挂到 AI 手上更是歪的。
// 数值是用「顶点投影到 XZ 后，求让包围盒面积最小的转角」离线扫出来的（tools/gun-yaw.py），
// 转完统一成：枪管 +X、枪身高度 +Z、厚度 Y。
const W_YAW = {
  ak47: 164, m4a1: 34, sg552: 132, aug: 141, mp5: 99, tmp: 137, ump45: 22,
  mac10: 58, m3: 143, awp: 154, scout: 15, remington: 16, m249: 8,
  glock18: 163, usp: 27, deagle: 162, fiveseven: 39, revolver: 11,
  beretta92: 27, tec9: 270,
};
const _waxisV = new THREE.Vector3();
function loadWorldGun(id) {
  if (!WGLB.hasOwnProperty(id)) {
    if (!WGEN_W.has(id)) { WGLB[id] = null; return null; }
    // 单手版没有自己的 w_ 模型：地面模型直接用 MAC-10 那份
    const wfile = id === 'mac10t' ? 'mac10' : id;
    WGLB[id] = new Promise((res) => {
      // 带版本参数：防止浏览器复用之前失败/404 的缓存
      loader.load(`./assets/models/w_${wfile}.glb?v=r90`, (g) => {
        // 这些 w_ 模型是单骨骼蒙皮：几何顶点在绑定空间里被骨骼姿势压得很小
        // （实测 AK 渲染出来只有 2.3cm，看着像根"滚木"）——这里把蒙皮结果
        // 烘焙成普通静态网格，再按武器类型归一到真实尺寸。
        g.scene.updateMatrixWorld(true);
        const out = new THREE.Group();
        let maxDim = 0;
        const parts = [];
        g.scene.traverse(o => {
          if (!o.isMesh) return;
          let geo, mat;
          if (o.isSkinnedMesh) {
            const sk = o;
            sk.skeleton.update();
            const g2 = sk.geometry.index ? sk.geometry.toNonIndexed() : sk.geometry;
            const p = g2.attributes.position;
            const ji = g2.attributes.skinIndex, jw = g2.attributes.skinWeight;
            const bm = sk.skeleton.boneMatrices;        // bone.matrixWorld * boneInverse
            const bindE = sk.bindMatrix.elements;
            const bindInvE = sk.bindMatrixInverse.elements;
            const n = p.count;
            const arr = new Float32Array(n * 3);
            const v = new THREE.Vector3();
            for (let i = 0; i < n; i++) {
              // 绑定空间顶点（齐次 w=1）
              v.fromBufferAttribute(p, i).applyMatrix4(sk.bindMatrix);
              const wx = v.x, wy = v.y, wz = v.z;
              let ox = 0, oy = 0, oz = 0, ow = 0;
              for (let k = 0; k < 4; k++) {
                const bidx = ji.getComponent(i, k);
                const bw = jw.getComponent(i, k);
                if (bw === 0) continue;
                const off = bidx * 16;
                ox += bw * (bm[off]      * wx + bm[off + 4]  * wy + bm[off + 8]   * wz + bm[off + 12]);
                oy += bw * (bm[off + 1]  * wx + bm[off + 5]  * wy + bm[off + 9]   * wz + bm[off + 13]);
                oz += bw * (bm[off + 2]  * wx + bm[off + 6]  * wy + bm[off + 10]  * wz + bm[off + 14]);
                ow += bw * (bm[off + 3]  * wx + bm[off + 7]  * wy + bm[off + 11]  * wz + bm[off + 15]);
              }
              // 回到 mesh 绑定空间，再烘到 gltf 场景空间
              v.set(ox / (ow || 1), oy / (ow || 1), oz / (ow || 1)).applyMatrix4(sk.bindMatrixInverse);
              v.applyMatrix4(sk.matrixWorld);
              arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z;
            }
            geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
            if (g2.attributes.uv) geo.setAttribute('uv', g2.attributes.uv.clone());
            geo.computeVertexNormals();
            mat = o.material;
          } else {
            geo = o.geometry.clone();
            geo.applyMatrix4(o.matrixWorld);
            mat = o.material;
          }
          const m = new THREE.Mesh(geo, mat);
          m.frustumCulled = false;
          m.castShadow = false;
          m.receiveShadow = false;
          parts.push(m);
        });
        // 零件先放进 inner：朝向修正转 inner，out 保持单位变换，
        // 这样后面按世界包围盒居中/缩放都不会算错
        const inner = new THREE.Group();
        out.add(inner);
        for (const m of parts) inner.add(m);
        out.updateMatrixWorld(true);
        // ---- 朝向归一 ----
        // 绝大多数 w_ 模型是「枪管沿 +X、厚度沿 Y、枪身高度沿 Z」，落地只转 yaw 就平躺；
        // 但个别模型（Tec-9）导出来是「枪管沿 Z、高度沿 Y」——直接摆到地上就是立着的。
        // 这种模型绕 (1,1,1) 转 120°：X→Y、Y→Z、Z→X，正好把枪管转到 X、厚度转到 Y（躺平）。
        {
          const b0 = new THREE.Box3().setFromObject(out);
          const s0 = b0.getSize(new THREE.Vector3());
          if (s0.z > s0.x * 1.15 && s0.y > s0.x * 1.15) {
            inner.quaternion.setFromAxisAngle(new THREE.Vector3(1, 1, 1).normalize(), Math.PI * 2 / 3);
            out.updateMatrixWorld(true);
          }
        }
        // 绕 Y 转正到「枪管 +X」（见 W_YAW 表）
        {
          const yw = W_YAW[id] || 0;
          if (yw) {
            inner.rotateY(yw * Math.PI / 180);   // three 的 +Y 旋转把 +X 转向 -Z，这里的角度是扫出来的「反向」
            out.updateMatrixWorld(true);
          }
        }
        // 按武器类型归一到真实尺寸（枪长：手枪 0.25 / 冲锋枪 0.55 / 步枪 0.85 /
        // 霰弹 0.92 / 狙击 1.05 / 机枪 0.95 米）；个别枪（Tec-9）用 def.dropLen 单独给
        const def = WEAPON_BY_ID[id];
        const target = (def.dropLen || { pistol: 0.25, smg: 0.55, rifle: 0.85, shotgun: 0.92, sniper: 1.05, mg: 0.95 }[def.kind] || 0.8);
        const box = new THREE.Box3().setFromObject(inner);
        const size = box.getSize(new THREE.Vector3());
        const dim = Math.max(size.x, size.y, size.z) || 1;
        out.scale.setScalar(target / dim);
        // 包围盒中心移到原点（翻转/贴地都绕原点算）。
        // 偏移要加在 inner.position 上（out 未缩放空间的坐标），
        // 之前把「乘过 scale 的中心」减到零件局部坐标里，等于没减。
        inner.position.sub(box.getCenter(new THREE.Vector3()));
        res(out);
      }, undefined, () => {
        // 加载失败：允许稍后重试（最多 3 次），避免一次网络抖动就永远用低模
        WGLB[id] = null;
        WGRETRY[id] = (WGRETRY[id] || 0) + 1;
        if (WGRETRY[id] <= 6) setTimeout(() => { delete WGLB[id]; loadWorldGun(id); }, 1500 + WGRETRY[id] * 1200);
        res(null);
      });
    });
  }
  return WGLB[id];
}

/** 把（已准备好的）枪 mesh 在玩家手上生成实体并抛出 */
function spawnDrop(mesh, id, ammoState) {
  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  const fx = -sin, fz = -cos;                    // 玩家前方
  mesh.position.set(
    player.pos.x + fx * 0.45 + cos * 0.18,
    player.pos.y + 1.2,
    player.pos.z + fz * 0.45 - sin * 0.18
  );
  // 枪口沿 +X（低模同样按 +X 枪管构造）：转 yaw+90° 让枪口指向玩家前方
  mesh.rotation.set(0, player.yaw + Math.PI / 2, 0);
  const heavy = !!KIND_HEAVY[WEAPON_BY_ID[id] && WEAPON_BY_ID[id].kind];
  const speed = (heavy ? 2.6 : 3.0) + Math.random() * 0.6;
  // 原版 CS1.6：枪丢出去在空中就是平躺的，只走抛物线，不翻滚
  DROPPED.push({
    mesh,
    vel: new THREE.Vector3(fx * speed, (heavy ? 1.55 : 1.9) + Math.random() * 0.3, fz * speed),
    rest: false, bounces: 0, t: 0, life: 90, id,
    model: id !== 'fallback-lowpoly',
    low: !WGEN_W.has(id),
    // 弹药跟着枪一起落地：捡回来时按这份数据恢复，不会再变成满弹
    ammo: ammoState ? ammoState.ammo : null,
    reserve: ammoState ? ammoState.reserve : null,
  });
  scene.add(mesh);
  const item = DROPPED[DROPPED.length - 1];
  if (DROPPED.length > 12) {
    const old = DROPPED.shift();
    scene.remove(old.mesh);
  }
  return item;
}

/** 把地上的低模换成 w_ 真模型。模型没就绪（加载中/失败重试中）就一直等，
 *  直到换成真模型为止——之前的写法只等一次，那次失败（比如手机显存不足）
 *  这具尸体就永远是低模了。 */
function upgradeDrop(d, id, attempt) {
  if (!WGEN_W.has(id)) return;                   // 这把枪本来就没有 w_ 模型
  const p = loadWorldGun(id);
  if (!p) {
    // 上一次加载失败留下的 null：清掉缓存重来
    if (attempt < 10) setTimeout(() => { delete WGLB[id]; upgradeDrop(d, id, attempt + 1); }, 1200 + attempt * 700);
    return;
  }
  p.then((scene3) => {
    if (!d || !d.mesh || !d.mesh.parent || d.upgraded) return;
    if (!scene3) {                               // 这次没拿到 → 稍后再试
      if (attempt < 10) setTimeout(() => upgradeDrop(d, id, attempt + 1), 1200 + attempt * 700);
      return;
    }
    d.mesh.clear();                              // 去掉低模盒子
    d.mesh.add(scene3.clone(true));              // 换成真模型（同一物理体）
    d.low = false;
    d.upgraded = true;
  }).catch(() => {
    if (attempt < 10) setTimeout(() => upgradeDrop(d, id, attempt + 1), 1200 + attempt * 700);
  });
}

/** 丢枪：先用低模立刻生成实体（丢出瞬间一定有可见的枪 + 下落动画，
 *  任何情况下都不会"凭空消失"），w_ 模型就绪后再无缝替换外观。
 *  ammoState：{ ammo, reserve } —— 丢出去时枪里/背包里还剩多少，捡回来就还是多少。 */
function dropWeaponWorld(id, ammoState) {
  const def = WEAPON_BY_ID[id];
  if (!def || def.kind === 'melee' || def.kind === 'grenade') return;
  const d = spawnDrop(buildDropMesh(id), id, ammoState);
  upgradeDrop(d, id, 0);
}

// 开局后台把 14 把枪的 w_ 模型逐把预热进内存（一把一把来，别和地图抢带宽），
// 这样玩家真丢枪时模型早就在内存里，不会出现"丢出去只有低模"。
let _wgWarmed = false;
function preloadWorldGuns() {
  if (_wgWarmed) return;
  _wgWarmed = true;
  const ids = [...WGEN_W];
  let i = 0;
  const step = () => {
    if (i >= ids.length) return;
    const id = ids[i++];
    loadWorldGun(id);
    setTimeout(step, 240);
  };
  setTimeout(step, 1500);
}

function updateDropped(dt) {
  if (!DROPPED.length) return;
  for (let i = DROPPED.length - 1; i >= 0; i--) {
    const d = DROPPED[i];
    d.t += dt;
    if (!d.rest) {
      d.vel.y -= 11 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      const p = d.mesh.position;
      // 落点检测：射线从「上一帧位置之上」起打（和玩家移动同一套防穿地逻辑）。
      // 之前起点用 p.y+0.5：枪快速下落 / 飞进坡地时起点会落到地面之下，
      // 向下的射线打不到头顶的地形 → 整把枪穿进地里（看不见也捡不着）。
      const startY = Math.max(p.y, d.prevY == null ? p.y : d.prevY) + 0.5;
      const g = groundHeightAt(p.x, p.z, startY);
      if (g > -90) d.groundY = g;              // 记录最近见过的有效地面（兜底用）
      // 绝对兜底：枪掉到地图下方（理论上防穿地后不会发生），直接放回最后见过的地面
      if (d.groundY != null && p.y < d.groundY - 3) {
        p.y = d.groundY + 0.045;
        d.vel.set(0, 0, 0);
        d.mesh.rotation.set(0, Math.random() * Math.PI * 2, 0);
        d.rest = true;
      }
      if (g > -90 && p.y <= g + 0.045) {
        p.y = g + 0.045;
        if (Math.abs(d.vel.y) > 1.5 && d.bounces < 1) {
          d.vel.y *= -0.18;
          d.vel.x *= 0.32;
          d.vel.z *= 0.32;
          d.bounces++;
          audio.play('pl_shell1', { gain: 0.16, rate: 0.65 + Math.random() * 0.2 });
        } else {
          // 全程就平躺着，落地直接停住（原版行为：不翻转、不改朝向）
          d.vel.set(0, 0, 0);
          d.rest = true;
        }
      }
      d.prevY = p.y;
    } else {
      d.restT = (d.restT || 0) + dt;
      // ---- 自动捡起（CS1.6 规则）：站在枪上，且对应物品栏是空的才捡 ----
      // 刚落地有 0.5s 缓冲：丢出去的枪不会一落地就被自己瞬间捡回来
      if (d.restT > 0.5) {
      d.pickT = (d.pickT || 0) + dt;
      if (d.pickT > 0.12) {
        d.pickT = 0;
        const dx = player.pos.x - d.mesh.position.x;
        const dz = player.pos.z - d.mesh.position.z;
        const dy = player.pos.y - d.mesh.position.y;
        if (dx * dx + dz * dz < 0.56 && dy > -1.4 && dy < 1.6) {
          const def = WEAPON_BY_ID[d.id];
          const cat = catOf(def);
          if (cat === 'primary' || cat === 'secondary') {
            const hasSame = [...owned].some(oid => catOf(WEAPON_BY_ID[oid]) === cat);
            if (!hasSame) {
              owned.add(d.id);
              // 弹药跟着地上的枪走：捡回来沿用掉落时记录的弹匣/备弹。
              // 这里不能再调 resetAmmo() —— 那会把所有枪（包括身上这把）刷成满弹，
              // 就是「丢出去再捡回来子弹又满了」的根因。
              const wobj = weapons && weapons.weapons.find(x => x.def.id === d.id);
              if (wobj) {
                wobj.ammo = d.ammo != null ? Math.max(0, Math.min(d.ammo, def.magSize)) : def.magSize;
                wobj.reserve = d.reserve != null ? Math.max(0, Math.min(d.reserve, def.reserve)) : def.reserve;
              }
              renderSlots();
              const idx = weapons && weapons.weapons.findIndex(x => x.def.id === d.id);
              if (idx >= 0) weapons.equip(idx);
              audio.play('gunpickup', { gain: 0.85 });   // 原版捡枪提示音
              showHint(`捡起了 ${def.name}`);
              scene.remove(d.mesh);
              DROPPED.splice(i, 1);
              refreshHUD(true);
              continue;
            }
          }
        }
      }
      }
    }
    if (d.t > d.life) {
      scene.remove(d.mesh);
      DROPPED.splice(i, 1);
    }
  }
}

/** 玩家丢当前枪（G 键 / 手机「丢枪」按钮）。原版规则：刀不能丢、丢完自动切下一把 */
function dropCurrentWeapon() {
  if (!gameStarted || player.dead || inPrep() || buyOpen) return;
  const w = weapons && weapons.current;
  if (!w) return;
  const def = w.def;
  if (def.kind === 'melee' || def.kind === 'grenade') {
    showHint(def.kind === 'melee' ? '刀不能丢' : '手雷是直接扔出去的');
    return;
  }
  // C4：随时可以丢（丢在地上后走过去还能捡回来）
  if (def.kind === 'c4') { dropBomb(); return; }
  dropWeaponWorld(def.id, { ammo: w.ammo, reserve: w.reserve });
  owned.delete(def.id);
  // 只清空被丢掉这把的弹药。不能调 resetAmmo()：那会把身上其它枪一起补满
  // （丢一把枪=给另一把免费补弹，之前「丢枪子弹回满」的另一半根因）。
  w.ammo = 0;
  w.reserve = 0;
  renderSlots();
  weapons.switchNext();
  audio.click();
  refreshHUD(true);
}

// ---------------------------------------------------------------- 投掷物
const projectiles = [];
const grenadeEffects = [];
const G_SPHERE = new THREE.SphereGeometry(0.085, 14, 10);
const G_MATS = {
  he: new THREE.MeshStandardMaterial({ color: 0x46523a, roughness: 0.75, metalness: 0.35 }),
  flash: new THREE.MeshStandardMaterial({ color: 0x6b7078, roughness: 0.50, metalness: 0.70 }),
  smoke: new THREE.MeshStandardMaterial({ color: 0x3f4a35, roughness: 0.80, metalness: 0.20 })
};
// 粒子贴图（程序生成，不占资源）
const TEX = { glow: null, smoke: null, spark: null, scorch: null };

function radialTex(stops, size = 128) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [p, col] of stops) grd.addColorStop(p, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function smokeTex() {
  // 一团软边烟：中心亮、边缘碎，靠多次叠加做出体积感
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const r = 18 + Math.random() * 26;
    const x = size / 2 + (Math.random() - 0.5) * 34;
    const y = size / 2 + (Math.random() - 0.5) * 34;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.30)');
    grd.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
  }
  // 中心再补一层，避免中间发空
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.5);
  grd.addColorStop(0, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * 世界场景特效预编译：手雷模型、爆炸 sprite/冲击环的材质在首次渲染时才编 shader，
 * SwiftShader 上就是投出/爆炸瞬间的 200~300ms 卡顿。加载完在这里全部过一遍 renderer.compile。
 */
function precompileWorldFx() {
  try {
    initFxTextures();
    const temps = [];
    // 手雷弹体（用视模型烘焙时的同一批材质实例）
    if (weapons) {
      for (const w of weapons.weapons) {
        const proj = w.projectile;
        if (!proj || !proj.parts) continue;
        for (const part of proj.parts) {
          const m = new THREE.Mesh(part.geo, part.mat);
          m.visible = true;
          m.position.set(0, -100, 0);   // 放到镜头外，不影响画面
          scene.add(m); temps.push(m);
        }
      }
    }
    // 爆炸 sprite / 冲击环 / 扬尘（参数与 explode() 里一致，命中同一份 program cache）
    const mkSprite = (tex, color, blending) => {
      const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0.5, depthWrite: false, blending, fog: false });
      const s = new THREE.Sprite(m);
      s.visible = true;
      s.position.set(0, -100, 0);
      scene.add(s); temps.push(s);
    };
    mkSprite(TEX.glow, 0xffd08a, THREE.AdditiveBlending);
    mkSprite(TEX.spark, 0xffd27a, THREE.AdditiveBlending);
    mkSprite(TEX.smoke, 0xd8ccb6, THREE.NormalBlending);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xffcf86, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.visible = true;
    ring.position.set(0, -100, 0);
    scene.add(ring); temps.push(ring);
    // C4 焦痕（带贴图的 MeshBasic + polygonOffset，是另一份 program）
    const sc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 16),
      new THREE.MeshBasicMaterial({ map: TEX.scorch, color: 0x1c1712, transparent: true, opacity: 0.5, depthWrite: false })
    );
    sc.visible = true;
    sc.position.set(0, -100, 0);
    scene.add(sc); temps.push(sc);
    renderer.compile(scene, camera);
    // 真实绘制一帧：让纹理也上传到 GPU（compile 只编 program 不传纹理）
    renderer.render(scene, camera);
    for (const o of temps) scene.remove(o);
  } catch (e) { console.warn('[fx] 预编译失败(不影响运行)', e); }
}

function initFxTextures() {
  if (TEX.glow) return;
  TEX.glow = radialTex([
    [0, 'rgba(255,246,214,1)'],
    [0.16, 'rgba(255,206,110,0.95)'],
    [0.38, 'rgba(255,140,40,0.72)'],
    [0.68, 'rgba(226,74,12,0.28)'],
    [1, 'rgba(180,40,0,0)']
  ]);
  TEX.spark = radialTex([
    [0, 'rgba(255,255,235,1)'],
    [0.4, 'rgba(255,200,110,0.8)'],
    [1, 'rgba(255,120,30,0)']
  ], 64);
  TEX.smoke = smokeTex();
  TEX.scorch = scorchTex();
}

/** 地面焦痕：中心浓、边缘碎，中间留几处透亮，看着像被烧穿 */
function scorchTex() {
  const size = 192;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  for (let i = 0; i < 42; i++) {
    const a = Math.random() * 6.283;
    const d = Math.pow(Math.random(), 0.7) * size * 0.40;
    const x = size / 2 + Math.cos(a) * d;
    const y = size / 2 + Math.sin(a) * d;
    const r = 12 + Math.random() * 30;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const k = 1 - d / (size * 0.45);
    grd.addColorStop(0, `rgba(255,255,255,${0.30 + 0.4 * Math.max(0, k)})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
  }
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.48);
  grd.addColorStop(0, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sprite(tex, color, blending = THREE.NormalBlending) {
  const m = new THREE.SpriteMaterial({
    map: tex, color, transparent: true, opacity: 0,
    depthWrite: false, blending, fog: false
  });
  const s = new THREE.Sprite(m);
  s.visible = false;
  scene.add(s);
  return s;
}

let grenadeSeq = null;

function throwGrenade(w, now) {
  if (grenadeSeq) return;
  // 拔枪动画没播完也能直接扔（低帧率下拔枪会拖到 2s，按了没反应最难受）
  if ((w.ammo || 0) <= 0) return;
  if (w.state === 'reload' || w.state === 'silencer') return;
  if (now < w.nextFire) return;
  const g = w.def.grenade;
  if (!g) return;
  grenadeSeq = { w, phase: 'pin', tossed: false, t0: performance.now() / 1000 };
  w.ammo = Math.max(0, w.ammo - 1);
  // 拉栓 → 掷出，两段动作串起来
  w.play(g.pin, { state: 'fire', fade: 0.06, force: true });
  // 颗数变了：物品栏里这颗雷要么数字减少、要么整格消失（之前不刷新，
  // 扔完最后一颗后物品栏里还挂着一个已经空了的投掷物）
  renderSlots();
  refreshHUD(true);
}

function updateGrenade(dt) {
  if (!grenadeSeq) return;
  const { w } = grenadeSeq;
  const g = w.def.grenade;
  // 用真实时间推进：低帧率下也不会把整套动作拖长
  const now = performance.now() / 1000;
  const el = now - grenadeSeq.t0;

  if (grenadeSeq.phase === 'pin') {
    if (el >= 0.92) {
      grenadeSeq.phase = 'toss';
      grenadeSeq.t0 = now;
      w.play(g.toss, { state: 'fire', fade: 0.08, force: true });
    }
    return;
  }
  if (grenadeSeq.phase === 'toss') {
    const e2 = now - grenadeSeq.t0;
    if (!grenadeSeq.tossed && e2 >= 0.26) {
      spawnGrenade(w);
      grenadeSeq.tossed = true;
    }
    if (e2 >= 0.80) endGrenadeThrow(w);
  }
}

function endGrenadeThrow(w) {
  grenadeSeq = null;
  w.state = 'idle';
  renderSlots();
  // 只有「手里还拿着这颗扔完的雷」才需要换枪；中途自己切走了就别抢玩家的操作
  const cur = weapons && weapons.current;
  if (!cur || cur.def.id !== w.def.id) return;
  // 优先切回切雷之前那把；那把也不可用时按 主武器 → 副武器 → 刀 兜底。
  // （以前这里写死 switchToSlot(1)：只带手枪+雷的时候切不回去，
  //   结果扔完最后一颗还举着空手雷站在原地）
  const i = weapons.weapons.indexOf(w);
  const ok = (idx) => idx >= 0 && idx !== i && weapons.allows(weapons.weapons[idx]);
  let target = ok(weapons.lastIndex) ? weapons.lastIndex : -1;
  if (target < 0) {
    for (const cat of ['primary', 'secondary', 'melee']) {
      const idx = weapons.weapons.findIndex(x => catOf(x.def) === cat && ok(weapons.weapons.indexOf(x)));
      if (idx >= 0) { target = idx; break; }
    }
  }
  if (target >= 0) weapons.equip(target);
  else w.hide();                            // 实在没别的枪：至少把空手雷收起来
}

/** 扔出去的手雷：用视模型里烘焙出来的真模型（顶盖 / 拉环 / 弹体） */
function spawnGrenade(w) {
  const def = w.def;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // 从身前 1m 处开始飞：视模型的“手”离镜头只有 30cm，在原地生成会在镜头前糊一大块
  const pos = camera.position.clone().addScaledVector(dir, 1.0);
  pos.y -= 0.16;

  const group = new THREE.Group();
  const proj = w.projectile;
  if (proj && proj.parts && proj.parts.length) {
    for (const part of proj.parts) {
      const m = new THREE.Mesh(part.geo, part.mat);
      m.frustumCulled = false;
      group.add(m);
    }
  } else {
    group.add(new THREE.Mesh(G_SPHERE, G_MATS[def.grenade.type] || G_MATS.he));
  }
  group.position.copy(pos);
  group.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
  scene.add(group);

  const vel = dir.clone().multiplyScalar(def.grenade.speed);
  vel.y += 2.6;
  projectiles.push({
    mesh: group, vel, def, w,
    spin: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
    radius: (w.projectile && w.projectile.radius) || 0.085,
    expireAt: performance.now() / 1000 + def.grenade.fuse
  });
}

function updateProjectiles(dt) {
  const tnow = performance.now() / 1000;
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    const pdt = Math.min(0.06, p.last ? tnow - p.last : dt);
    p.last = tnow;
    p.vel.y -= 9.8 * pdt;
    const x0 = p.mesh.position.x, z0 = p.mesh.position.z;
    p.mesh.position.addScaledVector(p.vel, pdt);
    p.mesh.rotation.x += p.spin.x * pdt;
    p.mesh.rotation.y += p.spin.y * pdt;
    p.mesh.rotation.z += p.spin.z * pdt;
    // 撞墙反弹（水平），避免手雷穿墙飞出去
    if (p.mesh.position.y > -0.5) {
      const feet = p.mesh.position.y;
      if (blockedMove(x0, z0, p.mesh.position.x, p.mesh.position.z, feet)) {
        p.mesh.position.x = x0;
        p.mesh.position.z = z0;
        p.vel.x *= -0.45;
        p.vel.z *= -0.45;
        p.spin.multiplyScalar(0.7);
      }
    }
    // 真实地面高度（之前固定 y=0.085：低地丢会悬在半空、台地丢会穿过地面）
    const gStart = Math.max(p.mesh.position.y, p.prevY == null ? p.mesh.position.y : p.prevY) + 0.5;
    const gY = groundHeightAt(p.mesh.position.x, p.mesh.position.z, gStart);
    if (gY > -90) p.groundY = gY;
    const floor = (p.groundY != null ? p.groundY : 0) + p.radius;
    if (p.mesh.position.y < floor) {
      p.mesh.position.y = floor;
      p.vel.y *= -0.42;
      p.vel.x *= 0.68;
      p.vel.z *= 0.68;
      p.spin.multiplyScalar(0.6);
      if (Math.abs(p.vel.y) < 0.7) p.vel.y = 0;
    }
    p.prevY = p.mesh.position.y;
    if (performance.now() / 1000 >= p.expireAt) {
      explode(p.def, p.mesh.position.clone(), p.w);
      scene.remove(p.mesh);
      projectiles.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- 爆炸伤害（投掷物通用）
/**
 * 可受伤实体表。目前场上只有玩家自己（AI 还没做）。
 * 手雷 / 闪光弹统一按这张表结算：以后加 bot 只要 push 一个
 * { pos, team, dead, takeDamage(dmg, x, z, cause) } 进来，就能直接吃到投掷物伤害。
 */
const actors = [];
const playerActor = {
  get pos() { return player.pos; },
  get team() { return playerTeam; },
  get dead() { return player.dead || !gameStarted; },
  takeDamage(dmg, x, z, cause) { damagePlayer(dmg, x, z, cause); },
};
actors.push(playerActor);

/**
 * 爆炸视线遮挡：只认接近竖直的面（墙）。地板/斜坡不挡爆炸伤害，
 * 否则爆点比脚底低时（台阶下、沟里）射线必然穿过地板，永远打不到。
 * 0.35m 内的命中算「起点贴在几何体上」，直接忽略。
 */
const _blastN = new THREE.Vector3();
function blastBlocked(from, to) {
  const hdir = to.clone().sub(from);
  const reach = hdir.length();
  if (reach < 0.02) return false;
  hdir.multiplyScalar(1 / reach);
  raycaster.set(from, hdir);
  raycaster.far = reach;
  const wh = raycaster.intersectObjects(mapMeshes.length ? mapMeshes : [ground], false);
  for (const h of wh) {
    if (h.distance <= 0.35 || h.distance >= reach - 0.25) continue;
    if (!h.face) continue;
    _blastN.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    if (Math.abs(_blastN.y) < 0.7) return true;
  }
  return false;
}

/** 圆形爆炸伤害：距离越近越疼（平方衰减），墙后无伤 */
function blastDamage(pos, { radius = 8, maxDamage = 100, minDamage = 1, cause = '爆炸' } = {}) {
  let hits = 0;
  for (const a of actors) {
    if (!a || a.dead) continue;
    const feet = a.pos;
    const d = feet.distanceTo(pos);
    if (d >= radius) continue;
    // 射线从胸口打：脚底嵌在地面网格里，从脚底起打会命中距离 0 被误判成墙
    const chest = feet.clone().add(new THREE.Vector3(0, 0.55, 0));
    if (blastBlocked(chest, pos)) continue;
    const k = 1 - d / radius;
    const dmg = Math.round(minDamage + (maxDamage - minDamage) * k * k);
    a.takeDamage(dmg, pos.x, pos.z, cause);
    hits++;
  }
  return hits;
}

/** 爆炸 / 烟雾 / 闪光：全部用 sprite 粒子 + 冲击环 + 灯光，分层做体积感 */
function explode(def, pos, w) {
  initFxTextures();
  const g = def.grenade;
  audio.play(def.sfx && def.sfx.explode);

  if (g.type === 'he') {
    // 1) 核心火球（加色叠加，先炸开再熄灭）
    const core = sprite(TEX.glow, 0xffd08a, THREE.AdditiveBlending);
    core.position.copy(pos).add(new THREE.Vector3(0, 0.55, 0));
    core.scale.setScalar(0.7);
    grenadeEffects.push({ kind: 'fire', s: core, t: 0, dur: 0.40, from: 0.6, to: 3.6, a0: 0.95, rise: 0.5 });

    // 2) 外层橘红火团（慢一点、更大、更淡）
    const outer = sprite(TEX.glow, 0xff5a12, THREE.AdditiveBlending);
    outer.position.copy(pos).add(new THREE.Vector3(0, 0.8, 0));
    outer.scale.setScalar(1.0);
    grenadeEffects.push({ kind: 'fire', s: outer, t: -0.05, dur: 0.62, from: 0.9, to: 5.4, a0: 0.66, rise: 1.0 });

    // 3) 火星（小点，带重力，四散）
    // 贴地焦痕（烧黑的地面印子，慢慢淡出）
    const scorch = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 24),
      new THREE.MeshBasicMaterial({ color: 0x1a1512, transparent: true, opacity: 0.55, depthWrite: false })
    );
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.copy(pos).add(new THREE.Vector3(0, 0.03, 0));
    scene.add(scorch);
    grenadeEffects.push({ kind: 'scorch', mesh: scorch, t: 0, dur: 22, a0: 0.55 });

    for (let i = 0; i < 30; i++) {
      const sp = sprite(TEX.spark, 0xffd27a, THREE.AdditiveBlending);
      sp.position.copy(pos).add(new THREE.Vector3(0, 0.35, 0));
      const a = Math.random() * Math.PI * 2;
      const up = 2.5 + Math.random() * 5.0;
      const sp2 = 2.0 + Math.random() * 5.5;
      sp.scale.setScalar(0.10 + Math.random() * 0.09);
      grenadeEffects.push({
        kind: 'spark', s: sp, t: -Math.random() * 0.05, dur: 0.55 + Math.random() * 0.45,
        vel: new THREE.Vector3(Math.cos(a) * sp2, up, Math.sin(a) * sp2), a0: 1
      });
    }

    // 4) 冲击环（贴地扩散）
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xffcf86, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.04, 0));
    scene.add(ring);
    grenadeEffects.push({ kind: 'ring', mesh: ring, t: 0, dur: 0.42, from: 0.9, to: 5.2, a0: 0.5 });

    // 5) 地面扬尘（低位、慢、横向铺开）
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
      const d = 0.5 + Math.random() * 0.8;
      const sm = sprite(TEX.smoke, 0xd8ccb6);
      sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * d, 0.18 + Math.random() * 0.25, Math.sin(a) * d));
      grenadeEffects.push({ kind: 'puff', s: sm, t: -i * 0.03, dur: 1.9, from: 0.7, to: 2.2, a0: 0.34, rise: 0.55, drift: 0.9, spin: (Math.random() - 0.5) * 0.6 });
    }

    // 6) 中心浓烟柱（比火球活得久，慢慢升起来）
    for (let i = 0; i < 6; i++) {
      const sm = sprite(TEX.smoke, 0x8d8880);
      sm.position.copy(pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.5 + Math.random() * 0.7, (Math.random() - 0.5) * 0.6));
      grenadeEffects.push({ kind: 'puff', s: sm, t: -0.1 - i * 0.12, dur: 2.8, from: 0.6, to: 2.4, a0: 0.34, rise: 1.0, drift: 0.35 });
    }

    // 7) 灯光（复用常驻 fxLight，避免临时加灯触发全场景 shader 重编译）+ 屏幕震一下 + 橙色闪屏
    fxLight.color.setHex(0xff9a2e);
    fxLight.distance = 18;
    fxLight.position.copy(pos).add(new THREE.Vector3(0, 0.9, 0));
    fxLight.intensity = 26;
    grenadeEffects.push({ kind: 'light', light: fxLight, pooled: true, t: 0, dur: 0.75, from: 26 });
    addShake(1, 0.55);
    flashScreen('#ff9a35', 0.26, 260);

    // 8) 伤害：距爆心越近越疼，墙后面无伤（扔脚边会炸死自己，和 CS 一样）。
    //    走统一的 blastDamage()：玩家 / 队友 / 敌人一视同仁（AI 还没做，
    //    现在场上只有玩家自己，加 bot 时只要往 actors 里塞人就能吃到伤害）。
    blastDamage(pos, { radius: g.radius, maxDamage: g.maxDamage || 150, cause: 'HE 手雷' });
  } else if (g.type === 'smoke') {
    // 先一小股喷发，再铺成一大团
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sm = sprite(TEX.smoke, 0xe6e9e6);
      sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * 0.25, 0.25 + Math.random() * 0.3, Math.sin(a) * 0.25));
      grenadeEffects.push({ kind: 'puff', s: sm, t: -i * 0.02, dur: 2.2, from: 0.5, to: 2.2, a0: 0.55, rise: 0.7, drift: 1.4 });
    }
    // 大团烟雾：原版烟雾弹能盖住一条小道，直径 6~8m、高一米多
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2;
      const r0 = Math.random() * 1.6;
      const sm = sprite(TEX.smoke, i % 3 === 0 ? 0xc9cfca : 0xe2e6e2);
      sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * r0, 0.25 + Math.random() * 1.2, Math.sin(a) * r0));
      grenadeEffects.push({
        kind: 'puff', s: sm, t: -0.2 - Math.random() * 1.4, dur: 14,
        from: 1.4 + Math.random() * 0.8, to: 4.8 + Math.random() * 1.8,
        a0: 0.42 + Math.random() * 0.16,
        rise: 0.30 + Math.random() * 0.28,
        drift: 0.5 + Math.random() * 0.8,
        spin: (Math.random() - 0.5) * 0.5
      });
    }
    // 中心几团超大烟补满体积
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const sm = sprite(TEX.smoke, 0xd7dcd7);
      sm.position.copy(pos).add(new THREE.Vector3(Math.cos(a) * 0.6, 0.5 + Math.random() * 0.8, Math.sin(a) * 0.6));
      grenadeEffects.push({
        kind: 'puff', s: sm, t: -0.4 - i * 0.12, dur: 14,
        from: 2.0, to: 6.8 + Math.random() * 1.2,
        a0: 0.34, rise: 0.22, drift: 0.4, spin: (Math.random() - 0.5) * 0.3
      });
    }
    addShake(0.25, 0.25);
  } else {
    // 闪光弹：一瞬间的白光 + 冲击环 + 白屏
    const core = sprite(TEX.glow, 0xffffff, THREE.AdditiveBlending);
    core.position.copy(pos).add(new THREE.Vector3(0, 0.6, 0));
    core.scale.setScalar(1.0);
    grenadeEffects.push({ kind: 'fire', s: core, t: 0, dur: 0.35, from: 1.0, to: 7.5, a0: 1.0, rise: 0.6 });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 1.0, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.04, 0));
    scene.add(ring);
    grenadeEffects.push({ kind: 'ring', mesh: ring, t: 0, dur: 0.5, from: 1, to: 9, a0: 0.9 });
    const light = fxLight;
    light.color.setHex(0xffffff);
    light.distance = 20;
    light.position.copy(pos).add(new THREE.Vector3(0, 1.0, 0));
    light.intensity = 30;
    grenadeEffects.push({ kind: 'light', light, pooled: true, t: 0, dur: 0.5, from: 30 });
    addShake(0.6, 0.4);
    // 致盲判定（原版逻辑）：半径 500 单位内、中间没有墙，就能被闪到。
    // 正面看爆点白得最久（4.9s），背对也有一点点余光（1.1s）；
    // 不看朝向直接按角度比例在白屏强度和时长上做插值，不再要求「必须正对」。
    const eye = camera.position.clone();
    const dEye = eye.distanceTo(pos);
    if (dEye < g.radius && gameStarted && !player.dead && !blastBlocked(eye, pos)) {
      const to = pos.clone().sub(eye).normalize();
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd);
      const facing = fwd.dot(to);                       // 1 = 正看爆点，-1 = 完全背对
      // 距离衰减（平方）+ 朝向衰减（背对也有 18%）
      const distK = Math.pow(Math.max(0, 1 - dEye / g.radius), 1.15);
      const faceK = 0.18 + 0.82 * Math.max(0, Math.min(1, (facing + 0.25) / 1.25));
      const k = distK * faceK;
      const blindMax = g.blindMax != null ? g.blindMax : 4.9;
      const blindMin = g.blindMin != null ? g.blindMin : 1.1;
      const dur = (blindMin + (blindMax - blindMin) * k) * 1000;
      flashScreen('#ffffff', Math.min(1, 0.70 + 0.30 * k), dur, k);
      // 耳鸣：致盲越久，耳朵里的高频余音越长
      if (audio.ring) audio.ring(dur / 1000 * 0.9, 0.16 * k + 0.05);
    }
    // 闪光弹也有极小的灼伤（原版贴近会掉几滴血）
    blastDamage(pos, { radius: 4.0, maxDamage: g.maxDamage || 8, minDamage: 1, cause: '闪光弹' });
  }
}

let flashSeq = 0;
/**
 * 全屏闪白：#flash 直接压一层纯白，先「啪」地一下满屏（几帧内到峰值），
 * 强闪会保持一小会儿再淡出；连续被闪时以最后一次为准，多个 rAF 不会互相覆盖。
 */
function flashScreen(color = '#ffffff', peak = 0.96, dur = 900) {
  const f = ui.flash;
  if (!f) return;
  const my = ++flashSeq;
  f.style.background = color;
  f.style.transition = 'none';
  const t0 = performance.now();
  // 强闪（>0.75）先满屏白 30% 时长再淡出；弱闪（手雷橙光那种）一闪即走
  const hold = peak > 0.75 ? 0.32 : 0.12;
  const ramp = 0.035;
  const tick = () => {
    if (my !== flashSeq) return;
    const k = (performance.now() - t0) / dur;
    if (k >= 1) { f.style.opacity = '0'; return; }
    let a;
    if (k < ramp) a = peak * (k / ramp);
    else if (k < hold) a = peak;
    else { const q = (k - hold) / (1 - hold); a = peak * (1 - q) * (1 - q * 0.35); }
    f.style.opacity = String(Math.max(0, Math.min(1, a)));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function updateEffects(dt) {
  for (let i = grenadeEffects.length - 1; i >= 0; i--) {
    const e = grenadeEffects[i];
    e.t += dt;
    if (e.t < 0) continue;
    const k = Math.min(1, e.t / e.dur);

    if (e.kind === 'fire') {
      e.s.visible = true;
      e.s.scale.setScalar(e.from + (e.to - e.from) * Math.pow(k, 0.55));
      e.s.position.y += e.rise * dt * (1 - k);
      // 先猛后缓的衰减，像真爆炸那样一下就暗
      e.s.material.opacity = e.a0 * Math.pow(1 - k, 1.6);
      if (k >= 1) { scene.remove(e.s); grenadeEffects.splice(i, 1); }
    } else if (e.kind === 'spark') {
      e.s.visible = true;
      e.vel.y -= 9.8 * dt;
      e.s.position.addScaledVector(e.vel, dt);
      if (e.s.position.y < 0.05) { e.s.position.y = 0.05; e.vel.multiplyScalar(0.3); e.vel.y *= -0.35; }
      e.s.material.opacity = e.a0 * (1 - k);
      if (k >= 1) { scene.remove(e.s); grenadeEffects.splice(i, 1); }
    } else if (e.kind === 'puff') {
      e.s.visible = true;
      const grow = e.from + (e.to - e.from) * Math.pow(k, 0.5);
      e.s.scale.setScalar(grow);
      e.s.position.y += e.rise * dt;
      if (e.drift) {
        e.s.position.x += Math.cos(e.t * 0.7) * e.drift * dt;
        e.s.position.z += Math.sin(e.t * 0.6) * e.drift * dt;
      }
      if (e.spin) e.s.material.rotation += e.spin * dt;
      const fadeIn = Math.min(1, Math.max(0, (e.t - 0) / 0.35));
      const fadeOut = Math.min(1, Math.max(0, (e.dur - e.t) / Math.min(3, e.dur * 0.4)));
      e.s.material.opacity = e.a0 * fadeIn * fadeOut;
      if (e.t > e.dur) { scene.remove(e.s); grenadeEffects.splice(i, 1); }
    } else if (e.kind === 'scorch') {
      // 焦痕：长时间淡出
      e.mesh.material.opacity = e.a0 * Math.min(1, Math.max(0, (e.dur - e.t) / 4));
      if (e.t > e.dur) { scene.remove(e.mesh); grenadeEffects.splice(i, 1); }
    } else if (e.kind === 'ring') {
      e.mesh.scale.setScalar(e.from + (e.to - e.from) * Math.pow(k, 0.6));
      e.mesh.material.opacity = e.a0 * Math.pow(1 - k, 1.4);
      if (k >= 1) { scene.remove(e.mesh); grenadeEffects.splice(i, 1); }
    } else if (e.kind === 'light') {
      e.light.intensity = e.from * Math.pow(1 - k, 2.2);
      if (k >= 1) {
        // 常驻灯只灭掉，不移除（移除又会触发 shader 重编译）
        e.light.intensity = 0;
        e.light.position.set(0, -50, 0);
        grenadeEffects.splice(i, 1);
      }
    }
  }
}

function shoot(stab = false) {
  if (!weapons) return;
  if (inPrep()) return;              // 准备阶段不能开枪
  const now = performance.now() / 1000;
  const w = weapons.current;
  if (!w) return;

  if (w.def.kind === 'melee') {
    if (!weapons.canFire(now)) return;
    weapons.fire(now, { stab });
    return;
  }

  if (w.def.kind === 'grenade') {
    throwGrenade(w, now);
    return;
  }
  if (w.def.kind === 'c4') return;      // C4 只能安放，不能开火

  if (w.ammo <= 0) {
    if (w.state !== 'reload' && now - lastShotTime > 0.25) {
      // 空仓只有击锤声与极轻微的枪身下沉，不播射击动画
      audio.empty(w.def);
      w.kick += 0.0018;
      w.kickRot += 0.25 * DEG;
      refreshHUD(true);
      lastShotTime = now;
    }
    return;
  }
  if (!weapons.canFire(now)) return;

  // Glock 三连发：一次扳机打三发，声音只用 burst 那一段
  if (w.def.burst && w.burstMode) {
    if (burst.left > 0) return;             // 上一轮还没打完
    if (now < burst.readyAt) return;        // 三连发刚打完的冷却（防止无间隔连点）
    startBurst(w, now);
    return;
  }

  // 停火超过阈值就重新开始算弹道（下一枪回到第一发的竖直上抬）
  if (now - sprayLast > SPRAY_RESET) sprayCount = 0;
  sprayLast = now;

  // AWP / Scout：开一枪立刻退镜，等拉拴（射击）动作播完再自动回到原镜位。
  // AUG / SG552：开镜后连续射击不退镜（换弹才退），保持瞄准状态。
  const zc = w.def.zoom;
  const scoped = zoomLevel > 0 && !!zc;
  const holdScope = scoped && w.def.kind !== 'sniper';
  if (scoped && !holdScope) {
    pendingZoom = zoomLevel;
    exitZoom();
  }

  weapons.fire(now);
  lastShotTime = now;
  if (botMgr && botMgr.ready) botMgr.onGunshot(player.pos, playerTeam);

  // 后坐力：开镜状态稍收敛一点，腰射是完整力度
  applyRecoil(w, scoped ? 0.85 : 1);
  spreadBloom = Math.min(spreadBloom + w.def.spread.fire, (w.def.spread.max || 0.06) - w.def.spread.base);

  // 弹道：霰弹枪一次打多颗，每颗单独散布
  const pellets = w.def.pellets || 1;
  const base = scoped ? 0 : currentSpread(w);
  if (pellets > 1) {
    const extra = w.def.spread.pellet || 0.02;
    for (let i = 0; i < pellets; i++) {
      // 每颗弹丸在锥形范围内随机散布，越靠外密度越低（和 CS 的霰弹一致）
      firePellet(base + Math.random() * extra, 0.55);
    }
  } else {
    firePellet(base);
  }

  refreshHUD();
}

function meleeStab() {
  if (!weapons) return;
  const w = weapons.current;
  if (!w || w.def.kind !== 'melee') return;
  const now = performance.now() / 1000;
  if (!weapons.canFire(now)) return;
  weapons.fire(now, { stab: true });
}


// ---------------------------------------------------------------- 开镜
let scopeClsTimer = 0;
let chShown = null;    // 准星当前是否显示（缓存，避免每帧改 DOM）

/** 哪些武器有准星：刀、三种投掷物、AWP/Scout 都不要准星 */
function crosshairAllowed(def) {
  if (!def) return false;
  const k = def.kind;
  return k !== 'melee' && k !== 'grenade' && k !== 'sniper';
}

function syncCrosshair() {
  const w = weapons && weapons.current;
  const ok = !!(gameStarted && !player.dead && crosshairAllowed(w && w.def));
  if (ok === chShown) return;
  chShown = ok;
  ui.crosshair.classList.toggle('on', ok);
}

function applyZoom(w) {
  const z = w.def.zoom;
  if (!z) { zoomLevel = 0; zoomTargetFov = FOV; return; }
  if (zoomLevel > 0) {
    zoomTargetFov = z.levels[zoomLevel - 1];
    // 狙击枪用圆筒镜，步枪（AUG/SG552）用轻量十字镜
    ui.scope.classList.toggle('rifle', w.def.kind !== 'sniper');
    ui.scope.classList.add('on');
    // AUG / SG552 开镜时保留准星（用屏幕准星瞄准）；AWP/Scout 只显示镜内十字
    chShown = null;
    syncCrosshair();
  } else {
    zoomTargetFov = FOV;
    ui.scope.classList.remove('on');
    // 关键：rifle 类要等淡出结束再摘，否则 AUG/SG552 退镜的一瞬间
    // 会先变回 AWP 那种圆筒镜（黑边 + 十字）闪一下
    clearTimeout(scopeClsTimer);
    scopeClsTimer = setTimeout(() => {
      if (!zoomLevel) ui.scope.classList.remove('rifle');
    }, 140);
    chShown = null;
    syncCrosshair();
  }
  if (ui.bZoom) ui.bZoom.classList.toggle('off', zoomLevel === 0);
}

function toggleZoom() {
  const w = weapons && weapons.current;
  if (!w || !w.def.zoom) return;
  if (!gameStarted) return;
  if (w.state === 'draw' || w.state === 'reload') return;
  // 手动开镜就取消「自动回镜」，交给玩家自己控制
  pendingZoom = 0;
  const max = w.def.zoom.levels.length;
  zoomLevel = (zoomLevel + 1) % (max + 1);
  applyZoom(w);
  audio.click();
}

function exitZoom() {
  if (!zoomLevel) return;
  zoomLevel = 0;
  zoomTargetFov = FOV;
  ui.scope.classList.remove('on');
  chShown = null;
  syncCrosshair();
  if (ui.bZoom) ui.bZoom.classList.remove('off');
}

// 拉拴动作播完后自动回到之前的镜位（AWP）
function restoreZoomAfterBolt(w) {
  if (!pendingZoom || !w || !w.def.zoom) { pendingZoom = 0; return; }
  if (weapons.current !== w) { pendingZoom = 0; return; }
  if (w.ammo <= 0 || w.state === 'reload' || w.state === 'draw') { pendingZoom = 0; return; }
  zoomLevel = Math.min(pendingZoom, w.def.zoom.levels.length);
  pendingZoom = 0;
  applyZoom(w);
  audio.click();
}


// ---------------------------------------------------------------- 主循环
const clock = new THREE.Clock();
let elapsed = 0;

// ---- 回合系统：开局 3 秒准备阶段（冻结），之后 15 分钟倒数 ----
const PREP_TIME = 3;        // 准备阶段秒数（期间玩家动不了，计时器倒数 3-2-1）
const ROUND_TIME = 15 * 60; // 准备结束后计时器从 15:00 开始倒数
let roundState = 'idle';    // idle | prep | live
let roundT0 = 0;            // 本回合开始时（进入 prep）的 elapsed
function startRound() {
  roundState = 'prep';
  roundT0 = elapsed;
  // 炸弹回合：只要场上没有还没处理完的 C4，就重新发一次
  if (!bomb.roundEnded && (bomb.phase === 'none' || bomb.phase === 'carried' || bomb.phase === 'ground')) {
    beginBombRound();
  }
}
function inPrep() { return roundState === 'prep'; }
function roundLeft() {
  if (roundState === 'prep') return PREP_TIME - (elapsed - roundT0);
  if (roundState === 'live') return ROUND_TIME - (elapsed - roundT0 - PREP_TIME);
  return 0;
}

function updatePlayer(dt) {
  const w = weapons && weapons.current;
  let mx = input.right, mz = input.forward;
  if (!gameStarted) { mx = 0; mz = 0; }
  if (keys.has('KeyW')) mz += 1;
  if (keys.has('KeyS')) mz -= 1;
  if (keys.has('KeyD')) mx += 1;
  if (keys.has('KeyA')) mx -= 1;
  if (inPrep()) { mx = 0; mz = 0; }   // 准备阶段：动不了（放在键盘之后拦，否则 WASD 又加回来）
  const mag = Math.hypot(mx, mz);
  if (mag > 1) { mx /= mag; mz /= mag; }

  const walking = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const zoomK = (zoomLevel && w && w.def.zoom) ? w.def.zoom.speed : 1;
  // 蹲下：按住 Ctrl（桌面）/ 点一下蹲按钮（手机）
  player.crouch = !!(input.crouch || keys.has('ControlLeft') || keys.has('ControlRight'));
  const crouchK = player.crouch ? 0.34 : 1;
  // 跑速 6.5 m/s（原 5.3 太慢，CS 250u/s ≈ 6.35）；静步 2.6
  const speed = (walking ? 2.6 : 6.5) * zoomK * crouchK;

  const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
  // 前方向 = (-sin, 0, -cos)
  const wishX = (-sin * mz + cos * mx) * speed;
  const wishZ = (-cos * mz - sin * mx) * speed;

  const accel = player.onGround ? 14 : 3.2;
  player.vel.x = damp(player.vel.x, wishX, accel, dt);
  player.vel.z = damp(player.vel.z, wishZ, accel, dt);

  if (window.__noclip) {
    // 调试飞行：直接按速度走，不做碰撞，也不受重力（用来俯视看地图）
    player.pos.x += player.vel.x * dt;
    player.pos.z += player.vel.z * dt;
    player.pos.y += player.vel.y * dt;
  } else {
  // ---- 水平移动：按位移拆子步，低帧率下一帧跨 0.5m 也不会穿薄墙 ----
  const moveLen = Math.hypot(player.vel.x, player.vel.z) * dt;
  const sub = Math.max(1, Math.min(6, Math.ceil(moveLen / 0.28)));
  const sdt = dt / sub;
  for (let i = 0; i < sub; i++) {
    const x0 = player.pos.x, z0 = player.pos.z;
    const feet = player.pos.y;
    const nx = x0 + player.vel.x * sdt;
    const nz = z0 + player.vel.z * sdt;
    if (!blockedMove(x0, z0, nx, nz, feet) && floorOK(nx, nz, feet)) {
      player.pos.x = nx;
      player.pos.z = nz;
    } else {
      // 先试「抬脚登踏」：前方是高差 STEP_UP 以内的台阶/箱子/岩石沿时，
      // 把脚底抬到平台高度走上去，不用按跳（Source 引擎的 step up；
      // CS 原版 1m 内要跳，但本地图的垂直过渡（木箱层、岩石沿、石阶）
      // 普遍是 1~1.4m 一档，不登踏就永远上不去这些「楼梯」）。
      let stepped = false;
      // 登踏探测很贵（一次要打十几条地面射线）。撞墙时每个子步都试一遍，
      // 8 个子步就是近百条射线 —— 这就是「一贴墙走就卡」的元凶。
      // 每帧只给一次探测机会，失败就交给贴墙滑行。
      if (!window.__noclip && stepUpBudget > 0 && stepUpCool <= 0) {
        stepUpBudget--;
        const mLen = Math.hypot(nx - x0, nz - z0) || 1;
        const ux = (nx - x0) / mLen, uz = (nz - z0) / mLen;
        for (const k of [1, 0.5]) {           // 整步不行再试半步（一级一级上）
          const tx = x0 + (nx - x0) * k;
          const tz = z0 + (nz - z0) * k;
          // 沿前进方向探几档，取最高的可登平台：一级窄箱/岩沿只比
          // 落脚点宽一点，单点探测会漏（探到箱沿外的地面上）
          let plat = -100, bx = tx, bz = tz;
          for (const ex of [0, 0.25, PLAYER_R + 0.16]) {
            const qx = tx + ux * ex, qz = tz + uz * ex;
            const p = groundHeightAt(qx, qz, feet + STEP_UP + 0.5);
            if (p > plat) { plat = p; bx = qx; bz = qz; }
          }
          const rise = plat - feet;
          // 平台必须「站得下」：落点左右两侧同高处也得是同一块平台面。
          // 护栏/窄墙顶只有几厘米宽，两侧探下去就是地面（高差很大或没面），
          // 不做这个校验就会「瞬移到护栏顶上翻过去」。
          let wide = true;
          for (const s of [-0.3, 0.3]) {
            const sx = bx - uz * s, sz = bz + ux * s;
            const h = groundHeightAt(sx, sz, feet + STEP_UP + 0.5);
            if (h < -90 || Math.abs(h - plat) > 0.25) { wide = false; break; }
          }
          if (rise > 0.02 && rise <= STEP_UP && wide) {
            const f2 = plat + 0.03;   // 站到平台面上一点点，膝盖/胸口射线越过竖面
            if (!blockedMove(x0, z0, bx, bz, f2) && floorOK(bx, bz, f2)) {
              player.pos.x = bx;      // 直接落到平台上方：窄箱也能站稳
              player.pos.z = bz;
              player.pos.y = f2;      // 重力段随后贴到平台顶面
              stepped = true;
              break;
            }
          }
        }
      }
      if (!stepped && !window.__noclip) stepUpCool = 0.12;   // 失败冷却，避免顶着墙每帧狂打射线
      if (stepped) continue;
      // 贴着墙滑：只试「这一轴真的有位移」的方向。
      // （之前没判断 dx/dz 是否为 0：只按 Z 走时 X 轴位移是 0，
      //  blockedMove 平凡通过、floorOK 也通过，于是走进这条分支只把速度
      //  乘 0.55 却没移动 —— 每帧衰减，走几米就自己停住。）
      const dx = nx - x0, dz = nz - z0;
      let slid = false;
      if (Math.abs(dx) > 1e-6 && !blockedMove(x0, z0, nx, z0, feet) && floorOK(nx, z0, feet)) {
        player.pos.x = nx;
        player.vel.z *= 0.5;
        slid = true;
      }
      if (!slid && Math.abs(dz) > 1e-6 && !blockedMove(x0, z0, x0, nz, feet) && floorOK(x0, nz, feet)) {
        player.pos.z = nz;
        player.vel.x *= 0.5;
        slid = true;
      }
      if (!slid) {
        player.vel.x *= 0.2;
        player.vel.z *= 0.2;
        break;
      }
    }
  }

  // ---- 垂直：重力 + 贴地（射线从上一帧脚底稍上起打，不会被头顶横梁误导）----
  const prevY = player.pos.y;
  player.vel.y -= 18 * dt;
  player.pos.y += player.vel.y * dt;
  // 地面采样：中心射线 + 四个 0.22m 偏移，取「不高于脚底 +0.35m」里最高的那个。
  // 薄围栏 / 窄墙顶只有十几厘米宽，人站上去稍微偏一点中心射线就打空，
  // 于是整帧没有地面、直接穿过薄板掉到下面 —— 就是「跳上围栏走两步掉出地面」。
  // 限制高度是为了贴着高墙时不会把墙顶当成脚下地面。
  const fromY = Math.max(prevY, player.pos.y) + 0.12;
  let floorY = groundHeightAt(player.pos.x, player.pos.z, fromY);
  for (const [ox, oz] of _FOOT_OFFS) {
    const h = groundHeightAt(player.pos.x + ox, player.pos.z + oz, fromY);
    if (h > floorY && h <= player.pos.y + 0.35) floorY = h;
  }
  if (player.pos.y <= floorY) {
    player.pos.y = floorY;
    player.vel.y = 0;
    player.onGround = true;
  } else if (player.pos.y > floorY + 0.05) {
    // 下坡吸附：贴地行走时地面每帧往下走一点，直接跟着贴下去——
    // 否则每帧「离地→落地」抖动，onGround 反复翻转，准星散布跟着乱跳（上/下坡准星一直动的根因）
    if (player.onGround && player.vel.y <= 0.01 && player.pos.y - floorY <= 0.5) {
      player.pos.y = floorY;
      player.vel.y = 0;
    } else {
      player.onGround = false;
    }
  }
  // 记录最后站稳的位置（掉出地图时优先回到这里，而不是直接回出生点）
  if (player.onGround && player.vel.y <= 0.01) {
    player.safeX = player.pos.x;
    player.safeY = player.pos.y;
    player.safeZ = player.pos.z;
  }
  // 掉出地图兜底：地图最低处约 -9m，掉到 -15 就是出去了
  if (player.pos.y < -15) {
    if (player.safeY != null && player.safeY > -12) {
      player.pos.set(player.safeX, player.safeY + 0.05, player.safeZ);
      player.vel.set(0, 0, 0);
      showHint('脚下地形有缝，已把你放回刚才站的位置');
    } else {
      const sp = spawnPoint(playerTeam || 't');
      if (sp) {
        player.pos.set(sp.x, sp.y + 0.1, sp.z);
        player.vel.set(0, 0, 0);
      } else {
        player.pos.y = 200;
        player.vel.set(0, 0, 0);
      }
    }
  }
  }

  // 后坐力回正：punchangle 按指数衰减，视角自己走回来（CS 1.6 的手感）
  const w0 = weapons && weapons.current;
  const rec = (w0 && w0.def.recoil && w0.def.recoil.recover) || 0.24;
  const back = 1 - Math.exp(-dt / rec);
  punch.p -= punch.p * back;
  punch.y -= punch.y * back;

  // 蹲下时视高平滑下降
  player.eye = damp(player.eye, player.crouch ? 1.14 : 1.62, 13, dt);

  // 走动晃动
  const hs = Math.hypot(player.vel.x, player.vel.z);
  const targetBob = clamp(hs / 5.3, 0, 1);
  player.bobAmt = damp(player.bobAmt, targetBob, 8, dt);
  player.bobPhase += dt * (5.2 + hs * 1.1);
  const bobY = Math.sin(player.bobPhase * 2) * 0.017 * player.bobAmt;
  const bobX = Math.cos(player.bobPhase) * 0.012 * player.bobAmt;

  // 爆炸震屏：高频小幅，快速衰减
  let shp = 0, shy = 0, shr = 0;
  if (shake.t > 0) {
    shake.t -= dt;
    shake.amp *= Math.exp(-3.4 * dt);
    if (shake.t <= 0) shake.amp = 0;
    const ph = performance.now() / 1000 * 34 + shake.seed;
    shp = Math.sin(ph) * shake.amp * 0.028;
    shy = Math.sin(ph * 1.37 + 1.7) * shake.amp * 0.030;
    shr = Math.sin(ph * 0.87 + 3.1) * shake.amp * 0.012;
  }

  // AUG / SG552 开镜：视线再往前贴一点（相机沿视线前移，FOV 同时收窄）
  const wNow = weapons && weapons.current;
  const scopedRifle = zoomLevel > 0 && wNow && wNow.def.kind === 'rifle' && !!wNow.def.zoom;
  camScopeFwd = damp(camScopeFwd, scopedRifle ? 0.16 : 0, 14, dt);
  const fwdX = -Math.sin(player.yaw), fwdZ = -Math.cos(player.yaw);
  camera.position.set(
    player.pos.x + bobX + fwdX * camScopeFwd,
    player.pos.y + player.eye + bobY,
    player.pos.z + fwdZ * camScopeFwd
  );
  // 相机防穿墙（节流 + 平滑）：
  // 以视线方向为中心，每隔 70ms 打 7 条（正面、±30°、±60°、±90°）水平射线。
  // 只探正前方时，贴着墙「平行」走侧墙永远探不到，屏幕边缘会从墙里透出去；
  // 现在侧向也能感知，并把相机沿墙面法线方向轻推回房间内。
  if (!window.__noclip && mapMeshes.length) {
    const nowMs = performance.now();
    if (nowMs >= camClipNext) {
      camClipNext = nowMs + 70;
      let pushX = 0, pushZ = 0, near = 0;
      for (const deg of [0, -30, 30, -60, 60, -90, 90]) {
        const a = player.yaw + deg * Math.PI / 180;
        const dx = -Math.sin(a), dz = -Math.cos(a);
        _rayFrom.set(camera.position.x, camera.position.y, camera.position.z);
        _mapRay.set(_rayFrom, _moveDir.set(dx, 0, dz));
        _mapRay.far = CAM_CLEAR + 0.24;
        const hs = _mapRay.intersectObjects(mapMeshes, false);
        if (!hs.length) continue;
        const d = hs[0].distance;
        if (d < CAM_CLEAR) {
          const need = CAM_CLEAR - d;
          // 只有正对/斜对的墙需要推；侧墙按一半力度（避免贴墙走路时被横着弹开）
          const w = Math.abs(deg) >= 90 ? 0.55 : 1;
          pushX -= dx * need * w;
          pushZ -= dz * need * w;
          near++;
        }
      }
      let len = Math.hypot(pushX, pushZ);
      if (len > 0.32) { pushX *= 0.32 / len; pushZ *= 0.32 / len; len = 0.32; }
      // 目标位移沿「最近的墙面法线」方向，方向固定后再做平滑，避免帧间抖
      if (near) { camClipDX = pushX / (len || 1); camClipDZ = pushZ / (len || 1); }
      camClipTarget = near ? len : 0;
    }
    camClipAmt = damp(camClipAmt, camClipTarget, 18, dt);
    if (camClipAmt > 0.001) {
      camera.position.x += camClipDX * camClipAmt;
      camera.position.z += camClipDZ * camClipAmt;
    }
  }
  camera.rotation.set(
    clamp(player.pitch + punch.p + shp, -89 * DEG, 89 * DEG),
    player.yaw + punch.y + shy,
    Math.sin(player.bobPhase) * 0.0025 * player.bobAmt + shr
  );

  // 脚步声：bobPhase 每过一个 π 就是一只脚落地（一个完整周期 = 左右各一步）。
  // 只在真正走动、且贴地时响；音量跟移动速度走，音高随机一点避免机械感。
  const stepIdx = Math.floor(player.bobPhase / Math.PI);
  if (stepIdx !== player.stepPhase) {
    player.stepPhase = stepIdx;
    const nowMs = performance.now();
    if (player.bobAmt > 0.12 && player.onGround && nowMs - player.lastStepSfx > 120) {
      player.lastStepSfx = nowMs;
      audio.play('pl_step' + (1 + ((Math.random() * 4) | 0)), {
        gain: 0.12 + player.bobAmt * 0.26,
        rate: 0.94 + Math.random() * 0.12
      });
    }
  }

  return player.bobAmt;
}

// ---------------------------------------------------------------- 三连发（Glock）
const burst = { left: 0, next: 0, weapon: null, readyAt: 0 };

function startBurst(w, now) {
  const cfg = w.def.burst;
  burst.left = Math.min(cfg.count, w.ammo);
  burst.next = now;
  burst.weapon = w;
  // 整段三连发动画只播一次：新模型的 shoot 本身就是「三发连打」，
  // 每发都播一次就成了九连发。动画的滑套节奏(~0.05s 间隔)正好对上 burst.gap。
  w.playFire(false, { burst: true });
  // 一次三连发只播一次这段音频（本身包含三发）
  if (w.def.sfx && w.def.sfx.burst) audio.play(w.def.sfx.burst, { gain: 1 });
}

function fireBurstShot(w, now) {
  if (!w || w.ammo <= 0) { burst.left = 0; return; }
  weapons.fire(now, { silent: true, noAnim: true });
  lastShotTime = now;
  applyRecoil(w, 1);
  spreadBloom = Math.min(spreadBloom + w.def.spread.fire, (w.def.spread.max || 0.06) - w.def.spread.base);
  firePellet(currentSpread(w));
  refreshHUD();
}

let lastAmmoState = '';
let lastBuyBtn = null;
let chGapSm = -1;    // 准星间距的平滑值（-1 表示尚未初始化）
let chGapWritten = -1;

/**
 * 性能统计（只观测，不改分辨率）。
 * r89 的动态分辨率会在帧时间临界点反复 setPixelRatio → 画布随之重建：
 * 一是画面会糊（0.72~1.0 之间来回），二是重建那一帧天然闪一下白。
 * r90 起彻底去掉降分辨率逻辑，内部渲染永远按 settings.quality 的满像素跑，
 * 这里只留统计给 ?tune 调试面板看。
 */
function tickPerf(dt) {
  if (document.hidden) { perfAcc = 0; perfN = 0; return; }
  if (!gameStarted) { perfAcc = 0; perfN = 0; return; }
  perfAcc += dt; perfN++;
  if (perfAcc < 0.5) return;
  window.__fps = Math.round(perfN / perfAcc);
  perfAcc = 0; perfN = 0;
}
function gameLoop() {
  requestAnimationFrame(gameLoop);
  // 上限 0.1s：低于 20FPS 时不再把时间砍掉（原来 clamp 0.05，在 11FPS 下
  // 实际速度只有设定值的 57%，走起来像在拖地）。位移靠子步进保证不穿墙。
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;

  // 购买菜单打开 / 阵亡：冻结角色。
  // 准备阶段不冻结相机——按原版：能转视角、能换弹切枪，只是「动不了、开不了枪」，
  // （之前把 prep 也算 frozen，相机不跟着玩家走，看起来就像所有人被瞬移到了一个地方）
  const frozen = buyOpen || player.dead;
  if (inPrep()) { input.firing = false; input.fireQueued = false; }
  stepUpBudget = 1;              // 每帧重置登踏探测预算
  if (stepUpCool > 0) stepUpCool -= dt;
  const moveAmt = frozen ? 0 : updatePlayer(dt);

  if (gameStarted && weapons) {
    const now = performance.now() / 1000;
    const w = weapons.current;
    // Glock 三连发推进
    if (burst.left > 0) {
      const bw = weapons.current;
      if (!bw || bw !== burst.weapon || bw.state === 'reload' || bw.state === 'draw' || bw.ammo <= 0) {
        burst.left = 0;
      } else {
        while (burst.left > 0 && now >= burst.next) {
          fireBurstShot(bw, now);
          burst.left--;
          burst.next += bw.def.burst.gap;
          if (burst.left <= 0 || bw.ammo <= 0) {
            burst.left = 0;
            // 三发打完后进入冷却：这段时间内点扳机不会再开一轮
            burst.readyAt = now + (bw.def.burst.cooldown || 0.5);
            break;
          }
        }
      }
    }

    // 连发
    if (w) {
      const auto = w.def.auto;
      if ((input.firing && auto) || (input.fireQueued && input.firing)) {
        shoot(false);
        input.fireQueued = false;
      }
    }
    if (!input.firing) input.fireQueued = false;

    weapons.update(dt, weaponLookDX, weaponLookDY, moveAmt, elapsed, player.bobPhase);
    // 兜底：手里还端着空的投掷物（扔完了 / 换回合清弹 / 中途切回来）→ 收枪换别的
    const cw = weapons.current;
    if (cw && cw.def.kind === 'grenade' && cw.ammo <= 0 && !grenadeSeq) endGrenadeThrow(cw);
    updateBomb(dt);
    updateGrenade(dt);
    updateProjectiles(dt);
    updateEffects(dt);
    updateCasings(dt);
    updateDropped(dt);
  } else if (weapons) {
    weapons.update(dt, 0, 0, 0, elapsed, player.bobPhase);
    updateBomb(dt);
    updateGrenade(dt);
    updateProjectiles(dt);
    updateEffects(dt);
    updateCasings(dt);
    updateDropped(dt);
  }
  if (weapons) updateEjectMarker();
  if (botMgr && botMgr.ready && gameStarted) botMgr.update(dt, performance.now() / 1000);
  weaponLookDX = 0; weaponLookDY = 0;

  spreadBloom *= Math.exp(-dt * 4.5);

  updateRadar(performance.now());
  syncCrosshair();

  // 准星（散布变化带平滑动画：目标值指数趋近，不再每帧硬跳）
  const w = weapons && weapons.current;
  if (w) {
    const target = 4 + currentSpread(w) * 1500 * (settings.chSens || 1);
    chGapSm = chGapSm < 0 ? target : damp(chGapSm, target, 10, dt);
    // 只有真的变了才写 CSS 变量：每帧无脑写会让浏览器每帧重算一次样式
    const gap = Math.round(chGapSm * 2) / 2;
    if (gap !== chGapWritten) {
      chGapWritten = gap;
      document.documentElement.style.setProperty('--ch-gap', gap + 'px');
    }
  }

  refreshHUD();

  // 手机端购买按钮：出了购买范围 / 非游戏状态就隐藏（状态没变就不碰 DOM）
  if (ui.bBuy) {
    const wantBuyBtn = gameStarted && !player.dead && canBuyNow();
    if (wantBuyBtn !== lastBuyBtn) {
      lastBuyBtn = wantBuyBtn;
      ui.bBuy.classList.toggle('hide', !wantBuyBtn);
    }
  }

  // 回合计时（准备阶段 3-2-1 倒数 → 回到 15:00 倒数）+ 阵亡重生倒计时
  if (gameStarted && ui.tClock) {
    if (inPrep()) {
      const left = Math.max(1, Math.ceil(roundLeft()));
      ui.tClock.textContent = '0:0' + left;
      ui.tClock.classList.add('prep');
      if (elapsed - roundT0 >= PREP_TIME) {
        roundState = 'live';
        roundT0 = elapsed - PREP_TIME;   // 无缝衔接：live 从 prep 结束点起算
        ui.tClock.classList.remove('prep');
      }
    } else if (roundState === 'live') {
      const left = Math.max(0, Math.floor(roundLeft()));
      ui.tClock.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
    if (player.dead) {
      const left = Math.max(0, Math.ceil((player.respawnAt - performance.now()) / 1000));
      if (ui.dCount) ui.dCount.textContent = left;
      if (left <= 0) respawnPlayer();
    }
  }

  // 开镜 FOV 过渡
  if (Math.abs(camera.fov - zoomTargetFov) > 0.05) {
    camera.fov = damp(camera.fov, zoomTargetFov, 22, dt);
    camera.updateProjectionMatrix();
  }

  renderer.clear();
  camera.layers.set(0);              // 先画世界（弹壳在另一层，这一步不画）
  renderer.render(scene, camera);
  // AWP 开镜要收起枪身（只看镜筒），AUG / SG552 的瞄准镜是装在枪上的，枪要留着
  const keepGunScoped = weapons && weapons.current && weapons.current.def.kind !== 'sniper';
  if (!zoomLevel || keepGunScoped) {
    renderer.clearDepth();
    renderer.render(viewScene, viewCamera);
  }
  // 弹壳最后单独画一遍：层级高于枪模型，飞出去时不会再被枪身盖住。
  // 没有弹壳时整段跳过，不白付一次场景遍历的代价。
  // scene.background 必须临时置空：带颜色背景时 three 会强制清屏
  // （forceClear + autoClearColor 仍为 true），把已经画好的世界和枪一起抹掉。
  if (CASES.length) {
    renderer.clearDepth();
    const _bg = scene.background;
    scene.background = null;
    camera.layers.set(CASE_LAYER);
    renderer.render(scene, camera);
    camera.layers.set(0);
    scene.background = _bg;
  }

  tickPerf(dt);
}

// ---------------------------------------------------------------- 响应式
function onResize() {
  const r = applyRatio();          // 画布尺寸/比例由设置里的「画面比例」决定
  const aspect = r.cw / r.ch;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  viewCamera.aspect = aspect;
  viewCamera.updateProjectionMatrix();
  // 竖屏时缩小武器视图并重新构图，避免枪械占满屏幕或被裁切
  const portrait = aspect < 1.15;
  const k = portrait ? Math.min(1, Math.max(0.34, 0.5 * aspect + 0.11)) : 1;
  if (weapons) weapons.setViewScale(k, -0.017 * (1 - k), 0.0045 * (1 - k), portrait);
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 120));

// ---------------------------------------------------------------- 开始
function startGame(auto) {
  const first = !gameStarted;
  gameStarted = true;
  zoomLevel = 0;
  zoomTargetFov = FOV;
  camera.fov = FOV;
  camera.updateProjectionMatrix();
  ui.scope.classList.remove('on');
  ui.menu.classList.add('hidden');
  chShown = null;
  syncCrosshair();
  audio.init();
  if (first && !auto && weapons && weapons.current) weapons.current.playDraw();
  if (!auto && !IS_TOUCH) tryLock();
  if (IS_TOUCH) ui.mobile.classList.remove('hidden');
  refreshHUD(true);
  refreshVitals(true);
}

// 开始/继续的统一入口：资源没就绪时先记下来，加载完自动接上
let pendingStart = false, loadSkipped = false;
function requestStart() {
  if (!window.__ready) {
    pendingStart = true;
    ui.btnStart.textContent = '载入中…';
    return;
  }
  if (!playerTeam) {
    const tp = document.getElementById('teamPick');
    if (tp) { tp.classList.add('on'); return; }
  }
  startGame(false);
}

// ---------------------------------------------------------------- 设置（本机保存）
// 存档双写：localStorage + cookie。某些手机浏览器/隐私模式/清理缓存后
// localStorage 会丢，cookie 还能兜一层；读取时用「默认值 + 逐项校验」合并，
// 旧版本缺字段也不会把整份设置判废（之前只要 JSON 里有一项异常就全部回落默认）。
const SETTINGS_KEY = 'cs16.settings.v1';
const SETTINGS_COOKIE = 'cs16_settings_v1';
const SETTINGS_DEFAULTS = {
  shadow: 'on', quality: 'mid', sens: 1,
  chStyle: 'cross', chColor: '#6dff7a', chSens: 1
};

function readSettingsRaw() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return raw;
  } catch (e) { /* 隐私模式 */ }
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + SETTINGS_COOKIE + '=([^;]*)'));
    if (m) return decodeURIComponent(m[1]);
  } catch (e) { /* file:// 下 cookie 可能不可用 */ }
  return null;
}

function loadSettings() {
  let obj = {};
  try { obj = JSON.parse(readSettingsRaw() || '{}') || {}; } catch (e) { obj = {}; }
  const s = Object.assign({}, SETTINGS_DEFAULTS);
  if (obj.shadow === 'on' || obj.shadow === 'off') s.shadow = obj.shadow;
  if (obj.quality === 'high' || obj.quality === 'mid' || obj.quality === 'low') s.quality = obj.quality;
  if (Number.isFinite(+obj.sens)) s.sens = Math.min(3, Math.max(0.2, +obj.sens));
  if (['cross', 'dot', 'circle', 't'].includes(obj.chStyle)) s.chStyle = obj.chStyle;
  if (typeof obj.chColor === 'string' && /^#[0-9a-f]{6}$/i.test(obj.chColor)) s.chColor = obj.chColor;
  if (Number.isFinite(+obj.chSens)) s.chSens = Math.min(2.5, Math.max(0.2, +obj.chSens));
  return s;
}

const settings = loadSettings();
// 迁移：把读到的旧 localStorage 立刻镜像进 cookie。
// cookie 不区分端口，更新版本后即使换端口打开（新包常被解到新端口），设置也能继承。
try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
try {
  document.cookie = SETTINGS_COOKIE + '=' + encodeURIComponent(JSON.stringify(settings)) +
    '; max-age=31536000; path=/; SameSite=Lax';
} catch (e) {}

function saveSettings() {
  const raw = JSON.stringify(settings);
  try { localStorage.setItem(SETTINGS_KEY, raw); } catch (e) {}
  try {
    document.cookie = SETTINGS_COOKIE + '=' + encodeURIComponent(raw) +
      '; max-age=31536000; path=/; SameSite=Lax';
  } catch (e) {}
}
function pixelCap() {
  return settings.quality === 'high' ? 2 : settings.quality === 'low' ? 1 : 1.5;
}
// ---- 动态分辨率（保帧率不降画质）----
// 平时按满分辨率渲染；只有当帧时间连续超预算（跑不到 ~90 帧）时，
// 才把内部分辨率按 8% 一档往下收，最高收到 0.72 倍；
// 帧时间恢复宽裕（< 8ms）再一档档升回去。所以能跑满的设备看到的就是原画质。
let resScale = 1;                 // r90：固定 1（不再动态降分辨率）
let perfAcc = 0, perfN = 0;
function applyPixelRatio() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelCap()));
}
/** 画布尺寸：永远铺满窗口（「画面比例」选项已移除） */
function applyRatio() {
  const W = window.innerWidth, H = window.innerHeight;
  const cw = W, ch = H;
  applyPixelRatio();
  renderer.setSize(cw, ch, false);
  canvas.style.position = 'fixed';
  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.style.left = Math.round((W - cw) / 2) + 'px';
  canvas.style.top = Math.round((H - ch) / 2) + 'px';
  return { cw, ch };
}
function applyShadowSetting() {
  const on = settings.shadow === 'on';
  if (renderer.shadowMap.enabled === on) return;
  renderer.shadowMap.enabled = on;
  sun.castShadow = on && !!DEV.shadows;
  renderer.shadowMap.needsUpdate = true;
  // 开关阴影会让材质编译版本变化，需要标记重编
  scene.traverse(o => {
    if (!o.material) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) m.needsUpdate = true;
  });
}
const settingsEl = document.getElementById('settings');
const chColorsEl = document.getElementById('chColors');
const chSensEl = document.getElementById('chSens');
const chSensValEl = document.getElementById('chSensVal');
const stResetEl = document.getElementById('stReset');

/** 把准星设置套到 DOM（颜色走 CSS 变量，样式走 data-style） */
function applyCrosshair() {
  if (!ui.crosshair) return;
  ui.crosshair.dataset.style = settings.chStyle || 'cross';
  document.documentElement.style.setProperty('--ch-color', settings.chColor || '#6dff7a');
}

function syncSettingsUI() {
  for (const box of settingsEl.querySelectorAll('.st-opts')) {
    const k = box.dataset.k;
    for (const b of box.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === settings[k]);
  }
  if (chColorsEl) {
    for (const b of chColorsEl.querySelectorAll('button')) b.classList.toggle('on', b.dataset.c === settings.chColor);
  }
  if (ui.sens) ui.sens.value = settings.sens;
  if (ui.sensVal) ui.sensVal.textContent = (+settings.sens).toFixed(2);
  if (chSensEl) chSensEl.value = settings.chSens;
  if (chSensValEl) chSensValEl.textContent = (+settings.chSens).toFixed(2);
}
function openSettings() { settingsEl.classList.remove('hidden'); syncSettingsUI(); }
function closeSettings() { settingsEl.classList.add('hidden'); }
document.getElementById('btnSettings').addEventListener('click', openSettings);
document.getElementById('stClose').addEventListener('click', closeSettings);
settingsEl.addEventListener('click', (e) => {
  if (e.target === settingsEl) closeSettings();
  const b = e.target.closest('.st-opts button');
  if (!b) return;
  const k = b.parentElement.dataset.k;
  settings[k] = b.dataset.v;
  saveSettings();
  syncSettingsUI();
  if (k === 'shadow') applyShadowSetting();
  if (k === 'quality') onResize();
  if (k === 'chStyle') applyCrosshair();
});
// 设置里的灵敏度：进游戏前也能调
input.sens = +settings.sens || 1;

// 准星颜色 / 灵敏度 / 重置
if (chColorsEl) {
  chColorsEl.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-c]');
    if (!b) return;
    settings.chColor = b.dataset.c;
    saveSettings();
    syncSettingsUI();
    applyCrosshair();
  });
}
if (chSensEl) {
  chSensEl.addEventListener('input', () => {
    settings.chSens = Math.min(2.5, Math.max(0.2, parseFloat(chSensEl.value) || 1));
    chSensValEl.textContent = settings.chSens.toFixed(2);
    saveSettings();
  });
}
const chResetEl = document.getElementById('chReset');
if (chResetEl) chResetEl.addEventListener('click', () => {
  settings.chStyle = SETTINGS_DEFAULTS.chStyle;
  settings.chColor = SETTINGS_DEFAULTS.chColor;
  settings.chSens = SETTINGS_DEFAULTS.chSens;
  saveSettings();
  syncSettingsUI();
  applyCrosshair();
});

// 「重置存档」：连点两次确认，恢复画面/灵敏度/准星全部默认值
let stResetArmedAt = 0, stResetTimer = 0;
if (stResetEl) {
  stResetEl.addEventListener('click', () => {
    const now = performance.now();
    if (now - stResetArmedAt > 3000) {
      stResetArmedAt = now;
      stResetEl.textContent = '再点一次确认';
      clearTimeout(stResetTimer);
      stResetTimer = setTimeout(() => { stResetEl.textContent = '重置存档'; }, 3100);
      return;
    }
    clearTimeout(stResetTimer);
    stResetArmedAt = 0;
    Object.assign(settings, SETTINGS_DEFAULTS);
    saveSettings();
    // 浏览器里临时调参的缓存也一并清掉（view-tune.js 文件本身不动）
    try {
      localStorage.removeItem('cs16.viewtune.v1');
      localStorage.removeItem('cs16.tuner.muzzlebox');
    } catch (e) {}
    input.sens = settings.sens;
    syncSettingsUI();
    applyCrosshair();
    applyShadowSetting();
    onResize();
    stResetEl.textContent = '已恢复默认';
    setTimeout(() => { stResetEl.textContent = '重置存档'; }, 1500);
  });
}

ui.btnStart.addEventListener('click', () => requestStart());

// 主菜单：点画面任意处开始/继续（设置按钮除外）
ui.menu.addEventListener('click', (e) => {
  if (e.target.closest('#btnSettings, #btnStart')) return;
  requestStart();
});

// 加载页：点击任意处跳过加载，直接进主菜单（资源继续在后台加载）
const loadSkipEl = ui.loader;
if (loadSkipEl) {
  loadSkipEl.addEventListener('click', () => {
    if (window.__ready) return;
    loadSkipped = true;
    loadSkipEl.classList.add('done');
    setTimeout(() => { loadSkipEl.style.display = 'none'; }, 320);
    ui.menu.classList.remove('hidden');
    ui.btnStart.textContent = '载入中…';
  });
}

ui.sens.addEventListener('input', () => {
  input.sens = parseFloat(ui.sens.value);
  ui.sensVal.textContent = input.sens.toFixed(2);
  settings.sens = input.sens;
  saveSettings();
});

if (IS_TOUCH) {
  document.body.classList.add('touch');
  ui.mobile.classList.remove('hidden');
  ui.menuTip.textContent = '左侧摇杆移动 · 右侧滑动视角';
  document.getElementById('bJump').style.display = '';
}

// 调试：?auto=1 直接进入，?w=ak47 指定武器
if (DEBUG) {
  window.__THREE = THREE;
  window.__scene = scene;
  window.__sky = skyDome;
  window.__renderer = renderer;
  window.__mapMeshes = mapMeshes;
  window.__viewCamera = viewCamera;
  window.__viewScene = viewScene;
  window.__rigs = () => (weapons ? weapons.weapons.map(w => [w.def.id, w.rig.visible, +w.orient.scale.x.toFixed(4)]) : []);
  window.__camera = camera;
  window.__wref = () => weapons && weapons.current;
  window.__setView = (o = {}) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    const v = w.def.view || (w.def.view = {});
    for (const k of ['scale', 'rx', 'ry', 'rz', 'pos']) if (o[k] !== undefined) v[k] = o[k];
    w.applyViewConfig();
    return JSON.stringify(v);
  };
  window.__pose = (o = {}) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    if (o.s != null) w.orient.scale.setScalar(o.s);
    if (o.ry != null) w.orient.rotation.y = o.ry * DEG;
    if (o.rx != null) w.orient.rotation.x = o.rx * DEG;
    if (o.rz != null) w.orient.rotation.z = o.rz * DEG;
    if (o.gx != null || o.gy != null || o.gz != null) {
      const w2 = weapons.current;
      const off = w2.gunOffset || new THREE.Vector3();
      w2.gunOffset = new THREE.Vector3(o.gx ?? off.x, o.gy ?? off.y, o.gz ?? off.z);
    }
    if (o.px != null || o.py != null || o.pz != null) {
      const p = w.basePos;
      w.rig.position.set(o.px ?? p.x, o.py ?? p.y, o.pz ?? p.z);
      w.basePos.copy(w.rig.position);
    }
    return 'ok';
  };
  window.__info = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    return {
      id: w.def.id,
      scale: w.orient.scale.x,
      ry: w.orient.rotation.y / DEG,
      pos: w.basePos.toArray(),
      state: w.state,
      ammo: w.ammo
    };
  };
  window.__tp = (x, y, z, pitchDeg) => {
    player.pos.set(+x, +y, +z);
    player.vel.set(0, 0, 0);
    if (pitchDeg != null) player.pitch = (+pitchDeg) * Math.PI / 180;
  };
  window.__noclip = false;
  window.__dbgMove = { blockedMove, floorOK, floorUnder, groundHeightAt, stepRise, STEP_H, STEP_UP };
// 相机正前方到墙的距离（诊断"顶墙穿模"用）
window.__wallDist = (deg = 0) => {
  const a = camera.rotation.y + deg * Math.PI / 180;
  _rayFrom.set(camera.position.x, camera.position.y, camera.position.z);
  _mapRay.set(_rayFrom, _moveDir.set(-Math.sin(a), 0, -Math.cos(a)));
  _mapRay.far = 3;
  const hs = _mapRay.intersectObjects(mapMeshes, false);
  return hs.length ? +hs[0].distance.toFixed(3) : null;
};
window.__camPos = () => camera.position.toArray().map(n => +n.toFixed(2));
  window.__setYaw = (deg) => { player.yaw = (+deg) * DEG; };
  window.__player = () => ({ p: player.pos.toArray().map(n => +n.toFixed(2)),
                             v: player.vel.toArray().map(n => +n.toFixed(2)),
                             onGround: player.onGround, yaw: +(player.yaw / DEG).toFixed(1),
                             pitch: +(player.pitch / DEG).toFixed(1) });
  window.__gnd = (x, z) => groundHeightAt(x, z, 60);
  window.__mapInfo = () => ({ ready: mapReady, meshes: mapMeshes.length,
                              ground: +groundHeightAt(player.pos.x, player.pos.z).toFixed(2) });
  window.__fire = (stab) => shoot(!!stab);
  window.__proj = () => projectiles.map(p => ({ pos: p.mesh.position.toArray().map(n => +n.toFixed(2)), fuse: +(p.expireAt - performance.now() / 1000).toFixed(2) }));
  window.__reload = () => weapons.reload();
  window.__round = () => ({ state: roundState, left: +roundLeft().toFixed(2), prep: inPrep(), t: +(elapsed - roundT0).toFixed(2) });
  window.__goLive = () => { roundState = 'live'; roundT0 = elapsed - PREP_TIME - 0.05; return true; };
  window.__state = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    return { id: w.def.id, state: w.state, ammo: w.ammo, reserve: w.reserve,
             active: w._activeName, t: w.active ? +w.active.time.toFixed(2) : 0,
             dur: w.active ? +w.active.getClip().duration.toFixed(2) : 0,
             vs: w.viewScale, os: +w.orient.scale.x.toFixed(5),
             rig: w.rig.position.toArray().map(n => +n.toFixed(3)),
             fov: +camera.fov.toFixed(1), zoom: zoomLevel, aspect: +viewCamera.aspect.toFixed(3) };
  };
  window.__names = (re) => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const out = [];
    w.root.traverse(o => { if (!re || new RegExp(re, 'i').test(o.name)) out.push(o.name); });
    return out;
  };
  window.__ndc = (name) => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const o = name ? w.root.getObjectByName(name) : w.root;
    if (!o) return 'not found';
    w.root.updateMatrixWorld(true);
    const p = new THREE.Vector3(); o.getWorldPosition(p);
    const q = p.clone().project(viewCamera);
    return { world: p.toArray().map(n => +n.toFixed(3)), ndc: [+q.x.toFixed(2), +q.y.toFixed(2)], z: +q.z.toFixed(3) };
  };
  window.__mirror = (on) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    w.mirror.scale.x = on ? -1 : 1;
    return 'ok';
  };
  window.__gunRot = (x, y, z) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    const g = w.root.getObjectByName(w.def.fix && w.def.fix.handMount ? w.def.fix.handMount.gun : '');
    if (!g || !g.userData.baseQ) return 'no gun';
    const e = new THREE.Euler(x * DEG, y * DEG, z * DEG, 'XYZ');
    g.quaternion.copy(g.userData.baseQ).multiply(new THREE.Quaternion().setFromEuler(e));
    return 'ok';
  };
  window.__gunShift = (x, y, z) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    const g = w.root.getObjectByName(w.def.fix && w.def.fix.handMount ? w.def.fix.handMount.gun : '');
    if (!g || !g.userData.baseP) return 'no gun';
    g.position.copy(g.userData.baseP).add(new THREE.Vector3(x, y, z));
    return 'ok';
  };
  // 调试：直接改当前武器「枪体相对手」的微调（位置 / 角度 / 缩放）
  window.__mount = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => {
    const w = weapons && weapons.current;
    if (!w || !w.handPivot) return 'no pivot';
    const cfg = w.def.fix.handMount;
    cfg.tune = { pos: [x, y, z], rotDeg: [rx, ry, rz], scale: s };
    w._applyMountTune();
    return JSON.stringify(cfg.tune);
  };
  // 调试：左手支撑姿势参数（rot 为手骨局部欧拉角，lerp/drop 为位置微调）
  window.__seatL = (rot, lerp, drop) => {
    const w = weapons && weapons.current;
    if (!w || !w.seatLeft) return 'no';
    return JSON.stringify(w.seatLeft({ rot, lerp, drop }));
  };
  // 调试：弹壳状态 + 视角俯仰
  window.__gseq = () => (grenadeSeq ? { phase: grenadeSeq.phase, tossed: grenadeSeq.tossed } : null);
  // 性能：当前动态分辨率倍率 / 实际像素比 / 平均帧时间
  window.__tp = (x, z, yawDeg) => {
  const gy = groundHeightAt(x, z, 200);
  player.pos.set(x, (gy > -90 ? gy : 0) + 0.06, z);
  player.vel.set(0, 0, 0);
  if (yawDeg != null) player.yaw = yawDeg * DEG;
  return { y: +player.pos.y.toFixed(2) };
};
window.__THREE = THREE;
// 调试：把相机摆到指定位置并看向目标（校准手上武器 / 检查 AI 用）
window.__lookAt = (px, py, pz, tx, ty, tz) => {
  const eye = player.eye || 1.62;
  player.pos.set(px, py - eye, pz);
  player.vel.set(0, 0, 0);
  const dx = tx - px, dz = tz - pz;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.atan2(ty - py, Math.hypot(dx, dz));
  return { yaw: +(player.yaw / DEG).toFixed(1), pitch: +(player.pitch / DEG).toFixed(1) };
};
window.__cam = () => camera;
window.__tri = () => ({ tri: renderer.info.render.triangles, calls: renderer.info.render.calls });
window.__bots = () => (window.__botMgr ? window.__botMgr.debug() : null);
// 调试：热改 AI 手上武器的挂载参数（校准用）
window.__mountSet = (pos, rotDeg, scale) => {
  if (!window.__botMgr) return null;
  window.__botMgr.setMount(pos, rotDeg, scale == null ? 1 : scale);
  return window.__botMgr.bots[0] && window.__botMgr.bots[0].gunHolder
    ? { pos: window.__botMgr.bots[0].gunHolder.position.toArray().map(v => +v.toFixed(3)),
        rot: window.__botMgr.bots[0].gunHolder.rotation.toArray().slice(0, 3).map(v => +(v / DEG).toFixed(1)) }
    : null;
};
window.__perf = () => ({ res: +resScale.toFixed(3), pr: +renderer.getPixelRatio().toFixed(3), calls: renderer.info.render.calls });
  window.__cases = () => CASES.map(c => ({
    p: c.mesh.position.toArray().map(n => +n.toFixed(3)),
    q: c.mesh.quaternion.toArray().map(n => +n.toFixed(2)),
    rest: c.rest, t: +c.t.toFixed(2), len: +(c.kit.len * 1000).toFixed(1), r: +(c.kit.radius * 1000).toFixed(1),
    s: +c.mesh.scale.x.toFixed(2)
  }));
  window.__pitch = (deg) => { player.pitch = deg * DEG; return +player.pitch.toFixed(3); };
  window.__bgun = (rx, ry, rz, x, y, z, sc) => {
    const w = weapons && weapons.current;
    const m = w && w.bakedGun;
    if (!m) return 'no';
    m.rotation.set(rx * DEG, ry * DEG, rz * DEG);
    const b = m.userData.baseP;
    m.position.set(b.x + x, b.y + y, b.z + z);
    if (sc) m.scale.setScalar(m.userData.baseS * sc);
    return JSON.stringify({ p: m.position.toArray().map(n => +n.toFixed(2)), s: +m.scale.x.toFixed(3) });
  };
  window.__bgunRot = (rx, ry, rz) => {
    const w = weapons && weapons.current;
    const m = w && w.bakedGun;
    if (!m) return 'no';
    const T = THREE, e = new T.Euler(rx * DEG, ry * DEG, rz * DEG, 'XYZ');
    m.quaternion.copy(m.userData.baseQ).multiply(new T.Quaternion().setFromEuler(e));
    return 'ok';
  };
  window.__boneOff = (name, x, y, z) => {
    const w = weapons && weapons.current;
    return w && w.offsetBone ? !!w.offsetBone(name, [x, y, z]) : 'no';
  };
  window.__reseat = (back, down, mode) => {
    const w = weapons && weapons.current;
    return w && w.reseat ? w.reseat(back, down, mode) : 'no';
  };
  window.__frame = (k, ox = 0, oy = 0) => {    if (weapons) weapons.setViewScale(k, ox, oy);
    return 'ok';
  };
  window.__portraitSet = (k, ox, oy, oz) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    w.def.view.portrait = { k, ox, oy, oz };
    weapons.setViewScale(weapons.viewScale, weapons.viewOX, weapons.viewOY, true);
    return 'ok';
  };
  // 只调整当前武器的竖屏构图：k 为缩放倍率，ox/oy 为偏移
  window.__portrait = (k, ox, oy) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    w.def.view.portrait = { k, ox, oy };
    weapons.setViewScale(weapons.viewScale, weapons.viewOX, weapons.viewOY, true);
    return JSON.stringify({ k, ox, oy, vs: w.viewScale, off: w.viewOffset.toArray() });
  };
  window.__tracks = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const out = new Set();
    for (const c of w.clips.values()) for (const t of c.tracks) if (/parent/.test(t.name)) out.add(t.name);
    return [...out];
  };
  window.__bump = (dx) => {
    const w = weapons && weapons.current;
    if (!w || !w.gunNode) return null;
    w.gunNode.position.x += dx;
    return w.gunNode.position.toArray().map(n => +n.toFixed(2));
  };
  window.__tick = () => {
    const w = weapons && weapons.current;
    if (!w || !w.gunNode) return null;
    w.update(0.016, 0, 0, 0, 0);
    return w.gunNode.position.toArray().map(n => +n.toFixed(2));
  };
  window.__gun = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    return { node: w.gunNode ? w.gunNode.name : null, off: w.gunOffset ? w.gunOffset.toArray() : null,
             pos: w.gunNode ? w.gunNode.position.toArray().map(n => +n.toFixed(2)) : null };
  };
  window.__gunOff = (x, y, z) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    if (!w.gunOffset) w.gunOffset = new THREE.Vector3();
    w.gunOffset.set(x, y, z);
    return 'ok';
  };
  window.__reparent = (child, parent) => {
    const w = weapons && weapons.current;
    if (!w) return 'no weapon';
    const c = w.root.getObjectByName(child);
    const p = w.root.getObjectByName(parent);
    if (!c || !p) return 'missing';
    p.add(c);
    return 'ok';
  };
  window.__clipinfo = (n) => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const c = w.clips.get(n);
    if (!c) return 'no clip';
    return { name: c.name, dur: +c.duration.toFixed(2), tracks: c.tracks.length, names: c.tracks.map(t => t.name) };
  };
  window.__parents = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const out = [];
    w.root.traverse(o => { if (o.parent) out.push(o.name + ' <- ' + o.parent.name); });
    return out;
  };
  window.__range = (clipName, suffix) => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const c = w.clips.get(clipName);
    if (!c) return 'no clip';
    const t = c.tracks.find(x => x.name.includes(suffix) && x.name.endsWith('.position'));
    if (!t) return 'no track';
    let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    for (let i = 0; i < t.values.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], t.values[i + k]);
        mx[k] = Math.max(mx[k], t.values[i + k]);
      }
    }
    return { name: t.name, min: mn.map(n => +n.toFixed(2)), max: mx.map(n => +n.toFixed(2)) };
  };
  window.__holdFlash = () => {
    const w = weapons && weapons.current;
    if (!w) return;
    w.triggerFlash();
    w.flashTimer = 999;
  };
  window.__flashInfo = () => {
    const w = weapons && weapons.current;
    if (!w) return null;
    return {
      hasBone: !!w.flashBone, bone: w.flashBone ? w.flashBone.name : null,
      bonePos: w._flashPos ? w._flashPos.toArray().map(n => +n.toFixed(3)) : null,
      sprite: w.flashSprite ? { vis: w.flashSprite.visible, pos: w.flashSprite.position.toArray().map(n => +n.toFixed(3)), sc: w.flashSprite.scale.toArray() } : null,
      timer: +w.flashTimer.toFixed(3)
    };
  };
  // 音效自检：已播放日志 + 配置里引用的素材是否都存在
  window.__sfx = () => {
    const refs = [];
    const push = (v) => { if (!v) return; if (Array.isArray(v)) v.forEach(x => push(typeof x === 'string' ? x : x[1])); else refs.push(v); };
    for (const w of WEAPONS) {
      const f = w.sfx || {};
      ['shot', 'shotSil', 'deploy', 'empty', 'stab', 'silencerOn', 'silencerOff'].forEach(k => push(f[k]));
      push(f.slash);
      if (f.reload) push(f.reload);
      if (f.reloadEmpty) push(f.reloadEmpty);
      if (f.fireCues) f.fireCues.forEach(c => push(c[1]));
      if (f.stage) Object.keys(f.stage).forEach(k => f.stage[k].forEach(c => push(c[1])));
    }
    const uniq = [...new Set(refs)];
    return {
      ready: audio.ready,
      played: audio.log.slice(),
      trace: audio.trace.slice(-40),
      refs: uniq.length,
      missing: uniq.filter(n => !audio.has(n)),
      loaded: audio.buffers.size,
      manifest: audio.manifest.size
    };
  };
  window.__latency = () => audio.latency ? +audio.latency().toFixed(3) : -1;
  window.__clearTrace = () => { audio.trace.length = 0; audio.log.length = 0; return 'ok'; };
  window.__equip = (id, instant = false) => {
    const i = WEAPONS.findIndex(x => x.id === id);
    if (i >= 0) weapons.equip(i, { instant: !!instant });
  };
  // ---- C4 调试 ----
  window.__bomb = () => ({
    phase: bomb.phase,
    site: bomb.site ? bomb.site.key : null,
    timer: +bomb.timer.toFixed(2),
    plant: +bomb.plantProg.toFixed(2),
    stage: bomb.plantStage,
    released: !!bomb.plantReleased,
    defuse: +bomb.defuseProg.toFixed(2),
    pos: bomb.pos.toArray().map(n => +n.toFixed(2)),
    kit: !!player.defuseKit,
    roundEnded: !!bomb.roundEnded,
    winner: bomb.winner,
    inSite: !!bombSiteAt(player.pos.x, player.pos.z),
    holding: isHoldingC4(),
    led: +bomb.ledPulse.toFixed(3),
    ledOp: bomb.led ? +bomb.led.material.opacity.toFixed(3) : -1,
    beepAt: +bomb.beepAt.toFixed(2),
  });
  window.__use = (v) => { input.use = !!v; return input.use; };
  window.__fireHold = (v) => { input.firing = !!v; return input.firing; };
  window.__c4 = () => switchToC4();
  window.__bombReset = () => { bomb.roundEnded = false; beginBombRound(); return bomb.phase; };
  // 只在调试里：原地放一发爆炸特效（不结算伤害、不结束回合），用来单独看画面
  window.__boom = (dist = 7) => {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    dir.y = 0; dir.normalize();
    const p = camera.position.clone().addScaledVector(dir, dist);
    p.y = groundHeightAt(p.x, p.z, p.y + 6);
    if (!(p.y > -90)) p.y = player.pos.y;
    spawnBombExplosion(p);
    return p.toArray().map(n => +n.toFixed(2));
  };
  window.__kit = (v) => { player.defuseKit = !!v; return player.defuseKit; };
  window.__bombSet = (o) => { Object.assign(bomb, o); return window.__bomb(); };
  window.__bombMesh = () => {
    if (!bomb.mesh) return null;
    const box = new THREE.Box3().setFromObject(bomb.mesh);
    return { min: box.min.toArray().map(n => +n.toFixed(2)), max: box.max.toArray().map(n => +n.toFixed(2)),
             pos: bomb.mesh.position.toArray().map(n => +n.toFixed(2)) };
  };
  window.__wstate = () => ({ index: weapons.index, last: weapons.lastIndex, cur: weapons.current && weapons.current.def.id,
    team: weapons.team, owned: [...(weapons.owned || [])],
    allows: weapons.weapons.filter(w => weapons.allows(w)).map(w => w.def.id) });
  window.__plantHere = () => {
    const s = bombSiteAt(player.pos.x, player.pos.z);
    if (!s) return 'not-in-site';
    plantBombAt(s, player.pos.x, player.pos.z);
    return s.key;
  };
  window.__marker = () => ({ v: ejectMarker.visible, p: ejectMarker.position.toArray().map(n => +n.toFixed(3)), s: +ejectMarker.scale.x.toFixed(2) });
  window.__cam = () => ({ p: camera.position.toArray().map(n => +n.toFixed(2)), yaw: +(camera.rotation.y / DEG).toFixed(1) });
  window.__weapons = () => weapons && weapons.weapons.map(w => w.def.id);
  window.__gunPos = (name) => {
    const w = weapons && weapons.current;
    if (!w) return null;
    const o = w.root.getObjectByName(name);
    if (!o) return 'not found';
    w.root.updateMatrixWorld(true);
    const p = new THREE.Vector3(); o.getWorldPosition(p);
    return { pos: p.toArray().map(n=>+n.toFixed(2)), quat: o.quaternion.toArray().map(n=>+n.toFixed(3)), localPos: o.position.toArray().map(n=>+n.toFixed(2)) };
  };
}

onResize();
applyShadowSetting();
syncSettingsUI();
applyCrosshair();
boot();
gameLoop();
