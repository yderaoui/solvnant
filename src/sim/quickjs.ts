// Loads the QuickJS WebAssembly engine used to sandbox driver code. Kept separate from the race
// engine so the live game server (humans + native bots only) never bundles QuickJS.
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { runRace, type RaceConfig, type RaceRecord } from './race';

let modulePromise: Promise<QuickJSWASMModule> | null = null;
export function loadQuickJS(): Promise<QuickJSWASMModule> {
  return (modulePromise ??= newQuickJSWASMModuleFromVariant(variant as any));
}

/** Simulate a whole race (loads QuickJS on first use). */
export async function simulateRace(config: RaceConfig): Promise<RaceRecord> {
  return runRace(await loadQuickJS(), config);
}
