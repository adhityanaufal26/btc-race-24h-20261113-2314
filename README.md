# btc-race-24h-20261113-2314

A long-only trading bot for the make.fun competition "Race a BTC trading
bot live for 24 hours". It trades Coinbase Wrapped BTC (cbBTC) against
USDC on 1-minute Orca Whirlpool bars, starting from $1,000 of paper
money, speaking the `agent-fun/bars-replay/v1` protocol (`main.ts`,
Node 22, standard library only).

## Strategy

Slow EMA crossover in an oversold regime, one full-size position at a
time:

- Indicators over bar closes: EMA(21) and EMA(90), each seeded as the
  mean of its first span of closes; SMA(120) over the 120 closes before
  the current bar.
- **Entry:** EMA(21) crosses above EMA(90) while the close sits below
  SMA(120) — a confirmed bounce from below the 120-bar mean, not a chase
  of an already extended uptrend. Buys with all cash.
- **Exit** (whole position), first trigger wins: EMA(21) crosses back
  below EMA(90), close reaches entry +1% (take profit), or close falls
  to entry −1% (stop loss).
- Otherwise it holds cash. Orders fill at the next bar's open and are
  capped at 100 bps slippage from the close they were decided on.

## Why this shape

On the frozen dev window cbBTC fell 4.9% in 24h, grinding down in steps
with brief 0.8–1.3% bounces. Fast crossovers whipsaw and bleed the
~32 bps round-trip cost; buy-and-hold loses with the market. This bot
stays in cash through the grind and only buys a slow, confirmed bounce,
banking it at +1%.

## Dev-window result (local grade, `grade-local --driver process`)

- Net PnL: **+6.157267 USDC** (return +0.62%)
- Trades: 2 (one round trip, win rate 1.0), fees 0.802624 USDC
- Max drawdown: 0.41%
- Net PnL at 2x fees: +5.353145 USDC — still positive
- Guardrails met; L1 regrade reproduced byte for byte

## Run

The grader runs `node /bot/main.ts`. To grade locally from the kit
directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

Deterministic: pure float64 EMA/SMA math on bar closes. No clock, no
network, no files, no randomness.

## License

MIT — see `LICENSE`.
