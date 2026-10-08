// Race audio, synthesized with Web Audio (no sound files): an engine that follows revs and gears,
// tyre squeal, crash thumps and a crowd that murmurs and roars on big moments.
// Browsers only allow audio after a user gesture, so start() is called from a click/keypress.
//
// Every per-frame change goes through glide(), which clears what was scheduled before: piling up
// a new automation event 60 times a second makes the browser's audio thread crackle after a while.

const GEARS = [0, 45, 80, 115, 150, 185, 215, 260]; // km/h where each gear starts

/** Brown noise (deep rumble) or white noise, 2 s, looped by the players. */
function noiseBuffer(ctx: AudioContext, brown: boolean): AudioBuffer {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

/** Soft clipping: a little growl without harsh distortion. */
function softClip(ctx: AudioContext, drive: number): WaveShaperNode {
  const ws = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  ws.oversample = '2x';
  return ws;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engOsc: OscillatorNode[] = [];
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private rumbleGain!: GainNode;
  private skidGain!: GainNode;
  private skidFilter!: BiquadFilterNode;
  private crowdGain!: GainNode;
  private crowdFilter!: BiquadFilterNode;
  private white!: AudioBuffer;
  private crowdBoost = 0;
  private gear = 0;
  private shiftDip = 0; // s left of the gear-change dip
  private lastImpact = 0;
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
    const ctx = (this.ctx = new Ctx({ latencyHint: 'interactive' }));
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    this.master.connect(comp).connect(ctx.destination);
    this.white = noiseBuffer(ctx, false);
    const brown = noiseBuffer(ctx, true);

    // --- engine: an engine-shaped waveform (strong low harmonics, falling off), two slightly detuned
    // copies for a thick sound, a sub octave for body, soft clipping for growl, then a gentle low-pass
    const harm = [0, 1, 0.75, 0.5, 0.42, 0.25, 0.2, 0.12, 0.09, 0.05, 0.04, 0.02];
    const wave = ctx.createPeriodicWave(new Float32Array(harm.map((_, i) => (i % 2 ? 0 : harm[i] * 0.3))), new Float32Array(harm));
    const engMix = ctx.createGain();
    engMix.gain.value = 0.32;
    for (const detune of [-7, 6]) {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.detune.value = detune;
      o.connect(engMix);
      o.start();
      this.engOsc.push(o);
    }
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'sine';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.45;
    this.engSub.connect(subGain).connect(engMix);
    this.engSub.start();
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 0.7;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    engMix.connect(softClip(ctx, 2.2)).connect(this.engFilter).connect(this.engGain).connect(this.master);

    // exhaust / road rumble under the engine
    const rumble = ctx.createBufferSource();
    rumble.buffer = brown;
    rumble.loop = true;
    const rumbleF = ctx.createBiquadFilter();
    rumbleF.type = 'lowpass';
    rumbleF.frequency.value = 260;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumble.connect(rumbleF).connect(this.rumbleGain).connect(this.master);
    rumble.start();

    // --- tyre squeal: band-passed noise whose pitch wanders a little
    const skid = ctx.createBufferSource();
    skid.buffer = this.white;
    skid.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1900;
    this.skidFilter.Q.value = 9;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    skid.connect(this.skidFilter).connect(this.skidGain).connect(this.master);
    skid.start();

    // --- crowd: deep noise through voice-range filters, slowly swelling (a murmur, not a hiss)
    const crowd = ctx.createBufferSource();
    crowd.buffer = brown;
    crowd.loop = true;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 700;
    this.crowdFilter.Q.value = 0.9;
    const voices = ctx.createBiquadFilter();
    voices.type = 'peaking';
    voices.frequency.value = 1400;
    voices.gain.value = 6;
    const swell = ctx.createGain();
    swell.gain.value = 0.85;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.23;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.15;
    lfo.connect(lfoDepth).connect(swell.gain);
    lfo.start();
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.05;
    crowd.connect(this.crowdFilter).connect(voices).connect(swell).connect(this.crowdGain).connect(this.master);
    crowd.start();
  }

  /** Move a parameter smoothly towards v, replacing whatever was still scheduled on it. */
  private glide(p: AudioParam, v: number, tc: number) {
    const now = this.ctx!.currentTime;
    if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now);
    else p.cancelScheduledValues(now);
    p.setTargetAtTime(v, now, tc);
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('agp-muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) this.glide(this.master.gain, m ? 0 : 0.9, 0.05);
  }

  /** Per frame: the followed car's state. `near` 0..1 = how close we are to a crowd. */
  update(speedMs: number, throttle: number, slip: number, near: number, dt: number, engineGain = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // No car to follow (lobby, fan view between races) can hand us NaN: Web Audio throws on that.
    const ok = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
    speedMs = ok(speedMs);
    throttle = Math.max(0, Math.min(1, ok(throttle)));
    slip = ok(slip);
    near = Math.max(0, Math.min(1, ok(near)));
    dt = Math.min(0.1, ok(dt, 0.016));
    engineGain = Math.max(0, Math.min(1, ok(engineGain, 1)));
    const kmh = Math.max(0, speedMs * 3.6);
    let g = 0;
    while (g < GEARS.length - 2 && kmh >= GEARS[g + 1]) g++;
    if (g !== this.gear) {
      if (g > this.gear) this.shiftDip = 0.12; // a short lift on the up-shift
      this.gear = g;
    }
    this.shiftDip = Math.max(0, this.shiftDip - dt);
    const lo = GEARS[g],
      hi = GEARS[g + 1];
    const frac = Math.min(1, (kmh - lo) / (hi - lo));
    const rpm = (g === 0 ? 1100 : 3000) + frac * (g === 0 ? 4800 : 3800) + throttle * 350;
    const f = 30 + rpm * 0.017; // ~50 Hz idle .. ~160 Hz at the limiter
    const shifting = this.shiftDip > 0;
    for (const o of this.engOsc) this.glide(o.frequency, f, shifting ? 0.09 : 0.05);
    this.glide(this.engSub.frequency, f / 2, shifting ? 0.09 : 0.05);
    this.glide(this.engFilter.frequency, 380 + throttle * 1500 + frac * 500 + kmh * 2, 0.08);
    const load = 0.06 + throttle * 0.06 + Math.min(1, kmh / 200) * 0.025;
    this.glide(this.engGain.gain, (shifting ? load * 0.45 : load) * engineGain, shifting ? 0.02 : 0.07);
    this.glide(this.rumbleGain.gain, Math.min(1, kmh / 120) * 0.16 * engineGain, 0.15);
    const sq = Math.max(0, Math.min(1, (slip - 2.5) / 6));
    this.glide(this.skidGain.gain, sq * sq * 0.14 * engineGain, 0.06);
    this.glide(this.skidFilter.frequency, 1700 + sq * 600 + Math.sin(ctx.currentTime * 13) * 120, 0.05);
    this.crowdBoost = Math.max(0, this.crowdBoost - dt * 0.22);
    this.glide(this.crowdGain.gain, 0.04 + near * 0.12 + this.crowdBoost * 0.35, 0.25);
    this.glide(this.crowdFilter.frequency, 650 + this.crowdBoost * 500, 0.3);
  }

  /** Crowd reaction (0..1): overtakes, crashes near the fans, the finish. */
  cheer(level: number) {
    this.crowdBoost = Math.min(1, Math.max(this.crowdBoost, level));
  }

  /** A hit: strength 0..1. Thump + crunch (a burst of hits plays as one, not a machine gun). */
  impact(strength: number, metal = false) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    if (t - this.lastImpact < 0.09) return;
    this.lastImpact = t;
    const s = Math.max(0.15, Math.min(1, strength));
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = metal ? 'bandpass' : 'lowpass';
    f.frequency.value = metal ? 2600 : 800;
    f.Q.value = metal ? 2 : 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4 * s, t + 0.005); // no click at the start
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + s * 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.7);
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(85, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.55 * s, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
  }

  stop() {
    void this.ctx?.close();
    this.ctx = null;
  }
}
