import type { Move } from './rules.js';
import type { PlayerView } from './view.js';

export interface SeatInfo {
  name: string;
  isBot: boolean;
  connected: boolean;
}

export interface RoomState {
  code: string;
  /** The viewer's own seat, or -1 when not seated. */
  you: number;
  youAreHost: boolean;
  seats: (SeatInfo | null)[];
  started: boolean;
  game: PlayerView | null;
}

export type Ack = { ok: true; token?: string; code?: string } | { ok: false; error: string };

export interface ClientToServer {
  'room:create': (p: { name: string }, ack: (r: Ack) => void) => void;
  'room:join': (p: { code: string; name: string; token?: string }, ack: (r: Ack) => void) => void;
  'room:leave': () => void;
  'room:sit': (p: { seat: number }, ack: (r: Ack) => void) => void;
  'room:addBot': (p: { seat: number }, ack: (r: Ack) => void) => void;
  'room:removeSeat': (p: { seat: number }, ack: (r: Ack) => void) => void;
  'game:start': (p: { targetLead?: number }, ack: (r: Ack) => void) => void;
  'game:bid': (p: { value: number }, ack: (r: Ack) => void) => void;
  'game:move': (p: { move: Move }, ack: (r: Ack) => void) => void;
  'game:nextDeal': (ack: (r: Ack) => void) => void;
  'game:newGame': (ack: (r: Ack) => void) => void;
  chat: (p: { text: string }) => void;
}

export interface ServerToClient {
  'room:state': (s: RoomState) => void;
  chat: (m: { name: string; text: string; at: number }) => void;
}
