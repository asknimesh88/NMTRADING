// ORB Breakout-Retest — JavaScript copy of orb_retest_strategy.pine (default settings, "Retest" entry mode).
// Replays one New York session on 1-minute bars and returns the opening range, the day's status and paper trades.
// Keep P in sync with the Pine inputs if you change them there.
// ponytail: failed-breakout fades and the other entry modes are not ported (off by default in Pine); add if you turn them on.

export const P = {
  orbStartMin: 9 * 60 + 30, // 09:30 NY
  orbLen: 15,               // opening range minutes
  entEndMin: 11 * 60 + 30,  // no new entries after 11:30 NY
  flatMin: 12 * 60,         // close everything at 12:00 NY
  structMin: 5,             // structure timeframe (minutes)
  touchPct: 10,             // retest zone, % of range
  invPct: 25,               // setup fails on a close this far back inside, % of range
  dirClose: true,           // confirmation candle must close in trade direction
  maxTrades: 1,             // per direction per day
  allowLong: true,
  allowShort: true,
  useFvg: true,
  fvgTolPct: 25,
  useVwap: true,
  usePdhl: true,
  skipWknd: true,
  useMinR: true,
  minRPct: 0.20,            // min opening range, % of price
  useStrong: true,
  bkDistPct: 10,            // breakout close beyond level, % of range
  bodyPct: 60,              // breakout candle body, % of candle
  slBufPct: 5,              // stop buffer, % of range
  minSlPct: 10,             // min stop, % of range
  atrLen: 14,
  minSlAtr: 1.0,            // min stop, x 1m ATR
  rr: 2,
  usePart: true,            // 50% at 1R, runner to breakeven
  feePct: 0.055,            // per side, % of notional (Bybit taker)
};

