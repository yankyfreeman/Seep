import { describe, expect, it } from 'vitest';
import { chooseBotBid, chooseBotMove, legalMoves } from '../src/shared/bot.js';
import { Card, fullDeck, parseCard, seededRng, sumPoints } from '../src/shared/cards.js';
import {
  analyzeMove,
  canPartition,
  contextFor,
  Floor,
  GameState,
  House,
  MoveContext,
  newGame,
  nextDeal,
  placeBid,
  playMove,
  SEEP_POINTS,
} from '../src/shared/rules.js';
import { viewFor } from '../src/shared/view.js';

const cards = (s: string): Card[] => s.split(/\s+/).filter(Boolean).map(parseCard);
const house = (id: string, value: number, s: string, owners: number[], cemented = false): House => ({
  id,
  value,
  cards: cards(s),
  cemented,
  owners,
});
const ctx = (hand: string, floor: Partial<Floor>, extra: Partial<MoveContext> = {}): MoveContext => ({
  seat: 0,
  hand: cards(hand),
  floor: { cards: [], houses: [], ...floor },
  firstMoveBid: null,
  ...extra,
});

describe('cards', () => {
  it('the deck is worth exactly 100 points', () => {
    expect(fullDeck()).toHaveLength(52);
    expect(sumPoints(fullDeck())).toBe(100);
    expect(sumPoints(cards('10D 10H AH AD AC KS'))).toBe(6 + 0 + 1 + 1 + 1 + 13);
  });
});

describe('canPartition', () => {
  it('splits values into equal-sum groups', () => {
    expect(canPartition([9], 9)).toBe(true);
    expect(canPartition([4, 5], 9)).toBe(true);
    expect(canPartition([4, 5, 9, 2, 7], 9)).toBe(true);
    expect(canPartition([4, 5, 3], 9)).toBe(false);
    expect(canPartition([6, 6, 3, 3], 9)).toBe(true);
    expect(canPartition([5, 5, 4, 4], 9)).toBe(true);
    expect(canPartition([10], 9)).toBe(false);
    expect(canPartition([6, 6, 6], 9)).toBe(false);
  });
});

describe('capturing', () => {
  it('captures matching cards and combinations', () => {
    const c = ctx('9S', { cards: cards('4H 5D 9C 2C') });
    expect(analyzeMove(c, { type: 'capture', cardId: '9S', cardIds: ['4H', '5D', '9C'], houseIds: [] }).ok).toBe(true);
    const bad = analyzeMove(c, { type: 'capture', cardId: '9S', cardIds: ['4H', '2C'], houseIds: [] });
    expect(bad.ok).toBe(false);
  });

  it('captures a house only with the exact value', () => {
    const floor = { houses: [house('h1', 11, '5S 6H', [1])] };
    expect(analyzeMove(ctx('JH', floor), { type: 'capture', cardId: 'JH', cardIds: [], houseIds: ['h1'] }).ok).toBe(true);
    expect(analyzeMove(ctx('QH', floor), { type: 'capture', cardId: 'QH', cardIds: [], houseIds: ['h1'] }).ok).toBe(false);
  });
});

describe('building', () => {
  it('builds a new house when holding the value', () => {
    const c = ctx('3S QD', { cards: cards('9H') });
    const a = analyzeMove(c, { type: 'build', cardId: '3S', value: 12, cardIds: ['9H'], houseIds: [] });
    expect(a.ok && a.outcome.type === 'build' && !a.outcome.cemented).toBe(true);
  });

  it('refuses a house you cannot capture later', () => {
    const c = ctx('3S 5D', { cards: cards('9H') });
    const a = analyzeMove(c, { type: 'build', cardId: '3S', value: 12, cardIds: ['9H'], houseIds: [] });
    expect(a.ok).toBe(false);
  });

  it('refuses houses outside 9..13', () => {
    const c = ctx('3S 8D', { cards: cards('5H') });
    expect(analyzeMove(c, { type: 'build', cardId: '3S', value: 8, cardIds: ['5H'], houseIds: [] }).ok).toBe(false);
  });

  it('raises an unbroken house', () => {
    const c = ctx('2S KD', { houses: [house('h1', 11, '5S 6H', [1])] });
    const a = analyzeMove(c, { type: 'build', cardId: '2S', value: 13, cardIds: [], houseIds: ['h1'] });
    expect(a.ok && a.outcome.type === 'build' && a.outcome.raised?.id).toBe('h1');
  });

  it('cannot raise a cemented house', () => {
    const c = ctx('2S KD', { houses: [house('h1', 11, '5S 6H JC', [1], true)] });
    expect(analyzeMove(c, { type: 'build', cardId: '2S', value: 13, cardIds: [], houseIds: ['h1'] }).ok).toBe(false);
  });

  it('cements by adding cards of the same value to an existing house', () => {
    const c = ctx('7S 10D 10C', { cards: cards('3H'), houses: [house('h1', 10, '4S 6H', [1])] });
    const a = analyzeMove(c, { type: 'build', cardId: '7S', value: 10, cardIds: ['3H'], houseIds: [] });
    expect(a.ok && a.outcome.type === 'build' && a.outcome.merged?.id === 'h1' && a.outcome.cemented).toBe(true);
    // Putting a 10 straight onto the house of 10 also cements it (another 10 is kept).
    expect(analyzeMove(c, { type: 'build', cardId: '10D', value: 10, cardIds: [], houseIds: ['h1'] }).ok).toBe(true);
  });

  it('builds a cemented house from two groups at once', () => {
    const c = ctx('9S 9D', { cards: cards('4H 5C') });
    const a = analyzeMove(c, { type: 'build', cardId: '9S', value: 9, cardIds: ['4H', '5C'], houseIds: [] });
    expect(a.ok && a.outcome.type === 'build' && a.outcome.cemented).toBe(true);
  });
});

