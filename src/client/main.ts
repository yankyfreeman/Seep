import { io, Socket } from 'socket.io-client';
import { Card, cardLabel, cardPoints, parseCard, rankLabel, SUIT_SYMBOL } from '../shared/cards.js';
import type { Ack, ClientToServer, RoomState, SeatInfo, ServerToClient } from '../shared/protocol.js';
import { analyzeMove, Analysis, biddableValues, House, MAX_HOUSE, MIN_HOUSE, Move, MoveContext, teamOf } from '../shared/rules.js';
import type { PlayerView } from '../shared/view.js';
import { RULES_HTML } from './rulesText.js';
import './styles.css';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const socket: Socket<ServerToClient, ClientToServer> = io();
const app = document.getElementById('app')!;

let room: RoomState | null = null;
let selectedCard: string | null = null;
/** Selected floor items: "c:<cardId>" or "h:<houseId>". */
const selectedFloor = new Set<string>();
let modal: 'rules' | 'scores' | null = null;
let dismissedDealEnd = -1;
let toast: { text: string; until: number } | null = null;
let seepFlash = 0;
let lastLogLength = 0;
const chat: { name: string; text: string }[] = [];
let busy = false;

const store = {
  get name() { return safeGet('seep.name') ?? ''; },
  set name(v: string) { safeSet('seep.name', v); },
  get session(): { code: string; token: string } | null {
    try { return JSON.parse(safeGet('seep.session') ?? 'null'); } catch { return null; }
  },
  set session(v: { code: string; token: string } | null) { safeSet('seep.session', v ? JSON.stringify(v) : null); },
};

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string | null) {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}

const urlRoom = () => new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';

// ---------------------------------------------------------------------------
// Server communication
// ---------------------------------------------------------------------------

function send<E extends keyof ClientToServer>(event: E, ...args: unknown[]): Promise<Ack> {
  return new Promise((resolve) => {
    (socket.emit as (e: string, ...a: unknown[]) => void)(event, ...args, (r: Ack) => {
      if (!r.ok) showToast(r.error);
      resolve(r);
    });
  });
}

function enteredRoom(r: Ack) {
  if (r.ok && r.token && r.code) {
    store.session = { code: r.code, token: r.token };
    history.replaceState(null, '', `?room=${r.code}`);
  }
}

socket.on('connect', () => {
  const s = store.session;
  const code = urlRoom() || s?.code;
  if (s && code === s.code) {
    socket.emit('room:join', { code, name: store.name, token: s.token }, (r) => {
      if (r.ok) enteredRoom(r);
      else { store.session = null; room = null; render(); }
    });
  }
});

socket.on('disconnect', () => render());

socket.on('room:state', (s) => {
  room = s;
  const g = s.game;
  if (g) {
    if (g.log.length < lastLogLength) lastLogLength = 0;
    if (g.lastAction?.seep && g.log.length !== lastLogLength) seepFlash = Date.now() + 1600;
    lastLogLength = g.log.length;
    pruneSelection(g);
  }
  render();
});

socket.on('chat', (m) => {
  chat.push(m);
  if (chat.length > 100) chat.shift();
  render();
});

function pruneSelection(g: PlayerView) {
  if (selectedCard && !g.hand.some((c) => c.id === selectedCard)) selectedCard = null;
  const valid = new Set([...(g.floor?.cards.map((c) => `c:${c.id}`) ?? []), ...(g.floor?.houses.map((h) => `h:${h.id}`) ?? [])]);
  for (const k of [...selectedFloor]) if (!valid.has(k)) selectedFloor.delete(k);
}

