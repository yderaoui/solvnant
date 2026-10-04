// Cloudflare Worker entry: routes WebSocket connections to the single live race room.
export { GameRoom } from './room';

interface Env {
  ROOM: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/ws') return env.ROOM.get(env.ROOM.idFromName('main')).fetch(request);
    if (url.pathname === '/health') return new Response('ok');
    return new Response('AI Grand Prix game server. Connect a WebSocket to /ws.', { headers: { 'content-type': 'text/plain' } });
  },
};
