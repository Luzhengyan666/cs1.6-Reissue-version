import { AUDIO_MANIFEST } from '../assets/audio/manifest.js?v=r90';

// 素材根目录（相对本模块）
const BASE = new URL('../assets/audio/', import.meta.url).href;
// 素材版本：改了 wav 就加一，避免浏览器拿 HTTP 缓存里的旧音轨
const VER = '?v=r90';

/**
 * 各类音效的基准音量。
 * 原版素材是 8bit/22kHz 的 CS 1.6 wav，枪声本身就很冲，机械声要压下来，
 * 否则换弹的咔哒声会盖过枪声。
 */
export const SFX_GAIN = {
  shot: 1.00,
  deploy: 0.85,
  clipout: 0.62,
  clipin: 0.62,
  bolt: 0.62,
  slide: 0.60,
  shell: 0.72,
  pump: 0.78,
  reload: 1.00,
  empty: 0.42,
  knife: 0.72,
  silencer: 0.55
};

/**
 * 纯素材播放引擎：全部音效来自 assets/audio/*.wav（CS 1.6 原版素材）。
 * - 启动后后台解码全部素材到 AudioBuffer，播放零延迟
 * - play() 支持传数组：按顺序取第一个「素材包里真的存在」的文件名
 * - 缺文件时静默跳过，绝不拿别的枪的声音顶替
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.9;
    this.buffers = new Map();
    this._loading = new Map();
    this.manifest = new Set(AUDIO_MANIFEST);
    this.ready = false;
    this.keyed = new Map();   // 可被中断的长音（换弹整段等）按 key 管理
    this.log = [];            // 调试用：最近播放的素材名
    this.trace = [];          // 调试用：{name, t} 带时间戳的播放记录
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    this.preload();
  }

  /** 输出延迟（秒）：换弹这种长音可以靠「跳过开头」提前发声来抵消 */
  latency() {
    if (!this.ctx) return 0;
    const l = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return Math.max(0, Math.min(0.12, l));
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  has(name) {
    return !!name && this.manifest.has(name);
  }

  /** 预解码全部素材，并回报进度（加载页用） */
  async preloadAll(onProgress) {
    if (!this.ctx) return;
    const names = [...AUDIO_MANIFEST];
    let next = 0, done = 0;
    const worker = async () => {
      while (next < names.length) {
        const name = names[next++];
        try { await this._load(name); } catch (e) { /* 缺少的素材跳过 */ }
        done++;
        if (onProgress) onProgress(done, names.length);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.ready = true;
  }

  /** 预解码全部素材 */
  async preload() {
    if (!this.ctx) return;
    await Promise.all(AUDIO_MANIFEST.map(n => this._load(n).catch(() => null)));
    this.ready = true;
  }

  _load(name) {
    if (!this.has(name)) return Promise.resolve(null);
    if (this.buffers.has(name)) return Promise.resolve(this.buffers.get(name));
    if (this._loading.has(name)) return this._loading.get(name);
    const p = fetch(BASE + name + '.wav' + VER)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(buf => new Promise((res, rej) => {
        // 老浏览器不支持 Promise 版 decodeAudioData
        const ret = this.ctx.decodeAudioData(buf, res, rej);
        if (ret && ret.then) ret.then(res, rej);
      }))
      .then(audio => {
        this.buffers.set(name, audio);
        this._loading.delete(name);
        return audio;
      })
      .catch(err => {
        this._loading.delete(name);
        console.warn('[audio] 素材加载失败', name, err.message);
        return null;
      });
    this._loading.set(name, p);
    return p;
  }

  _playBuffer(name, { gain = 1, rate = 1, delay = 0, key = null, startAt = 0, dur = 0, pan = 0 } = {}) {
    const buf = this.buffers.get(name);
    if (!buf || !this.ctx) return;
    const ctx = this.ctx;

    // 同一 key 的长音先停掉（切枪打断换弹时不会继续响）
    if (key) this.stopKey(key);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    let out = g;
    // 声像：只有 AI 的世界音源会传 pan（-1 左 / +1 右），玩家自己的枪声不加节点
    if (pan) {
      if (ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, pan));
        g.connect(p); out = p;
      } else if (ctx.createPanner) {
        const p = ctx.createPanner();
        p.panningModel = 'equalpower';
        p.setPosition(Math.max(-1, Math.min(1, pan)), 0, 1 - Math.abs(pan));
        g.connect(p); out = p;
      }
    }
    out.connect(this.master);
    const t = ctx.currentTime + Math.max(0, delay);
    const off = Math.max(0, Math.min(startAt, Math.max(0, buf.duration - 0.05)));
    src.start(t, off);
    // dur：只播素材的前 N 秒。有些拟音是「一整段」的（比如 remington_clipout
    // 1.8s 里含拔匣+插匣+拉栓），整段放着会拖过动作结束，必须能掐掉尾巴。
    if (dur > 0) { try { src.stop(t + dur); } catch (e) { /* 已结束 */ } }
    if (key) {
      this.keyed.set(key, src);
      src.onended = () => { if (this.keyed.get(key) === src) this.keyed.delete(key); };
    }

    this.log.push(name);
    if (this.log.length > 24) this.log.shift();
    this.trace.push({ name, t: performance.now(), rate });
    if (this.trace.length > 400) this.trace.shift();
  }

  /** 按素材名推断音量（枪声单独在 shot() 里给满音量） */
  autoGain(name) {
    if (/insertshell/.test(name)) return SFX_GAIN.shell;
    if (/pump/.test(name)) return SFX_GAIN.pump;
    if (/silencer/.test(name)) return SFX_GAIN.silencer;
    if (/clipout|clipin/.test(name)) return SFX_GAIN.clipout;
    if (/bolt|slide/.test(name)) return SFX_GAIN.bolt;
    if (/deploy/.test(name)) return SFX_GAIN.deploy;
    if (/^knife_/.test(name)) return SFX_GAIN.knife;
    if (/^dryfire/.test(name)) return SFX_GAIN.empty;
    if (/_reload(_empty)?$/.test(name)) return SFX_GAIN.reload;
    return 0.7;
  }

  /**
   * 播放一个素材。name 可以是字符串或字符串数组（取第一个存在的）。
   * 返回真正播放（或排队播放）的素材名，便于自检。
   */
  play(name, opts = {}) {
    if (!this.enabled) return null;
    const list = Array.isArray(name) ? name : [name];
    const pick = list.find(n => this.has(n));
    if (!pick) return null;
    this.init();
    if (!this.ctx) return null;

    const { rate = 1, delay = 0, key = null, startAt = 0, dur = 0 } = opts;
    const gain = opts.gain != null ? opts.gain : this.autoGain(pick);
    if (this.buffers.has(pick)) {
      this._playBuffer(pick, { gain, rate, delay, key, startAt, dur });
    } else {
      // 首次播放还没解码完：解码后补播（延迟不会超过一帧）
      this._load(pick).then(() => this._playBuffer(pick, { gain, rate, delay, key, startAt, dur }));
    }
    return pick;
  }

  /** 停掉某个 key 上的长音（换弹被切枪打断时用） */
  stopKey(key) {
    const src = this.keyed.get(key);
    if (!src) return;
    try { src.stop(); } catch (e) { /* 可能已经播完 */ }
    this.keyed.delete(key);
  }

  /**
   * 距离衰减系数：ref 米内基本不衰减，之后按 ref/(ref+d) 掉，
   * 超过 maxDist 直接静音（省掉节点，也符合「远处听不见」）。
   */
  attenuation(pos, ref = 7, maxDist = 55) {
    const L = this.listener && this.listener();
    if (!L || !L.pos) return 1;
    const d = Math.hypot(pos.x - L.pos.x, pos.y - L.pos.y, pos.z - L.pos.z);
    if (d >= maxDist) return 0;
    return ref / (ref + d);
  }

  /** 世界坐标音源（AI 的枪声 / 脚步 / 换弹 / 手雷）：距离衰减 + 左右声像 */
  playAt(name, pos, opts = {}) {
    if (!this.enabled || !pos) return null;
    const list = Array.isArray(name) ? name : [name];
    const pick = list.find(n => this.has(n));
    if (!pick) return null;
    this.init();
    if (!this.ctx) return null;
    const { rate = 1, ref = 7, maxDist = 55, panK = 0.85 } = opts;
    const att = this.attenuation(pos, ref, maxDist);
    if (att <= 0) return pick;
    const gain = (opts.gain != null ? opts.gain : this.autoGain(pick)) * att;
    let pan = 0;
    const L = this.listener && this.listener();
    if (L && L.pos && L.right) {
      const dx = pos.x - L.pos.x, dz = pos.z - L.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      pan = ((dx * L.right.x + dz * L.right.z) / d) * panK;
    }
    if (this.buffers.has(pick)) {
      this._playBuffer(pick, { gain, rate, pan });
    } else {
      this._load(pick).then(() => this._playBuffer(pick, { gain, rate, pan }));
    }
    return pick;
  }

  /** 枪声：装了消音器用消音版本（M4A1 / USP） */
  shot(def, silenced) {
    const sfx = def.sfx || {};
    const name = silenced ? (sfx.shotSil || sfx.shot) : sfx.shot;
    // 每发轻微随机音高，连发时不会像电子循环
    return this.play(name, { gain: SFX_GAIN.shot, rate: 0.97 + Math.random() * 0.06 });
  }

  /** 空仓：按枪型选击锤/撞针的空响 */
  empty(def) {
    const name = (def.sfx && def.sfx.empty) ||
      (def.kind === 'pistol' ? 'dryfire_pistol' : 'dryfire_rifle');
    return this.play(name, { gain: SFX_GAIN.empty });
  }

  /** 近战 */
  melee(def, { stab = false } = {}) {
    const sfx = def.sfx || {};
    const name = stab ? (sfx.stab || 'knife_stab') : (sfx.slash || ['knife_slash1', 'knife_slash2']);
    return this.play(name, { gain: SFX_GAIN.knife });
  }

  /** 纯 UI 操作音（开镜/买枪等）：短合成咔哒。
   *  buffer 只生成一次缓存起来，每次点击都起一个独立 source 播放 ——
   *  快速连点每一下都立即发声、互相叠加，不会互相顶掉。 */
  click() {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (!this._clickBuf) {
      const len = Math.floor(ctx.sampleRate * 0.02);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 6);
      this._clickBuf = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._clickBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 2300; f.Q.value = 3;
    const g = ctx.createGain();
    g.gain.value = 0.10;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(ctx.currentTime);
  }

  /**
   * C4 键盘「滴」：直接用 C4 倒计时那声「滴」的音色（r90 玩家指定）。
   * c4_beep1.wav 是 8bit/22kHz 的单声滴 + 静音填充，滴在 0.68~0.82s；
   * 截这一段播 0.145s 就是原汁原味的那一下，比之前合成的 1860Hz 电子音更「原版」。
   * 素材还没解码完时退回原来的合成音，保证按键永远有反馈。
   */
  keypad({ rate = 1, gain = 0.20 } = {}) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const beep = this.buffers.get('c4_beep1');
    if (beep) {
      this._playBuffer('c4_beep1', { gain, rate, startAt: 0.675, dur: 0.150 });
      return;
    }
    this._load('c4_beep1');
    if (!this._keyBuf) {
      const sr = ctx.sampleRate;
      const len = Math.floor(sr * 0.075);
      const buf = ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      const f0 = 1860;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        // 1.5ms 起音、指数衰减（约 45ms 后基本听不见），尾巴收干净不拖泥带水
        const env = (1 - Math.exp(-t * 1400)) * Math.exp(-t * 62);
        const s = Math.sin(2 * Math.PI * f0 * t) * 0.72
                + Math.sin(2 * Math.PI * f0 * 2 * t) * 0.16
                + Math.sin(2 * Math.PI * f0 * 0.5 * t) * 0.12;
        d[i] = s * env * 0.42;
      }
      this._keyBuf = buf;
    }
    const src = ctx.createBufferSource();
    src.buffer = this._keyBuf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    src.start(ctx.currentTime);
    this.log.push('keypad');
    if (this.log.length > 24) this.log.shift();
    this.trace.push({ name: 'keypad', t: performance.now(), rate });
    if (this.trace.length > 400) this.trace.shift();
  }

  /**
   * 闪光弹耳鸣：被闪到之后耳朵里那条高频余音（原版没有单独素材，这里合成）。
   * 一个 3.8kHz 的正弦 + 8Hz 轻微颤动，指数衰减，起音留 10ms 免得出爆音。
   */
  ring(dur = 2, gain = 0.1) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * Math.max(0.2, Math.min(6, dur))));
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    const f0 = 3800;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const k = t / (len / sr);
      // 起音 8ms；音量整体按 (1-k)^1.6 收，尾段再叠一个慢速颤动
      const atk = Math.min(1, t / 0.008);
      const env = atk * Math.pow(1 - k, 1.6) * (0.85 + 0.15 * Math.sin(2 * Math.PI * 7.5 * t));
      d[i] = Math.sin(2 * Math.PI * f0 * t) * env * 0.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, gain);
    src.connect(g); g.connect(this.master);
    src.start(ctx.currentTime);
    this.log.push('ring');
    if (this.log.length > 24) this.log.shift();
  }
}
