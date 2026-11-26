/**
 * Seep rules engine — pure, framework-free, shared by server and client.
 *
 * Seats are 0..3. Partners sit opposite each other: team 0 = seats 0 & 2,
 * team 1 = seats 1 & 3. Play goes counter-clockwise, which we model as
 * seat -> (seat + 1) % 4 (the next seat is drawn on the current player's right).
 */
import { Card, cardLabel, cardPoints, fullDeck, Rng, shuffle, sumPoints } from './cards.js';

export const MIN_HOUSE = 9;
export const MAX_HOUSE = 13;
export const SEEP_POINTS = 50;
export const NUM_SEATS = 4;

export type Team = 0 | 1;
export const teamOf = (seat: number): Team => (seat % 2) as Team;
export const nextSeat = (seat: number): number => (seat + 1) % NUM_SEATS;

/** A "house" (ghar / dheri): a pile of cards on the floor with a fixed capture value 9–13. */
export interface House {
  id: string;
  value: number;
  cards: Card[];
  /** Cemented (pakka) houses can no longer be raised. */
  cemented: boolean;
  /** Seats that must keep a card of `value` in hand until this house is taken. */
  owners: number[];
}

export interface Floor {
  cards: Card[];
  houses: House[];
}

export type Move =
  | { type: 'throw'; cardId: string }
  | { type: 'capture'; cardId: string; cardIds: string[]; houseIds: string[] }
  | { type: 'build'; cardId: string; value: number; cardIds: string[]; houseIds: string[] };

export type Phase = 'bidding' | 'playing' | 'dealEnd' | 'gameOver';

export interface GameSettings {
  /** A team wins the game (a "baazi") when it leads by at least this many points. */
  targetLead: number;
}

export const DEFAULT_SETTINGS: GameSettings = { targetLead: 100 };

export interface LogEntry {
  /** Seat that acted, or null for table messages. Clients prefix the seat's name. */
  seat: number | null;
  text: string;
}

export interface LastAction {
  seat: number;
  type: Move['type'];
  card: Card;
  /** Cards taken (capture) or gathered into the house (build). */
  cards: Card[];
  houseValue?: number;
  seep: boolean;
}

export interface DealResult {
  dealNumber: number;
  dealer: number;
  bidder: number;
  bid: number;
  cardPoints: [number, number];
  seeps: [number, number];
  cardsTaken: [number, number];
  dealPoints: [number, number];
  totals: [number, number];
}

export interface GameState {
  settings: GameSettings;
  phase: Phase;
  dealNumber: number;
  dealer: number;
  bidder: number;
  bid: number | null;
  turn: number;
  hands: Card[][];
  stock: Card[];
  floor: Floor;
  floorRevealed: boolean;
  captured: [Card[], Card[]];
  seeps: [number, number];
  lastCapturer: number | null;
  movesThisDeal: number;
  scores: [number, number];
  history: DealResult[];
  log: LogEntry[];
  lastAction: LastAction | null;
  winner: Team | null;
  nextHouseId: number;
}

export class RuleError extends Error {}

// ---------------------------------------------------------------------------
// Combinatorics helpers
// ---------------------------------------------------------------------------

/** Can every value be placed into groups that each sum exactly to `target`? */
export function canPartition(values: number[], target: number): boolean {
  if (target <= 0) return false;
  const total = values.reduce((a, b) => a + b, 0);
  if (total % target !== 0) return false;
  if (values.some((v) => v > target || v <= 0)) return false;
  const sorted = values.slice().sort((a, b) => b - a);
  const used = new Array<boolean>(sorted.length).fill(false);

  const fill = (groupsLeft: number, current: number, start: number): boolean => {
    if (groupsLeft === 0) return true;
    if (current === target) return fill(groupsLeft - 1, 0, 0);
    let lastTried = -1;
    for (let i = start; i < sorted.length; i++) {
      if (used[i] || sorted[i] === lastTried || current + sorted[i] > target) continue;
      used[i] = true;
      if (fill(groupsLeft, current + sorted[i], i + 1)) return true;
      used[i] = false;
      lastTried = sorted[i];
      // The first card of a new group can be any unused card; trying one is enough.
      if (current === 0) return false;
    }
    return false;
  };
  return fill(total / target, 0, 0);
}

// ---------------------------------------------------------------------------
// Move analysis (validation without mutation)
// ---------------------------------------------------------------------------

export interface MoveContext {
  seat: number;
  hand: Card[];
  floor: Floor;
  /** Set only for the bidder's very first play of a deal: the play must use this value. */
  firstMoveBid: number | null;
}

