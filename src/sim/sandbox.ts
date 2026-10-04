// Runs untrusted driver code inside QuickJS (WebAssembly). Each car gets its own runtime:
// no network, DOM, timers or host objects, with a memory cap, a stack cap and a per-call CPU budget.
// The CPU budget counts interpreter interrupt polls instead of wall-clock time, so a driver
// times out at exactly the same point on every machine. That keeps races deterministic.
import type { QuickJSWASMModule, QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core';
import type { DriverOutput } from './driverApi';

export const SANDBOX_LIMITS = {
  codeBytes: 20_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 512 * 1024,
  initBudget: 100, // interrupt polls allowed while loading the code
  callBudget: 10, // interrupt polls allowed per drive() call (~100k ops)
};


const HARNESS = (seed: number) => `
"use strict";
(function () {
  var g = globalThis;
  // Many models write window.X / self.X for globals. Alias the names only: there is still no DOM.
  g.window = g;
  g.self = g;
  var s = ${seed >>> 0};
  Math.random = function () {
    s = (s + 0x6d2b79f5) | 0;
    var t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  var now = 0;
  g.__setNow = function (ms) { now = ms; };
  g.Date = { now: function () { return now; } };
  var noop = function () {};
  g.console = { log: noop, info: noop, warn: noop, error: noop, debug: noop };
  g.__makeStep = function (drive) {
    var parse = JSON.parse, setNow = g.__setNow;
    return function (json) {
      var st = parse(json);
      setNow(st.t * 1000);
      var o = drive(st);
      if (!o || typeof o !== "object") return "0,0,0";
      return (+o.throttle) + "," + (+o.steer) + "," + (+o.brake);
    };
  };
})();
`;

export interface SandboxResult {
  ok: boolean;
  error?: string;
}

export class DriverSandbox {
  private rt: QuickJSRuntime;
  private vm: QuickJSContext;
  private step: QuickJSHandle | null = null;
  private polls = 0;
  private budget = 0;
  dead = false;
  error: string | null = null;

  constructor(qjs: QuickJSWASMModule, rngSeed: number) {
    this.rt = qjs.newRuntime();
    this.rt.setMemoryLimit(SANDBOX_LIMITS.memoryBytes);
    this.rt.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
    this.rt.setInterruptHandler(() => ++this.polls > this.budget);
    this.vm = this.rt.newContext();
    this.budget = SANDBOX_LIMITS.initBudget;
    this.polls = 0;
    const r = this.vm.evalCode(HARNESS(rngSeed), 'harness.js');
    if (r.error) throw new Error('sandbox harness failed: ' + this.dumpError(r.error));
    r.value.dispose();
  }

  /** Load the TRACK global and the driver code. */
  load(code: string, trackJson: string): SandboxResult {
    if (byteLength(code) > SANDBOX_LIMITS.codeBytes) return this.fail(`code exceeds ${SANDBOX_LIMITS.codeBytes} bytes`);
    this.polls = 0;
    this.budget = SANDBOX_LIMITS.initBudget;
    const t = this.vm.evalCode(`globalThis.TRACK = JSON.parse(${JSON.stringify(trackJson)});`, 'track.js');
    if (t.error) return this.fail('track load: ' + this.dumpError(t.error));
    t.value.dispose();

    this.polls = 0;
    const r = this.vm.evalCode(
      code + '\n;globalThis.__drive = (typeof drive === "function") ? drive : undefined;',
      'driver.js',
    );
    if (r.error) return this.fail(this.dumpError(r.error));
    r.value.dispose();

    const s = this.vm.evalCode('globalThis.__drive ? globalThis.__makeStep(globalThis.__drive) : undefined', 'bind.js');
    if (s.error) return this.fail(this.dumpError(s.error));
    if (this.vm.typeof(s.value) !== 'function') {
      s.value.dispose();
      return this.fail('no function named drive(state) was defined');
    }
    this.step = s.value;
    return { ok: true };
  }

  /** Call drive(state). Returns null if the driver crashed (it stays dead afterwards). */
  call(stateJson: string): DriverOutput | null {
    if (this.dead || !this.step) return null;
    this.polls = 0;
    this.budget = SANDBOX_LIMITS.callBudget;
    const arg = this.vm.newString(stateJson);
    const r = this.vm.callFunction(this.step, this.vm.undefined, arg);
    arg.dispose();
    if (r.error) {
      this.fail(this.dumpError(r.error));
      return null;
    }
    const str = this.vm.typeof(r.value) === 'string' ? this.vm.getString(r.value) : '0,0,0';
    r.value.dispose();
    const [a, b, c] = str.split(',').map(Number);
    return { throttle: a, steer: b, brake: c };
  }

  private disposed = false;
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.step?.dispose();
      this.vm.dispose();
      this.rt.dispose();
    } catch {
      // A runtime that hit its memory limit can fail to dispose cleanly. Ignore it.
    }
  }

  private fail(msg: string): SandboxResult {
    this.dead = true;
    this.error = msg.slice(0, 300);
    return { ok: false, error: this.error };
  }

  private dumpError(h: QuickJSHandle): string {
    let msg = 'unknown error';
    try {
      const e = this.vm.dump(h);
      if (e && typeof e === 'object') {
        msg = `${e.name ?? 'Error'}: ${e.message ?? JSON.stringify(e)}`;
      } else msg = String(e);
    } catch {
      /* ignore */
    }
    h.dispose();
    if (/interrupted/i.test(msg)) return 'Timeout: exceeded CPU budget';
    if (/out of memory/i.test(msg)) return 'Out of memory';
    return msg;
  }
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
