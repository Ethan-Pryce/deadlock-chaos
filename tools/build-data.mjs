// build-data.mjs — fetches the current Deadlock roster + items from the
// community deadlock-api, downloads every image locally into ../assets, and
// writes trimmed local snapshots (referencing the local images) into ../data.
//
// Run:  node tools/build-data.mjs
// Re-run any time to refresh the baked data after a game patch. Already-downloaded
// images are skipped; delete ../assets to force a fresh re-download.
//
// Requires Node 18+ (uses the built-in global fetch).

import { writeFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
const DATA_DIR = join(PROJECT_DIR, "data");

// Images are downloaded here and referenced from the JSON with these relative
// paths (relative to index.html at the project root).
const ASSETS_REL = "assets";
const DOWNLOAD_CONCURRENCY = 8;

const HEROES_URL = "https://api.deadlock-api.com/v1/assets/heroes";
const ITEMS_URL = "https://api.deadlock-api.com/v1/assets/items/by-type/upgrade";
const ABILITIES_URL = "https://api.deadlock-api.com/v1/assets/items/by-type/ability";

// A hero's four upgradeable abilities live under these keys in hero.items
// (signature4 is the ultimate). They map to ability class_names.
const SIGNATURE_SLOTS = ["signature1", "signature2", "signature3", "signature4"];

// Thematic buckets for "Bundles" mode. An item is tagged with every theme whose
// `pattern` matches one of its *headline* stat keys (the elevated/important stats
// the game highlights in the tooltip) — and whose `slot`, if set, matches. Using
// only headline stats (not every incidental non-zero stat) keeps the buckets
// coherent: an item with a little incidental health no longer reads as "Tanky".
// Items can belong to several themes — these are "related item" groups, not
// exclusive categories.
const THEME_DEFS = [
  { name: "Gun Damage", pattern: /WeaponPower|BaseAttackDamage|CritDamage|RicochetDamage|WeaponDamagePerStack|BonusDamagePercent|BulletSplitShot/ },
  { name: "Headshots", pattern: /HeadShot|Headshot/ },
  { name: "Fire Rate & Ammo", pattern: /FireRate|ClipSize|BulletSpeed|Reload|Ammo/ },
  { name: "Melee", pattern: /Melee/ },
  { name: "Spirit Power", pattern: /TechPower|SpiritPower|SpiritDamage|TechDamagePercent|MagicIncrease|MagicDamage/ },
  // Special case: a gun item "scales with spirit" via its scaling stat, which is
  // not a highlighted headline stat — so match against the full property set.
  { name: "Spirit-Scaling Guns", slot: "weapon", source: "all", pattern: /^SpiritPower$|^TechPower$|MagicDamage|SpiritDamage|MagicIncrease/ },
  { name: "Movement", pattern: /MoveSpeed|Movespeed|SprintSpeed|GroundDash|AirMove|Stamina|SlideScale/ },
  { name: "Health & Regen", pattern: /BonusHealth|BonusBaseHealth|HealthRegen|TotalHealthRegen|Regeneration|HealLifePercentOutOfCombat/ },
  { name: "Barriers & Shields", pattern: /Barrier|DamageThreshold|DeathImmunity/ },
  { name: "Bullet Resist", pattern: /(?<!Non)BulletResist(?!Reduction)|BuffBulletResist/ },
  { name: "Spirit Resist", pattern: /(?<!Non)TechResist(?!.*Reduction)|BuffTechResist|TechDamageReduction|TechArmorGain|SpiritDamageReduction/ },
  { name: "Resist Shred", pattern: /ArmorReduction|ResistReduction|TechPowerReduction|ArmorDamageReduction/ },
  { name: "Slows, Stuns & Disables", pattern: /(?<!Max)Slow(?!Resistance)|Stun|Disarm|EMP|Freeze/ },
  { name: "Lifesteal & Healing", pattern: /Lifesteal|HealOn|HealFrom|HealPer|Lifestrike|ParrySuccess|HealthSteal|HealingPerCast|HealPercent|LifestealHeal|HealAmpCast/ },
  { name: "Anti-Heal", pattern: /HealAmpReceive|HealAmpRegen/ },
  { name: "Cooldowns & Charges", pattern: /Cooldown|AbilityCharges|AbilityDuration/ },
  { name: "Range & Reach", pattern: /RangeMultiplier|AttackRange|Zoom|CastRange/ },
  { name: "Stacking & Farming", pattern: /PerStack|MaxStacks|MaxArmorStacks|GoldPerMinute/ },
  { name: "Proc & On-Hit", pattern: /Proc|PerChain|ExplosionDamage|ImpactDamage|DamagePulse/ },
];

// An item's "headline" stat keys: the elevated/important properties the game
// highlights in the tooltip. These define what the item is actually for.
function headlineProperties(tooltipSections) {
  const out = new Set();
  for (const section of tooltipSections || []) {
    for (const attr of section.section_attributes || []) {
      for (const p of attr.elevated_properties || []) out.add(p);
      for (const p of attr.important_properties || []) out.add(p);
    }
  }
  return [...out];
}

// Every non-zero stat key (used by themes that key off a scaling stat rather than
// a highlighted one).
function allProperties(properties) {
  const out = [];
  for (const [key, prop] of Object.entries(properties || {})) {
    const value = prop && typeof prop === "object" ? prop.value : prop;
    const disabled = prop && typeof prop === "object" && prop.disabled === true;
    const num = parseFloat(value);
    if (!disabled && !Number.isNaN(num) && num !== 0) out.push(key);
  }
  return out;
}

function themesForItem(rawItem) {
  const headline = headlineProperties(rawItem.tooltip_sections);
  const all = allProperties(rawItem.properties);
  return THEME_DEFS.filter((t) => {
    if (t.slot && t.slot !== rawItem.item_slot_type) return false;
    const keys = t.source === "all" ? all : headline;
    return keys.some((k) => t.pattern.test(k));
  }).map((t) => t.name);
}

// Items priced at this sentinel cost are the "legendary" items for a limited
// game mode — exclude them from the normal roll.
const LEGENDARY_COST = 9999;

// The deadlock-api item icons lag behind the game, so we pull current icons from
// the community wiki (MediaWiki) via its imageinfo API, in batches.
const WIKI_API = "https://deadlock.wiki/api.php";
const WIKI_ICON_WIDTH = 96;
const WIKI_BATCH = 50;

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "deadlock-chaos/1.0" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

// Resolve current item icon URLs from the wiki by item name (File:<Name>.png).
// Mutates each item's `image` to the wiki thumbnail when one is found, leaving
// the deadlock-api image as a fallback otherwise.
async function attachWikiIcons(items) {
  const fileTitle = (name) => "File:" + name.replace(/ /g, "_") + ".png";
  let resolved = 0;
  const missing = [];

  for (let i = 0; i < items.length; i += WIKI_BATCH) {
    const batch = items.slice(i, i + WIKI_BATCH);
    const titles = batch.map((it) => fileTitle(it.name)).join("|");
    const url =
      `${WIKI_API}?action=query&format=json&redirects=1&prop=imageinfo` +
      `&iiprop=url&iiurlwidth=${WIKI_ICON_WIDTH}&titles=${encodeURIComponent(titles)}`;
    const data = await getJson(url);

    // Map (possibly normalized/redirected) returned titles back to our items.
    const byTitle = new Map(batch.map((it) => [fileTitle(it.name), it]));
    const aliasToOriginal = new Map();
    for (const n of data.query.normalized || []) aliasToOriginal.set(n.to, n.from);
    for (const r of data.query.redirects || []) aliasToOriginal.set(r.to, r.from);
    const trace = (title) => {
      let t = title;
      while (aliasToOriginal.has(t)) t = aliasToOriginal.get(t);
      return t;
    };

    for (const page of Object.values(data.query.pages)) {
      const original = trace(page.title);
      const item = byTitle.get(original);
      const thumb = page.imageinfo && page.imageinfo[0] && page.imageinfo[0].thumburl;
      if (item && thumb) {
        item.image = thumb;
        resolved++;
      } else {
        missing.push(page.title);
      }
    }
  }

  console.log(`wiki icons resolved: ${resolved}/${items.length}`);
  if (missing.length) console.warn(`wiki icons missing (kept api fallback): ${missing.join(", ")}`);
  return items;
}

function pickImage(images, ...keys) {
  if (!images) return null;
  for (const k of keys) if (images[k]) return images[k];
  return null;
}

async function buildHeroes() {
  const [raw, abilities] = await Promise.all([getJson(HEROES_URL), getJson(ABILITIES_URL)]);
  const abilityByClass = new Map(abilities.map((a) => [a.class_name, a]));

  const heroes = raw
    // Only `disabled` marks unreleased/placeholder heroes. `in_development` lags
    // behind releases (e.g. Violet and Baba stayed flagged after launching).
    .filter((h) => h && h.disabled === false && h.name)
    .map((h) => {
      // Resolve the four signature abilities (slot index 4 = ultimate).
      const abilities = SIGNATURE_SLOTS.map((slot, i) => {
        const ab = abilityByClass.get(h.items?.[slot]);
        if (!ab) return null;
        return {
          name: ab.name,
          image: ab.image_webp || ab.image || null,
          ultimate: i === 3,
        };
      }).filter(Boolean);

      return {
        id: h.id,
        name: h.name,
        icon: pickImage(h.images, "icon_hero_card_webp", "icon_hero_card", "icon_image_small_webp"),
        background: pickImage(h.images, "background_image_webp", "background_image"),
        abilities,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return heroes;
}

async function buildItems() {
  const raw = await getJson(ITEMS_URL);
  const items = raw
    .filter(
      (it) =>
        it &&
        it.shopable === true && // shopable === false are the disabled/non-purchasable ones
        it.cost !== LEGENDARY_COST && // skip limited-mode legendary items
        it.name &&
        typeof it.item_tier === "number" &&
        it.item_slot_type &&
        (!Array.isArray(it.heroes) || it.heroes.length === 0) // skip hero-locked items
    )
    .map((it) => ({
      id: it.id,
      name: it.name,
      tier: it.item_tier,
      cost: it.cost ?? null,
      slot: it.item_slot_type, // "weapon" | "vitality" | "spirit"
      image: it.image_webp || it.image || null,
      themes: themesForItem(it), // related-item buckets for Bundles mode
    }))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));
  await attachWikiIcons(items);
  return items;
}

// --- Local image download ------------------------------------------------

async function fileExists(absPath) {
  try {
    return (await stat(absPath)).size > 0;
  } catch {
    return false;
  }
}

// Download one image to a local path (skips if it already exists).
async function downloadImage(url, relPath) {
  const abs = join(PROJECT_DIR, relPath);
  if (await fileExists(abs)) return; // already have it
  await mkdir(dirname(abs), { recursive: true });
  const res = await fetch(url, { headers: { "user-agent": "deadlock-chaos/1.0" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  await writeFile(abs, Buffer.from(await res.arrayBuffer()));
}

// Run async jobs with a fixed concurrency; collects failures rather than throwing.
async function runPool(jobs, worker, concurrency) {
  let index = 0;
  let failed = 0;
  async function worker_loop() {
    while (index < jobs.length) {
      const job = jobs[index++];
      try {
        await worker(job);
      } catch (err) {
        failed++;
        console.warn(`image failed: ${job.url} (${err.message})`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker_loop));
  return { failed };
}

// Download every hero/item/ability image locally and rewrite the data objects to
// reference the local relative paths. Downloads that fail keep their remote URL
// as a fallback so the app still shows something.
async function localizeImages(heroes, items) {
  const jobs = []; // { url, rel, assign(localRelPath) }
  const add = (url, rel, assign) => {
    if (url) jobs.push({ url, rel, assign });
  };

  for (const it of items) {
    add(it.image, `${ASSETS_REL}/items/${it.id}.webp`, (p) => (it.image = p));
  }
  for (const h of heroes) {
    add(h.icon, `${ASSETS_REL}/heroes/${h.id}.webp`, (p) => (h.icon = p));
    add(h.background, `${ASSETS_REL}/heroes/${h.id}-bg.webp`, (p) => (h.background = p));
    for (const ab of h.abilities || []) {
      const base = ab.image ? ab.image.split("/").pop().split("?")[0] : null;
      if (base) add(ab.image, `${ASSETS_REL}/abilities/${base}`, (p) => (ab.image = p));
    }
  }

  // Download each distinct target path once.
  const uniqueByRel = [...new Map(jobs.map((j) => [j.rel, j])).values()];
  const { failed } = await runPool(uniqueByRel, (job) => downloadImage(job.url, job.rel), DOWNLOAD_CONCURRENCY);

  // Point every field at its local file (only if the file actually exists).
  for (const job of jobs) {
    if (await fileExists(join(PROJECT_DIR, job.rel))) job.assign(job.rel);
  }

  console.log(`images: ${uniqueByRel.length} targets, ${failed} failed`);
}

function tierSummary(items) {
  const by = {};
  for (const it of items) {
    by[it.tier] ??= { weapon: 0, vitality: 0, spirit: 0, total: 0 };
    by[it.tier][it.slot] = (by[it.tier][it.slot] || 0) + 1;
    by[it.tier].total++;
  }
  return by;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [heroes, items] = await Promise.all([buildHeroes(), buildItems()]);

  // Download all images locally and rewrite image fields to local paths.
  await localizeImages(heroes, items);

  await writeFile(join(DATA_DIR, "heroes.json"), JSON.stringify(heroes, null, 2) + "\n");
  await writeFile(join(DATA_DIR, "items.json"), JSON.stringify(items, null, 2) + "\n");

  const themeCounts = {};
  for (const it of items) for (const t of it.themes) themeCounts[t] = (themeCounts[t] || 0) + 1;

  console.log(`heroes: ${heroes.length}`);
  console.log(`items:  ${items.length}`);
  console.log("items by tier/slot:", JSON.stringify(tierSummary(items), null, 2));
  console.log("theme bucket sizes:", JSON.stringify(themeCounts, null, 2));
}

main().catch((err) => {
  console.error("build-data failed:", err.message);
  process.exit(1);
});
