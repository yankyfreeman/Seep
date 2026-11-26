import { randomBytes, randomInt } from 'node:crypto';
import { chooseBotBid, chooseBotMove } from '../shared/bot.js';
import type { RoomState, SeatInfo } from '../shared/protocol.js';
import {
  contextFor,
  GameState,
  Move,
  newGame,
  nextDeal,
  NUM_SEATS,
  placeBid,
  playMove,
  RuleError,
} from '../shared/rules.js';
import { viewFor } from '../shared/view.js';

const BOT_NAMES = ['Gurpreet (bot)', 'Simran (bot)', 'Harjit (bot)', 'Navdeep (bot)', 'Jaspal (bot)', 'Manpreet (bot)'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS ?? 900);

export class UserError extends Error {}

interface Member {
  token: string;
  name: string;
  sockets: Set<string>;
}

type Occupant = { kind: 'human'; token: string } | { kind: 'bot'; name: string };

export type Emit = (socketId: string, state: RoomState) => void;

export class Room {
  readonly members = new Map<string, Member>();
  readonly seats: (Occupant | null)[] = [null, null, null, null];
  hostToken: string | null = null;
  game: GameState | null = null;
  lastActivity = Date.now();
  private botTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    private readonly emit: Emit,
  ) {}

  // ---- membership -------------------------------------------------------

  join(name: string, token: string | undefined, socketId: string): string {
    let member = token ? this.members.get(token) : undefined;
    if (!member) {
      member = { token: randomBytes(16).toString('hex'), name, sockets: new Set() };
      this.members.set(member.token, member);
    } else if (name) {
      member.name = name;
    }
    member.sockets.add(socketId);
    if (!this.hostToken) this.hostToken = member.token;
    if (this.seatOf(member.token) < 0 && !this.game) {
      const free = this.seats.findIndex((s) => s === null);
      if (free >= 0) this.seats[free] = { kind: 'human', token: member.token };
    }
    this.touch();
    return member.token;
  }

  disconnect(token: string, socketId: string) {
    this.members.get(token)?.sockets.delete(socketId);
    this.touch();
    this.broadcast();
  }

  leave(token: string, socketId: string) {
    const member = this.members.get(token);
    if (!member) return;
    member.sockets.delete(socketId);
    if (member.sockets.size > 0) return this.broadcast();
    const seat = this.seatOf(token);
    if (seat >= 0) {
      // Mid-game a leaving player is replaced by a bot so the others can finish.
      this.seats[seat] = this.game ? { kind: 'bot', name: this.botName() } : null;
    }
    this.members.delete(token);
    if (this.hostToken === token) {
      this.hostToken = [...this.members.values()].find((m) => m.sockets.size > 0)?.token ?? null;
    }
    this.broadcast();
    this.scheduleBots();
  }

  get connectedCount(): number {
    let n = 0;
    for (const m of this.members.values()) n += m.sockets.size;
    return n;
  }

  seatOf(token: string): number {
    return this.seats.findIndex((s) => s?.kind === 'human' && s.token === token);
  }

  private requireHost(token: string) {
    if (token !== this.hostToken) throw new UserError('Only the host can do that.');
  }

  private validSeat(seat: number) {
    if (!Number.isInteger(seat) || seat < 0 || seat >= NUM_SEATS) throw new UserError('Invalid seat.');
  }

  sit(token: string, seat: number) {
    this.validSeat(seat);
    const occupant = this.seats[seat];
    const current = this.seatOf(token);
    if (current === seat) return;
    if (occupant?.kind === 'human') throw new UserError('That seat is taken.');
    if (this.game && occupant === null) throw new UserError('That seat is not available.');
    if (this.game && current >= 0) throw new UserError('You cannot change seats during a game.');
    if (current >= 0) this.seats[current] = null;
    this.seats[seat] = { kind: 'human', token }; // takes over a bot seat mid-game
    this.touch();
    this.broadcast();
  }

  addBot(token: string, seat: number) {
    this.requireHost(token);
    this.validSeat(seat);
    if (this.seats[seat]) throw new UserError('That seat is taken.');
    this.seats[seat] = { kind: 'bot', name: this.botName() };
    this.broadcast();
  }

  removeSeat(token: string, seat: number) {
    this.requireHost(token);
    this.validSeat(seat);
    const occupant = this.seats[seat];
    if (!occupant) return;
    if (this.game) {
      if (occupant.kind === 'bot') throw new UserError('A bot cannot leave mid-game; a player can take its seat instead.');
      this.seats[seat] = { kind: 'bot', name: this.botName() };
    } else {
      this.seats[seat] = null;
    }
    this.broadcast();
    this.scheduleBots();
  }

  private botName(): string {
    const used = new Set(this.seats.map((s) => (s?.kind === 'bot' ? s.name : '')));
    return BOT_NAMES.find((n) => !used.has(n)) ?? 'Bot';
  }

  // ---- game -------------------------------------------------------------

  start(token: string, targetLead?: number) {
    this.requireHost(token);
    if (this.game && this.game.phase !== 'gameOver') throw new UserError('A game is already in progress.');
    if (this.seats.some((s) => s === null)) throw new UserError('All four seats must be filled (add bots for empty seats).');
    const lead = Number.isFinite(targetLead) ? Math.min(1000, Math.max(50, Math.round(targetLead!))) : undefined;
    this.game = newGame({ settings: lead ? { targetLead: lead } : {}, dealer: randomInt(NUM_SEATS) });
    this.afterChange();
  }

  private requireSeat(token: string): number {
    const seat = this.seatOf(token);
    if (seat < 0) throw new UserError('You are not seated.');
    if (!this.game) throw new UserError('The game has not started.');
    return seat;
  }

  bid(token: string, value: number) {
    const seat = this.requireSeat(token);
    this.wrap(() => placeBid(this.game!, seat, value));
  }

  move(token: string, move: Move) {
    const seat = this.requireSeat(token);
    this.wrap(() => playMove(this.game!, seat, move));
  }

  nextDeal(token: string) {
    this.requireSeat(token);
    this.wrap(() => nextDeal(this.game!));
  }

  private wrap(fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (e instanceof RuleError) throw new UserError(e.message);
      throw e;
    }
    this.afterChange();
  }

  private afterChange() {
    this.touch();
    this.broadcast();
    this.scheduleBots();
  }

  private scheduleBots() {
    if (this.botTimer || !this.game) return;
    const g = this.game;
    if (g.phase !== 'bidding' && g.phase !== 'playing') return;
    if (this.seats[g.turn]?.kind !== 'bot') return;
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      this.runBot();
    }, BOT_DELAY_MS);
  }

  private runBot() {
    const g = this.game;
    if (!g || this.seats[g.turn]?.kind !== 'bot') return;
    try {
      if (g.phase === 'bidding') placeBid(g, g.turn, chooseBotBid(g.hands[g.turn]));
      else if (g.phase === 'playing') playMove(g, g.turn, chooseBotMove(contextFor(g, g.turn)));
      else return;
    } catch (e) {
      console.error(`[room ${this.code}] bot error`, e);
      return;
    }
    this.afterChange();
  }

  dispose() {
    if (this.botTimer) clearTimeout(this.botTimer);
  }

  // ---- views ------------------------------------------------------------

  private touch() {
    this.lastActivity = Date.now();
  }

  stateFor(token: string): RoomState {
    const seats: (SeatInfo | null)[] = this.seats.map((s) => {
      if (!s) return null;
      if (s.kind === 'bot') return { name: s.name, isBot: true, connected: true };
      const m = this.members.get(s.token);
      return { name: m?.name ?? '?', isBot: false, connected: (m?.sockets.size ?? 0) > 0 };
    });
    const you = this.seatOf(token);
    return {
      code: this.code,
      you,
      youAreHost: token === this.hostToken,
      seats,
      started: this.game !== null,
      game: this.game ? viewFor(this.game, you) : null,
    };
  }

  broadcast() {
    for (const m of this.members.values()) {
      if (m.sockets.size === 0) continue;
      const state = this.stateFor(m.token);
      for (const id of m.sockets) this.emit(id, state);
    }
  }

  memberName(token: string): string {
    return this.members.get(token)?.name ?? '?';
  }

  socketIds(): string[] {
    return [...this.members.values()].flatMap((m) => [...m.sockets]);
  }
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor(private readonly emit: Emit) {}

  create(): Room {
    let code: string;
    do {
      code = Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = new Room(code, this.emit);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.trim().toUpperCase());
  }

  /** Drop rooms nobody has been connected to for a while. */
  sweep(maxIdleMs: number) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.connectedCount === 0 && now - room.lastActivity > maxIdleMs) {
        room.dispose();
        this.rooms.delete(code);
      }
    }
  }
}