describe('throwing and house obligations', () => {
  it('house owners may not throw and must keep the house card', () => {
    const floor = { cards: cards('2H'), houses: [house('h1', 12, '5S 7H', [0])] };
    const c = ctx('QD 4C', floor);
    expect(analyzeMove(c, { type: 'throw', cardId: '4C' }).ok).toBe(false);
    // Capturing 2H with a 2 isn't possible; but playing the Q elsewhere would abandon the house.
    expect(analyzeMove(ctx('QD QC 4C', floor), { type: 'throw', cardId: '4C' }).ok).toBe(false);
    expect(analyzeMove(c, { type: 'capture', cardId: 'QD', cardIds: [], houseIds: ['h1'] }).ok).toBe(true);
  });

  it('a card matching a house cannot be thrown loose', () => {
    const floor = { houses: [house('h1', 12, '5S 7H', [1])] };
    expect(analyzeMove(ctx('QD 4C', floor), { type: 'throw', cardId: 'QD' }).ok).toBe(false);
    expect(analyzeMove(ctx('QD 4C', floor), { type: 'throw', cardId: '4C' }).ok).toBe(true);
  });

  it("the bidder's first play must use the bid value", () => {
    const c = ctx('KS 3D 5H 9C', { cards: cards('8H 2C 4D 6S') }, { firstMoveBid: 13 });
    expect(analyzeMove(c, { type: 'throw', cardId: '3D' }).ok).toBe(false);
    expect(analyzeMove(c, { type: 'throw', cardId: 'KS' }).ok).toBe(true);
    expect(analyzeMove(c, { type: 'build', cardId: '5H', value: 13, cardIds: ['8H'], houseIds: [] }).ok).toBe(true);
    expect(analyzeMove(c, { type: 'build', cardId: '5H', value: 9, cardIds: ['4D'], houseIds: [] }).ok).toBe(false);
  });
});

describe('game flow', () => {
  it('deals 4 to the bidder, then 12 each after the first play', () => {
    const g = newGame({ dealer: 0, rng: seededRng(7) });
    expect(g.bidder).toBe(1);
    expect(g.hands[1]).toHaveLength(4);
    expect(g.floor.cards).toHaveLength(4);
    expect(viewFor(g, 2).floor).toBeNull();
    const bid = chooseBotBid(g.hands[1]);
    placeBid(g, 1, bid);
    playMove(g, 1, chooseBotMove(contextFor(g, 1), seededRng(1)));
    expect(g.hands.map((h) => h.length)).toEqual([12, 11, 12, 12]);
    expect(g.turn).toBe(2);
    expect(g.stock).toHaveLength(0);
  });

  it('views never leak other hands', () => {
    const g = newGame({ dealer: 3, rng: seededRng(3) });
    const v = viewFor(g, 1);
    expect(v.hand).toHaveLength(0);
    expect(JSON.stringify(v)).not.toContain('"hands"');
  });

  /** Plays whole games with bots, checking invariants after every move. */
  function simulate(seed: number): GameState {
    const rng = seededRng(seed);
    const g = newGame({ dealer: seed % 4, rng });
    for (let steps = 0; steps < 10_000; steps++) {
      if (g.phase === 'gameOver') return g;
      if (g.phase === 'dealEnd') {
        const r = g.history[g.history.length - 1];
        expect(r.cardsTaken[0] + r.cardsTaken[1]).toBe(52);
        expect(r.cardPoints[0] + r.cardPoints[1]).toBe(100);
        expect(r.dealPoints[0] + r.dealPoints[1]).toBe(100 + SEEP_POINTS * (r.seeps[0] + r.seeps[1]));
        nextDeal(g, rng);
        continue;
      }
      if (g.phase === 'bidding') {
        placeBid(g, g.turn, chooseBotBid(g.hands[g.turn]));
        continue;
      }
      const c = contextFor(g, g.turn);
      expect(legalMoves(c).length).toBeGreaterThan(0);
      playMove(g, g.turn, chooseBotMove(c, rng));
      const total =
        g.hands.reduce((t, h) => t + h.length, 0) +
        g.stock.length +
        g.floor.cards.length +
        g.floor.houses.reduce((t, h) => t + h.cards.length, 0) +
        g.captured[0].length +
        g.captured[1].length;
      if (g.phase === 'playing') expect(total).toBe(52);
      for (const h of g.floor.houses) {
        expect(h.cards.reduce((t, c) => t + c.rank, 0) % h.value).toBe(0);
        for (const o of h.owners) expect(g.hands[o].some((c) => c.rank === h.value)).toBe(true);
      }
    }
    throw new Error('game did not finish');
  }

  it('bot-vs-bot games always finish with consistent scoring', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const g = simulate(seed);
      expect(g.winner).not.toBeNull();
      const [a, b] = g.scores;
      expect(Math.abs(a - b)).toBeGreaterThanOrEqual(g.settings.targetLead);
    }
  });
});
