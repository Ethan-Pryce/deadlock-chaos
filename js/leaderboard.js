// Deadlock Chaos — score card + shared leaderboard.
// Talks to the Vercel function in api/scores.js. Reads the current roll from
// js/app.js through window.DeadlockChaos and its "chaos:*" events.

"use strict";

(function () {
  // --- Configuration -----------------------------------------------------

  // On the Vercel deployment (or `vercel dev` locally) the API is same-origin.
  // Everywhere else — e.g. the GitHub Pages copy — call the Vercel deployment.
  const SAME_ORIGIN_API =
    location.hostname.endsWith(".vercel.app") || ["localhost", "127.0.0.1"].includes(location.hostname);
  const LEADERBOARD_API = SAME_ORIGIN_API ? "/api/scores" : "https://deadlock-chaos-nu96.vercel.app/api/scores";

  const TOP_N = 50; // rows shown per tab
  const NAME_KEY = "dc-name"; // localStorage key for the remembered player name
  const NAME_MAX = 24; // keep in sync with api/_score.js
  const MODE_NAMES = { 1: "Locked Loadout", 2: "Pick Your Build", 3: "Bundles" };

  // Same rules as api/_score.js (the server recomputes the score; this is the preview).
  function computeScore({ poolSize, itemsBought, questsDone, questsFailed }) {
    return poolSize + itemsBought * 3 + questsDone * 10 - questsFailed * 5;
  }

  // --- Elements & state ----------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const els = {
    card: $("scoreCard"),
    heroes: $("scoreHeroes"),
    items: $("scoreItems"),
    itemsCount: $("scoreItemsCount"),
    quests: $("scoreQuests"),
    win: $("scoreWin"),
    loss: $("scoreLoss"),
    name: $("scoreName"),
    breakdown: $("scoreBreakdown"),
    value: $("scoreValue"),
    submit: $("scoreSubmit"),
    status: $("scoreStatus"),
    tabs: $("lbTabs"),
    body: $("lbBody"),
    lbStatus: $("lbStatus"),
  };

  const app = () => window.DeadlockChaos;

  // Score card for the current roll:
  // { roll, heroId, win, bought: Set<itemId>, required, items, submitting, submitted }
  let card = null;

  // Leaderboard.
  let entries = [];
  let filter = "all";
  let highlightId = null;
  let heroesById = new Map();
  const expanded = new Set();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function loadName() {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch {
      return "";
    }
  }
  function saveName(name) {
    try {
      localStorage.setItem(NAME_KEY, name);
    } catch {
      /* private mode etc. — not important */
    }
  }

  // --- Score card ----------------------------------------------------------

  function startCard(roll) {
    card = { roll, heroId: null, win: null, bought: new Set(), required: 0, items: [], submitting: false, submitted: false };
    els.card.hidden = false;
    els.card.classList.remove("locked");
    for (const input of els.card.querySelectorAll("input, button")) input.disabled = false;
    els.status.textContent = "";
    els.status.classList.remove("error");
    els.submit.querySelector(".roll-btn-label").textContent = "SUBMIT SCORE";
    if (!els.name.value) els.name.value = loadName();

    renderHeroChoices();
    setWin(null);
    refreshCard();
  }

  function renderHeroChoices() {
    els.heroes.innerHTML = "";
    for (const hero of card.roll.heroes) {
      const opt = el("label", "score-hero");
      const radio = el("input", "score-hero-radio");
      radio.type = "radio";
      radio.name = "scoreHero";
      radio.value = hero.id;
      radio.addEventListener("change", () => {
        card.heroId = hero.id;
        for (const o of els.heroes.querySelectorAll(".score-hero")) o.classList.toggle("on", o === opt);
        updateTotals();
      });
      opt.append(radio, app().imgEl(hero.icon, "score-hero-icon"), el("span", "score-hero-name", hero.name));
      els.heroes.appendChild(opt);
    }
  }

  function setWin(value) {
    if (card) card.win = value;
    els.win.classList.toggle("on", value === true);
    els.loss.classList.toggle("on", value === false);
    els.win.setAttribute("aria-checked", String(value === true));
    els.loss.setAttribute("aria-checked", String(value === false));
    updateTotals();
  }

  // Re-read the required items + side quests from the page (they change as the
  // player picks items / a bundle and ticks quests).
  function refreshCard() {
    if (!card || card.submitted) return;
    renderItems();
    renderQuests();
    updateTotals();
  }

  function renderItems() {
    const req = app().getRequiredItems();
    card.required = req.required;
    card.items = req.items;
    // `card.bought` keeps every tick for this roll, so briefly un-picking an item
    // (to swap it) doesn't lose the others. Only ticks on currently required
    // items count — see boughtCount().

    els.items.innerHTML = "";
    if (req.message) {
      els.items.appendChild(el("p", "score-hint", req.message));
      return;
    }
    for (const it of req.items) {
      const row = el("label", "score-item");
      const box = el("input", "score-item-check");
      box.type = "checkbox";
      box.checked = card.bought.has(it.id);
      row.classList.toggle("on", box.checked);
      box.addEventListener("change", () => {
        if (box.checked) card.bought.add(it.id);
        else card.bought.delete(it.id);
        row.classList.toggle("on", box.checked);
        updateTotals();
      });
      row.append(
        box,
        app().imgEl(it.image, "score-item-icon"),
        el("span", "score-item-name", it.name),
        el("span", "score-item-tier", `T${it.tier}`)
      );
      els.items.appendChild(row);
    }
  }

  function questCounts() {
    const { done, total } = app().getQuestStatus();
    return { questsDone: done, questsFailed: total - done };
  }

  function renderQuests() {
    const { questsDone, questsFailed } = questCounts();
    els.quests.innerHTML = "";
    els.quests.append(
      el("span", "sq-done", `${questsDone} done`),
      document.createTextNode(" · "),
      el("span", "sq-failed", `${questsFailed} failed`)
    );
    els.quests.appendChild(el("small", "score-note", "Tick quests off in the Side Quests list above."));
  }

  function boughtCount() {
    return card.items.filter((it) => card.bought.has(it.id)).length;
  }

  function currentParts() {
    const { questsDone, questsFailed } = questCounts();
    return {
      poolSize: card.roll.poolSize,
      itemsBought: boughtCount(),
      itemsRequired: card.required,
      questsDone,
      questsFailed,
    };
  }

  // What's still needed before the run can be submitted.
  function missingFields() {
    const missing = [];
    if (card.heroId == null) missing.push("pick the hero you played");
    if (!card.items.length) missing.push(card.roll.mode === 3 ? "choose a bundle" : "pick your items");
    if (card.win == null) missing.push("pick Win or Loss");
    if (!els.name.value.trim()) missing.push("enter your name");
    return missing;
  }

  function updateTotals() {
    if (!card) return;
    const p = currentParts();
    const score = computeScore(p);
    els.itemsCount.textContent = card.items.length ? `${p.itemsBought}/${p.itemsRequired}` : "";
    els.breakdown.textContent =
      `Pool ${p.poolSize} + Items ${p.itemsBought}×3 + Quests ${p.questsDone}×10 − ${p.questsFailed}×5`;
    els.value.textContent = score;
    els.value.classList.toggle("neg", score < 0);

    if (card.submitted || card.submitting) return;
    const missing = missingFields();
    els.submit.disabled = missing.length > 0;
    els.status.classList.remove("error");
    els.status.textContent = missing.length ? `To submit: ${missing.join(", ")}.` : "Ready to submit.";
  }

  async function submit() {
    if (!card || card.submitted || card.submitting || missingFields().length) return;
    const hero = card.roll.heroes.find((h) => h.id === card.heroId);
    const name = els.name.value.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);
    const payload = { name, mode: card.roll.mode, heroId: hero.id, heroName: hero.name, win: card.win, ...currentParts() };

    card.submitting = true;
    els.submit.disabled = true;
    els.status.classList.remove("error");
    els.status.textContent = "Submitting…";
    try {
      const res = await fetch(LEADERBOARD_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);

      saveName(name);
      card.submitted = true;
      lockCard();
      highlightId = body.id;
      mergeEntries([body]);
      setFilter("all");
      const rank = entries.findIndex((e) => e.id === body.id) + 1;
      els.status.textContent = `Submitted ✓ — ${body.score} points, #${rank} on the board.`;
    } catch (err) {
      console.error(err);
      els.status.classList.add("error");
      els.status.textContent = `Couldn't submit: ${err.message}`;
      els.submit.disabled = false;
    } finally {
      card.submitting = false;
    }
  }

  function lockCard() {
    els.card.classList.add("locked");
    for (const input of els.card.querySelectorAll("input, button")) input.disabled = true;
    els.submit.querySelector(".roll-btn-label").textContent = "SUBMITTED";
  }

  // --- Leaderboard ---------------------------------------------------------

  function sortEntries(list) {
    return list.sort((a, b) => b.score - a.score || String(b.date).localeCompare(String(a.date)));
  }

  // Merge by id. Keeps entries we just submitted even if the (briefly cached)
  // server list doesn't include them yet.
  function mergeEntries(list) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const e of list) if (e && e.id) byId.set(e.id, e);
    entries = sortEntries([...byId.values()]);
    renderBoard();
  }

  async function loadBoard() {
    els.lbStatus.classList.remove("error");
    els.lbStatus.textContent = "Loading leaderboard…";
    try {
      const res = await fetch(LEADERBOARD_API, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`);
      if (!Array.isArray(body)) throw new Error("Unexpected response");
      mergeEntries(body);
    } catch (err) {
      console.warn("Leaderboard unavailable:", err);
      els.lbStatus.classList.add("error");
      els.lbStatus.textContent =
        "Leaderboard unavailable right now." +
        (SAME_ORIGIN_API && !location.hostname.endsWith(".vercel.app") ? " Run `vercel dev` to use it locally." : "");
    }
  }

  function setFilter(mode) {
    filter = mode;
    for (const tab of els.tabs.querySelectorAll(".lb-tab")) {
      const on = tab.dataset.mode === mode;
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    renderBoard();
  }

  function formatDate(iso, long) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return long
      ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function heroCell(e) {
    const td = el("td", "lb-hero-cell");
    const wrap = el("span", "lb-hero");
    const hero = heroesById.get(e.heroId);
    wrap.append(app().imgEl(hero && hero.icon, "lb-hero-icon"), el("span", "lb-hero-name lb-hide-sm", e.heroName));
    td.title = e.heroName;
    td.appendChild(wrap);
    return td;
  }

  function detailText(e) {
    const parts = [
      `${e.heroName} · ${MODE_NAMES[e.mode] || "Mode " + e.mode} · ${e.win ? "Win" : "Loss"}`,
      `Items ${e.itemsBought}/${e.itemsRequired} (+${e.itemsBought * 3})`,
      `Quests ${e.questsDone} done (+${e.questsDone * 10}), ${e.questsFailed} failed (−${e.questsFailed * 5})`,
      `Pool ${e.poolSize} heroes (+${e.poolSize})`,
      formatDate(e.date, true),
    ];
    return parts.join("  ·  ");
  }

  function renderBoard() {
    const list = filter === "all" ? entries : entries.filter((e) => String(e.mode) === filter);
    els.body.innerHTML = "";

    if (!list.length) {
      els.lbStatus.classList.remove("error");
      els.lbStatus.textContent =
        filter === "all" ? "No scores yet — be the first!" : `No ${MODE_NAMES[filter]} runs yet.`;
      return;
    }

    const table = el("table", "lb-table");
    const thead = el("thead");
    const head = el("tr");
    for (const [label, cls] of [
      ["#", "lb-rank"],
      ["Player", ""],
      ["Score", "lb-score"],
      ["Hero", ""],
      ["Mode", "lb-hide-sm"],
      ["Result", "lb-result"],
      ["Date", "lb-hide-sm"],
    ]) {
      head.appendChild(el("th", cls, label));
    }
    thead.appendChild(head);
    table.appendChild(thead);

    const tbody = el("tbody");
    list.slice(0, TOP_N).forEach((e, i) => {
      const rank = i + 1;
      const row = el("tr", "lb-row" + (rank <= 3 ? ` lb-top lb-top-${rank}` : "") + (e.id === highlightId ? " lb-new" : ""));
      row.tabIndex = 0;
      row.setAttribute("aria-expanded", String(expanded.has(e.id)));

      row.appendChild(el("td", "lb-rank", String(rank)));
      row.appendChild(el("td", "lb-name", e.name));
      row.appendChild(el("td", "lb-score", String(e.score)));
      row.appendChild(heroCell(e));
      row.appendChild(el("td", "lb-mode lb-hide-sm", MODE_NAMES[e.mode] || ""));
      const result = el("td", "lb-result");
      result.appendChild(el("span", "wl-badge " + (e.win ? "win" : "loss"), e.win ? "W" : "L"));
      row.appendChild(result);
      const date = el("td", "lb-date lb-hide-sm", formatDate(e.date));
      date.title = formatDate(e.date, true);
      row.appendChild(date);

      const detail = el("tr", "lb-detail");
      detail.hidden = !expanded.has(e.id);
      const td = el("td", "", detailText(e));
      td.colSpan = 7;
      detail.appendChild(td);

      const toggle = () => {
        if (expanded.has(e.id)) expanded.delete(e.id);
        else expanded.add(e.id);
        detail.hidden = !expanded.has(e.id);
        row.setAttribute("aria-expanded", String(expanded.has(e.id)));
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          toggle();
        }
      });

      tbody.append(row, detail);
    });
    table.appendChild(tbody);
    els.body.appendChild(table);

    els.lbStatus.classList.remove("error");
    els.lbStatus.textContent =
      list.length > TOP_N ? `Showing the top ${TOP_N} of ${list.length} runs.` : `${list.length} run${list.length === 1 ? "" : "s"}. Click a row for the breakdown.`;
  }

  // --- Wiring --------------------------------------------------------------

  document.addEventListener("chaos:rolling", () => {
    card = null;
    els.card.hidden = true;
  });
  document.addEventListener("chaos:rolled", (ev) => startCard(ev.detail));
  document.addEventListener("chaos:selection", refreshCard);

  els.win.addEventListener("click", () => setWin(true));
  els.loss.addEventListener("click", () => setWin(false));
  els.name.addEventListener("input", updateTotals);
  els.submit.addEventListener("click", submit);

  for (const tab of els.tabs.querySelectorAll(".lb-tab")) {
    tab.addEventListener("click", () => setFilter(tab.dataset.mode));
  }
  const refresh = el("button", "pool-btn lb-refresh", "↻ Refresh");
  refresh.type = "button";
  refresh.addEventListener("click", loadBoard);
  els.tabs.appendChild(refresh);

  // Hero portraits for the board (cached by the browser; app.js loads the same file).
  fetch("data/heroes.json")
    .then((r) => r.json())
    .then((list) => {
      heroesById = new Map(list.map((h) => [h.id, h]));
      if (entries.length) renderBoard();
    })
    .catch(() => {});

  loadBoard();
})();
