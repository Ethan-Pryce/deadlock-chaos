// Deadlock Chaos — roll logic + rendering.
// Loads baked snapshots from /data and produces a random challenge loadout.

"use strict";

// --- Configuration -------------------------------------------------------

// How many of each thing a roll produces.
const ROLL = { heroes: 3, cheap: 2, medium: 2, expensive: 2 };

// Bundles mode (mode 3): pick BUNDLE_SETS themed sets of BUNDLE_SIZE items each.
const BUNDLE_SIZE = 3;
const BUNDLE_SETS = 2;

// Tier (1-4) -> price bucket. Easy to tweak.
// (Tier 5 "legendary" items are excluded from the baked data — limited mode only.)
const TIER_BUCKET = {
  1: "cheap",
  2: "medium",
  3: "medium",
  4: "expensive",
};

const PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#221d31"/>' +
      '<text x="32" y="38" font-size="28" fill="#9a90b4" text-anchor="middle" font-family="sans-serif">?</text>' +
      "</svg>"
  );

// --- State ---------------------------------------------------------------

let data = { heroes: [], buckets: { cheap: [], medium: [], expensive: [] }, themes: {}, sidequests: [] };

const els = {
  rollBtn: document.getElementById("rollBtn"),
  status: document.getElementById("status"),
  result: document.getElementById("result"),
  heroes: document.getElementById("heroes"),
  itemsGroups: document.getElementById("itemsGroups"),
  itemsNote: document.getElementById("itemsNote"),
  sidequest: document.getElementById("sidequest"),
  sqCount: document.getElementById("sqCount"),
  poolGrid: document.getElementById("poolGrid"),
  poolCount: document.getElementById("poolCount"),
  poolTotal: document.getElementById("poolTotal"),
  poolHint: document.getElementById("poolHint"),
  poolAll: document.getElementById("poolAll"),
  poolNone: document.getElementById("poolNone"),
};

// True while a roll animation is in progress (keeps the button disabled).
let isRolling = false;

// --- Options (read from the controls) ------------------------------------

// Mode 1 = "Locked Loadout" (2 fixed items per tier).
// Mode 2 = "Pick Your Build" (3 items per tier, you check 2).
// Mode 3 = "Bundles" (3 items from each of 2 random themed sets).
function getMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  const v = checked ? parseInt(checked.value, 10) : 1;
  return [1, 2, 3].includes(v) ? v : 1;
}

function getSideQuestCount() {
  const v = parseInt(els.sqCount.value, 10);
  if (Number.isNaN(v)) return 1;
  return Math.min(5, Math.max(1, v));
}

// --- Hero pool -----------------------------------------------------------

// Build the toggle grid (one chip per hero, all selected by default).
function populateHeroPool() {
  els.poolGrid.innerHTML = "";
  for (const hero of data.heroes) {
    const chip = document.createElement("label");
    chip.className = "pool-chip";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "pool-check";
    box.checked = true;
    box.dataset.heroId = hero.id;
    box.addEventListener("change", () => {
      chip.classList.toggle("on", box.checked);
      updatePoolState();
    });

    chip.appendChild(box);
    chip.appendChild(imgEl(hero.icon, "pool-icon"));
    const name = document.createElement("span");
    name.className = "pool-name";
    name.textContent = hero.name;
    chip.appendChild(name);

    chip.classList.add("on");
    els.poolGrid.appendChild(chip);
  }
  els.poolTotal.textContent = data.heroes.length;
}

// The heroes currently eligible to be rolled.
function getHeroPool() {
  const ids = new Set(
    [...els.poolGrid.querySelectorAll(".pool-check:checked")].map((b) => Number(b.dataset.heroId))
  );
  return data.heroes.filter((h) => ids.has(h.id));
}

function setAllHeroes(checked) {
  for (const box of els.poolGrid.querySelectorAll(".pool-check")) {
    box.checked = checked;
    box.closest(".pool-chip").classList.toggle("on", checked);
  }
  updatePoolState();
}

// Update the count + roll availability whenever the pool changes.
function updatePoolState() {
  const n = getHeroPool().length;
  els.poolCount.textContent = n;
  const ok = n >= ROLL.heroes;
  els.poolHint.textContent = ok ? "" : `Pick at least ${ROLL.heroes} heroes`;
  refreshRollAvailability();
}

// The roll button is enabled only when not mid-roll and the pool is big enough.
function refreshRollAvailability() {
  els.rollBtn.disabled = isRolling || getHeroPool().length < ROLL.heroes;
}

// --- Helpers -------------------------------------------------------------