// bars: [{t, o, h, l, c, v}] ascending 1m bars from 00:00 UTC of the session's UTC date; only CLOSED bars.
// nyOffsetMs: (New York local time - UTC) in ms for this session, e.g. -4h in summer.
export function runSession(bars, { pdh = NaN, pdl = NaN, nyOffsetMs, weekday, p = P } = {}) {
  const out = { orbH: null, orbL: null, rangePct: null, status: 'waiting', trades: [] };
  if (p.skipWknd && (weekday === 0 || weekday === 6)) { out.status = 'skipped: weekend'; return out; }

  const MIN = 60000, SMS = p.structMin * MIN;
  const nyMin = t => (((Math.floor((t + nyOffsetMs) / MIN)) % 1440) + 1440) % 1440;

  // 5m structure bars, keyed by bucket start
  const sIdx = new Map(), sBars = [];
  for (const b of bars) {
    const k = Math.floor(b.t / SMS) * SMS;
    let s = sIdx.get(k);
    if (!s) { s = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; sIdx.set(k, sBars.length); sBars.push(s); }
    else { s = sBars[s]; s.h = Math.max(s.h, b.h); s.l = Math.min(s.l, b.l); s.c = b.c; }
  }

  // state
  let orbH = NaN, orbL = NaN, orbReady = false, rangeOk = true, orbEndT = 0, sawOrb = false;
  let vwPV = 0, vwV = 0, atr = NaN, trSum = 0, prevC = NaN;
  const cnt = { 1: 0, '-1': 0 };
  const up = { st: 0, ret: false, swing: NaN, fvgT: NaN, fvgB: NaN };
  const dn = { st: 0, ret: false, swing: NaN, fvgT: NaN, fvgB: NaN };
  let pending = null;   // signal waiting for next bar's open
  let pos = null;       // open trade
  let flatPending = false;
  let prevBucket = null;

  const fee = p.feePct / 100;
  const closeLeg = (leg, px, t, why) => { leg.exit = px; leg.exitT = t; leg.why = why; };
  const finish = (tr) => {
    tr.status = 'closed';
    let g = 0, exitN = 0;
    for (const L of tr.legs) { g += L.q * (L.exit - tr.fill) * tr.dir; exitN += L.q * L.exit; }
    tr.exitT = Math.max(...tr.legs.map(L => L.exitT));
    tr.exitPx = exitN;
    tr.rGross = g / tr.risk;
    tr.rNet = (g - fee * (tr.fill + exitN)) / tr.risk;
    tr.reason = tr.legs.map(L => L.why).join('+');
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], m = nyMin(b.t);

    // indicators (Pine: ta.vwap(hlc3) anchored daily at 00:00 UTC; ta.atr = RMA of true range)
    vwPV += (b.h + b.l + b.c) / 3 * b.v; vwV += b.v;
    const vw = vwV > 0 ? vwPV / vwV : b.c;
    const tr = isNaN(prevC) ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC));
    if (i < p.atrLen) { trSum += tr; if (i === p.atrLen - 1) atr = trSum / p.atrLen; }
    else atr = (atr * (p.atrLen - 1) + tr) / p.atrLen;
    prevC = b.c;

    // 1) broker: fills at this bar's open
    if (pending) {
      pos = pending; pending = null;
      pos.fill = b.o; pos.entryT = b.t; pos.status = 'open';
      out.trades.push(pos);
    }
    if (pos && flatPending) {
      for (const L of pos.legs) if (L.exit == null) closeLeg(L, b.o, b.t, 'Time');
      finish(pos); pos = null; flatPending = false;
    }
    // 2) broker: stop / limit exits inside this bar (Pine path: nearer extreme first)
    if (pos) {
      const d = pos.dir;
      const highFirst = (b.h - b.o) <= (b.o - b.l);
      const favFirst = d === 1 ? highFirst : !highFirst;
      const fav = d === 1 ? b.h : b.l, adv = d === 1 ? b.l : b.h;
      const pastFav = (x, lvl) => d === 1 ? x >= lvl : x <= lvl;
      const pastAdv = (x, lvl) => d === 1 ? x <= lvl : x >= lvl;
      const doLimits = () => { for (const L of pos.legs) if (L.exit == null && pastFav(fav, L.tp)) closeLeg(L, pastFav(b.o, L.tp) ? b.o : L.tp, b.t, L.name); };
      const doStops = () => { for (const L of pos.legs) if (L.exit == null && pastAdv(adv, L.stop)) closeLeg(L, pastAdv(b.o, L.stop) ? b.o : L.stop, b.t, L.stop === pos.fill ? 'BE' : 'SL'); };
      if (favFirst) { doLimits(); doStops(); } else { doStops(); doLimits(); }
      if (pos.legs.every(L => L.exit != null)) { finish(pos); pos = null; }
    }

    // 3) script logic at bar close
    if (pos && p.usePart && pos.legs[0].exit != null && !pos.beDone) { pos.legs[1].stop = pos.fill; pos.beDone = true; }

    const inOrb = m >= p.orbStartMin && m < p.orbStartMin + p.orbLen;
    if (inOrb) { sawOrb = true; orbH = isNaN(orbH) ? b.h : Math.max(orbH, b.h); orbL = isNaN(orbL) ? b.l : Math.min(orbL, b.l); }
    if (!inOrb && sawOrb && !orbReady && m >= p.orbStartMin + p.orbLen && m < p.flatMin) {
      orbReady = true; orbEndT = b.t;
      const r0 = orbH - orbL;
      out.orbH = orbH; out.orbL = orbL; out.rangePct = r0 / b.c * 100;
      rangeOk = !(p.useMinR && out.rangePct < p.minRPct);
      out.status = rangeOk ? 'no setup' : 'skipped: range too small';
    }
    if (m >= p.flatMin) {
      orbReady = false;
      if (pos) flatPending = true;
    }

    const rng = orbH - orbL;
    const tol = rng * p.fvgTolPct / 100, touch = rng * p.touchPct / 100, inv = rng * p.invPct / 100;
    const active = orbReady && m >= p.orbStartMin + p.orbLen && m < p.entEndMin && rangeOk;

    // structure timeframe: last CLOSED 5m bar becomes visible on the first 1m bar of the next bucket
    const bucket = Math.floor(b.t / SMS) * SMS;
    const newStruct = prevBucket !== null && bucket !== prevBucket;
    prevBucket = bucket;
    if (active && newStruct) {
      const k = sIdx.get(bucket - SMS);
      const s = k != null ? sBars[k] : null, s3 = k != null && k >= 2 ? sBars[k - 2] : null;
      if (s && s.t >= orbEndT) {
        const bkDist = p.useStrong ? rng * p.bkDistPct / 100 : 0;
        const bodyOk = !p.useStrong || (s.h > s.l && Math.abs(s.c - s.o) >= (s.h - s.l) * p.bodyPct / 100);
        if (p.allowLong && up.st === 0 && s.c > orbH + bkDist && s.c > s.o && bodyOk) { up.st = 1; up.swing = s.l; }
        if (p.allowShort && dn.st === 0 && s.c < orbL - bkDist && s.c < s.o && bodyOk) { dn.st = 1; dn.swing = s.h; }
        if (s3) {
          if (s.l > s3.h && up.st === 1 && s3.h <= orbH + tol && s.l >= orbH - tol) { up.fvgB = s3.h; up.fvgT = s.l; }
          if (s.h < s3.l && dn.st === 1 && s.h <= orbL + tol && s3.l >= orbL - tol) { dn.fvgB = s.h; dn.fvgT = s3.l; }
        }
      }
    }

    // 1m retest + confirmation
    let go = null;
    if (active && up.st === 1) {
      const hasF = p.useFvg && !isNaN(up.fvgB);
      const invLvl = (hasF ? Math.min(up.fvgB, orbH) : orbH) - inv;
      if (b.c < invLvl) up.st = 2;
      else {
        const fvgOk = !p.useFvg || !isNaN(up.fvgT);
        if (!up.ret) {
          const zone = hasF ? Math.max(up.fvgT, orbH + touch) : orbH + touch;
          if (fvgOk && b.l <= zone) { up.ret = true; up.swing = b.l; }
        } else up.swing = Math.min(up.swing, b.l);
        if (up.ret && b.c > orbH && (!p.dirClose || b.c > b.o)) go = { dir: 1, swing: up.swing, level: orbH, setup: up };
      }
    }
    if (active && dn.st === 1) {
      const hasF = p.useFvg && !isNaN(dn.fvgT);
      const invLvl = (hasF ? Math.max(dn.fvgT, orbL) : orbL) + inv;
      if (b.c > invLvl) dn.st = 2;
      else {
        const fvgOk = !p.useFvg || !isNaN(dn.fvgB);
        if (!dn.ret) {
          const zone = hasF ? Math.min(dn.fvgB, orbL - touch) : orbL - touch;
          if (fvgOk && b.h >= zone) { dn.ret = true; dn.swing = b.h; }
        } else dn.swing = Math.max(dn.swing, b.h);
        if (!go && dn.ret && b.c < orbL && (!p.dirClose || b.c < b.o)) go = { dir: -1, swing: dn.swing, level: orbL, setup: dn };
      }
    }

    // orders
    if (go && !pos && !pending) {
      go.setup.st = 2; // one shot per setup, whether or not filters pass
      const d = go.dir, entry = b.c;
      let sl = go.swing - d * rng * p.slBufPct / 100;
      const minD = Math.max(rng * p.minSlPct / 100, (isNaN(atr) ? 0 : atr) * p.minSlAtr);
      sl = d === 1 ? Math.min(sl, entry - minD) : Math.max(sl, entry + minD);
      const risk = Math.abs(entry - sl), tp = entry + d * risk * p.rr, tp1 = entry + d * risk;
      const countOk = cnt[d] < p.maxTrades;
      const vwapOk = !p.useVwap || (d === 1 ? b.c > vw : b.c < vw);
      const pdOk = !p.usePdhl || (d === 1 ? (isNaN(pdh) || !(entry < pdh && tp > pdh)) : (isNaN(pdl) || !(entry > pdl && tp < pdl)));
      if (countOk && vwapOk && pdOk && risk > 0) {
        cnt[d]++;
        const legs = p.usePart
          ? [{ name: 'TP1', q: 0.5, tp: tp1, stop: sl }, { name: 'TP2', q: 0.5, tp, stop: sl }]
          : [{ name: 'TP', q: 1, tp, stop: sl }];
        pending = { dir: d, signalT: b.t, entry, sl, tp, tp1, risk, legs, status: 'signal', beDone: false };
      } else {
        out.skipped = (out.skipped || []).concat({ t: b.t, dir: d, why: !countOk ? 'max trades' : !vwapOk ? 'VWAP' : !pdOk ? 'PDH/PDL in the way' : 'zero risk' });
      }
    }
  }

  if (pending) out.trades.push(pending); // signalled on the latest bar; fills at next open
  if (out.trades.length) out.status = 'traded';
  // tidy trades for storage
  out.trades = out.trades.map(t => ({
    dir: t.dir, signalT: t.signalT, entryT: t.entryT ?? null, entry: t.entry, fill: t.fill ?? null,
    sl: t.sl, tp: t.tp, tp1: t.tp1, risk: t.risk, status: t.status,
    exitT: t.exitT ?? null, exitPx: t.exitPx ?? null, rGross: t.rGross ?? null, rNet: t.rNet ?? null, reason: t.reason ?? null,
    legs: t.legs.map(L => ({ name: L.name, q: L.q, exit: L.exit ?? null, why: L.why ?? null })),
  }));
  return out;
}
