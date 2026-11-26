import type { Card } from './cards.js';
import type { DealResult, Floor, GameSettings, LastAction, LogEntry, Phase, Team } from './rules.js';
import { GameState, contextFor } from './rules.js';

/** What a single seat is allowed to see. Never contains other players' cards. */
export interface PlayerView {
  seat: number;
  settings: GameSettings;
  phase: Phase;
  dealNumber: number;
  dealer: number;
  bidder: number;
  bid: number | null;
  turn: number;
  hand: Card[];
  handCounts: number[];
  stockCount: number;
  /** Null while the floor is still face down (before the bid). */
  floor: Floor | null;
  hiddenFloorCount: number;
  capturedCounts: [number, number];
  seeps: [number, number];
  lastCapturer: number | null;
  scores: [number, number];
  history: DealResult[];
  log: LogEntry[];
  lastAction: LastAction | null;
  winner: Team | null;
  /** The bid the viewer's play must use, if this is the bidder's first play. */
  firstMoveBid: number | null;
}

/** Spectators (seat = -1) see the table but no hand. */
export function viewFor(state: GameState, seat: number): PlayerView {
  const ctx = seat >= 0 ? contextFor(state, seat) : null;
  return {
    seat,
    settings: state.settings,
    phase: state.phase,
    dealNumber: state.dealNumber,
    dealer: state.dealer,
    bidder: state.bidder,
    bid: state.bid,
    turn: state.turn,
    hand: seat >= 0 ? sortHand(state.hands[seat]) : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    floor: state.floorRevealed ? structuredClone(state.floor) : null,
    hiddenFloorCount: state.floorRevealed ? 0 : state.floor.cards.length,
    capturedCounts: [state.captured[0].length, state.captured[1].length],
    seeps: [...state.seeps] as [number, number],
    lastCapturer: state.lastCapturer,
    scores: [...state.scores] as [number, number],
    history: state.history,
    log: state.log.slice(-60),
    lastAction: state.lastAction,
    winner: state.winner,
    firstMoveBid: ctx?.firstMoveBid ?? null,
  };
}

const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3 } as const;

export function sortHand(hand: Card[]): Card[] {
  return hand.slice().sort((a, b) => SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit] || a.rank - b.rank);
}
