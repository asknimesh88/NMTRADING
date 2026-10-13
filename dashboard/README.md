# ORB Paper Trades dashboard (Cloudflare)

A Cloudflare Worker that paper-trades the ORB breakout-retest strategy on Bybit 1-minute data
for up to 15 USDT perpetuals, stores every trade in a D1 database, and serves a dashboard.
No exchange API key needed: it only reads public price data and never places orders.

- `src/strategy.js`: JavaScript copy of `orb_retest_strategy.pine` (default settings). Settings are in `P` at the top.
- `src/index.js`: runs every minute 09:45–12:30 New York time on weekdays, plus the dashboard API.
- `src/dashboard.html`: the dashboard page.

## Deploy (about 10 minutes)

You need Node.js (LTS) installed and a free Cloudflare account. Open a terminal in this folder:

1. `npm install`
2. `npx wrangler login` (opens the browser to approve)
3. `npx wrangler d1 create orb-dashboard`
   Copy the `database_id` it prints into `wrangler.toml`, replacing `PASTE-YOUR-DATABASE-ID-HERE`.
4. `npx wrangler d1 execute orb-dashboard --remote --file=schema.sql`
5. Edit `SYMBOLS` in `wrangler.toml`: up to 15 Bybit USDT perpetual names, comma separated (e.g. `BTCUSDT,ETHUSDT`).
6. `npx wrangler deploy`
   It prints your dashboard URL, like `https://orb-dashboard.<your-name>.workers.dev`.
7. `npx wrangler secret put ADMIN_KEY` and type a password of your choice. It's only used for the backfill button.
8. Open the URL, expand **Backfill history**, enter the admin key and run 20 trading days. That fills the dashboard with past results straight away.

After that it updates on its own every weekday during the NY morning session.

## Good to know

- **Free plan:** each run may use only 10 ms of CPU, so each run updates 3 coins in rotation
  (`SYMBOLS_PER_RUN`). With 15 coins each coin refreshes about every 5 minutes; final results are the same.
  On Workers Paid, set `SYMBOLS_PER_RUN = "15"` for minute-by-minute updates.
- **Data errors:** if the dashboard header shows errors such as `Bybit HTTP 403`, Bybit refused requests
  from Cloudflare's servers. Send the message over and we'll switch the data source.
- **Private dashboard:** anyone with the URL can view it. To lock it to your email, add the URL under
  Cloudflare Zero Trust → Access → Applications (free).
- **Changing strategy settings:** change them in both the Pine script and `P` in `src/strategy.js`,
  then `npx wrangler deploy` and re-run the backfill.
- **Results are in R** (multiples of the risk per trade) after Bybit taker fees of 0.055% per side (`feePct`).
- `npm test` runs the strategy checks.

## Deploy straight from GitHub (no terminal)

1. Cloudflare dashboard → **Storage & Databases → D1 → Create** a database named `orb-dashboard`.
   Open it → **Console**, paste the contents of `schema.sql`, run it. Copy its database ID into
   `dashboard/wrangler.toml` on GitHub (replace `PASTE-YOUR-DATABASE-ID-HERE`) and commit.
2. **Workers & Pages → Create → Import a repository** → pick `NMTRADING`, set **Root directory** to `dashboard`, deploy.
3. In the new Worker → **Settings → Variables and Secrets** → add a **Secret** `ADMIN_KEY` with a password of your choice.
4. Open the Worker's URL and run **Backfill history**.

Every push to `main` redeploys automatically.
