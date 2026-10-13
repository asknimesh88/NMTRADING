// Run: node test/strategy.test.mjs
import assert from 'node:assert/strict';
import { runSession, P } from '../src/strategy.js';

const OFF = -4 * 3600e3;                     // EDT
const day0 = Date.UTC(2026, 9, 13);          // Tue 13 Oct 2026, 00:00 UTC
const tAt = (h, m) => day0 + ((h * 60 + m) * 60e3) - OFF; // NY clock -> UTC ms

// Build a session: flat 100 until 09:30 NY, then the scripted bars, then optional tail.
function session(script, tail) {
  const bars = [];
  for (let t = day0; t < tAt(9, 30); t += 60e3) bars.push({ t, o: 100, h: 100.1, l: 99.9, c: 100, v: 1 });
  let t = tAt(9, 30);
  for (const [o, h, l, c] of script) { bars.push({ t, o, h, l, c, v: 1 }); t += 60e3; }
  for (const [o, h, l, c] of tail) { bars.push({ t, o, h, l, c, v: 1 }); t += 60e3; }
  return bars;
}
const rep = (n, bar) => Array.from({ length: n }, () => bar);

// 09:30-09:44 opening range 100..101; 09:35 5m bar high 100.8 (FVG candle 1)
const orb = [
  [100.5, 101, 100.2, 100.6], ...rep(4, [100.6, 100.7, 100.3, 100.5]),
  ...rep(5, [100.4, 100.8, 100.0, 100.5]),
  ...rep(5, [100.6, 101.0, 100.5, 100.9]),
];
// 09:45-09:49 strong breakout candle, low 101.05 > 100.8 => bullish FVG overlapping ORB high
const breakout = [[101.05, 101.3, 101.05, 101.25], [101.25, 101.5, 101.2, 101.45], [101.45, 101.7, 101.4, 101.65], [101.65, 101.85, 101.6, 101.8], [101.8, 101.95, 101.75, 101.9]];
// 09:50 retest into the zone and bullish close -> long signal
const retest = [[101.3, 101.55, 101.08, 101.5]];

// --- 1. winner: TP1 then TP2
{
  const up = Array.from({ length: 12 }, (_, i) => { const o = 101.5 + i * 0.1; return [o, o + 0.12, o - 0.03, o + 0.1]; });
  const r = runSession(session([...orb, ...breakout, ...retest], up), { pdh: 110, pdl: 90, nyOffsetMs: OFF, weekday: 2 });
  assert.equal(r.orbH, 101); assert.equal(r.orbL, 100);
  assert.equal(r.trades.length, 1, 'one long trade');
  const t = r.trades[0];
  assert.equal(t.dir, 1); assert.equal(t.status, 'closed'); assert.equal(t.reason, 'TP1+TP2');
  assert.ok(Math.abs(t.rGross - 1.5) < 1e-9, `gross R 1.5, got ${t.rGross}`);
  assert.ok(t.rNet < t.rGross, 'fees reduce R');
}
// --- 2. loser: straight to the stop
{
  const down = [[101.5, 101.52, 101.2, 101.25], [101.25, 101.26, 100.9, 100.95]];
  const r = runSession(session([...orb, ...breakout, ...retest], down), { pdh: 110, pdl: 90, nyOffsetMs: OFF, weekday: 2 });
  const t = r.trades[0];
  assert.equal(t.reason, 'SL+SL'); assert.ok(Math.abs(t.rGross + 1) < 1e-9, `gross R -1, got ${t.rGross}`);
}
// --- 3. TP1 then runner back to breakeven
{
  const tail = [[101.5, 102.0, 101.45, 101.9], [101.9, 101.95, 101.3, 101.35]];
  const t = runSession(session([...orb, ...breakout, ...retest], tail), { pdh: 110, pdl: 90, nyOffsetMs: OFF, weekday: 2 }).trades[0];
  assert.equal(t.reason, 'TP1+BE'); assert.ok(Math.abs(t.rGross - 0.5) < 1e-9, `gross R 0.5, got ${t.rGross}`);
}
// --- 4. filters
{
  const bars = session([...orb, ...breakout, ...retest], []);
  assert.equal(runSession(bars, { nyOffsetMs: OFF, weekday: 0 }).status, 'skipped: weekend');
  assert.equal(runSession(bars, { nyOffsetMs: OFF, weekday: 2, p: { ...P, minRPct: 5 } }).status, 'skipped: range too small');
  assert.equal(runSession(bars, { pdh: 101.6, nyOffsetMs: OFF, weekday: 2 }).trades.length, 0, 'PDH in the way blocks the long');
  assert.equal(runSession(bars, { pdh: 110, nyOffsetMs: OFF, weekday: 2 }).trades[0].status, 'signal', 'signal on the last bar is pending');
  // weak breakout (small body) is ignored
  const weak = breakout.map(([o, h, l, c], i) => i === 4 ? [o, 103, 100.9, c] : [o, h, l, c]);
  assert.equal(runSession(session([...orb, ...weak, ...retest], []), { pdh: 110, nyOffsetMs: OFF, weekday: 2 }).trades.length, 0, 'weak breakout ignored');
}
console.log('strategy tests passed');
