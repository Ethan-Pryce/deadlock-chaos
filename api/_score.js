// Shared leaderboard rules: input validation + score calculation.
// Files starting with "_" inside /api are not exposed as Vercel functions, so this
// is just a module imported by api/scores.js (and by local tests).

// Required items per mode. Keep in sync with js/app.js:
//   1 = Locked Loadout  -> ROLL.cheap + ROLL.medium + ROLL.expensive (2+2+2)
//   2 = Pick Your Build -> 2 picks x 3 tiers
//   3 = Bundles         -> BUNDLE_TIERS.length (one item per tier 1-4)
export const ITEMS_REQUIRED = { 1: 6, 2: 6, 3: 4 };

export const NAME_MAX = 24;
export const MAX_QUESTS = 5;
export const MIN_POOL = 3;
export const MAX_POOL = 60; // generous upper bound; the roster is ~44 today

// Score rules (shown on the page under "The Rules"):
//   +1 per hero left in the pool, +3 per rolled item bought,
//   +10 per side quest completed, -5 per side quest failed.
// Win/loss is recorded for display only.
export function computeScore({ poolSize, itemsBought, questsDone, questsFailed }) {
  return poolSize + itemsBought * 3 + questsDone * 10 - questsFailed * 5;
}

const isInt = (v) => Number.isInteger(v);

function cleanText(v, max) {
  if (typeof v !== "string") return null;
  // Turn newlines/tabs into spaces, drop other control characters, collapse whitespace.
  const s = v.replace(/\s+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/ +/g, " ").trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

// Returns { ok: true, entry } with a cleaned entry (score computed here — any
// client-sent score is ignored), or { ok: false, error }.
export function validate(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };

  const name = cleanText(body.name, NAME_MAX);
  if (!name) return { ok: false, error: `Name must be 1-${NAME_MAX} characters.` };

  const mode = body.mode;
  if (!isInt(mode) || !(mode in ITEMS_REQUIRED)) return { ok: false, error: "Mode must be 1, 2 or 3." };

  const heroId = body.heroId;
  if (!isInt(heroId) || heroId <= 0) return { ok: false, error: "Invalid hero." };
  const heroName = cleanText(body.heroName, 40);
  if (!heroName) return { ok: false, error: "Invalid hero name." };

  if (typeof body.win !== "boolean") return { ok: false, error: "Pick Win or Loss." };

  const { poolSize, itemsBought, itemsRequired, questsDone, questsFailed } = body;
  if (!isInt(poolSize) || poolSize < MIN_POOL || poolSize > MAX_POOL) {
    return { ok: false, error: `Hero pool size must be ${MIN_POOL}-${MAX_POOL}.` };
  }
  if (itemsRequired !== ITEMS_REQUIRED[mode]) {
    return { ok: false, error: `Mode ${mode} has ${ITEMS_REQUIRED[mode]} required items.` };
  }
  if (!isInt(itemsBought) || itemsBought < 0 || itemsBought > itemsRequired) {
    return { ok: false, error: "Items bought is out of range." };
  }
  if (!isInt(questsDone) || !isInt(questsFailed) || questsDone < 0 || questsFailed < 0) {
    return { ok: false, error: "Side quest counts are invalid." };
  }
  const quests = questsDone + questsFailed;
  if (quests < 1 || quests > MAX_QUESTS) {
    return { ok: false, error: `You must have 1-${MAX_QUESTS} side quests.` };
  }

  const entry = {
    name,
    mode,
    heroId,
    heroName,
    win: body.win,
    poolSize,
    itemsBought,
    itemsRequired,
    questsDone,
    questsFailed,
  };
  entry.score = computeScore(entry);
  return { ok: true, entry };
}

// Basic shape check for entries read back from storage.
export function isStoredEntry(e) {
  return (
    e &&
    typeof e === "object" &&
    typeof e.id === "string" &&
    typeof e.name === "string" &&
    Number.isFinite(e.score) &&
    typeof e.date === "string"
  );
}

// Highest score first; ties go to the most recent run.
export function sortEntries(entries) {
  return entries.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
}
