// ORB dashboard Worker: paper-trades the ORB strategy on Bybit 1m data and serves a dashboard.
import { runSession, P } from './strategy.js';
import DASHBOARD_HTML from './dashboard.html';

let BYBIT = 'https://api.bybit.com';   // BYBIT_URL var overrides (used for local testing)
const MIN = 60000, DAY = 86400000;

// ---------- time helpers (America/New_York) ----------
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function ny(t) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const y = +p.year, mo = +p.month, d = +p.day, hh = +p.hour, mm = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, min: hh * 60 + mm, weekday: WD[p.weekday],
    offset: Date.UTC(y, mo - 1, d, hh, mm) - Math.floor(t / MIN) * MIN };
}

// ---------- Bybit ----------
async function bybit(path) {
  const r = await fetch(BYBIT + path, { headers: { 'User-Agent': 'orb-dashboard' } });
  if (!r.ok) throw new Error(`Bybit HTTP ${r.status}`);
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(`Bybit ${j.retCode}: ${j.retMsg}`);
  return j.result.list;
}
async function minuteBars(symbol, start, end) {
  const out = new Map();
  for (let s = start; s <= end; s += 1000 * MIN) {       // chunks of <= 1000 bars
    const e = Math.min(s + 999 * MIN, end);
    for (const k of await bybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=1&start=${s}&end=${e}&limit=1000`))
      out.set(+k[0], { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ---------- one symbol, one NY session ----------
async function processDay(env, symbol, date, now) {
  const [y, m, d] = date.split('-').map(Number);
  const dayStart = Date.UTC(y, m - 1, d);                  // VWAP anchor: 00:00 UTC
  const info = ny(dayStart + 15 * 3600e3);                  // mid-session, for DST offset + weekday
  const end = Math.min(now, dayStart + (12 * 60 + 5) * MIN - info.offset);

  let res;
  if (P.skipWknd && (info.weekday === 0 || info.weekday === 6)) {
    res = runSession([], { weekday: info.weekday, nyOffsetMs: info.offset });
  } else {
    const prev = await env.DB.prepare('SELECT pdh, pdl FROM days WHERE symbol=? AND date=?').bind(symbol, date).first();
    let pdh = prev?.pdh, pdl = prev?.pdl;
    if (pdh == null) {
      const dk = await bybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=D&start=${dayStart - DAY}&end=${dayStart - 1}&limit=1`);
      if (dk.length) { pdh = +dk[0][2]; pdl = +dk[0][3]; }
    }
    const bars = (await minuteBars(symbol, dayStart, end)).filter(b => b.t + MIN <= now);   // closed bars only
    res = runSession(bars, { pdh: pdh ?? NaN, pdl: pdl ?? NaN, nyOffsetMs: info.offset, weekday: info.weekday });
    res.pdh = pdh; res.pdl = pdl;
  }

  const stmts = [
    env.DB.prepare(`INSERT OR REPLACE INTO days (symbol,date,orb_h,orb_l,range_pct,status,pdh,pdl,filtered,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(symbol, date, res.orbH, res.orbL, res.rangePct, res.status, res.pdh ?? null, res.pdl ?? null, JSON.stringify(res.skipped || []), now),
    env.DB.prepare('DELETE FROM trades WHERE symbol=? AND date=?').bind(symbol, date),
    ...res.trades.map((t, i) => env.DB.prepare(
      `INSERT INTO trades (id,symbol,date,dir,signal_t,entry_t,entry,fill,sl,tp,tp1,risk,status,exit_t,exit_px,r_gross,r_net,reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(`${symbol}|${date}|${i}`, symbol, date, t.dir, t.signalT, t.entryT, t.entry, t.fill,
      t.sl, t.tp, t.tp1, t.risk, t.status, t.exitT, t.exitPx, t.rGross, t.rNet, t.reason)),
  ];
  await env.DB.batch(stmts);
  return { symbol, date, status: res.status, trades: res.trades.length };
}

function symbols(env) {
  return (env.SYMBOLS || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 15);
}
const setMeta = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)').bind(k, JSON.stringify(v)).run();

// ---------- HTTP ----------
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(req, env) {
    if (env.BYBIT_URL) BYBIT = env.BYBIT_URL;
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response(DASHBOARD_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });

    if (url.pathname === '/api/data') {
      const days = Math.min(+url.searchParams.get('days') || 90, 3650);
      const from = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
      const [tr, dy, meta] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM trades WHERE date >= ? ORDER BY signal_t').bind(from),
        env.DB.prepare('SELECT symbol,date,orb_h,orb_l,range_pct,status,filtered FROM days WHERE date >= ? ORDER BY date').bind(from),
        env.DB.prepare('SELECT k,v FROM meta'),
      ]);
      return json({ symbols: symbols(env), params: P, now: Date.now(), trades: tr.results, days: dy.results,
        meta: Object.fromEntries(meta.results.map(r => [r.k, JSON.parse(r.v)])) });
    }

    if (url.pathname === '/api/backfill') {          // one symbol + one date per call; the dashboard loops
      if (!env.ADMIN_KEY || url.searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'bad key' }, 401);
      const symbol = (url.searchParams.get('symbol') || '').toUpperCase(), date = url.searchParams.get('date') || '';
      if (!symbols(env).includes(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad symbol or date' }, 400);
      try { return json(await processDay(env, symbol, date, Date.now())); }
      catch (e) { return json({ error: String(e.message || e) }, 502); }
    }
    return new Response('Not found', { status: 404 });
  },

  // Cron (see wrangler.toml): runs every minute on weekdays; acts 09:45-12:30 New York time.
  async scheduled(event, env) {
    if (env.BYBIT_URL) BYBIT = env.BYBIT_URL;
    const now = event.scheduledTime, n = ny(now);
    if (n.weekday === 0 || n.weekday === 6 || n.min < 9 * 60 + 45 || n.min > 12 * 60 + 30) return;
    // ponytail: free plan = 10 ms CPU per run, so each run updates a few coins in rotation (SYMBOLS_PER_RUN).
    // Results are identical, just refreshed every few minutes. On Workers Paid set SYMBOLS_PER_RUN=15.
    const all = symbols(env), k = Math.max(1, +env.SYMBOLS_PER_RUN || 3), groups = Math.ceil(all.length / k);
    const g = Math.floor(now / MIN) % groups, batch = all.slice(g * k, g * k + k);
    const results = await Promise.allSettled(batch.map(s => processDay(env, s, n.date, now)));
    const errors = results.map((r, i) => r.status === 'rejected' ? `${batch[i]}: ${r.reason?.message || r.reason}` : null).filter(Boolean);
    await setMeta(env, 'lastRun', { t: now, symbols: batch, errors });
  },
};
