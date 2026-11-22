// Deadlock Chaos — roll logic + rendering.
// Loads baked snapshots from /data and produces a random challenge loadout.

"use strict";

// --- Configuration -------------------------------------------------------

// How many of each thing a roll produces.
const ROLL = { heroes: 3, cheap: 2, medium: 2, expensive: 2 };

// Bundles mode (mode 3): offer BUNDLE_CHOICES themed bundles; the player picks 1.
// Each bundle has exactly one item from each tier in BUNDLE_TIERS.
const BUNDLE_TIERS = [1, 2, 3, 4];
const BUNDLE_CHOICES = 3;

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

// The most recent roll: { mode, poolSize, heroes: [{id, name, icon}], quests }.
// Read by js/leaderboard.js via window.DeadlockChaos.
let currentRoll = null;

// Let other scripts (the leaderboard) know when the roll or item choices change.
// Suppressed during the shuffle animation, when the board is changing rapidly.
function emit(name, detail) {
  if (isRolling) return;
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

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

  // Theme buckets for Bundles mode, grouped by tier: themes[name][tier] = [items].
  // Only keep themes that have at least one item in every bundle tier.
  const themesAll = {};
  for (const it of items) {
    for (const t of it.themes || []) {
      const byTier = (themesAll[t] = themesAll[t] || {});
      (byTier[it.tier] = byTier[it.tier] || []).push(it);
    }
  }
  const themes = {};
  for (const [name, byTier] of Object.entries(themesAll)) {
    if (BUNDLE_TIERS.every((tier) => byTier[tier] && byTier[tier].length)) themes[name] = byTier;
  }
  if (Object.keys(themes).length < BUNDLE_CHOICES) {
    console.warn(
      `Only ${Object.keys(themes).length} themes cover every tier (need ${BUNDLE_CHOICES} for Bundles mode).`
    );
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
    emit("chaos:selection");
  };
  boxes.forEach((b) => b.addEventListener("change", update));
  update();
}

// opts: { selectable: boolean, maxSelect: number, showTier: boolean }
function renderItems(container, items, opts = {}) {
  container.innerHTML = "";
  for (const it of items) {
    const card = document.createElement(opts.selectable ? "label" : "div");
    card.className = "item-card pop-in" + (opts.selectable ? " selectable" : "");
    card.dataset.slot = it.slot;
    card.dataset.itemId = it.id;
    card.dataset.tier = it.tier;

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
    const souls = it.cost != null ? `${it.cost.toLocaleString()} souls` : null;
    if (opts.showTier) cost.textContent = souls ? `T${it.tier} · ${souls}` : `Tier ${it.tier}`;
    else cost.textContent = souls || `Tier ${it.tier}`;
    meta.append(slot, cost);

    text.append(name, meta);
    card.appendChild(text);
    container.appendChild(card);
  }

  if (opts.selectable) enforceMaxSelect(container, opts.maxSelect);
}

// Build one titled item group (header + a row of item cards).
function renderItemGroup({ title, sub, hint, items, selectable = false, maxSelect = 2, showTier = false }) {
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
  renderItems(row, items, { selectable, maxSelect, showTier });

  return group;
}

// One Bundles-mode choice: a "Choose this bundle" switch above a themed item group.
function renderBundle({ name, items }) {
  const card = document.createElement("div");
  card.className = "bundle-card";

  const toggle = document.createElement("label");
  toggle.className = "bundle-toggle";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.className = "bundle-check";
  box.setAttribute("role", "switch");
  const track = document.createElement("span");
  track.className = "bundle-switch";
  track.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "bundle-toggle-label";
  label.textContent = "Choose this bundle";
  toggle.append(box, track, label);
  card.appendChild(toggle);

  const tierRange = `T${BUNDLE_TIERS[0]}–T${BUNDLE_TIERS[BUNDLE_TIERS.length - 1]}`;
  card.appendChild(renderItemGroup({ title: name, sub: `${items.length} items · ${tierRange}`, items, showTier: true }));
  return card;
}

// Only one bundle can be chosen at a time. Turning a switch off again un-chooses it.
// The chosen bundle is highlighted and the rest are dimmed.
function wireBundleToggles(container) {
  const cards = [...container.querySelectorAll(".bundle-card")];
  const boxOf = (card) => card.querySelector(".bundle-check");
  const update = (changed) => {
    if (changed.checked) {
      for (const c of cards) if (boxOf(c) !== changed) boxOf(c).checked = false;
    }
    const anyChosen = cards.some((c) => boxOf(c).checked);
    for (const c of cards) {
      const on = boxOf(c).checked;
      c.classList.toggle("chosen", on);
      c.classList.toggle("dimmed", anyChosen && !on);
      c.querySelector(".bundle-toggle-label").textContent = on ? "Bundle chosen" : "Choose this bundle";
    }
    emit("chaos:selection");
  };
  for (const c of cards) {
    const box = boxOf(c);
    box.addEventListener("change", () => update(box));
  }
}