export type MoveOutcome =
  | { type: 'throw'; card: Card }
  | { type: 'capture'; card: Card; cards: Card[]; houses: House[] }
  | {
      type: 'build';
      card: Card;
      value: number;
      cards: Card[];
      /** Unbroken house raised to a new value by this play. */
      raised: House | null;
      /** Existing house of the same value that this play adds to (cementing it). */
      merged: House | null;
      cemented: boolean;
    };

export type Analysis = { ok: true; outcome: MoveOutcome } | { ok: false; error: string };

const fail = (error: string): Analysis => ({ ok: false, error });

export function analyzeMove(ctx: MoveContext, move: Move): Analysis {
  const card = ctx.hand.find((c) => c.id === move.cardId);
  if (!card) return fail('That card is not in your hand.');
  const handAfter = ctx.hand.filter((c) => c.id !== card.id);

  const cardIds = move.type === 'throw' ? [] : move.cardIds;
  const houseIds = move.type === 'throw' ? [] : move.houseIds;
  if (new Set(cardIds).size !== cardIds.length || new Set(houseIds).size !== houseIds.length) {
    return fail('Duplicate selection.');
  }
  const loose: Card[] = [];
  for (const id of cardIds) {
    const c = ctx.floor.cards.find((x) => x.id === id);
    if (!c) return fail('Selected card is not on the floor.');
    loose.push(c);
  }
  const houses: House[] = [];
  for (const id of houseIds) {
    const h = ctx.floor.houses.find((x) => x.id === id);
    if (!h) return fail('Selected house is not on the floor.');
    houses.push(h);
  }

  if (ctx.firstMoveBid !== null) {
    const bid = ctx.firstMoveBid;
    if (move.type === 'build' ? move.value !== bid : card.rank !== bid) {
      return fail(
        `Your first play must use your bid of ${bid}: build a house of ${bid}, capture with a ${bid}, or throw a ${bid}.`,
      );
    }
  }

  let outcome: MoveOutcome;
  let housesAfter: House[];

  if (move.type === 'throw') {
    if (ctx.floor.houses.some((h) => h.owners.includes(ctx.seat))) {
      return fail('You have a house on the floor, so you must capture or build instead of throwing.');
    }
    const same = ctx.floor.houses.find((h) => h.value === card.rank);
    if (same) return fail(`There is a house of ${same.value} on the floor — capture it with this card instead.`);
    outcome = { type: 'throw', card };
    housesAfter = ctx.floor.houses;
  } else if (move.type === 'capture') {
    if (loose.length === 0 && houses.length === 0) return fail('Select the floor cards or houses to capture.');
    const wrongHouse = houses.find((h) => h.value !== card.rank);
    if (wrongHouse) return fail(`A house of ${wrongHouse.value} can only be captured with a ${wrongHouse.value}.`);
    if (loose.length > 0 && !canPartition(loose.map((c) => c.rank), card.rank)) {
      return fail(`The selected cards must form groups that each add up to ${card.rank}.`);
    }
    outcome = { type: 'capture', card, cards: loose, houses };
    housesAfter = ctx.floor.houses.filter((h) => !houses.includes(h));
  } else {
    const value = move.value;
    if (!Number.isInteger(value) || value < MIN_HOUSE || value > MAX_HOUSE) {
      return fail(`Houses must be worth between ${MIN_HOUSE} and ${MAX_HOUSE}.`);
    }
    if (!handAfter.some((c) => c.rank === value)) {
      return fail(`To build a house of ${value} you must keep another ${value} in your hand to capture it later.`);
    }
    let raised: House | null = null;
    for (const h of houses) {
      if (h.value === value) continue; // the existing house of this value; merged automatically below
      if (h.value > value) return fail(`A house of ${h.value} cannot become a house of ${value}.`);
      if (h.cemented) return fail(`The house of ${h.value} is cemented (pakka) and cannot be raised.`);
      if (raised) return fail('You can only raise one house at a time.');
      raised = h;
    }
    const merged = ctx.floor.houses.find((h) => h.value === value) ?? null;
    const lead = card.rank + (raised ? raised.value : 0);
    if (!raised && !merged && loose.length === 0) {
      return fail('Select floor cards to combine with your card into a house.');
    }
    if (!canPartition([lead, ...loose.map((c) => c.rank)], value)) {
      return fail(
        raised
          ? `Raising the house of ${raised.value} with your ${cardLabel(card)} must total exactly ${value}.`
          : `Your card and the selected cards must form groups that each add up to ${value}.`,
      );
    }
    const groups = (lead + loose.reduce((t, c) => t + c.rank, 0)) / value;
    const cemented = merged !== null || groups >= 2;
    outcome = { type: 'build', card, value, cards: loose, raised, merged, cemented };
    const owners = merged ? Array.from(new Set([...merged.owners, ctx.seat])) : [ctx.seat];
    housesAfter = [
      ...ctx.floor.houses.filter((h) => h !== raised && h !== merged),
      { id: '_new', value, cards: [], cemented, owners },
    ];
  }

  for (const h of housesAfter) {
    if (h.owners.includes(ctx.seat) && !handAfter.some((c) => c.rank === h.value)) {
      return fail(`You must keep a ${h.value} in your hand while your house of ${h.value} is on the floor.`);
    }
  }
  return { ok: true, outcome };
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

export function newGame(opts: { settings?: Partial<GameSettings>; dealer?: number; rng?: Rng } = {}): GameState {
  const rng = opts.rng ?? Math.random;
  const dealer = opts.dealer ?? Math.floor(rng() * NUM_SEATS);
  const state: GameState = {
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    phase: 'bidding',
    dealNumber: 0,
    dealer,
    bidder: nextSeat(dealer),
    bid: null,
    turn: nextSeat(dealer),
    hands: [[], [], [], []],
    stock: [],
    floor: { cards: [], houses: [] },
    floorRevealed: false,
    captured: [[], []],
    seeps: [0, 0],
    lastCapturer: null,
    movesThisDeal: 0,
    scores: [0, 0],
    history: [],
    log: [],
    lastAction: null,
    winner: null,
    nextHouseId: 1,
  };
  startDeal(state, rng);
  return state;
}

/** Shuffle and deal four cards to the bidder and four (face down) to the floor. */
export function startDeal(state: GameState, rng: Rng = Math.random): void {
  state.dealNumber += 1;
  state.bidder = nextSeat(state.dealer);
  state.turn = state.bidder;
  state.bid = null;
  state.phase = 'bidding';
  state.captured = [[], []];
  state.seeps = [0, 0];
  state.lastCapturer = null;
  state.movesThisDeal = 0;
  state.lastAction = null;
  state.floorRevealed = false;
  state.log.push({ seat: state.dealer, text: `deals (deal ${state.dealNumber}).` });

  for (let attempt = 0; ; attempt++) {
    const deck = shuffle(fullDeck(), rng);
    state.hands = [[], [], [], []];
    state.hands[state.bidder] = deck.splice(0, 4);
    state.floor = { cards: deck.splice(0, 4), houses: [] };
    state.stock = deck;
    if (state.hands[state.bidder].some((c) => c.rank >= MIN_HOUSE)) break;
    state.log.push({
      seat: state.bidder,
      text: `has no card of 9 or higher (${state.hands[state.bidder].map(cardLabel).join(' ')}) — cards are redealt.`,
    });
    if (attempt > 100) throw new Error('Could not deal a biddable hand');
  }
}

export function biddableValues(hand: Card[]): number[] {
  return Array.from(new Set(hand.filter((c) => c.rank >= MIN_HOUSE).map((c) => c.rank))).sort((a, b) => a - b);
}

export function placeBid(state: GameState, seat: number, value: number): void {
  if (state.phase !== 'bidding') throw new RuleError('It is not time to bid.');
  if (seat !== state.bidder) throw new RuleError('Only the bidder may bid.');
  if (!biddableValues(state.hands[seat]).includes(value)) {
    throw new RuleError(`You can only bid a value from 9 to 13 that you hold.`);
  }
  state.bid = value;
  state.floorRevealed = true;
  state.phase = 'playing';
  state.turn = seat;
  state.log.push({ seat, text: `bids ${value}.` });
}

export function contextFor(state: GameState, seat: number): MoveContext {
  return {
    seat,
    hand: state.hands[seat],
    floor: state.floor,
    firstMoveBid: state.movesThisDeal === 0 && seat === state.bidder ? state.bid : null,
  };
}

const dealIsOver = (state: GameState) => state.stock.length === 0 && state.hands.every((h) => h.length === 0);

export function playMove(state: GameState, seat: number, move: Move): LastAction {
  if (state.phase !== 'playing') throw new RuleError('It is not time to play.');
  if (seat !== state.turn) throw new RuleError('It is not your turn.');
  const analysis = analyzeMove(contextFor(state, seat), move);
  if (!analysis.ok) throw new RuleError(analysis.error);
  const o = analysis.outcome;
  const team = teamOf(seat);

  state.hands[seat] = state.hands[seat].filter((c) => c.id !== o.card.id);
  const action: LastAction = { seat, type: o.type, card: o.card, cards: [], seep: false };

  if (o.type === 'throw') {
    state.floor.cards.push(o.card);
    state.log.push({ seat, text: `throws ${cardLabel(o.card)}.` });
  } else if (o.type === 'capture') {
    const taken = [o.card, ...o.cards, ...o.houses.flatMap((h) => h.cards)];
    const ids = new Set(o.cards.map((c) => c.id));
    state.floor.cards = state.floor.cards.filter((c) => !ids.has(c.id));
    state.floor.houses = state.floor.houses.filter((h) => !o.houses.includes(h));
    state.captured[team].push(...taken);
    state.lastCapturer = seat;
    action.cards = taken.slice(1);
    const floorEmpty = state.floor.cards.length === 0 && state.floor.houses.length === 0;
    const what = [
      ...o.houses.map((h) => `house of ${h.value}`),
      ...o.cards.map(cardLabel),
    ].join(', ');
    if (floorEmpty && !dealIsOver(state)) {
      state.seeps[team] += 1;
      action.seep = true;
      state.log.push({ seat, text: `SEEP! sweeps the floor with ${cardLabel(o.card)} (${what}) — +${SEEP_POINTS}.` });
    } else {
      state.log.push({ seat, text: `captures ${what} with ${cardLabel(o.card)}.` });
    }
  } else {
    const ids = new Set(o.cards.map((c) => c.id));
    state.floor.cards = state.floor.cards.filter((c) => !ids.has(c.id));
    const gathered = [o.card, ...o.cards, ...(o.raised ? o.raised.cards : [])];
    if (o.merged) {
      o.merged.cards.push(...gathered);
      o.merged.cemented = true;
      if (!o.merged.owners.includes(seat)) o.merged.owners.push(seat);
    }
    if (o.raised) state.floor.houses = state.floor.houses.filter((h) => h !== o.raised);
    if (!o.merged) {
      state.floor.houses.push({
        id: `h${state.nextHouseId++}`,
        value: o.value,
        cards: gathered,
        cemented: o.cemented,
        owners: [seat],
      });
    }
    state.floor.houses.sort((a, b) => a.value - b.value);
    action.cards = gathered.slice(1);
    action.houseValue = o.value;
    const verb = o.merged ? 'cements' : o.raised ? `raises the house of ${o.raised.value} to` : 'builds';
    state.log.push({
      seat,
      text: `${verb} a${o.cemented && !o.merged ? ' cemented' : ''} house of ${o.value} with ${cardLabel(o.card)}.`,
    });
  }

  state.movesThisDeal += 1;
  state.lastAction = action;

  if (state.movesThisDeal === 1) dealRemainder(state);

  if (dealIsOver(state)) {
    finishDeal(state);
  } else {
    state.turn = nextSeat(seat);
  }
  return action;
}

/** After the bidder's first play: bidder receives 8 more cards, everyone else 12. */
function dealRemainder(state: GameState): void {
  for (let i = 0; i < NUM_SEATS; i++) {
    const seat = (state.bidder + i) % NUM_SEATS;
    const n = seat === state.bidder ? 8 : 12;
    state.hands[seat].push(...state.stock.splice(0, n));
  }
}

function finishDeal(state: GameState): void {
  const leftover = [...state.floor.cards, ...state.floor.houses.flatMap((h) => h.cards)];
  if (leftover.length > 0) {
    const takerSeat = state.lastCapturer ?? state.dealer;
    state.captured[teamOf(takerSeat)].push(...leftover);
    state.log.push({ seat: takerSeat, text: `takes the ${leftover.length} card(s) left on the floor (last capture).` });
  }
  state.floor = { cards: [], houses: [] };

  const cp: [number, number] = [sumPoints(state.captured[0]), sumPoints(state.captured[1])];
  const dp: [number, number] = [cp[0] + SEEP_POINTS * state.seeps[0], cp[1] + SEEP_POINTS * state.seeps[1]];
  state.scores = [state.scores[0] + dp[0], state.scores[1] + dp[1]];
  state.history.push({
    dealNumber: state.dealNumber,
    dealer: state.dealer,
    bidder: state.bidder,
    bid: state.bid ?? 0,
    cardPoints: cp,
    seeps: [...state.seeps] as [number, number],
    cardsTaken: [state.captured[0].length, state.captured[1].length],
    dealPoints: dp,
    totals: [...state.scores] as [number, number],
  });
  state.log.push({ seat: null, text: `Deal ${state.dealNumber} over: ${dp[0]} – ${dp[1]}.` });

  const lead = state.scores[0] - state.scores[1];
  if (Math.abs(lead) >= state.settings.targetLead) {
    state.winner = lead > 0 ? 0 : 1;
    state.phase = 'gameOver';
    state.log.push({ seat: null, text: `Game over — team ${state.winner === 0 ? 'A' : 'B'} wins the baazi!` });
  } else {
    state.phase = 'dealEnd';
  }
}

export function nextDeal(state: GameState, rng: Rng = Math.random): void {
  if (state.phase !== 'dealEnd') throw new RuleError('The deal is not over yet.');
  state.dealer = nextSeat(state.dealer);
  startDeal(state, rng);
}

export { cardPoints };
