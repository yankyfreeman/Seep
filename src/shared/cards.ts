export type Suit = 'S' | 'H' | 'D' | 'C';

export interface Card {
  /** Unique id, e.g. "10D", "AS", "KH". */
  id: string;
  /** 1 (Ace) … 13 (King). */
  rank: number;
  suit: Suit;
}

export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];

export const SUIT_SYMBOL: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

export function rankLabel(rank: number): string {
  switch (rank) {
    case 1: return 'A';
    case 11: return 'J';
    case 12: return 'Q';
    case 13: return 'K';
    default: return String(rank);
  }
}

export function cardLabel(card: Card): string {
  return `${rankLabel(card.rank)}${SUIT_SYMBOL[card.suit]}`;
}

export function makeCard(rank: number, suit: Suit): Card {
  return { id: `${rankLabel(rank)}${suit}`, rank, suit };
}

/** Parse ids such as "10D", "AS", "kh". Handy for tests. */
export function parseCard(id: string): Card {
  const m = /^(A|J|Q|K|[2-9]|10)([SHDC])$/i.exec(id.trim());
  if (!m) throw new Error(`Bad card id: ${id}`);
  const r = m[1].toUpperCase();
  const rank = r === 'A' ? 1 : r === 'J' ? 11 : r === 'Q' ? 12 : r === 'K' ? 13 : Number(r);
  return makeCard(rank, m[2].toUpperCase() as Suit);
}

export function fullDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) deck.push(makeCard(rank, suit));
  return deck;
}

export type Rng = () => number;

export function shuffle<T>(items: T[], rng: Rng = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Point value of a card in Seep. The deck holds exactly 100 points:
 * every spade is worth its rank (A♠=1 … K♠=13, 91 total), the other three
 * aces are worth 1 each, and the 10♦ is worth 6.
 */
export function cardPoints(card: Card): number {
  if (card.suit === 'S') return card.rank;
  if (card.rank === 1) return 1;
  if (card.rank === 10 && card.suit === 'D') return 6;
  return 0;
}

export function sumPoints(cards: Card[]): number {
  return cards.reduce((t, c) => t + cardPoints(c), 0);
}

/** Small seeded PRNG (mulberry32) — deterministic games for tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
