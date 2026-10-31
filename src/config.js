// 后坐力弹道表：[纵向倍率, 横向倍率]，按连发第 n 发取值（超出长度后沿用最后一发）
// 仿 CS 1.6 的喷射形状：前几发几乎纯上抬，随后左右摆动，尾段回到中线
const P_RIFLE = [
  [1.00, 0.00], [1.00, 0.06], [0.96, -0.06], [0.92, -0.16], [0.88, -0.26],
  [0.82, -0.34], [0.78, -0.30], [0.74, -0.18], [0.68, 0.10], [0.64, 0.34],
  [0.58, 0.56], [0.54, 0.68], [0.50, 0.56], [0.46, 0.30], [0.42, -0.08],
  [0.38, -0.46], [0.35, -0.66], [0.32, -0.70], [0.30, -0.54], [0.28, -0.24],
  [0.26, 0.14], [0.24, 0.46], [0.22, 0.62], [0.20, 0.56], [0.18, 0.32],
  [0.16, -0.04], [0.15, -0.34], [0.14, -0.50], [0.13, -0.44], [0.12, -0.18]
];
const P_SMG = [
  [1.00, 0.02], [0.94, -0.10], [0.90, -0.22], [0.86, -0.34], [0.82, -0.30],
  [0.78, -0.10], [0.74, 0.18], [0.70, 0.44], [0.66, 0.58], [0.62, 0.50],
  [0.58, 0.24], [0.56, -0.10], [0.54, -0.42], [0.52, -0.60], [0.50, -0.56],
  [0.48, -0.30], [0.46, 0.06], [0.44, 0.38], [0.42, 0.56], [0.40, 0.52]
];
const P_PISTOL = [
  [1.00, 0.05], [0.72, -0.18], [0.60, 0.14], [0.52, -0.10], [0.46, 0.08]
];
const P_SHOTGUN = [
  [1.00, 0.00], [0.55, 0.10], [0.45, -0.12], [0.40, 0.08]
];
const P_SNIPER = [
  [1.00, 0.00], [0.55, 0.12], [0.45, -0.10]
];

// ---------------------------------------------------------------- 调试开关
// 平时全部为 0；需要用某一项时把它改成 1，刷新页面即可生效。
export const DEV = {
  tuner: 1,      // 武器调参面板（右上角按钮 / P 键 / ?tune=1）
  siteTuner: 0,  // 包点现场调试（「调参」按钮正上方的「包点」按钮 / J 键 / ?sites=1）；0 关 / 1 开
                 // 关掉时入口按钮、J 键、?sites 一起隐藏，A/B 点的黄色圈和地面染色也不再绘制
  shadows: 1,    // 地图太阳阴影（1 开 / 0 关）。低端设备觉得卡就改成 0
};

