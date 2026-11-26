import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Server, Socket } from 'socket.io';
import type { Ack, ClientToServer, ServerToClient } from '../shared/protocol.js';
import { Room, RoomManager, UserError } from './rooms.js';

const PORT = Number(process.env.PORT ?? 3000);
const CLIENT_DIR = join(process.cwd(), 'dist', 'client');

const app = express();
const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(http, {
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN.split(',') } : undefined,
});

const rooms = new RoomManager((socketId, state) => io.to(socketId).emit('room:state', state));
setInterval(() => rooms.sweep(30 * 60_000), 5 * 60_000).unref();

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.rooms.size });
});

if (existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR));
  app.get(/^(?!\/socket\.io).*/, (_req, res) => res.sendFile(join(CLIENT_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('text').send('Seep server is running. Build the client with `npm run build`, or use `npm run dev`.');
  });
}

type SeepSocket = Socket<ClientToServer, ServerToClient, Record<string, never>, { code?: string; token?: string }>;

const cleanName = (name: unknown) =>
  String(name ?? '')
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 20) || 'Player';

/** Run a handler, converting thrown errors into an `{ ok: false }` acknowledgement. */
function handle(ack: ((r: Ack) => void) | undefined, fn: () => Ack | void) {
  const reply = typeof ack === 'function' ? ack : () => {};
  try {
    reply(fn() ?? { ok: true });
  } catch (e) {
    if (e instanceof UserError) return reply({ ok: false, error: e.message });
    console.error(e);
    reply({ ok: false, error: 'Something went wrong on the server.' });
  }
}

io.on('connection', (socket: SeepSocket) => {
  const current = (): { room: Room; token: string } => {
    const { code, token } = socket.data;
    const room = code ? rooms.get(code) : undefined;
    if (!room || !token) throw new UserError('You are not in a room.');
    return { room, token };
  };

  const leaveCurrent = () => {
    const { code, token } = socket.data;
    const room = code ? rooms.get(code) : undefined;
    if (room && token) room.leave(token, socket.id);
    socket.data = {};
  };

  const enter = (room: Room, name: string, token?: string): Ack => {
    if (socket.data.code && socket.data.code !== room.code) leaveCurrent();
    const t = room.join(name, token, socket.id);
    socket.data = { code: room.code, token: t };
    room.broadcast();
    return { ok: true, token: t, code: room.code };
  };

  socket.on('room:create', (p, ack) => handle(ack, () => enter(rooms.create(), cleanName(p?.name))));

  socket.on('room:join', (p, ack) =>
    handle(ack, () => {
      const room = rooms.get(String(p?.code ?? ''));
      if (!room) throw new UserError('No room with that code.');
      return enter(room, cleanName(p?.name), typeof p?.token === 'string' ? p.token : undefined);
    }),
  );

  socket.on('room:leave', () => leaveCurrent());

  socket.on('room:sit', (p, ack) => handle(ack, () => { const { room, token } = current(); room.sit(token, Number(p?.seat)); }));
  socket.on('room:addBot', (p, ack) => handle(ack, () => { const { room, token } = current(); room.addBot(token, Number(p?.seat)); }));
  socket.on('room:removeSeat', (p, ack) => handle(ack, () => { const { room, token } = current(); room.removeSeat(token, Number(p?.seat)); }));
  socket.on('game:start', (p, ack) => handle(ack, () => { const { room, token } = current(); room.start(token, Number(p?.targetLead)); }));
  socket.on('game:newGame', (ack) => handle(ack, () => { const { room, token } = current(); room.start(token, room.game?.settings.targetLead); }));
  socket.on('game:bid', (p, ack) => handle(ack, () => { const { room, token } = current(); room.bid(token, Number(p?.value)); }));
  socket.on('game:nextDeal', (ack) => handle(ack, () => { const { room, token } = current(); room.nextDeal(token); }));
  socket.on('game:move', (p, ack) =>
    handle(ack, () => {
      const { room, token } = current();
      const m = p?.move;
      if (!m || typeof m !== 'object' || typeof m.cardId !== 'string') throw new UserError('Invalid move.');
      const ids = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
      if (m.type === 'throw') room.move(token, { type: 'throw', cardId: m.cardId });
      else if (m.type === 'capture') room.move(token, { type: 'capture', cardId: m.cardId, cardIds: ids(m.cardIds), houseIds: ids(m.houseIds) });
      else if (m.type === 'build') room.move(token, { type: 'build', cardId: m.cardId, value: Number(m.value), cardIds: ids(m.cardIds), houseIds: ids(m.houseIds) });
      else throw new UserError('Invalid move.');
    }),
  );

  socket.on('chat', (p) => {
    try {
      const { room, token } = current();
      const text = String(p?.text ?? '').trim().slice(0, 300);
      if (!text) return;
      const msg = { name: room.memberName(token), text, at: Date.now() };
      for (const id of room.socketIds()) io.to(id).emit('chat', msg);
    } catch {
      /* not in a room */
    }
  });

  socket.on('disconnect', () => {
    const { code, token } = socket.data;
    const room = code ? rooms.get(code) : undefined;
    if (room && token) room.disconnect(token, socket.id);
  });
});

http.listen(PORT, () => {
  console.log(`Seep server listening on http://localhost:${PORT}`);
});