function showToast(text: string) {
  toast = { text, until: Date.now() + 3500 };
  render();
  setTimeout(render, 3600);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const seatName = (seat: number | null): string => {
  if (seat === null || seat < 0 || !room) return '';
  if (room.you === seat) return 'You';
  return room.seats[seat]?.name ?? `Seat ${seat + 1}`;
};

const TEAM_LABEL = ['A', 'B'];

function teamNames(team: number): string {
  if (!room) return '';
  return [team, team + 2].map((s) => esc(room!.seats[s]?.name ?? '—')).join(' & ');
}

function cardHtml(card: Card, opts: { cls?: string; data?: string } = {}): string {
  const red = card.suit === 'H' || card.suit === 'D';
  const pts = cardPoints(card);
  const sym = SUIT_SYMBOL[card.suit];
  return `<div class="card ${red ? 'red' : 'black'} ${opts.cls ?? ''}" ${opts.data ?? ''} title="${cardLabel(card)}${pts ? ` · ${pts} pt${pts > 1 ? 's' : ''}` : ''}">
    <span class="corner">${rankLabel(card.rank)}<br>${sym}</span>
    <span class="pip">${sym}</span>
    ${pts ? `<span class="pts">${pts}</span>` : ''}
  </div>`;
}

const backHtml = (cls = '') => `<div class="card back ${cls}"></div>`;

function moveContext(g: PlayerView): MoveContext {
  return { seat: g.seat, hand: g.hand, floor: g.floor ?? { cards: [], houses: [] }, firstMoveBid: g.firstMoveBid };
}

function selection() {
  const cardIds: string[] = [];
  const houseIds: string[] = [];
  for (const k of selectedFloor) (k.startsWith('c:') ? cardIds : houseIds).push(k.slice(2));
  return { cardIds, houseIds };
}

interface ActionOption {
  label: string;
  move: Move;
  kind: 'capture' | 'build' | 'throw';
}

/** Legal actions for the current selection, plus a hint explaining why nothing is legal. */
function currentOptions(g: PlayerView): { options: ActionOption[]; hint: string } {
  if (!selectedCard) return { options: [], hint: '' };
  const ctx = moveContext(g);
  const card = g.hand.find((c) => c.id === selectedCard)!;
  const { cardIds, houseIds } = selection();
  const options: ActionOption[] = [];
  let hint = '';
  const note = (a: Analysis) => { if (!a.ok && !hint) hint = a.error; return a.ok; };

  if (selectedFloor.size === 0) {
    const t: Move = { type: 'throw', cardId: card.id };
    if (note(analyzeMove(ctx, t))) options.push({ label: `Throw ${cardLabel(card)}`, move: t, kind: 'throw' });
    // Adding straight onto a house of the same value (cementing).
    const h = ctx.floor.houses.find((x) => x.value === card.rank);
    if (h) {
      const b: Move = { type: 'build', cardId: card.id, value: card.rank, cardIds: [], houseIds: [] };
      if (analyzeMove(ctx, b).ok) options.push({ label: `Cement house of ${card.rank}`, move: b, kind: 'build' });
    }
    if (!options.length && !hint) hint = 'Select floor cards or houses to capture or build with.';
    return { options, hint };
  }

  const c: Move = { type: 'capture', cardId: card.id, cardIds, houseIds };
  const capA = analyzeMove(ctx, c);
  if (capA.ok) options.push({ label: `Capture with ${cardLabel(card)}`, move: c, kind: 'capture' });

  const buildErrors: string[] = [];
  for (let v = MIN_HOUSE; v <= MAX_HOUSE; v++) {
    const b: Move = { type: 'build', cardId: card.id, value: v, cardIds, houseIds };
    const a = analyzeMove(ctx, b);
    if (a.ok) {
      const o = a.outcome;
      const verb = o.type === 'build' && o.merged ? 'Cement' : o.type === 'build' && o.raised ? 'Raise to' : 'Build';
      options.push({ label: `${verb} ${v}`, move: b, kind: 'build' });
    } else buildErrors.push(a.error);
  }
  if (!options.length) {
    const sum =
      card.rank +
      cardIds.reduce((t, id) => t + (ctx.floor.cards.find((x) => x.id === id)?.rank ?? 0), 0) +
      houseIds.reduce((t, id) => t + (ctx.floor.houses.find((x) => x.id === id)?.value ?? 0), 0);
    if (sum >= MIN_HOUSE && sum <= MAX_HOUSE) {
      const b = analyzeMove(ctx, { type: 'build', cardId: card.id, value: sum, cardIds, houseIds });
      if (!b.ok) hint = b.error;
    }
    if (!hint && !capA.ok) hint = capA.error;
  }
  return { options, hint };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  // Preserve input values and focus across re-renders.
  const inputs = new Map<string, string>();
  app.querySelectorAll<HTMLInputElement>('input[id], select[id]').forEach((el) => inputs.set(el.id, el.value));
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement.id : '';
  const scrollers = new Map<string, number>();
  app.querySelectorAll<HTMLElement>('[data-scroll]').forEach((el) => {
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    scrollers.set(el.dataset.scroll!, atBottom ? -1 : el.scrollTop);
  });

  let html = '';
  if (!room) html = homeHtml();
  else if (!room.started || !room.game) html = lobbyHtml(room);
  else html = gameHtml(room, room.game);

  if (!socket.connected) html += `<div class="conn">Connecting to server…</div>`;
  if (toast && toast.until > Date.now()) html += `<div class="toast">${esc(toast.text)}</div>`;
  if (modal === 'rules') html += modalHtml(RULES_HTML);
  app.innerHTML = html;

  inputs.forEach((v, id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = v;
  });
  if (focused) {
    const el = document.getElementById(focused) as HTMLInputElement | null;
    el?.focus();
    if (el && el.type === 'text') el.setSelectionRange(el.value.length, el.value.length);
  }
  app.querySelectorAll<HTMLElement>('[data-scroll]').forEach((el) => {
    const prev = scrollers.get(el.dataset.scroll!);
    el.scrollTop = prev === undefined || prev === -1 ? el.scrollHeight : prev;
  });
}

function homeHtml(): string {
  const code = urlRoom();
  return `<main class="home">
    <div class="hero">
      <div class="hero-cards">${['AS', 'KS', '10D'].map((id, i) => `<div class="fan f${i}">${cardHtml(parseCard(id))}</div>`).join('')}</div>
      <h1>Seep <span class="gurmukhi">ਸੀਪ</span></h1>
      <p class="tag">The Punjabi partnership card game. Four players, two teams, one deck — capture, build houses, and sweep the floor.</p>
    </div>
    <form class="panel" data-form="${code ? 'join' : 'create'}">
      <label>Your name<input id="name" maxlength="20" autocomplete="nickname" placeholder="e.g. Jasleen" value="${esc(store.name)}" required></label>
      ${code ? `<p class="joining">Joining table <strong>${esc(code)}</strong></p>
        <button class="primary" type="submit">Join table</button>
        <button type="button" class="link" data-action="forget-room">Create a new table instead</button>` : `
        <button class="primary" type="submit">Create a table</button>
        <div class="or"><span>or join friends</span></div>
        <div class="row"><input id="code" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off"><button type="button" data-action="join">Join</button></div>`}
    </form>
    <button class="link" data-action="rules">How to play</button>
  </main>`;
}

function topbarHtml(r: RoomState, extra = ''): string {
  return `<header class="topbar">
    <div class="brand">Seep <span class="gurmukhi">ਸੀਪ</span></div>
    ${extra}
    <div class="top-actions">
      <button class="chip" data-action="copy-link" title="Copy invite link">Table ${esc(r.code)} ⧉</button>
      <button class="chip" data-action="rules">Rules</button>
      <button class="chip" data-action="leave">Leave</button>
    </div>
  </header>`;
}

function lobbyHtml(r: RoomState): string {
  const seatBox = (seat: number) => {
    const s = r.seats[seat];
    const team = teamOf(seat);
    const mine = r.you === seat;
    let body = '';
    if (s) {
      body = `<div class="seat-name">${esc(s.name)}${mine ? ' <em>(you)</em>' : ''}</div>
        <div class="seat-tags">${s.isBot ? '<span class="tag-bot">bot</span>' : ''}${!s.connected ? '<span class="tag-off">offline</span>' : ''}</div>
        ${r.youAreHost && !mine ? `<button class="small" data-action="remove" data-seat="${seat}">Remove</button>` : ''}`;
    } else {
      body = `<div class="seat-name empty">Empty seat</div>
        <div class="seat-btns">
          <button class="small" data-action="sit" data-seat="${seat}">Sit here</button>
          ${r.youAreHost ? `<button class="small" data-action="bot" data-seat="${seat}">Add bot</button>` : ''}
        </div>`;
    }
    return `<div class="lobby-seat team-${team} ${mine ? 'mine' : ''} ls-${seat}"><div class="team-label">Team ${TEAM_LABEL[team]}</div>${body}</div>`;
  };
  const full = r.seats.every(Boolean);
  const link = `${location.origin}${location.pathname}?room=${r.code}`;
  return `<div class="lobby">
    ${topbarHtml(r)}
    <main class="lobby-main">
      <h2>Waiting for players</h2>
      <p class="muted">Share the code <strong class="code">${esc(r.code)}</strong> or the link: <button class="link" data-action="copy-link">${esc(link)}</button></p>
      <div class="lobby-table">
        ${[0, 1, 2, 3].map(seatBox).join('')}
        <div class="lobby-felt">Partners sit opposite each other</div>
      </div>
      ${r.youAreHost ? `<div class="host-controls">
          <label>Win when a team leads by
            <select id="target">${[100, 200, 300, 500].map((v) => `<option value="${v}">${v} points</option>`).join('')}</select>
          </label>
          ${!full ? `<button data-action="fill-bots">Fill empty seats with bots</button>` : ''}
          <button class="primary" data-action="start" ${full ? '' : 'disabled'}>Start game</button>
        </div>` : `<p class="muted">${full ? 'Waiting for the host to start…' : 'Waiting for more players…'}</p>`}
    </main>
  </div>`;
}

function gameHtml(r: RoomState, g: PlayerView): string {
  const base = r.you >= 0 ? r.you : 0;
  const pos = (seat: number) => ['bottom', 'right', 'top', 'left'][(seat - base + 4) % 4];
  const myTurn = g.turn === r.you && (g.phase === 'playing' || g.phase === 'bidding');

  const scores = `<div class="scores">
    ${[0, 1].map((t) => `<div class="score team-${t} ${r.you >= 0 && teamOf(r.you) === t ? 'mine' : ''}" data-action="scores">
      <div class="score-label">Team ${TEAM_LABEL[t]} <span class="muted">${teamNames(t)}</span></div>
      <div class="score-val">${g.scores[t]}</div>
      <div class="score-sub">${g.capturedCounts[t]} cards${g.seeps[t] ? ` · <b>${g.seeps[t]} seep${g.seeps[t] > 1 ? 's' : ''}</b>` : ''}</div>
    </div>`).join('')}
  </div>`;

  const seats = [0, 1, 2, 3]
    .filter((s) => s !== r.you)
    .map((s) => seatHtml(r, g, s, pos(s)))
    .join('');

  return `<div class="game ${myTurn ? 'my-turn' : ''}">
    ${topbarHtml(r, scores)}
    <div class="main">
      <section class="table">
        ${seats}
        <div class="floor-wrap">
          <div class="deal-info">Deal ${g.dealNumber} · Dealer: ${esc(seatName(g.dealer))}${g.bid ? ` · Bid: <b>${g.bid}</b> by ${esc(seatName(g.bidder))}` : ''}</div>
          ${floorHtml(g)}
          <div class="status">${statusHtml(g)}</div>
          ${g.log.length ? `<div class="last-log">${lastLogHtml(g)}</div>` : ''}
        </div>
      </section>
      <aside class="side">
        <div class="log" data-scroll="log">${g.log.map((e) => `<div class="log-line ${e.text.startsWith('SEEP') ? 'seep' : ''}">${e.seat !== null ? `<b>${esc(seatName(e.seat))}</b> ` : ''}${esc(e.text)}</div>`).join('')}</div>
        <div class="chat" data-scroll="chat">${chat.map((m) => `<div><b>${esc(m.name)}:</b> ${esc(m.text)}</div>`).join('') || '<div class="muted">Chat with the table…</div>'}</div>
        <form class="chat-form" data-form="chat"><input id="chat-input" maxlength="300" placeholder="Say something…" autocomplete="off"><button type="submit">Send</button></form>
      </aside>
    </div>
    ${r.you >= 0 ? meHtml(r, g, myTurn) : spectatorHtml(r)}
    ${dealEndHtml(r, g)}
    ${seepFlash > Date.now() ? `<div class="seep-flash">SEEP!</div>` : ''}
  </div>`;
}

function lastLogHtml(g: PlayerView): string {
  const e = g.log[g.log.length - 1];
  return `${e.seat !== null ? `<b>${esc(seatName(e.seat))}</b> ` : ''}${esc(e.text)}`;
}

function badges(g: PlayerView, seat: number): string {
  return [
    seat === g.dealer ? '<span class="badge dealer" title="Dealer">D</span>' : '',
    seat === g.bidder && g.bid ? `<span class="badge bid" title="Bidder">Bid ${g.bid}</span>` : '',
    g.lastCapturer === seat ? '<span class="badge last" title="Made the last capture">last capture</span>' : '',
  ].join('');
}

function seatHtml(r: RoomState, g: PlayerView, seat: number, position: string): string {
  const info: SeatInfo | null = r.seats[seat];
  const n = g.handCounts[seat];
  const team = teamOf(seat);
  const partner = r.you >= 0 && teamOf(r.you) === team;
  return `<div class="seat pos-${position} team-${team} ${g.turn === seat && g.phase !== 'dealEnd' && g.phase !== 'gameOver' ? 'turn' : ''}">
    <div class="seat-head">
      <span class="seat-name">${esc(info?.name ?? '—')}</span>
      ${partner ? '<span class="badge partner">partner</span>' : ''}
      ${info && !info.connected ? '<span class="badge off">offline</span>' : ''}
      ${badges(g, seat)}
    </div>
    <div class="mini-hand">${Array.from({ length: Math.min(n, 12) }, () => '<div class="mini-back"></div>').join('')}<span class="count">${n}</span></div>
  </div>`;
}

function floorHtml(g: PlayerView): string {
  if (!g.floor) {
    return `<div class="floor">${Array.from({ length: g.hiddenFloorCount }, () => backHtml()).join('')}</div>`;
  }
  const fresh = new Set(g.lastAction && g.lastAction.type !== 'capture' ? [g.lastAction.card.id, ...g.lastAction.cards.map((c) => c.id)] : []);
  const loose = g.floor.cards.map((c) =>
    cardHtml(c, {
      cls: `floor-card ${selectedFloor.has(`c:${c.id}`) ? 'selected' : ''} ${fresh.has(c.id) ? 'fresh' : ''}`,
      data: `data-action="floor" data-key="c:${c.id}"`,
    }),
  );
  const houses = g.floor.houses.map((h) => houseHtml(h, fresh));
  const empty = !loose.length && !houses.length;
  return `<div class="floor">${houses.join('')}${loose.join('')}${empty ? '<div class="floor-empty">The floor is empty</div>' : ''}</div>`;
}

function houseHtml(h: House, fresh: Set<string>): string {
  const owners = h.owners.map((o) => esc(seatName(o))).join(', ');
  return `<div class="house ${h.cemented ? 'cemented' : ''} ${selectedFloor.has(`h:${h.id}`) ? 'selected' : ''} ${h.cards.some((c) => fresh.has(c.id)) ? 'fresh' : ''}"
      data-action="floor" data-key="h:${h.id}" title="House of ${h.value}${h.cemented ? ' (cemented)' : ''} — ${h.cards.map(cardLabel).join(' ')}">
    <div class="house-value">${h.value}</div>
    <div class="house-cards">${h.cards.map((c, i) => `<div class="stack" style="--i:${i}">${cardHtml(c)}</div>`).join('')}</div>
    <div class="house-meta">${h.cemented ? 'pakka' : 'kacha'} · ${owners}</div>
  </div>`;
}

function statusHtml(g: PlayerView): string {
  if (g.phase === 'bidding') {
    return g.seat === g.bidder
      ? `Look at your four cards and <b>bid</b> a value from 9 to 13 that you hold.`
      : `${esc(seatName(g.bidder))} is choosing a bid…`;
  }
  if (g.phase === 'playing') {
    if (g.turn === g.seat) {
      return g.firstMoveBid
        ? `<b>Your play.</b> It must use your bid of ${g.firstMoveBid}.`
        : `<b>Your turn.</b> Pick a card, then the floor cards to use.`;
    }
    return `Waiting for ${esc(seatName(g.turn))}…`;
  }
  if (g.phase === 'dealEnd') {
    return `Deal ${g.dealNumber} is over. ${g.seat >= 0 ? '<button class="primary small" data-action="next-deal">Next deal</button>' : ''}
      <button class="small" data-action="scores">Scores</button>`;
  }
  return `Game over.`;
}

function meHtml(r: RoomState, g: PlayerView, myTurn: boolean): string {
  const seat = r.you;
  let actions = '';
  if (g.phase === 'bidding' && seat === g.bidder) {
    actions = `<div class="actions"><span class="prompt">Your bid:</span>${biddableValues(g.hand)
      .map((v) => `<button class="primary" data-action="bid" data-value="${v}">${v} (${rankLabel(v)})</button>`)
      .join('')}</div>`;
  } else if (g.phase === 'playing') {
    const { options, hint } = myTurn ? currentOptions(g) : { options: [], hint: '' };
    const parts = options.map(
      (o, i) => `<button class="${o.kind === 'throw' ? '' : 'primary'} act-${o.kind}" data-action="play" data-idx="${i}">${esc(o.label)}</button>`,
    );
    const prompt = !myTurn
      ? `<span class="prompt muted">${esc(seatName(g.turn))} to play</span>`
      : !selectedCard
        ? `<span class="prompt">Select a card from your hand</span>`
        : !options.length
          ? `<span class="prompt warn">${esc(hint)}</span>`
          : '';
    const clear = selectedCard || selectedFloor.size ? `<button class="ghost" data-action="clear">Clear</button>` : '';
    actions = `<div class="actions">${prompt}${parts.join('')}${clear}</div>`;
  } else {
    actions = `<div class="actions"></div>`;
  }
  const team = teamOf(seat);
  return `<section class="me team-${team} ${myTurn ? 'turn' : ''}">
    <div class="me-head">
      <span class="seat-name">You · Team ${TEAM_LABEL[team]}</span>${badges(g, seat)}
    </div>
    ${actions}
    <div class="hand">${g.hand
      .map((c) => cardHtml(c, { cls: `hand-card ${selectedCard === c.id ? 'selected' : ''}`, data: `data-action="hand" data-id="${c.id}"` }))
      .join('')}</div>
  </section>`;
}

function spectatorHtml(r: RoomState): string {
  const bots = r.seats.map((s, i) => (s?.isBot ? i : -1)).filter((i) => i >= 0);
  return `<section class="me spectator">
    <p>You are watching. ${bots.length ? `Take over a bot's seat to play:` : ''}
    ${bots.map((s) => `<button class="small" data-action="sit" data-seat="${s}">Take ${esc(r.seats[s]!.name)}'s seat</button>`).join(' ')}</p>
  </section>`;
}

function dealEndHtml(r: RoomState, g: PlayerView): string {
  const showScores = modal === 'scores';
  const dealOver = (g.phase === 'dealEnd' && dismissedDealEnd !== g.dealNumber) || g.phase === 'gameOver';
  if (!dealOver && !showScores) return '';
  const last = g.history[g.history.length - 1];
  const rows = (label: string, f: (t: number) => string | number) =>
    `<tr><th>${label}</th><td>${f(0)}</td><td>${f(1)}</td></tr>`;
  const result =
    last && (dealOver || showScores)
      ? `<table class="results">
        <thead><tr><th></th><th class="team-0">Team ${TEAM_LABEL[0]}<small>${teamNames(0)}</small></th><th class="team-1">Team ${TEAM_LABEL[1]}<small>${teamNames(1)}</small></th></tr></thead>
        <tbody>
          ${rows('Cards taken', (t) => last.cardsTaken[t])}
          ${rows('Card points', (t) => last.cardPoints[t])}
          ${rows('Seeps (×50)', (t) => last.seeps[t])}
          ${rows(`Deal ${last.dealNumber}`, (t) => `<b>${last.dealPoints[t]}</b>`)}
          ${rows('Total', (t) => `<b>${last.totals[t]}</b>`)}
        </tbody></table>`
      : '<p class="muted">No deals finished yet.</p>';
  const historyRows = g.history.length > 1
    ? `<details><summary>All deals</summary><table class="results small">${g.history
        .map((h) => `<tr><th>Deal ${h.dealNumber} (bid ${h.bid})</th><td>${h.dealPoints[0]}</td><td>${h.dealPoints[1]}</td></tr>`)
        .join('')}</table></details>`
    : '';
  let title = `Deal ${g.dealNumber} result`;
  let buttons = '';
  if (g.phase === 'gameOver' && g.winner !== null) {
    const youWon = r.you >= 0 && teamOf(r.you) === g.winner;
    title = `${youWon ? '🎉 You win!' : `Team ${TEAM_LABEL[g.winner]} wins`} — ${teamNames(g.winner)}`;
    buttons = r.youAreHost ? `<button class="primary" data-action="new-game">Play again</button>` : `<p class="muted">Waiting for the host to start a new game.</p>`;
  } else if (g.phase === 'dealEnd' && !showScores) {
    const lead = Math.abs(g.scores[0] - g.scores[1]);
    buttons = `<p class="muted">First team to lead by ${g.settings.targetLead} wins${lead ? ` · current lead ${lead}` : ''}.</p>
      ${r.you >= 0 ? `<button class="primary" data-action="next-deal">Next deal</button>` : ''}
      <button class="ghost" data-action="dismiss-deal">Look at the table</button>`;
  } else {
    buttons = `<button class="primary" data-action="close-modal">Close</button>`;
  }
  return modalHtml(`<h2>${title}</h2>${result}${historyRows}<div class="modal-actions">${buttons}</div>`, !showScores);
}

function modalHtml(inner: string, sticky = false): string {
  return `<div class="modal-backdrop" ${sticky ? '' : 'data-action="close-modal"'}>
    <div class="modal" data-stop="1">${sticky ? '' : '<button class="close" data-action="close-modal">×</button>'}${inner}</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function nameValue(): string {
  const v = (document.getElementById('name') as HTMLInputElement | null)?.value.trim() ?? store.name;
  if (v) store.name = v;
  return v;
}

async function run(fn: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  try { await fn(); } finally { busy = false; render(); }
}

app.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = (e.target as HTMLElement).closest('form');
  const kind = form?.dataset.form;
  if (kind === 'create') {
    const name = nameValue();
    if (!name) return showToast('Please enter your name.');
    run(async () => enteredRoom(await send('room:create', { name })));
  } else if (kind === 'join') {
    joinRoom(urlRoom());
  } else if (kind === 'chat') {
    const input = document.getElementById('chat-input') as HTMLInputElement;
    const text = input.value.trim();
    if (text) socket.emit('chat', { text });
    input.value = '';
  }
});