// Fisher–Yates shuffle (returns a new array).
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Sample up to n distinct elements from arr.
function sample(arr, n) {
  if (arr.length <= n) return shuffle(arr);
  return shuffle(arr).slice(0, n);
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function imgEl(src, className) {
  const img = document.createElement("img");
  img.className = className;
  img.loading = "lazy";
  img.src = src || PLACEHOLDER;
  img.addEventListener("error", () => {
    if (img.src !== PLACEHOLDER) img.src = PLACEHOLDER;
  });
  return img;
}

// --- Data loading --------------------------------------------------------

async function loadData() {
  const [heroes, items, sidequests] = await Promise.all([
    fetch("data/heroes.json").then((r) => r.json()),
    fetch("data/items.json").then((r) => r.json()),
    fetch("data/sidequests.json").then((r) => r.json()),
  ]);

  const buckets = { cheap: [], medium: [], expensive: [] };
  for (const it of items) {
    const bucket = TIER_BUCKET[it.tier];
    if (bucket) buckets[bucket].push(it);
  }

  // Theme buckets for Bundles mode — only keep themes with enough items to fill
  // a bundle of 3.
  const themesAll = {};
  for (const it of items) {
    for (const t of it.themes || []) (themesAll[t] = themesAll[t] || []).push(it);
  }
  const themes = {};
  for (const [name, list] of Object.entries(themesAll)) {
    if (list.length >= BUNDLE_SIZE) themes[name] = list;
  }

  data = { heroes, buckets, themes, sidequests };

  // Warn (console only) if any bucket is too thin to satisfy a roll.
  for (const [bucket, need] of [
    ["cheap", ROLL.cheap],
    ["medium", ROLL.medium],
    ["expensive", ROLL.expensive],
  ]) {
    if (buckets[bucket].length < need) {
      console.warn(`Bucket "${bucket}" has only ${buckets[bucket].length} items (need ${need}).`);
    }
  }
  if (heroes.length < ROLL.heroes) {
    console.warn(`Only ${heroes.length} heroes available (need ${ROLL.heroes}).`);
  }
}

// --- Rendering -----------------------------------------------------------

// Random ability to "max first" — chosen from the hero's non-ultimate abilities.
function pickMaxFirstAbility(hero) {
  const abilities = hero.abilities || [];
  const pool = abilities.filter((a) => !a.ultimate);
  const list = pool.length ? pool : abilities;
  return list.length ? pickOne(list) : null;
}

function renderHeroes(heroes) {
  els.heroes.innerHTML = "";
  for (const hero of heroes) {
    const card = document.createElement("div");
    card.className = "hero-card pop-in";

    if (hero.background) card.appendChild(imgEl(hero.background, "hero-bg"));
    card.appendChild(imgEl(hero.icon, "hero-portrait"));

    const ability = pickMaxFirstAbility(hero);
    if (ability) {
      const badge = document.createElement("div");
      badge.className = "hero-ability";
      badge.appendChild(imgEl(ability.image, "ability-icon"));
      const text = document.createElement("div");
      text.className = "ability-text";
      const label = document.createElement("span");
      label.className = "ability-label";
      label.textContent = "Max first";
      const aname = document.createElement("span");
      aname.className = "ability-name";
      aname.textContent = ability.name;
      text.append(label, aname);
      badge.appendChild(text);
      card.appendChild(badge);
    }

    const name = document.createElement("div");
    name.className = "hero-name";
    name.textContent = hero.name;
    card.appendChild(name);

    els.heroes.appendChild(card);
  }
}

// When a group reaches its selection cap, lock the remaining checkboxes so the
// user can only ever have `max` items chosen (they can uncheck to swap).
function enforceMaxSelect(container, max) {
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  const update = () => {
    const checked = boxes.filter((b) => b.checked);
    const atCap = checked.length >= max;
    for (const b of boxes) {
      b.disabled = atCap && !b.checked;
      b.closest(".item-card").classList.toggle("selected", b.checked);
    }
  };
  boxes.forEach((b) => b.addEventListener("change", update));
  update();
}

// opts: { selectable: boolean, maxSelect: number }
function renderItems(container, items, opts = {}) {
  container.innerHTML = "";
  for (const it of items) {
    const card = document.createElement(opts.selectable ? "label" : "div");
    card.className = "item-card pop-in" + (opts.selectable ? " selectable" : "");
    card.dataset.slot = it.slot;

    if (opts.selectable) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "item-check";
      card.appendChild(box);
    }

    card.appendChild(imgEl(it.image, "item-icon"));

    const text = document.createElement("div");
    text.className = "item-text";

    const name = document.createElement("div");
    name.className = "item-name";
    name.textContent = it.name;

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const slot = document.createElement("span");
    slot.className = "item-slot-tag";
    slot.textContent = it.slot;
    const cost = document.createElement("span");
    cost.className = "item-cost";
    cost.textContent = it.cost != null ? `${it.cost.toLocaleString()} souls` : `Tier ${it.tier}`;
    meta.append(slot, cost);

    text.append(name, meta);
    card.appendChild(text);
    container.appendChild(card);
  }

  if (opts.selectable) enforceMaxSelect(container, opts.maxSelect);
}

