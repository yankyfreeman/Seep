export const RULES_HTML = `
<h2>How to play Seep</h2>
<p><strong>Seep</strong> (also called <em>Sweep</em> or <em>Sip</em>) is a fishing card game hugely popular in Punjab.
Four players play in two partnerships; partners sit opposite each other. Play goes counter-clockwise.</p>

<h3>Card values &amp; points</h3>
<ul>
  <li>For capturing and building, A = 1, number cards = face value, J = 11, Q = 12, K = 13.</li>
  <li>Points: every <strong>spade</strong> is worth its value (A♠ = 1 … K♠ = 13), the other three <strong>aces</strong> are 1 each,
  and the <strong>10♦</strong> is worth 6. That's 100 points in the deck.</li>
  <li>A <strong>seep</strong> — clearing the whole floor with a capture — is worth <strong>50</strong> extra points
  (except on the very last play of a deal).</li>
</ul>

<h3>The deal &amp; the bid</h3>
<p>The dealer gives four cards to the player on their right (the <em>bidder</em>) and four cards face down to the floor.
The bidder must bid a value from 9 to 13 that they hold in hand (with no card of 9 or above, the cards are redealt).
The floor is turned face up and the bidder's first play <em>must</em> use the bid: build a house of that value,
capture with a card of that value, or throw that card. Then everyone is dealt up to 12 cards.</p>

<h3>On your turn, play one card to…</h3>
<ul>
  <li><strong>Capture</strong> — take floor cards that match your card's value, singly or in combinations adding up to it
  (a 9 can take a 9, a 4 + 5, and a 6 + 3 all at once), plus a house of exactly that value.</li>
  <li><strong>Build a house</strong> — combine your card with floor cards into a pile worth 9–13. You must hold another
  card of that value to capture it later.</li>
  <li><strong>Raise a house</strong> — add a card to an unbroken house to make it a higher value (up to 13), again holding the new value.</li>
  <li><strong>Cement a house</strong> — add cards totalling the house's value to it (or build a second pile of the same value).
  A cemented (<em>pakka</em>) house can no longer be raised.</li>
  <li><strong>Throw</strong> — place the card loose on the floor.</li>
</ul>

<h3>House rules enforced here</h3>
<ul>
  <li>While you own a house on the floor you may not throw; you must capture or build, and you must keep a card of the house's value.</li>
  <li>A card equal to a house's value cannot be thrown loose — capture the house with it instead.</li>
  <li>Only one house of each value can exist; a new pile of the same value is merged into it and cemented.</li>
</ul>

<h3>Scoring</h3>
<p>When all cards are played, any cards left on the floor go to the team that made the last capture.
Each team scores its card points plus 50 per seep. Deals continue (the deal passes counter-clockwise) until a team leads by
the target margin — that team wins the <em>baazi</em>.</p>

<h3>Using this table</h3>
<p>Tap a card in your hand, tap the floor cards / houses you want to use, then press <em>Capture</em>, <em>Build</em> or <em>Throw</em>.
Only legal actions light up.</p>
`;
