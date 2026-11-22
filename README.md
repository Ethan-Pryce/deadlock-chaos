# Deadlock Chaos

A tiny static website that rolls a random **challenge loadout** for the game
[Deadlock](https://store.steampowered.com/app/1422450/Deadlock/): **3 heroes**, a
random **"max-first" ability** per hero, a set of **items** across the tiers, and
**1–5 side quests**. Pick one of the three heroes and build toward the items while
completing the quests.

### Ways to play

- **Mode 1 — Locked Loadout:** you get exactly 2 items per tier; build those.
- **Mode 2 — Pick Your Build:** you get 3 items per tier and tick the 2 you want.
- **Mode 3 — Bundles:** you're offered 3 random *themed* bundles (e.g. "Melee",
  "Resist Shred"). Each has 4 items, one from each tier (T1–T4). Flip the
  "Choose this bundle" switch on the one you want to build.
- **Side quests:** choose how many to roll (1–5); tick each off as you finish it.
- **Hero pool:** open the "Hero pool" panel to choose which heroes the random 3 are
  drawn from (anywhere from 3 up to the whole cast). The roll button is disabled until
  at least 3 are selected.

The core rule across all modes: **you must buy each rolled item before any other
(non-rolled) item of the same tier.** A set's items may span different tiers and costs.

## Running it

The page loads its data with `fetch()`, which browsers block over `file://`. So
serve the folder over HTTP:

```bash
npx serve .
# or: python -m http.server
# or: VS Code "Live Server" extension
```

Then open the printed URL (e.g. http://localhost:3000).

## Leaderboard

After a match, fill in the **Finish & Submit** card under your roll:
- the hero you played
- which mandatory items you bought
- side quests, read from the ticks in the Side Quests list (unticked ones count as failed)
- Win / Loss
- your name

The page previews the score. The server recalculates it using the same rules:
+1 per hero in your pool, +3 per item bought, +10 per quest done, −5 per quest failed.
Win/Loss is shown but doesn't affect the score.

The board is shared online. A Vercel serverless function (`api/scores.js`) stores
each run as its own small JSON file in a **private Vercel Blob store**
(`deadlock-chaos-blob`) under `scores/`, and returns
the whole board as one JSON list. Runs are only ever added as new files, so
simultaneous submissions can't overwrite each other.

**One-time setup (Vercel dashboard):**

1. Open the Vercel project (`deadlock-chaos-nu96`) → **Storage** → **Create** → **Blob**.
2. Connect the store to the project. This sets `BLOB_STORE_ID`, and `@vercel/blob`
   signs in with the deployment's automatic OIDC token. Older stores set
   `BLOB_READ_WRITE_TOKEN` instead; both work.
3. Redeploy (or just push a commit).

The function writes with `access: "private"` (the `ACCESS` constant in
`api/scores.js`). If you ever switch to a public store, change that constant to match.

**GitHub Pages:** the GitHub Pages copy works too. It calls the Vercel API
(`LEADERBOARD_API` at the top of `js/leaderboard.js`).

**Running locally with the leaderboard:** plain `npx serve` shows "Leaderboard
unavailable" because it can't run the function. Use the Vercel CLI instead:

```bash
npm i -g vercel
vercel link        # pick the deadlock-chaos-nu96 project
vercel env pull    # writes BLOB_STORE_ID + a short-lived VERCEL_OIDC_TOKEN to .env.local
vercel dev
```

`BLOB_STORE_ID` is only pulled if the store's connection includes the
**Development** environment. Tick it under the project's Storage →
deadlock-chaos-blob → connection settings. The local OIDC token expires after about 12 hours. Re-run `vercel env pull` if the
leaderboard stops working locally.

Note that `vercel dev` writes to the same Blob store as the live site.

**Removing a score:** in the Vercel dashboard open the Blob store's file browser
and delete the matching `scores/*.json` file.

## Refreshing the game data

Hero and item data is baked into `data/heroes.json` and `data/items.json` from the
community [deadlock-api](https://deadlock-api.com). Deadlock changes every patch,
so re-run the generator to refresh:

```bash
node tools/build-data.mjs
```

It fetches the current roster + shopable upgrade items, trims them to the fields the
site needs, **downloads every hero/item/ability image into `assets/`**, and rewrites
the JSON to point at those local files. Requires Node 18+.

Images already on disk are skipped, so re-running is fast. To force a fresh image
re-download (e.g. after a visual update), delete the `assets/` folder first.

> Note: the bundled images are ~64 MB, almost all of it the full-resolution hero
> background art. If you want a smaller footprint, delete `assets/heroes/*-bg.webp`
> (the card backdrops) — the app falls back to a placeholder and still looks fine.

## Customizing

- **Side quests:** edit `data/sidequests.json` — it's a plain array of strings, add
  your own freely. How many roll at once (1–5) is chosen in the UI.
- **Roll counts:** edit the `ROLL` constant at the top of `js/app.js` (hero count and
  the per-tier item count for Mode 1 / the "pick from" pool size logic in `doRoll`).
- **Price buckets:** edit the `TIER_BUCKET` map in `js/app.js`. Purchasable items have
  tiers 1–4; the default is cheap = T1, medium = T2–3, expensive = T4. (Tier-5
  "legendary" items are a limited mode and are excluded by `build-data.mjs`.)
- **Bundle themes:** edit `THEME_DEFS` in `tools/build-data.mjs` and re-run it. Each
  theme tags items whose non-zero stat properties match its `keys` (optionally
  restricted to a `slot`). The build logs each theme's item count. A theme only
  shows up in Bundles mode if it has at least one item in every tier
  (`BUNDLE_TIERS` in `js/app.js`); `BUNDLE_CHOICES` sets how many bundles are offered.

## Notes

- Everything is local: data **and** images are served from this project, so the site
  works fully offline and never pings the wiki/CDN at runtime. The generator sources
  item icons from the [Deadlock Wiki](https://deadlock.wiki/Items) (the deadlock-api
  item icons lag behind the game) and hero/ability art from deadlock-api, then saves
  them under `assets/`. If an image is ever missing it falls back to a placeholder.
- Not affiliated with Valve. Deadlock assets belong to Valve.

## Project layout

```
index.html              # markup
favicon.svg             # site icon (roulette wheel with an eye hub)
favicon-32.png          # PNG fallback icon
apple-touch-icon.png    # 180px home-screen icon
css/styles.css          # theme + layout + animations
js/app.js               # data loading, roll logic, rendering
js/leaderboard.js       # score card + leaderboard UI (talks to api/scores.js)
api/scores.js           # Vercel function: GET/POST leaderboard, stored in Vercel Blob
api/_score.js           # shared validation + score rules (not exposed as an endpoint)
package.json            # @vercel/blob dependency for the function
data/heroes.json        # baked snapshot (local image paths)
data/items.json         # baked snapshot (local image paths)
data/sidequests.json    # curated challenge list
assets/items/           # item icons (<id>.webp)
assets/heroes/          # hero portraits + backgrounds (<id>.webp, <id>-bg.webp)
assets/abilities/       # ability icons
tools/build-data.mjs    # regenerates snapshots + downloads images
```