// Render the whole items area for the given mode.
function renderItemsSection(mode) {
  els.itemsGroups.innerHTML = "";
  els.itemsGroups.classList.toggle("bundles", mode === 3);

  if (mode === 3) {
    els.itemsNote.textContent =
      `Choose 1 of ${BUNDLE_CHOICES} themed bundles — buy each item before any other of its tier.`;
    // Themes can share items, so avoid repeating an item across bundles where
    // possible (fall back to the full tier list if a tier is exhausted).
    const used = new Set();
    for (const name of sample(Object.keys(data.themes), BUNDLE_CHOICES)) {
      const byTier = data.themes[name];
      const picks = BUNDLE_TIERS.map((tier) => {
        const fresh = byTier[tier].filter((it) => !used.has(it.id));
        const it = pickOne(fresh.length ? fresh : byTier[tier]);
        used.add(it.id);
        return it;
      });
      els.itemsGroups.appendChild(renderBundle({ name, items: picks }));
    }
    wireBundleToggles(els.itemsGroups);
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
    box.addEventListener("change", () => {
      row.classList.toggle("done", box.checked);
      emit("chaos:selection");
    });
    const text = document.createElement("span");
    text.className = "sidequest-text";
    text.textContent = q;
    row.append(box, text);
    els.sidequest.appendChild(row);
  }
}

// --- Roll ----------------------------------------------------------------

function doRoll() {
  const pool = getHeroPool();
  const mode = getMode();
  const heroes = sample(pool, ROLL.heroes);
  const quests = sample(data.sidequests, getSideQuestCount());
  renderHeroes(heroes);
  renderItemsSection(mode);
  renderSidequests(quests);
  currentRoll = {
    mode,
    poolSize: pool.length,
    heroes: heroes.map(({ id, name, icon }) => ({ id, name, icon })),
    quests,
  };
}

// --- Read-only API for js/leaderboard.js --------------------------------

// The items the player must buy for the current roll, based on the mode:
//   1 = every rolled item, 2 = the 2 picked per tier, 3 = the chosen bundle.
// Returns { required, items: [{id, name, image, tier}], message? } where
// `message` explains what to do if the selection isn't complete yet.
function getRequiredItems() {
  const info = (card) => ({
    id: Number(card.dataset.itemId),
    name: card.querySelector(".item-name").textContent,
    image: card.querySelector(".item-icon").src,
    tier: Number(card.dataset.tier),
  });
  const mode = currentRoll ? currentRoll.mode : getMode();

  if (mode === 3) {
    const required = BUNDLE_TIERS.length;
    const chosen = els.itemsGroups.querySelector(".bundle-card.chosen");
    if (!chosen) return { required, items: [], message: "Choose a bundle above first." };
    return { required, items: [...chosen.querySelectorAll(".item-card")].map(info) };
  }

  if (mode === 2) {
    const groups = [...els.itemsGroups.querySelectorAll(".items-group")];
    const required = groups.length * 2;
    const picked = groups.flatMap((g) => [...g.querySelectorAll(".item-card.selected")]);
    if (picked.length < required) return { required, items: [], message: "Pick 2 items per tier above first." };
    return { required, items: picked.map(info) };
  }

  const cards = [...els.itemsGroups.querySelectorAll(".item-card")];
  return { required: cards.length, items: cards.map(info) };
}

// Side quest progress for the current roll: { done, total }.
function getQuestStatus() {
  const boxes = [...els.sidequest.querySelectorAll(".sidequest-check")];
  return { done: boxes.filter((b) => b.checked).length, total: boxes.length };
}

window.DeadlockChaos = {
  getRoll: () => currentRoll,
  getRequiredItems,
  getQuestStatus,
  imgEl,
};

// Brief "shuffle" flicker before settling on the result.
function rollWithAnimation() {
  if (getHeroPool().length < ROLL.heroes) return; // not enough heroes selected
  els.result.hidden = false;
  document.dispatchEvent(new CustomEvent("chaos:rolling"));
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
      emit("chaos:rolled", currentRoll);
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
