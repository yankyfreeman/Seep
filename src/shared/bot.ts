/**
 * A simple heuristic computer player. It only looks at what its own seat can
 * see (its hand and the floor), never at other hands.
 */
import { Card, cardPoints, Rng, sumPoints } from './cards.js';
import {
  analyzeMove,
  biddableValues,
  Floor,
  MAX_HOUSE,
  MIN_HOUSE,
  Move,
  MoveContext,
  MoveOutcome,
  SEEP_POINTS,
} from './rules.js';

interface Candidate {
  move: Move;
  outcome: MoveOutcome;
}

type Item = { kind: 'card'; card: Card } | { kind: 'house'; id: string; value: number };

function floorItems(floor: Floor): Item[] {
  return [
    ...floor.cards.map((card) => ({ kind: 'card' as const, card })),
    ...floor.houses.map((h) => ({ kind: 'house' as const, id: h.id, value: h.value })),
  ];
}

const itemValue = (i: Item) => (i.kind === 'card' ? i.card.rank : i.value);

/** Non-empty subsets of the floor; capped in size when the floor is large. */
function subsets(items: Item[]): Item[][] {
  const maxSize = items.length <= 10 ? items.length : 4;
  const out: Item[][] = [];
  const rec = (start: number, acc: Item[]) => {
    if (acc.length > 0) out.push(acc.slice());
    if (acc.length === maxSize) return;
    for (let i = start; i < items.length; i++) {
      acc.push(items[i]);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}

function toIds(sel: Item[]) {
  return {
    cardIds: sel.flatMap((i) => (i.kind === 'card' ? [i.card.id] : [])),
    houseIds: sel.flatMap((i) => (i.kind === 'house' ? [i.id] : [])),
  };
}

/** Every distinct legal move for this context (deduplicated by outcome). */
export function legalMoves(ctx: MoveContext): Candidate[] {
  const items = floorItems(ctx.floor);
  const subs = subsets(items);
  const sums = subs.map((s) => s.reduce((t, i) => t + itemValue(i), 0));
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const tryMove = (move: Move) => {
    const a = analyzeMove(ctx, move);
    if (!a.ok) return;
    const key = JSON.stringify(move);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ move, outcome: a.outcome });
  };

  for (const card of ctx.hand) {
    tryMove({ type: 'throw', cardId: card.id });
    subs.forEach((sel, k) => {
      if (sums[k] % card.rank === 0) tryMove({ type: 'capture', cardId: card.id, ...toIds(sel) });
    });
    for (let v = MIN_HOUSE; v <= MAX_HOUSE; v++) {
      if (!ctx.hand.some((c) => c !== card && c.rank === v)) continue;
      const hasHouseV = ctx.floor.houses.some((h) => h.value === v);
      // Adding a card straight onto an existing house of v.
      if (hasHouseV && card.rank === v) tryMove({ type: 'build', cardId: card.id, value: v, cardIds: [], houseIds: [] });
      subs.forEach((sel, k) => {
        if (sel.some((i) => i.kind === 'house' && i.value === v)) return; // merged automatically
        if ((card.rank + sums[k]) % v === 0) {
          tryMove({ type: 'build', cardId: card.id, value: v, ...toIds(sel) });
        }
      });
    }
  }
  return out;
}

function floorAfter(floor: Floor, o: MoveOutcome): { looseSum: number; looseCount: number; houses: number } {
  let cards = floor.cards;
  let houses = floor.houses.length;
  if (o.type === 'throw') cards = [...cards, o.card];
  if (o.type === 'capture') {
    const ids = new Set(o.cards.map((c) => c.id));
    cards = cards.filter((c) => !ids.has(c.id));
    houses -= o.houses.length;
  }
  if (o.type === 'build') {
    const ids = new Set(o.cards.map((c) => c.id));
    cards = cards.filter((c) => !ids.has(c.id));
    houses += (o.merged ? 0 : 1) - (o.raised ? 1 : 0);
  }
  return { looseSum: cards.reduce((t, c) => t + c.rank, 0), looseCount: cards.length, houses };
}

function score(ctx: MoveContext, c: Candidate): number {
  const o = c.outcome;
  let s = 0;
  const after = floorAfter(ctx.floor, o);
  const floorEmpty = after.looseCount === 0 && after.houses === 0;

  if (o.type === 'capture') {
    const taken = [o.card, ...o.cards, ...o.houses.flatMap((h) => h.cards)];
    s += 20 + sumPoints(taken) * 3 + taken.length;
    if (floorEmpty) s += SEEP_POINTS * 4;
  } else if (o.type === 'build') {
    const inHouse = [o.card, ...o.cards, ...(o.raised?.cards ?? []), ...(o.merged?.cards ?? [])];
    s += 8 + sumPoints(inHouse) * 1.5 + (o.cemented ? 4 : 0);
  } else {
    s -= cardPoints(o.card) * 3 + (o.card.rank >= MIN_HOUSE ? 3 : 0);
  }
  // Leaving a small, loose-only floor invites the next player to sweep it.
  if (!floorEmpty && after.houses === 0 && after.looseSum <= MAX_HOUSE) s -= 25;
  return s;
}

export function chooseBotMove(ctx: MoveContext, rng: Rng = Math.random): Move {
  const moves = legalMoves(ctx);
  if (moves.length === 0) throw new Error('Bot has no legal move');
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = score(ctx, m) + rng() * 2;
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  return best.move;
}

export function chooseBotBid(hand: Card[]): number {
  const values = biddableValues(hand);
  // Prefer a value we hold twice (it can be built and then captured), else the highest.
  const pair = values.filter((v) => hand.filter((c) => c.rank === v).length >= 2);
  return (pair.length ? pair : values)[(pair.length ? pair : values).length - 1];
}