export const WEAPONS = [
  {
    id: 'ak47',
    teams: ['t'],
    short: 'AK',
    name: 'AK-47',
    price: 2500,
    ammoPrice: 80,
    model: 'v_ak47',
    slot: 1,
    kind: 'rifle',
    caseType: '762',
    auto: true,
    rpm: 600,
    magSize: 30,
    reserve: 90,
    damage: 36,
    spread: { base: 0.0020, move: 0.013, fire: 0.0042, max: 0.045 },
    recoil: { kick: 1.10, pitch: 1.60, yaw: 1.45, roll: 0.12, pattern: P_RIFLE, recover: 0.34 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone_AK47', casingLocal: [-0.06, -3.54, 4.03] },
    view: { bob: 0.95, scale: 0.009648, ry: 90, rx: 0, rz: 0, pos: [-0.1981, 0.0533, -0.16] },
    sound: { body: 120, noise: 0.20, gain: 0.55, tail: 0.22 },
    sfx: { shot: 'ak47-1', deploy: 'ak47_boltpull', deployAt: 0.25, empty: 'dryfire_rifle',
           // 换弹分段：拔匣、插匣各自完整播一遍，互不覆盖（动画里没有拉栓动作）
           reloadCues: [[0.18, 'ak47_clipout'], [1.70, 'ak47_clipin']] },
  },
  {
    id: 'mp5',
    teams: ['t','ct'],
    short: 'MP5',
    name: 'MP5-SD',
    price: 1500,
    ammoPrice: 30,
    model: 'v_mp5',
    slot: 2,
    kind: 'smg',
    caseType: '9mm',
    auto: true,
    rpm: 750,
    magSize: 30,
    reserve: 120,
    damage: 27,
    spread: { base: 0.0026, move: 0.012, fire: 0.0038, max: 0.042 },
    recoil: { kick: 0.70, pitch: 1.05, yaw: 1.05, roll: 0.07, pattern: P_SMG, recover: 0.34 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone03', casingLocal: [0.11, -0.75, 4.51] },
    view: { bob: 0.19, scale: 0.011728, ry: 90, rx: 0, rz: 0, pos: [-0.1776, 0.0546, -0.16] },
    sound: { body: 150, noise: 0.18, gain: 0.5, tail: 0.18 },
    sfx: { shot: 'mp5-1', deploy: 'mp5_slideback', deployAt: 0.35, empty: 'dryfire_rifle',
           // 换弹末尾会拉一下机柄 → mp5_slideback
           reloadCues: [[0.41, 'mp5_clipout'], [1.53, 'mp5_clipin'], [2.02, 'mp5_slideback']] },
  },
  {
    id: 'awp',
    teams: ['t','ct'],
    short: 'AWP',
    name: 'AWP',
    price: 4750,
    ammoPrice: 125,
    model: 'v_awp',
    slot: 3,
    kind: 'sniper',
    caseType: '338',
    auto: false,
    rpm: 48,
    magSize: 10,
    reserve: 30,
    damage: 115,
    spread: { base: 0.0004, move: 0.030, fire: 0.010, max: 0.070 },
    recoil: { kick: 2.6, pitch: 4.5, yaw: 0.90, roll: 0.28, pattern: P_SNIPER, recover: 0.50 },
    zoom: { levels: [30, 13], sens: [0.55, 0.22], speed: 0.60, rezoom: 3.0 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.5, -4.59, 4.99], ejectDelay: 0.60 },
    view: { bob: 0.11, scale: 0.008688, ry: 90, rx: 0, rz: 0, pos: [-0.1757, 0.0408, -0.16] },
    sound: { body: 80, noise: 0.30, gain: 0.7, tail: 0.35 },
    sfx: { shot: 'awp1', fireCues: [[0.24, 'awp_deploy']], empty: 'dryfire_rifle' },
  },
  {
    // Scout（鸟狙）：CS 1.6 原版参数 —— $2750、伤害 75、10 发弹匣、拉栓 1 秒
    id: 'scout',
    teams: ['t','ct'],
    short: 'SCT',
    name: 'Scout 鸟狙',
    price: 2750,
    ammoPrice: 50,
    model: 'v_scout',
    slot: 3,
    kind: 'sniper',
    caseType: '762',
    auto: false,
    rpm: 60,
    magSize: 10,
    reserve: 90,
    damage: 75,
    spread: { base: 0.0006, move: 0.030, fire: 0.012, max: 0.075 },
    recoil: { kick: 1.9, pitch: 3.2, yaw: 0.62, roll: 0.20, pattern: P_SNIPER, recover: 0.42 },
    zoom: { levels: [40, 16], sens: [0.62, 0.30], speed: 0.90, rezoom: 2.6 },
    anims: { draw: 'draw', fire: ['shoot'], reload: 'reload' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.5, -4.59, 4.99], ejectDelay: 0.45 },
    view: { bob: 0.13, scale: 0.008688, ry: 90, rx: 0, rz: 0, pos: [-0.1757, 0.0408, -0.022] },
    sound: { body: 95, noise: 0.26, gain: 0.62, tail: 0.28 },
    sfx: { shot: 'scout_fire', fireCues: [[0.34, 'scout_bolt']], empty: 'dryfire_rifle',
           reloadCues: [[0.55, 'scout_clipout'], [1.55, 'scout_clipin']] },
  },
  {
    // Remington：栓动步枪（装在步枪分类里），可开镜。
    // 模型沿用 Scout 的骨骼，所以拉栓节奏直接按模型里 shoot_1 的栓柄运动对齐：
    // 0.30~0.50s 栓柄后拉到底，0.80~0.90s 推回闭锁 → 整段 remington_bolt 从 0.30 起播正好。
    id: 'remington',
    teams: ['t','ct'],
    short: 'REM',
    name: 'Remington',
    price: 4000,
    ammoPrice: 100,
    model: 'v_remington',
    slot: 3,
    kind: 'sniper',
    caseType: '762',
    auto: false,
    rpm: 48,
    magSize: 10,
    reserve: 30,
    damage: 100,
    spread: { base: 0.0005, move: 0.030, fire: 0.011, max: 0.072 },
    recoil: { kick: 2.2, pitch: 4.0, yaw: 0.72, roll: 0.24, pattern: P_SNIPER, recover: 0.46 },
    zoom: { levels: [36, 14], sens: [0.58, 0.24], speed: 0.80, rezoom: 2.8 },
    anims: { draw: 'draw', fire: ['shoot_1', 'shoot_2'], reload: 'reload' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.5, -4.59, 4.99], ejectDelay: 0.35 },
    view: { bob: 0.13, scale: 0.008688, ry: 90, rx: 0, rz: 0, pos: [-0.1757, 0.0408, -0.022] },
    sound: { body: 90, noise: 0.28, gain: 0.66, tail: 0.30 },
    // 换弹：和鸟狙同一段 reload（2.0s），只有「拔匣 / 插匣」两下，结尾没有拉栓动作。
    // remington_clipout.wav 本身是 1.8s 的整段拟音（拔匣 + 插匣 + 最后 1.55s 那下
    // 很像拉栓），整段播会拖到换弹结束之后，听着就像「换完又拉了一下栓」——
    // 所以这条 cue 只保留前 0.55s（拔匣），插匣交给 clipin。
    sfx: { shot: 'remington-1', fireCues: [[0.30, 'remington_bolt']], empty: 'dryfire_rifle',
           reloadCues: [[0.55, 'remington_clipout', 0.9, 0.55], [1.45, 'remington_clipin']] },
  },
  {
    id: 'deagle',
    teams: ['t','ct'],
    short: 'DE',
    name: 'Desert Eagle',
    price: 650,
    ammoPrice: 40,
    model: 'v_deagle',
    slot: 4,
    kind: 'pistol',
    caseType: '50ae',
    auto: false,
    rpm: 260,
    magSize: 7,
    reserve: 35,
    damage: 54,
    spread: { base: 0.0022, move: 0.016, fire: 0.0075, max: 0.055 },
    recoil: { kick: 1.55, pitch: 2.40, yaw: 0.75, roll: 0.22, pattern: P_PISTOL, recover: 0.38 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'], reload: 'reload', empty: 'shoot_empty' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.08, -0.67, 3.02] },
    view: { bob: 0.17, scale: 0.022352, ry: 90, rx: 0, rz: 0, pos: [-0.3186, 0.0342, -0.16] },
    sound: { body: 110, noise: 0.24, gain: 0.6, tail: 0.26 },
    sfx: { shot: 'deagle-1', deploy: 'deagle_clipout', deployAt: 0.25, empty: 'dryfire_pistol' },
  },
  {
    id: 'glock18',
    teams: ['t','ct'],
    short: 'GLK',
    name: 'Glock-18',
    price: 400,
    ammoPrice: 30,
    model: 'v_glock18',
    slot: 5,
    kind: 'pistol',
    caseType: '9mm',
    auto: false,
    rpm: 400,
    magSize: 20,
    reserve: 60,
    damage: 30,
    spread: { base: 0.0026, move: 0.014, fire: 0.0055, max: 0.048 },
    recoil: { kick: 0.85, pitch: 1.50, yaw: 0.60, roll: 0.10, pattern: P_PISTOL, recover: 0.34 },
    burst: { count: 3, gap: 0.072, cooldown: 0.55 },   // 一轮三连发打完后要等 0.55s 才能再打
    anims: { draw: 'draw', fire: ['shoot', 'shoot2', 'shoot3'], fireSingle: 'shoot3', reload: 'reload', empty: 'shoot_empty' },
    fix: { gunBone: 'USP', singleSource: 'shoot', slideBone: 'USP_Slide-handle', casingLocal: [0.02, -0.82, 2.27] },
    view: { bob: 0.35, scale: 0.043536, ry: 90, rx: 0, rz: 0, pos: [-0.6523, 0.1149, -0.16] },
    sound: { body: 170, noise: 0.15, gain: 0.45, tail: 0.14 },
    sfx: { shot: 'glock18-1', burst: 'glock18-2', deploy: 'glock18_deploy', deployAt: 0.20, empty: 'dryfire_pistol' },
  },
  {
    id: 'knife',
    teams: ['t','ct'],
    short: 'KNF',
    name: 'Knife',
    price: 0,
    model: 'v_knife',
    slot: 6,
    kind: 'melee',
    auto: false,
    rpm: 200,
    magSize: 0,
    reserve: 0,
    damage: 55,
    spread: { base: 0, move: 0, fire: 0, max: 0 },
    recoil: { kick: 0.35, pitch: 0.35, yaw: 0.15, roll: 0.05, pattern: P_PISTOL, recover: 0.24 },
    anims: {
      draw: 'draw',
      fire: ['midslash1'],
      stab: 'stab', stabMiss: 'stab_miss'
    },
    view: { bob: 0.09, scale: 0.00324, ry: 90, rx: 0, rz: 0, mirror: false, pos: [0.0699, -0.067, -0.16] },
    sound: { body: 0, noise: 0.0, gain: 0.0, tail: 0 },
    sfx: { deploy: 'knife_deploy1', deployAt: 0.02, slash: ['knife_slash1', 'knife_slash2'], stab: 'knife_stab' },
  },
  {
    id: 'm4a1',
    teams: ['ct'],
    short: 'M4',
    name: 'M4A1',
    price: 3100,
    ammoPrice: 60,
    model: 'v_m4a1',
    slot: 7,
    kind: 'rifle',
    caseType: '556',
    auto: true,
    rpm: 666,
    magSize: 30,
    reserve: 90,
    damage: 33,
    spread: { base: 0.0016, move: 0.012, fire: 0.0034, max: 0.040 },
    recoil: { kick: 0.95, pitch: 1.40, yaw: 1.25, roll: 0.10, pattern: P_RIFLE, recover: 0.36 },
    anims: { draw: 'draw_unsil', fire: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'], reload: 'reload_unsil' },
    silencer: {
      default: false,
      attach: 'add_silencer',
      detach: 'detach_silencer',
      cueOn: 0.49,
      cueOff: 0.22,
      on: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
      off: { draw: 'draw_unsil', fire: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'], reload: 'reload_unsil' },
      soundOn: { body: 150, noise: 0.10, gain: 0.32, tail: 0.10 },
      soundOff: { body: 108, noise: 0.24, gain: 0.62, tail: 0.24 }
    },
    fix: { gunBone: 'Bone02', casingLocal: [-0.11, -4.84, 4.66] },
    view: { bob: 0.17, scale: 0.012951, ry: 90, rx: 0, rz: 0, pos: [-0.2802, 0.0657, -0.16] },
    sound: { body: 108, noise: 0.24, gain: 0.62, tail: 0.24 },
    sfx: { shot: 'm4a1_unsil-1', shotSil: 'm4a1-1', deploy: 'm4a1_deploy', deployAt: 0.40, empty: 'dryfire_rifle',
           silencerOn: 'm4a1_silencer_on', silencerOff: 'm4a1_silencer_off',
           // 换弹分段：拔匣 / 插匣 / 末尾拍枪身，按动画实际动作时刻排
           reloadCues: [[0.40, 'm4a1_clipout'], [1.55, 'm4a1_clipin'], [2.47, 'm4a1_deploy']] },
  },

  // MAC-10：T 专用冲锋枪。T 拿是单手（v_mac10r），CT 捡起来自动换回双手（v_mac10），
  // 后坐力也跟着回到双手的手感 —— 同一把枪按阵营换模型。
  // r87 起商店里只有这一把 MAC-10，原来那把双手的已下架。
  // 机位 / 抛壳口等数值：view-tune.js 里有独立的 "mac10t" 条目，调参导出的存档会覆盖 config。
  {
    id: 'mac10t',
    teams: ['t'],
    short: 'MAC',
    name: 'MAC-10',
    price: 1400,
    ammoPrice: 30,
    model: 'v_mac10r',          // 左手不握枪的单手模型
    slot: 8,
    kind: 'smg',
    caseType: '45',
    auto: true,
    rpm: 800,
    magSize: 30,
    reserve: 100,
    damage: 29,
    spread: { base: 0.0034, move: 0.016, fire: 0.0048, max: 0.056 },
    // 单手压不住：后坐力约 +60%，回正也更慢
    recoil: { kick: 1.25, pitch: 1.82, yaw: 2.70, roll: 0.26, pattern: P_SMG, recover: 0.25 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: {
      gunBone: 'Bone03', casingLocal: [0, 0.51, 3.37],
      // 这份模型的枪体骨骼（Bone03）挂在左手下，而单手版左手并不握枪，
      // 待机时枪会悬在右手外面。用「枪体相对手」的枢轴把它沿手骨空间平移，
      // 让握把正好落进右手手心（数值是在调参面板里对着画面扫出来的）。
      handMount: { pivot: true, tune: { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 } },
    },
    // 机位：这份模型的枪离原点很远，所以 pos.x 会到 -0.235（r89 玩家自己调的机位）；
    // 竖屏按全局比例一缩会贴到近裁剪面上（整把枪消失），另给一套 portrait 偏移。
    // 同一份数值也写进了 view-tune.js 的 "mac10t" 条目，调参面板导出的存档会覆盖它。
    view: { bob: 0.24, scale: 0.0155, ry: 92, rx: 0, rz: 2,
            pos: [-0.235, 0.034, -0.014],
            portrait: { k: 0.80, ox: -0.030, oy: 0.050, oz: 0.004 } },
    sound: { body: 160, noise: 0.17, gain: 0.48, tail: 0.15 },
    // 切枪不放 boltpull（这把枪掏出来本来就没声音）；换弹按动画节拍分三段。
    sfx: { shot: 'mac10-1', empty: 'dryfire_rifle',
           reloadCues: [[0.55, 'mac10_clipout'], [1.75, 'mac10_clipin'], [2.45, 'mac10_boltpull']] },
    // 阵营变体：CT 捡到这把枪时换回双手模型（portrait: null = 不套 T 的竖屏偏移）
    teamVariant: {
      ct: {
        model: 'v_mac10',
        view: { ry: 90, rx: 0, rz: 0, pos: [-0.235, 0.02, -0.026], portrait: null },
        // 双手模型枪和手本来就是对齐的，不要套 T 那把的握持偏移
        fix: { handMount: { pivot: true, tune: { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 } } },
        recoil: { kick: 0.80, pitch: 1.10, yaw: 1.70, roll: 0.16, pattern: P_SMG, recover: 0.32 },
      },
    },
  },
  // TEC-9：T 专用冲锋枪。模型只有单发动画（shoot1/shoot2），但按全自动连发使用
  {
    id: 'tec9',
    teams: ['t'],
    short: 'TEC',
    name: 'Tec-9',
    price: 500,
    ammoPrice: 20,
    model: 'v_tec9',
    slot: 21,
    kind: 'smg',
    // 地面模型长度（米）：Tec-9 归类是冲锋枪，但实际只是把「大号手枪」，
    // 按 smg 的 0.55m 摆到地上明显偏大，这里单列真实枪长
    dropLen: 0.30,
    caseType: '9mm',
    auto: true,
    rpm: 600,
    magSize: 32,
    reserve: 100,
    damage: 20,
    spread: { base: 0.0030, move: 0.014, fire: 0.0044, max: 0.052 },
    recoil: { kick: 0.72, pitch: 1.15, yaw: 1.35, roll: 0.12, pattern: P_SMG, recover: 0.32 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'], reload: 'reload', empty: 'shoot_emply' },
    fix: { gunBone: 'USP', casingLocal: [0.02, -0.82, 2.27] },
    view: { bob: 0.20, scale: 0.026, ry: 90, rx: 0, rz: 0, pos: [-0.345, 0.042, -0.16] },
    sound: { body: 160, noise: 0.18, gain: 0.52, tail: 0.16 },
    // 换弹机械音专用 TMP 同款（用户要求）；枪声是自带的 tec-1
    // deployAt 0.28 → 0.82：draw 片段 1.089s，左手 0.70s 才摸到套筒、0.85s 拉到底，
    //   原来 0.28s 是枪还在往上抬的时候，声音比动作早了一大截。
    // reloadCues 按模型实测重排（v_tec9.glb reload 长 3.2s，逐帧比对骨骼/画面）：
    //   0.60~0.70 弹匣脱出 → 0.55 起声正好压在拔匣那一下
    //   1.45~1.55 新匣顶到位 → 1.65 是手拍匣底那一下
    //   2.58~2.68 套筒后拉到底（USP_Slide-handle 速度峰值 2.62s）
    //   原来第三条放在 2.90s，比实际拉栓晚了近 0.3s，听着「动作做完了才响」。
    sfx: { shot: 'tec-1', deploy: 'fiveseven_slidepull', deployAt: 0.82, empty: 'dryfire_pistol',
           reloadCues: [[0.55, 'tmp_clipout'], [1.65, 'tmp_clipin'], [2.58, 'fiveseven_slidepull']] },
  },
  // TMP：CT 专用冲锋枪
  {
    id: 'tmp',
    teams: ['ct'],
    short: 'TMP',
    name: 'TMP',
    price: 1250,
    ammoPrice: 30,
    model: 'v_tmp',
    // 原版模型自带固定消音器（不可拆装），所以开火没有枪口焰
    noFlash: true,
    slot: 22,
    kind: 'smg',
    caseType: '9mm',
    auto: true,
    rpm: 857,
    magSize: 30,
    reserve: 90,
    damage: 20,
    spread: { base: 0.0032, move: 0.015, fire: 0.0046, max: 0.054 },
    recoil: { kick: 0.66, pitch: 1.05, yaw: 1.25, roll: 0.10, pattern: P_SMG, recover: 0.30 },
    anims: { draw: 'draw', fire: ['shoot'], reload: 'reload' },
    fix: { gunBone: 'BONE_SteyrTMP', casingLocal: [0.02, -0.8, 2.3] },
    view: { bob: 0.19, scale: 0.027, ry: 90, rx: 0, rz: 0, pos: [-0.310, 0.063, -0.16] },
    sound: { body: 155, noise: 0.16, gain: 0.48, tail: 0.15 },
    // 切枪不出声（用户要求）：TMP 掏枪同样没有机械音
    sfx: { shot: 'tmp-1', empty: 'dryfire_rifle',
           reloadCues: [[0.35, 'tmp_clipout'], [1.45, 'tmp_clipin']] },
  },
  // UMP45：双方通用
  {
    id: 'ump45',
    teams: ['t', 'ct'],
    short: 'UMP',
    name: 'UMP45',
    price: 1700,
    ammoPrice: 40,
    model: 'v_ump45',
    slot: 23,
    kind: 'smg',
    caseType: '45',
    auto: true,
    rpm: 600,
    magSize: 25,
    reserve: 100,
    damage: 30,
    spread: { base: 0.0028, move: 0.014, fire: 0.0042, max: 0.050 },
    recoil: { kick: 0.78, pitch: 1.18, yaw: 1.15, roll: 0.12, pattern: P_SMG, recover: 0.32 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone51', casingLocal: [0.02, -0.8, 2.3] },
    view: { bob: 0.20, scale: 0.0128, ry: 90, rx: 0, rz: 0, pos: [-0.225, 0.052, -0.16] },
    sound: { body: 120, noise: 0.22, gain: 0.58, tail: 0.20 },
    // 切枪不出声（用户要求）：原版 UMP45 掏枪没有可听的机械动作
    sfx: { shot: 'ump45-1', empty: 'dryfire_rifle',
           reloadCues: [[0.45, 'ump45_clipout'], [2.10, 'ump45_clipin'], [3.00, 'ump45_boltslap']] },
  },
  {
    // M3 Super 90：双方通用霰弹枪（r90 起回到 r88 的设定，M12 已下架）
    id: 'm3',
    teams: ['t', 'ct'],
    short: 'M3',
    name: 'M3 Super 90',
    price: 1700,
    ammoPrice: 65,
    model: 'v_m3',
    slot: 9,
    kind: 'shotgun',
    caseType: 'shotgun',
    auto: false,
    rpm: 85,
    magSize: 8,
    reserve: 32,
    damage: 23,
    pellets: 8,
    spread: { base: 0.012, move: 0.008, fire: 0.004, max: 0.034, pellet: 0.055 },
    recoil: { kick: 2.0, pitch: 3.2, yaw: 0.60, roll: 0.22, pattern: P_SHOTGUN, recover: 0.42 },
    reloadSeq: { start: 'start_reload', loop: 'insert', end: 'after_reload', perLoop: 1 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'] },
    fix: { gunBone: 'Bone02', casingLocal: [-0.09, -2.38, 3.98], ejectDelay: 0.45 },
    view: { bob: 1.0, scale: 0.009037, ry: 90, rx: 0, rz: 0, pos: [-0.1598, 0.0407, -0.16] },
    sound: { body: 88, noise: 0.34, gain: 0.78, tail: 0.34 },
    sfx: { shot: 'm3-1', deploy: 'm3_pump', deployAt: 0.50,
           stage: { start: [], loop: [[0.53, 'm3_insertshell']], end: [[0.46, 'm3_pump']] }, empty: 'dryfire_rifle' },
  },
  {
    id: 'usp',
    teams: ['ct'],
    short: 'USP',
    name: 'USP',
    price: 500,
    ammoPrice: 25,
    model: 'v_usp',
    slot: 10,
    kind: 'pistol',
    caseType: '45',
    auto: false,
    rpm: 352,
    magSize: 12,
    reserve: 100,
    damage: 34,
    spread: { base: 0.0022, move: 0.015, fire: 0.0055, max: 0.050 },
    recoil: { kick: 1.10, pitch: 1.90, yaw: 0.55, roll: 0.16, pattern: P_PISTOL, recover: 0.36 },
    anims: { draw: 'draw_unsil', fire: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'], reload: 'reload_unsil', empty: 'shootlast_unsil' },
    silencer: {
      default: false,
      attach: 'add_silencer',
      detach: 'detach_silencer',
      cueOn: 0.50,
      cueOff: 0.25,
      on: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload', empty: 'shootlast' },
      off: { draw: 'draw_unsil', fire: ['shoot1_unsil', 'shoot2_unsil', 'shoot3_unsil'], reload: 'reload_unsil', empty: 'shootlast_unsil' },
      soundOn: { body: 190, noise: 0.10, gain: 0.30, tail: 0.10 },
      soundOff: { body: 128, noise: 0.26, gain: 0.58, tail: 0.22 }
    },
    fix: { gunBone: 'Bone02', casingLocal: [-4.39, 8.2, -3.33] },
    view: { bob: 0.33, scale: 0.040256, ry: 90, rx: 0, rz: 0, pos: [-0.5867, -0.0669, -0.16] },
    sound: { body: 128, noise: 0.26, gain: 0.58, tail: 0.22 },
    sfx: { shot: 'usp_unsil-1', shotSil: 'usp1', deploy: 'usp_slideback', deployAt: 0.55, empty: 'dryfire_pistol',
           silencerOn: 'usp_silencer_on', silencerOff: 'usp_silencer_off' },
  },
  {
    id: 'sg552',
    teams: ['t'],
    short: 'SG5',
    name: 'SG552',
    price: 3000,
    ammoPrice: 60,
    model: 'v_sg552',
    slot: 11,
    kind: 'rifle',
    caseType: '556',
    auto: true,
    rpm: 727,
    magSize: 30,
    reserve: 90,
    damage: 33,
    spread: { base: 0.0018, move: 0.012, fire: 0.0036, max: 0.042 },
    recoil: { kick: 0.92, pitch: 1.45, yaw: 1.15, roll: 0.10, pattern: P_RIFLE, recover: 0.35 },
    zoom: { levels: [50], sens: [0.70], speed: 0.80 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.06, -1.41, 4.85] },
    view: { bob: 0.26, scale: 0.011821, ry: 90, rx: 0, rz: 0, pos: [-0.2107, 0.0529, -0.16] },
    sound: { body: 132, noise: 0.22, gain: 0.58, tail: 0.22 },
    sfx: { shot: 'sg552-1', deploy: 'sg552_boltpull', deployAt: 0.55, empty: 'dryfire_rifle',
           reloadCues: [[0.58, 'sg552_clipout'], [2.06, 'sg552_clipin'], [2.57, 'sg552_boltpull']] },
  },
  {
    id: 'aug',
    teams: ['ct'],
    short: 'AUG',
    name: 'AUG',
    price: 3500,
    ammoPrice: 60,
    model: 'v_aug',
    slot: 12,
    kind: 'rifle',
    caseType: '556',
    auto: true,
    rpm: 666,
    magSize: 30,
    reserve: 90,
    damage: 32,
    spread: { base: 0.0017, move: 0.011, fire: 0.0034, max: 0.040 },
    recoil: { kick: 0.90, pitch: 1.35, yaw: 1.05, roll: 0.09, pattern: P_RIFLE, recover: 0.34 },
    zoom: { levels: [46], sens: [0.70], speed: 0.80 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload' },
    fix: { gunBone: 'Bone02', casingLocal: [-0.39, 0.27, 4.23] },
    view: { bob: 0.15, scale: 0.010616, ry: 90, rx: 0, rz: 0, pos: [-0.1893, 0.0394, -0.16] },
    sound: { body: 126, noise: 0.23, gain: 0.58, tail: 0.23 },
    sfx: { shot: 'aug-1', deploy: 'aug_boltslap', deployAt: 0.25, empty: 'dryfire_rifle',
           // AUG 的换弹动画是「先拉机柄 → 再换弹匣」，开头那一下必须有机柄声
           // 末尾（2.62~2.70s 手拉到最远）还要拉一下机柄，之前漏了这个音；
           // 顺便把插匣从 2.58 提前到 2.32（分帧实测手拍弹匣到位在 2.30~2.40）
           reloadCues: [[0.56, 'aug_boltpull'], [1.55, 'aug_clipout'],
                        [2.32, 'aug_clipin'], [2.64, 'aug_boltpull']] },
  },
  {
    id: 'm249',
    teams: ['t','ct'],
    short: 'M249',
    name: 'M249',
    price: 5750,
    ammoPrice: 100,
    model: 'v_m249',
    slot: 13,
    kind: 'rifle',
    caseType: '556',
    auto: true,
    rpm: 750,
    magSize: 100,
    reserve: 200,
    damage: 30,
    spread: { base: 0.0022, move: 0.016, fire: 0.0045, max: 0.052 },
    recoil: { kick: 1.05, pitch: 1.45, yaw: 1.35, roll: 0.13, pattern: P_RIFLE, recover: 0.34 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'], reload: 'reload' },
    fix: { gunBone: 'Bone52', casingLocal: [-0.09, -4.21, 5.35] },
    view: { bob: 0.12, scale: 0.013377, ry: 90, rx: 0, rz: 0, pos: [-0.2505, 0.0561, -0.16] },
    sound: { body: 118, noise: 0.22, gain: 0.56, tail: 0.24 },
    sfx: { shot: 'm249-1', empty: 'dryfire_rifle' },
  },
  {
    id: 'fiveseven',
    teams: ['ct'],
    short: '5-7',
    name: 'Five-SeveN',
    price: 750,
    ammoPrice: 50,
    model: 'v_fiveseven',
    slot: 14,
    kind: 'pistol',
    caseType: '57',
    auto: false,
    rpm: 400,
    magSize: 20,
    reserve: 100,
    damage: 25,
    spread: { base: 0.0022, move: 0.014, fire: 0.006, max: 0.048 },
    recoil: { kick: 0.82, pitch: 1.45, yaw: 0.60, roll: 0.10, pattern: P_PISTOL, recover: 0.33 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'], reload: 'reload', empty: 'shoot_empty' },
    fix: { gunBone: 'Bone47', casingLocal: [-0.07, -0.58, 2.84] },
    view: { bob: 0.18, scale: 0.03904, ry: 90, rx: 0, rz: 0, pos: [-0.4588, 0.1341, -0.16] },
    sound: { body: 168, noise: 0.14, gain: 0.44, tail: 0.14 },
    sfx: { shot: 'fiveseven-1', deploy: 'fiveseven_slidepull', deployAt: 0.40, empty: 'dryfire_pistol' },
  },
  {
    // Beretta 92（= CS 1.6 的 P228）：CT 专属手枪，$600、13 发弹匣、伤害 38。
    // 模型/音效由玩家提供（v_beretta / w_beretta / beretta-1.wav）。
    id: 'beretta92',
    teams: ['ct'],
    short: 'B92',
    name: 'Beretta 92',
    price: 600,
    ammoPrice: 50,
    model: 'v_beretta92',
    slot: 19,
    kind: 'pistol',
    caseType: '9mm',
    auto: false,
    rpm: 400,
    magSize: 13,
    reserve: 52,
    damage: 38,
    spread: { base: 0.0022, move: 0.014, fire: 0.0056, max: 0.048 },
    recoil: { kick: 0.95, pitch: 1.60, yaw: 0.58, roll: 0.11, pattern: P_PISTOL, recover: 0.34 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2', 'shoot3'], reload: 'reload', empty: 'shoot_empty' },
    fix: { gunBone: 'Bone02', casingLocal: [0, -0.7, 2.6] },
    // 机位：模型原点和 glock18 那套接近，先按手枪通用位给，实测后再收
    view: { bob: 0.33, scale: 0.040256, ry: 90, rx: 0, rz: 0, pos: [-0.5867, -0.0669, -0.16] },
    sound: { body: 128, noise: 0.24, gain: 0.56, tail: 0.22 },
    sfx: { shot: 'beretta-1', deploy: 'beretta_rightclipin', deployAt: 0.30, empty: 'dryfire_pistol',
           reloadCues: [[0.20, 'beretta_reloadstart'], [1.05, 'beretta_rightclipin']] },
  },
  {
    // 左轮手枪（六发转轮，开火不抛壳，换弹为转轮逐颗上膛）
    id: 'revolver',
    teams: ['t'],
    short: 'REV',
    name: 'Revolver',
    price: 650,
    ammoPrice: 40,
    model: 'v_revolver',
    slot: 18,
    kind: 'pistol',
    noCasing: true,
    cock: true,           // 单动左轮：每发打完必须手动扳击锤，动画播完前不能开下一枪
    auto: false,
    rpm: 300,
    magSize: 6,
    reserve: 36,
    damage: 60,
    spread: { base: 0.0022, move: 0.015, fire: 0.006, max: 0.050 },
    recoil: { kick: 1.25, pitch: 2.0, yaw: 0.6, roll: 0.14, pattern: P_PISTOL, recover: 0.36 },
    anims: { draw: 'draw', fire: ['shoot1', 'shoot2'], empty: 'shoot_empty', reload: 'reload' },
    fix: { gunBone: 'revolver' },
    view: { bob: 0.62, scale: 0.0213, ry: 90, rx: 0, rz: 0, pos: [-0.30, 0.06, -0.15] },
    sound: { body: 150, noise: 0.18, gain: 0.6, tail: 0.18 },
    sfx: { shot: 'revolver-1', empty: 'dryfire_pistol',
           // 切枪只留一声：落在「扳击锤」那一下（draw 1.16s，枪已经抬到位）。
           // 之前这里有 deploy(deployAt 0.58) + deployCues(1.16) 两条，
           // 都是 revolver_deploy，所以切一次枪会听两遍 —— 现在合成一条。
           deployCues: [[1.16, 'revolver_deploy']],
           // 单动左轮：每发打完要手动扳击锤，扳到位那一下的「咔哒」
           // shoot1 峰值 1.16s / shoot2 峰值 1.03s（两段动画长度不同）
           // 声音统一用 revolver_deploy（原来是单独合成的 revolver_cock，已删除）
           fireCuesByClip: { shoot1: [[1.16, 'revolver_deploy']],
                             shoot2: [[1.03, 'revolver_deploy']] },
           // 转轮换弹：开转轮 → 倒出弹壳（6 颗，用统一的弹壳落地声 pl_shell1）
           // → 上弹 → 合转轮。弹壳滑出转轮的区间是 1.36~2.30s，按疏密排 6 下。
           reloadCues: [[0.45, 'revolver_clipout'],
                        [1.50, 'pl_shell1', 0.55], [1.62, 'pl_shell1', 0.48],
                        [1.75, 'pl_shell1', 0.52], [1.88, 'pl_shell1', 0.40],
                        [2.02, 'pl_shell1', 0.34], [2.18, 'pl_shell1', 0.26],
                        [2.35, 'revolver_clipin'], [3.02, 'revolver_clipout']] },
  },
  {
    id: 'hegrenade',
    max: 1,
    teams: ['t','ct'],
    short: 'HE',
    name: 'HE Grenade',
    price: 300,
    model: 'v_hegrenade',
    slot: 15,
    kind: 'grenade',
    auto: false,
    rpm: 55,
    magSize: 1,
    reserve: 1,
    damage: 0,
    spread: { base: 0, move: 0, fire: 0, max: 0 },
    recoil: { kick: 0.2, pitch: 0.2, yaw: 0.1, roll: 0.03, pattern: P_PISTOL, recover: 0.3 },
    anims: { draw: 'deploy', fire: ['throw'] },
    // 原版手雷：500 单位 ≈ 12.7m 爆炸半径、爆心 200 左右伤害，按距离平方衰减
    grenade: { type: 'he', pin: 'pullpin', toss: 'throw', speed: 14, fuse: 2.4, radius: 9.2, maxDamage: 200, armorPen: 0.5, color: 0x46523a },
    view: { bob: 0.42, scale: 0.017454, ry: 90, rx: 0, rz: 0, pos: [-0.1835, 0.0172, -0.16] },
    sound: { body: 0, noise: 0, gain: 0, tail: 0 },
    sfx: { explode: 'hegrenade_explode' },
  },
  {
    id: 'flashbang',
    max: 2,
    teams: ['t','ct'],
    short: 'FB',
    name: 'Flashbang',
    price: 200,
    model: 'v_flashbang',
    slot: 16,
    kind: 'grenade',
    auto: false,
    rpm: 55,
    magSize: 1,
    reserve: 1,
    damage: 0,
    spread: { base: 0, move: 0, fire: 0, max: 0 },
    recoil: { kick: 0.2, pitch: 0.2, yaw: 0.1, roll: 0.03, pattern: P_PISTOL, recover: 0.3 },
    anims: { draw: 'deploy', fire: ['throw'] },
    // 闪光弹：500 单位 ≈ 12.7m 致盲半径，正对爆心 4.9s，背对也有 1.1s 余光；
    // 另外带一点点灼伤（原版也会掉几滴血）
    grenade: { type: 'flash', pin: 'pullpin', toss: 'throw', speed: 14, fuse: 1.9, radius: 12.7,
              maxDamage: 8, blindMax: 4.9, blindMin: 1.1, color: 0x3d434a },
    view: { bob: 0.42, scale: 0.017454, ry: 90, rx: 0, rz: 0, pos: [-0.1835, 0.0172, -0.16] },
    sound: { body: 0, noise: 0, gain: 0, tail: 0 },
    sfx: { explode: 'flashbang-1' },
  },
  {
    id: 'smokegrenade',
    max: 1,
    teams: ['t','ct'],
    short: 'SMK',
    name: 'Smoke Grenade',
    price: 300,
    model: 'v_smokegrenade',
    slot: 17,
    kind: 'grenade',
    auto: false,
    rpm: 55,
    magSize: 1,
    reserve: 1,
    damage: 0,
    spread: { base: 0, move: 0, fire: 0, max: 0 },
    recoil: { kick: 0.2, pitch: 0.2, yaw: 0.1, roll: 0.03, pattern: P_PISTOL, recover: 0.3 },
    anims: { draw: 'deploy', fire: ['throw'] },
    // 烟雾弹：烟团半径约 4m（原版能盖住一条小道），不造成伤害
    grenade: { type: 'smoke', pin: 'pullpin', toss: 'throw', speed: 13.5, fuse: 2.2, radius: 4.0, color: 0x3f4a35 },
    view: { bob: 0.42, scale: 0.017454, ry: 90, rx: 0, rz: 0, pos: [-0.1835, 0.0172, -0.16] },
    sound: { body: 0, noise: 0, gain: 0, tail: 0 },
    sfx: { explode: 'smokegrenade_explode' },
  },
  {
    // C4：不是常规武器，不进购买菜单 / 物品栏（hidden），由回合系统发给 T。
    // kind: 'c4' —— main.js 里单独处理（不能开火、不能换弹，只能安放 / 丢弃）
    id: 'c4',
    teams: ['t'],
    hidden: true,
    short: 'C4',
    name: 'C4 炸药',
    price: 0,
    ammoPrice: 0,
    model: 'v_c4',
    slot: 11,          // 不进数字键槽位（单独用 X / 左侧按钮切出）
    kind: 'c4',
    caseType: 'none',
    noFlash: true,
    auto: false,
    rpm: 30,
    magSize: 1,
    reserve: 0,
    damage: 0,
    spread: { base: 0, move: 0, fire: 0, max: 0 },
    recoil: { kick: 0, pitch: 0, yaw: 0, roll: 0, pattern: P_PISTOL, recover: 0.3 },
    anims: {
      draw: 'draw',
      fire: ['pressbutton'],
      reload: 'pressbutton',
      plant: 'pressbutton',    // 下包：按密码键盘
      plantDrop: 'drop'        // 下包：输完密码把 C4 放到地上
    },
    // portrait：手机竖屏单独构图。C4 离视点只有 2.8cm（比枪近得多），竖屏横向视野只有
    // 50° 左右，按全局竖屏比例缩到 0.34 还是糊半个屏幕；这里把它往后推 12cm、
    // 右移一点、压到准星下方，包体正好落在右下角手里。
    view: { bob: 0.22, scale: 0.0255, ry: 75, rx: 0, rz: 0, pos: [-0.401, 0.06, 0.028],
            portrait: { k: 1.3, ox: 0.08, oy: -0.03, oz: -0.12 } },
    sound: { body: 0, noise: 0, gain: 0, tail: 0 },
    // 切出 C4 不出声（原来那下 click 太抢戏）；丢下/安放时的机械声另算
    sfx: {},
    // 世界里的 C4 只有巴掌大：不给 dropLen 会按 0.8m 归一化，掉地上像块砖
    dropLen: 0.34,
  },
];

export const WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));

/**
 * C4 包点：数据放在 src/bomb-sites.js（游戏内「包点」面板可现场调、可导出替换）。
 * 这里只做转出，保证 main.js 等老代码的 import 不变。
 *   x / z = 圆心世界坐标（米），r = 半径（米）——判定范围和黄色圈共用 r。
 */
export { BOMB_SITES } from './bomb-sites.js?v=r90';

/** C4 规则（CS 1.6 原版数值） */
export const BOMB_RULES = {
  // pressbutton 动画 3.03s：开头 0~0.8s 是抬手翻包（手会糊到镜头前，看着像闪一下），
  // 跳过这段，从「手指按在键盘上」的姿势淡进来，剩下的 2.23s 就是纯按键
  plantAnimStart: 0.8,
  plantTime: 2.18,     // 输密码时长（比动画剩下的 2.23s 略短，保证接 drop 时动作还没结束）
  plantDropTime: 1.5,  // 输完密码后把 C4 放到地上的 drop 动画总长
  plantReleaseAt: 0.95,// drop 动画里手松开、C4 落地的时刻（到这儿才算真正安放）
  plantBeepGap: 0.19,  // 输密码时键盘「滴」的节奏
  timer: 40,           // 引信 40 秒
  defuseTime: 10,      // 无拆弹钳 10 秒
  defuseKitTime: 5,    // 有拆弹钳 5 秒
  radius: 12.7,        // 爆炸半径 500 单位 ≈ 12.7m
  maxDamage: 500,      // 爆心 500 伤害
};

