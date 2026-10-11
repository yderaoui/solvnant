interface Res { setHeader(name: string, value: string): void; status(code: number): Res; json(body: unknown): unknown }
/** Retired: the regular website uses the real server configuration and payment guards. */
export default function handler(_req: unknown, res: Res) {
  res.setHeader('cache-control', 'no-store');
  return res.status(410).json({ error: 'The separate check has closed. Use the normal PumpKart Buy coins page.', url: '/#/buy' });
}