function joinRoom(code: string) {
  const name = nameValue();
  if (!name) return showToast('Please enter your name.');
  if (!/^[A-Z]{4}$/i.test(code)) return showToast('Enter the 4-letter table code.');
  const s = store.session;
  run(async () => enteredRoom(await send('room:join', { code: code.toUpperCase(), name, token: s?.code === code.toUpperCase() ? s.token : undefined })));
}

app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el) return;
  // Clicks inside a modal shouldn't hit the backdrop's close action.
  if (el.classList.contains('modal-backdrop') && target.closest('[data-stop]')) return;
  const action = el.dataset.action!;
  const seat = Number(el.dataset.seat);
  const g = room?.game ?? null;

  switch (action) {
    case 'rules': modal = 'rules'; return render();
    case 'scores': modal = 'scores'; return render();
    case 'close-modal': modal = null; return render();
    case 'dismiss-deal': if (g) dismissedDealEnd = g.dealNumber; return render();
    case 'forget-room': history.replaceState(null, '', location.pathname); return render();
    case 'join': return joinRoom((document.getElementById('code') as HTMLInputElement).value.trim());
    case 'copy-link': {
      const link = `${location.origin}${location.pathname}?room=${room?.code}`;
      navigator.clipboard?.writeText(link).then(() => showToast('Invite link copied!'), () => showToast(link));
      return;
    }
    case 'leave':
      if (!confirm(room?.started ? 'Leave the game? A bot will take your seat.' : 'Leave this table?')) return;
      socket.emit('room:leave');
      store.session = null;
      room = null;
      history.replaceState(null, '', location.pathname);
      return render();
    case 'sit': return void run(() => send('room:sit', { seat }));
    case 'bot': return void run(() => send('room:addBot', { seat }));
    case 'remove': return void run(() => send('room:removeSeat', { seat }));
    case 'fill-bots':
      return void run(async () => {
        for (let s = 0; s < 4; s++) if (!room?.seats[s]) await send('room:addBot', { seat: s });
      });
    case 'start': {
      const targetLead = Number((document.getElementById('target') as HTMLSelectElement | null)?.value ?? 100);
      return void run(() => send('game:start', { targetLead }));
    }
    case 'new-game': return void run(() => send('game:newGame'));
    case 'next-deal': return void run(() => send('game:nextDeal'));
    case 'bid': return void run(() => send('game:bid', { value: Number(el.dataset.value) }));
    case 'hand': {
      const id = el.dataset.id!;
      selectedCard = selectedCard === id ? null : id;
      return render();
    }
    case 'floor': {
      const key = el.dataset.key!;
      if (selectedFloor.has(key)) selectedFloor.delete(key);
      else selectedFloor.add(key);
      return render();
    }
    case 'clear': selectedCard = null; selectedFloor.clear(); return render();
    case 'play': {
      if (!g) return;
      const opt = currentOptions(g).options[Number(el.dataset.idx)];
      if (!opt) return;
      return void run(async () => {
        const r = await send('game:move', { move: opt.move });
        if (r.ok) { selectedCard = null; selectedFloor.clear(); }
      });
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (modal) modal = null;
    else { selectedCard = null; selectedFloor.clear(); }
    render();
  }
});

setInterval(() => { if (seepFlash && seepFlash < Date.now()) { seepFlash = 0; render(); } }, 500);

render();
