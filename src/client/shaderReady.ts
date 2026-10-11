/** Poll live programs with a deadline. Removed programs and a lost context cannot trap loading. */
export async function shadersReady(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  programs: () => Iterable<{ program?: WebGLProgram | null }>,
  timeout = 3000,
): Promise<boolean> {
  const extension = gl.getExtension('KHR_parallel_shader_compile') as { COMPLETION_STATUS_KHR: number } | null;
  if (!extension) return !gl.isContextLost();
  const deadline = performance.now() + timeout;
  return new Promise(resolve => {
    const check = () => {
      if (gl.isContextLost()) { resolve(false); return; }
      try {
        let ready = true;
        for (const { program } of programs()) if (program && !gl.getProgramParameter(program, extension.COMPLETION_STATUS_KHR)) ready = false;
        if (ready) { resolve(true); return; }
      } catch { resolve(false); return; }
      if (performance.now() >= deadline) { resolve(false); return; }
      setTimeout(check, 20);
    };
    check();
  });
}
