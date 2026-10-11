import { expect, it, vi } from 'vitest';
import handler from '../api/private-coin-check';
it('retires the isolated configuration and preflight for all requests without contacting upstreams', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch');
  try {
    for (const action of ['config', 'preflight', 'withdraw']) {
      const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handler({ method: 'POST', body: { action } }, res);
      expect(res.status).toHaveBeenCalledWith(410);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ url: '/#/buy' }));
      expect(res.setHeader).toHaveBeenCalledWith('cache-control', 'no-store');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  } finally { fetchMock.mockRestore(); }
});