// Build one titled item group (header + a row of item cards).
function renderItemGroup({ title, sub, hint, items, selectable = false, maxSelect = 2 }) {
  const group = document.createElement("div");
  group.className = "items-group";

  const heading = document.createElement("h3");
  heading.className = "group-title";
  heading.append(document.createTextNode(title + " "));
  if (sub) {
    const s = document.createElement("span");
    s.className = "group-sub";
    s.textContent = sub;
    heading.appendChild(s);
  }
  if (hint) {
    const h = document.createElement("span");
    h.className = "group-hint";
    h.textContent = "· " + hint;
    heading.appendChild(h);
  }
  group.appendChild(heading);

  const row = document.createElement("div");
  row.className = "items-row";
  group.appendChild(row);
  renderItems(row, items, { selectable, maxSelect });

  return group;
}

// Render the whole items area for the given mode.
function renderItemsSection(mode) {
  els.itemsGroups.innerHTML = "";
  els.itemsGroups.classList.toggle("bundles", mode === 3);

  if (mode === 3) {
    els.itemsNote.textContent = "Two random themed sets — buy each item before any other of its tier.";
    const used = new Set();
    let remainingThemes = Object.keys(data.themes);
    for (let s = 0; s < BUNDLE_SETS && remainingThemes.length; s++) {
      // Prefer themes that still have enough not-yet-used items so overlapping
      // themes can't starve a later set below BUNDLE_SIZE.
      const unused = (name) => data.themes[name].filter((it) => !used.has(it.id));
      const viable = remainingThemes.filter((name) => unused(name).length >= BUNDLE_SIZE);
      const name = pickOne(viable.length ? viable : remainingThemes);
      remainingThemes = remainingThemes.filter((n) => n !== name);
      const picks = sample(unused(name), BUNDLE_SIZE);
      picks.forEach((it) => used.add(it.id));
      els.itemsGroups.appendChild(renderItemGroup({ title: name, sub: `${picks.length} items`, items: picks }));
    }
    return;
  }

  const selectable = mode === 2;
  const perTier = mode === 2 ? 3 : 2;
  els.itemsNote.textContent = selectable
    ? "Pick 2 of 3 per tier — buy them before any other item of that tier."
    : "Buy these before any other item of the same tier.";

  const tiers = [
    { key: "cheap", title: "Cheap", sub: "Tier 1" },
    { key: "medium", title: "Medium", sub: "Tier 2–3" },
    { key: "expensive", title: "Expensive", sub: "Tier 4" },
  ];
  for (const t of tiers) {
    els.itemsGroups.appendChild(
      renderItemGroup({
        title: t.title,
        sub: t.sub,
        hint: selectable ? "pick 2 of 3" : null,
        items: sample(data.buckets[t.key], perTier),
        selectable,
        maxSelect: 2,
      })
    );
  }
}

function renderSidequests(quests) {
  els.sidequest.innerHTML = "";
  for (const q of quests) {
    const row = document.createElement("label");
    row.className = "sidequest-row pop-in";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "sidequest-check";
    box.addEventListener("change", () => row.classList.toggle("done", box.checked));
    const text = document.createElement("span");
    text.className = "sidequest-text";
    text.textContent = q;
    row.append(box, text);
    els.sidequest.appendChild(row);
  }
}

// --- Roll ----------------------------------------------------------------

function doRoll() {
  renderHeroes(sample(getHeroPool(), ROLL.heroes));
  renderItemsSection(getMode());
  renderSidequests(sample(data.sidequests, getSideQuestCount()));
}

// Brief "shuffle" flicker before settling on the result.
function rollWithAnimation() {
  if (getHeroPool().length < ROLL.heroes) return; // not enough heroes selected
  els.result.hidden = false;
  isRolling = true;
  els.rollBtn.disabled = true;
  els.rollBtn.classList.add("rolling");

  const allCards = [els.heroes, els.itemsGroups, els.sidequest];
  allCards.forEach((c) => c.classList.add("shuffling"));

  // Cycle a few quick random previews for a slot-machine feel.
  let ticks = 0;
  const interval = setInterval(() => {
    doRoll();
    if (++ticks >= 6) {
      clearInterval(interval);
      allCards.forEach((c) => c.classList.remove("shuffling"));
      doRoll(); // final settle
      isRolling = false;
      refreshRollAvailability();
      els.rollBtn.classList.remove("rolling");
      els.rollBtn.querySelector(".roll-btn-label").textContent = "ROLL AGAIN";
    }
  }, 80);
}

// --- Init ----------------------------------------------------------------

(async function init() {
  try {
    await loadData();
    populateHeroPool();
    updatePoolState();
    els.status.textContent =
      `Ready — ${data.heroes.length} heroes, ` +
      `${data.buckets.cheap.length + data.buckets.medium.length + data.buckets.expensive.length} items loaded.`;
    els.rollBtn.addEventListener("click", rollWithAnimation);
    els.poolAll.addEventListener("click", () => setAllHeroes(true));
    els.poolNone.addEventListener("click", () => setAllHeroes(false));
  } catch (err) {
    console.error(err);
    els.status.textContent =
      "Failed to load game data. Serve this folder over http (e.g. `npx serve`) rather than opening the file directly.";
    els.status.classList.add("error");
    els.rollBtn.disabled = true;
  }
})();
