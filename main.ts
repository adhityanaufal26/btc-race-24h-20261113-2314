// BTC race bot: slow EMA crossover in an oversold regime, long only.
//
// Strategy (agent-fun/bars-replay/v1, one symbol CBBTC, 1-minute bars):
//   - Indicators over closes: EMA(21) and EMA(90), each seeded as the mean
//     of its first span of closes, then updated with k = 2 / (span + 1);
//     and SMA(120) taken over the 120 closes before the current bar.
//   - Entry: on a bar's close, EMA(21) crosses above EMA(90) while the
//     close sits below SMA(120) (an oversold-regime bounce, not a chase of
//     an already extended uptrend). Buy with all cash, one full-size order.
//     The order fills at the next bar's open.
//   - Exit, whole position, on the first of: EMA(21) crosses back below
//     EMA(90); close reaches entry + 1% (take profit); close falls to
//     entry - 1% (stop loss). The exit order fills at the next bar's open.
//   - No position, no trade otherwise. At most one order per reply.
//
// Why this shape: on the frozen dev window cbBTC fell 4.9% in 24h,
// grinding down in steps with brief 0.8-1.3% bounces. Fast crossovers
// whipsaw and bleed the ~32 bps round-trip cost; holding loses with the
// market. This bot stays in cash through the grind and only buys a slow,
// confirmed bounce from below the 120-bar mean, banking it at +1%.
//
// Deterministic: pure float64 EMA/SMA math on the bar closes, no clock,
// no network, no files, no randomness. Orders are capped at 100 bps
// slippage from the close they were decided on, like the house baselines.

import { createInterface } from 'node:readline';

const FAST_SPAN = 21;
const SLOW_SPAN = 90;
const SMA_SPAN = 120;
const TAKE_PROFIT = 0.01;
const STOP_LOSS = 0.01;
const MAX_SLIPPAGE_BPS = 100;
const SYMBOL = 'CBBTC';

interface Ema {
  span: number;
  k: number;
  warm: number[];
  value: number | null;
}

function makeEma(span: number): Ema {
  return { span, k: 2 / (span + 1), warm: [], value: null };
}

function pushEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += e.k * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

let hello: any = null;
let warmupBars = 0;
let cash = 0;
const fast = makeEma(FAST_SPAN);
const slow = makeEma(SLOW_SPAN);
const closes: number[] = []; // closes before the current bar, oldest first
let prevGap: number | null = null;
let entryClose = 0;
let nextId = 1;

for await (const line of lines) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  const kind = msg.type;
  if (kind === 'hello') {
    hello = msg;
    warmupBars = msg.warmup_bars ?? 0;
    cash = Number(msg.capital.quote_units);
    continue;
  }
  if (kind === 'done') break;
  if (kind !== 'batch') throw new Error('unknown message type: ' + kind);
  const seq = msg.seq;
  cash = Number(msg.account.cash_quote_units);
  const positions = new Map<string, bigint>();
  for (const p of msg.account.positions) {
    positions.set(p.symbol, BigInt(p.qty));
  }

  const orders: object[] = [];
  let bar: any = null;
  for (const b of msg.bars) {
    if (b.symbol === SYMBOL) {
      bar = b;
      break;
    }
  }

  if (bar !== null) {
    const close = Number(bar.c);
    // Degenerate bars (non-finite or non-positive close) carry no signal:
    // skip the indicator update for this bar rather than feeding NaN/0
    // into the EMAs, which would corrupt every later crossover.
    if (!Number.isFinite(close) || close <= 0) {
      process.stdout.write(
        JSON.stringify({ type: 'reply', seq, orders }) + '\n',
      );
      continue;
    }
    // SMA(120) over the closes before this bar, like the backtest.
    const sma =
      closes.length === SMA_SPAN
        ? closes.reduce((a, x) => a + x, 0) / SMA_SPAN
        : null;
    pushEma(fast, close);
    pushEma(slow, close);
    const gap =
      fast.value !== null && slow.value !== null
        ? fast.value - slow.value
        : null;
    closes.push(close);
    if (closes.length > SMA_SPAN) closes.shift();

    const warmingUp = warmupBars > 0 && seq < warmupBars;
    if (!warmingUp && gap !== null && prevGap !== null) {
      // Holding is read from the account, not from a local flag: if a
      // sell is rejected (no bar, slippage cap) the position is still
      // there next bar and the exit is sent again.
      const heldQty = positions.get(SYMBOL) ?? 0n;
      if (heldQty > 0n) {
        if (
          gap < 0 ||
          close >= entryClose * (1 + TAKE_PROFIT) ||
          close <= entryClose * (1 - STOP_LOSS)
        ) {
          orders.push({
            side: 'sell',
            client_id: 'o' + nextId,
            symbol: SYMBOL,
            qty: heldQty.toString(),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          nextId += 1;
        }
      } else if (
        gap > 0 &&
        prevGap <= 0 &&
        sma !== null &&
        close < sma
      ) {
        const minNotional = BigInt(hello.fees.min_notional_quote_units);
        if (BigInt(cash) >= minNotional && cash > 0) {
          orders.push({
            side: 'buy',
            client_id: 'o' + nextId,
            symbol: SYMBOL,
            notional_quote_units: String(cash),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          nextId += 1;
          entryClose = close;
        }
      }
    }
    if (gap !== null) prevGap = gap;
  }

  process.stdout.write(
    JSON.stringify({ type: 'reply', seq, orders }) + '\n',
  );
}
process.stdin.destroy();
