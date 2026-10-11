import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shadersReady } from '../src/client/shaderReady';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => vi.useRealTimers());
function context(ready = false) {
  return { getExtension: vi.fn(() => ({ COMPLETION_STATUS_KHR: 1 })), isContextLost: vi.fn(() => false), getProgramParameter: vi.fn(() => ready) };
}
const gl = (value: ReturnType<typeof context>) => value as unknown as WebGLRenderingContext;

it('bounds stalled shader preparation and leaves no polling timer behind', async () => {
  const ctx = context(), pending = shadersReady(gl(ctx), () => [{ program: {} as WebGLProgram }], 100);
  await vi.advanceTimersByTimeAsync(100);
  await expect(pending).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('stops preparation when the graphics context is lost', async () => {
  const ctx = context(), pending = shadersReady(gl(ctx), () => [{ program: {} as WebGLProgram }]);
  ctx.isContextLost.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(20);
  await expect(pending).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('does not keep waiting for a program removed by a track change', async () => {
  const ctx = context(), programs: { program?: WebGLProgram }[] = [{ program: {} as WebGLProgram }];
  const pending = shadersReady(gl(ctx), () => programs);
  programs[0].program = undefined;
  await vi.advanceTimersByTimeAsync(20);
  await expect(pending).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it('finishes immediately for ready programs', async () => {
  const ctx = context(true);
  await expect(shadersReady(gl(ctx), () => [{ program: {} as WebGLProgram }])).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
