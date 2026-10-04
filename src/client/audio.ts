// Race audio, synthesized with Web Audio (no sound files): engine note that follows revs and
// gears, tyre squeal, crash thumps and a crowd roar that swells on big moments.
// Browsers only allow audio after a user gesture, so start() is called from a click/keypress.

const GEARS = [0, 45, 80, 115, 150, 185, 215, 260]; // km/h where each gear starts

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private skidGain!: GainNode;
  private crowdGain!: GainNode;
  private crowdFilter!: BiquadFilterNode;
  private noise!: AudioBuffer;
  private crowdBoost = 0;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('agp-muted') === '1';
    } catch {
      /* ignore */
    }
  }

  get running() {
    return !!this.ctx;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  start() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // white noise buffer, reused by skid, crowd and crashes
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // engine: two detuned oscillators through a low-pass that opens with throttle
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 4;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.5;
    this.engA.connect(this.engFilter);
    this.engB.connect(bGain).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.engA.start();
    this.engB.start();

    // tyre squeal: band-passed noise
    const skid = ctx.createBufferSource();
    skid.buffer = this.noise;
    skid.loop = true;
    const skidF = ctx.createBiquadFilter();
    skidF.type = 'bandpass';
    skidF.frequency.value = 2400;
    skidF.Q.value = 6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skid.connect(skidF).connect(this.skidGain).connect(this.master);
    skid.start();

    // crowd: low-passed noise, a bed that swells
    const crowd = ctx.createBufferSource();
    crowd.buffer = this.noise;
    crowd.loop = true;
    crowd.playbackRate.value = 0.7;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 900;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.02;
    crowd.connect(this.crowdFilter).connect(this.crowdGain).connect(this.master);
    crowd.start();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('agp-muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05);
  }

  /** Per frame: the followed car's state. `near` 0..1 = how close we are to a crowd. */
  update(speedMs: number, throttle: number, slip: number, near: number, dt: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const kmh = Math.max(0, speedMs * 3.6);
    let g = 0;
    while (g < GEARS.length - 2 && kmh >= GEARS[g + 1]) g++;
    const lo = GEARS[g],
      hi = GEARS[g + 1];
    const frac = Math.min(1, (kmh - lo) / (hi - lo));
    const rpm = (g === 0 ? 900 : 3200) + frac * (g === 0 ? 6200 : 4300) + throttle * 400;
    const f = 38 + rpm * 0.026;
    this.engA.frequency.setTargetAtTime(f, now, 0.04);
    this.engB.frequency.setTargetAtTime(f * 0.501, now, 0.04);
    this.engFilter.frequency.setTargetAtTime(500 + throttle * 2200 + frac * 900, now, 0.05);
    this.engGain.gain.setTargetAtTime(0.05 + throttle * 0.07 + Math.min(1, kmh / 200) * 0.03, now, 0.06);
    const sq = Math.max(0, Math.min(1, (slip - 2.5) / 6));
    this.skidGain.gain.setTargetAtTime(sq * 0.12, now, 0.05);
    this.crowdBoost = Math.max(0, this.crowdBoost - dt * 0.25);
    this.crowdGain.gain.setTargetAtTime(0.015 + near * 0.05 + this.crowdBoost * 0.18, now, 0.2);
    this.crowdFilter.frequency.setTargetAtTime(800 + this.crowdBoost * 900, now, 0.2);
  }

  /** Crowd reaction (0..1): overtakes, crashes near the fans, the finish. */
  cheer(level: number) {
    this.crowdBoost = Math.min(1, Math.max(this.crowdBoost, level));
  }

  /** A hit: strength 0..1. Thump + crunch. */
  impact(strength: number, metal = false) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const s = Math.max(0.15, Math.min(1, strength));
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = metal ? 'bandpass' : 'lowpass';
    f.frequency.value = metal ? 3200 : 900;
    f.Q.value = metal ? 3 : 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * s, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + s * 0.4);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.8);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.6 * s, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
  }

  stop() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
