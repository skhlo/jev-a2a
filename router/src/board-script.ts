// The board page's script. It reads the rendered page and its data
// attributes only.
//
// The page works without it. It keeps what a person is doing across
// refreshes and adds the filter, the keys, the peek, the sheet, the usage
// pop-up in place, opening a task in place, the full router log and the
// help with its theme switch.
export const SCRIPT = `
const root = document.documentElement;
const $ = (selector, from = document) => from.querySelector(selector);
const $$ = (selector, from = document) => [...from.querySelectorAll(selector)];
const stored = (store, key, fallback) => {
  try { return JSON.parse(store.getItem(key)) ?? fallback; } catch { return fallback; }
};
const selected = () => $(".detail")?.dataset.task;
const narrow = matchMedia("(max-width: 900px)");

// Theme: the server paints the cookie's palette. A palette chosen on this
// device, in the help, wins and goes into both stores, so the next page
// paints it first. The cookie takes the page's directory, which is the
// board's: the page is served only there.
const THEMES = ["flexoki", "one-dark"];
const paint = () => $$(".themes button").forEach((b) => {
  b.classList.toggle("on", b.dataset.theme === root.dataset.theme);
  b.setAttribute("aria-pressed", String(b.dataset.theme === root.dataset.theme));
});
const theme = (name) => {
  root.dataset.theme = name;
  localStorage.setItem("router-theme", name);
  document.cookie = "router-theme=" + name + "; max-age=31536000; samesite=lax";
  paint();
};
const saved = localStorage.getItem("router-theme");
if (THEMES.includes(saved) && saved !== root.dataset.theme) theme(saved);
$$(".themes button").forEach((b) => b.addEventListener("click", () => theme(b.dataset.theme)));

// Collapsed groups, by data-group, on this device.
const fold = () => {
  const shut = [].concat(stored(localStorage, "router-collapsed", []));
  $$(".group").forEach((g) => g.classList.toggle("collapsed", shut.includes(g.dataset.group)));
};

// The router log: collapsed to its newest line until r opens the whole
// block, which stays open across refreshes, on this device. The server
// renders it open, so a page without a script, which r needs, shows every
// line in the open layout; the script sets it from the stored choice at
// start and after each refresh, before the page is painted.
const logOpen = () => localStorage.getItem("router-log") === "open";
const showLog = () => $(".agents .foot")?.classList.toggle("open", logOpen());
const toggleLog = () => {
  if (!$(".agents .foot")) return false;
  if (logOpen()) localStorage.removeItem("router-log");
  else localStorage.setItem("router-log", "open");
  showLog();
  return true;
};

// Blocks a toggle opens, by data-key, on this device: an account's details
// and a day table's older rows, in the usage pop-up. The server draws them
// open, so a page without a script shows them; the script shuts each one
// not kept open, at start and after each refresh, before the page is
// painted.
const opened = () => [].concat(stored(localStorage, "router-open", []));
const showBlock = (block, open) => {
  block.hidden = !open;
  if (block.id) $$('[aria-controls="' + CSS.escape(block.id) + '"]').forEach((t) => t.setAttribute("aria-expanded", String(open)));
};
const unfold = () => {
  const open = opened();
  $$(".usage [data-key]").forEach((block) => showBlock(block, open.includes(block.dataset.key)));
};
const keepBlock = (block, open) => {
  showBlock(block, open);
  const keys = opened().filter((key) => key !== block.dataset.key);
  if (open) keys.push(block.dataset.key);
  localStorage.setItem("router-open", JSON.stringify(keys));
};

// Drafts, by the data-path of the form or peek they are typed in, kept with
// the fields that name their item: a draft never fills another item's form
// when the paths shift.
const DRAFTED = "form textarea, form input[name=to]";
const draftKey = (field) => "router-draft " + field.closest("[data-path]").dataset.path + " " + field.name;
const itemOf = (field) => $$("input[type=hidden]", field.form).map((i) => i.value).join(" ");
const drafts = () => $$(DRAFTED).forEach((field) => {
  const draft = stored(sessionStorage, draftKey(field), null);
  if (draft?.item === itemOf(field) && !field.value && field !== document.activeElement) field.value = draft.text;
});

// The filter narrows the rows by what they show and by their ids.
const filter = () => {
  const words = ($(".filter input")?.value ?? "").trim().toLowerCase();
  $$(".task").forEach((row) => {
    const text = [row.dataset.task, row.dataset.path, ...$$(".line1, .line2", row).map((e) => e.textContent)];
    row.hidden = !text.join(" ").toLowerCase().includes(words);
  });
};

// The peek opens beside its row, above the panels; from 900px down the CSS
// places it across the screen.
const peek = () => $(".peek:not([hidden])");
const openPeek = (p) => {
  peek()?.setAttribute("hidden", "");
  p.hidden = false;
  if (narrow.matches) {
    p.style.left = p.style.top = "";
    return;
  }
  const r = p.parentElement.getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(r.right + 16, innerWidth - p.offsetWidth - 8)) + "px";
  p.style.top = Math.max(8, Math.min(r.top - 8, innerHeight - p.offsetHeight - 8)) + "px";
};
const closePeek = () => {
  const p = peek();
  p.hidden = true;
  $("a.id", p.parentElement)?.focus();
};

// The sheet: one placement's health over the tasks column. Every
// placement's sheet is in the page, hidden; a card's name or the s key
// shows one by its key, esc or its close button hides it, and a refresh
// keeps it open by key while the placement is still there.
const sheet = () => $(".bento > .sheet:not([hidden])");
const sheetFor = (key, root = document) => $('.bento > .sheet[data-key="' + CSS.escape(key) + '"]', root);
// The card of a placement, by its key: indexes shift between refreshes.
const cardFor = (key) => $$(".card").find((c) => $(".name .key", c)?.textContent === key);
const closeSheet = () => {
  const s = sheet();
  if (!s) return;
  s.hidden = true;
  cardFor(s.dataset.key)?.focus();
};
const openSheet = (key) => {
  const s = sheetFor(key);
  if (!s) return false;
  if (sheet() !== s) sheet()?.setAttribute("hidden", "");
  s.hidden = false;
  return true;
};

// The usage pop-up (v0.13): a rail row or u opens it beside the rail, over
// the tasks column, moved left to stay 12px inside the viewport; from 900px
// down the CSS makes it the page. A row, u, esc, its close button or a click
// outside closes it. Opening puts the focus on an account's toggle (the
// row's, from a row), and closing gives it back.
const usage = () => $(".usage");
const usageOpen = () => Boolean(usage() && !usage().hidden);
const place = () => {
  const u = usage();
  if (!u) return;
  if (u.hidden || narrow.matches) {
    u.style.left = "";
    return;
  }
  const rail = $(".agents")?.getBoundingClientRect().right ?? 0;
  u.style.left = Math.max(12, Math.min(rail + 8, innerWidth - 12 - u.offsetWidth)) + "px";
};
const syncUsage = () => {
  $$(".acct").forEach((a) => a.setAttribute("aria-expanded", String(usageOpen())));
  place();
};
// The element that opened the pop-up, and how to find it again when a
// refresh has replaced it: a row by its task, else by its tag and path.
let usageFrom = null;
const finder = (el) => {
  const task = el?.matches(".task a.id") && el.closest(".task").dataset.task;
  if (task) return '.task[data-task="' + CSS.escape(task) + '"] a.id';
  return el?.dataset?.path ? el.localName + '[data-path="' + CSS.escape(el.dataset.path) + '"]' : null;
};
const setUsage = (open, from = null) => {
  const u = usage();
  if (!u) return false;
  const was = usageOpen();
  u.hidden = !open;
  syncUsage();
  if (open && !was) {
    const el = from ?? document.activeElement;
    usageFrom = { el, find: finder(el) };
    const toggle = (from && $('.toggle[data-path="' + CSS.escape(from.dataset.path + ".name") + '"]', u)) || $(".toggle", u);
    toggle?.focus({ preventScroll: true });
  } else if (!open && was) {
    const to = usageFrom?.el.isConnected ? usageFrom.el : usageFrom?.find && $(usageFrom.find);
    const lost = u.contains(document.activeElement) || document.activeElement === document.body;
    if (lost && to) to.focus();
    else if (u.contains(document.activeElement)) document.activeElement.blur();
    usageFrom = null;
  }
  return true;
};
addEventListener("resize", place);

// Every few seconds the page fetches itself for the selected task and swaps
// the nav counts and tick, every panel the page marks with data-part, the
// sheets and the usage pop-up. A panel or an open overlay stays as it is
// while it holds the focus (unless the focus is on a row, a card, a usage
// row or an account's toggle that the new page has too) or a text
// selection, so what is being typed, read or copied is not pulled away.
// Opening a task in place is the same fetch, which swaps the detail
// whatever it holds; a later open supersedes an earlier one still on its
// way, and no periodic fetch starts while an open is on its way, so the
// open lands and its address and focus follow it. The notice is outside
// the swapped parts.
const parts = () => [".nav .counts", ".nav .tick", ...$$("[data-part]").map((el) => '[data-part="' + CSS.escape(el.dataset.part) + '"]')];
let fetches = 0;
// The open on its way, until its fetch settles: its task, the hash its link
// names, and whether it adds its link to the history (an open the viewer
// started) or finds the address set (Back, Forward, the task an action
// returns to).
let opening = null;
// How long an open waits for its page before it follows its link.
const OPEN_WAIT_MS = 12000;
// An open that cannot fetch follows its link instead. A link that differs
// from the address only by its hash (or not at all, as after Back) would
// not load the page, so the address takes the link and the page loads
// again.
const follow = (open, query) => {
  const link = new URL((query || location.pathname) + open.hash, location.href);
  if (link.pathname + link.search !== location.pathname + location.search) return location.assign(link);
  if (open.push && link.hash !== location.hash) history.pushState(null, "", link);
  else history.replaceState(null, "", link);
  location.reload();
};
const refresh = async (open = null) => {
  if (!open && (opening || document.hidden)) return;
  const id = open ? open.id : selected();
  const mine = ++fetches;
  const query = id ? "?task=" + encodeURIComponent(id) : "";
  let doc = null;
  try {
    const r = await fetch(location.pathname + query, { cache: "no-store", headers: { accept: "text/html" }, signal: open ? AbortSignal.timeout(OPEN_WAIT_MS) : null });
    if (!r.ok) throw new Error(r.statusText);
    doc = new DOMParser().parseFromString(await r.text(), "text/html");
  } catch {
    doc = null;
  }
  if (mine !== fetches) return;
  // The open has settled, so the timed refreshes go on whatever it found.
  if (open) opening = null;
  if (!doc) {
    if (open) follow(open, query);
    return;
  }
  const focus = document.activeElement;
  const sel = document.getSelection();
  const range = sel && !sel.isCollapsed && sel.rangeCount ? sel.getRangeAt(0) : null;
  // Whether a part holds a selection (either end, or the span between).
  const selectedIn = (el) => range !== null && range.intersectsNode(el);
  const row = focus?.matches(".task a.id") ? focus.closest(".task").dataset.task : null;
  const card = focus?.matches(".card") ? focus.dataset.path : null;
  const acct = focus?.matches(".acct") ? focus.dataset.path : null;
  const toggle = focus?.matches(".usage .toggle") ? focus.getAttribute("aria-controls") : null;
  const kept = row || card || acct || toggle;
  const peeked = peek() && '.task[data-task="' + CSS.escape(peek().parentElement.dataset.task) + '"] .peek[data-path="' + CSS.escape(peek().dataset.path) + '"]';
  const shown = sheet()?.dataset.key ?? "";
  const words = $(".filter input")?.value ?? "";
  for (const part of parts()) {
    const old = $(part);
    const next = $(part, doc);
    const swap = open && part === '[data-part="detail"]' && old?.dataset.task !== next?.dataset.task;
    if (!old || !next || (!swap && ((old.contains(focus) && !kept) || selectedIn(old)))) continue;
    const top = $(".scroll", old)?.scrollTop ?? 0;
    old.replaceWith(next);
    const scroll = $(".scroll", next);
    if (scroll) scroll.scrollTop = swap ? 0 : top;
  }
  // The hidden sheets are swapped whole; the open one keeps its element,
  // its scroll and its slide, and takes the new head and body, unless it
  // holds the focus or a selection. It goes when its placement is gone.
  const showing = sheet();
  $$(".bento > .sheet").forEach((s) => s !== showing && s.remove());
  $$(".bento > .sheet", doc).forEach((s) => s.dataset.key !== shown && $(".bento").append(s));
  const fresh = shown && sheetFor(shown, doc);
  if (showing && !fresh) showing.remove();
  else if (showing && fresh && !showing.contains(focus) && !selectedIn(showing)) {
    const top = $(".body", showing).scrollTop;
    showing.dataset.path = fresh.dataset.path;
    showing.replaceChildren(...fresh.children);
    $(".body", showing).scrollTop = top;
  }
  // The pop-up likewise: shut, it is swapped whole; open, it keeps its
  // element, its scroll and its place, and takes the new content. It comes
  // and goes with the usage section.
  const u = usage();
  const next = $(".usage", doc);
  if (!u && next) $(".help").before(next);
  else if (u && !next) u.remove();
  else if (u?.hidden) u.replaceWith(next);
  else if (u && ((!u.contains(focus) || toggle) && !selectedIn(u))) {
    const top = $(".body", u).scrollTop;
    u.replaceChildren(...next.children);
    $(".body", u).scrollTop = top;
  }
  if (row) $('.task[data-task="' + CSS.escape(row) + '"] a.id')?.focus();
  if (card) $('.card[data-path="' + CSS.escape(card) + '"]')?.focus();
  if (acct) $('.acct[data-path="' + CSS.escape(acct) + '"]')?.focus();
  if (toggle) $('.usage .toggle[aria-controls="' + CSS.escape(toggle) + '"]')?.focus();
  if (peeked && !peek() && $(peeked)) openPeek($(peeked));
  const input = $(".filter input");
  if (input && input !== focus) input.value = words;
  // The address follows: an open the viewer started adds its link to the
  // history, as following it would (a link to the address itself adds
  // nothing). When the page shows another task than the address names (the
  // bare page, a task that has gone), the address takes it, keeping its
  // notice and hash.
  if (open?.push && query + open.hash !== location.search + location.hash) history.pushState(null, "", (query || location.pathname) + open.hash);
  const here = new URLSearchParams(location.search);
  if (selected() && selected() !== here.get("task")) {
    here.set("task", selected());
    history.replaceState(null, "", "?" + here + location.hash);
  }
  // An Answer lever's open goes to its form.
  const target = open?.hash && document.getElementById(decodeURIComponent(open.hash.slice(1)));
  if (target) {
    target.scrollIntoView({ block: "nearest" });
    $("textarea", target)?.focus();
  }
  fold();
  showLog();
  unfold();
  syncUsage();
  filter();
  drafts();
};
setInterval(() => refresh(), Number($("#app").dataset.refresh) * 1000);

// Opening a task in place (v0.13): a link to a task (a row's id, a card's
// task, the peek's Open task, an Answer lever) marks its row at once, then
// swaps in the page fetched for the task; an Answer lever then goes to its
// form. Back and Forward open the task their entry names. The link still
// works without the script, and a modified click keeps the browser's own.
const openTask = (id, hash = "", push = true) => {
  const row = id && $('.task[data-task="' + CSS.escape(id) + '"]');
  if (row) {
    $$(".task[aria-current]").forEach((r) => {
      r.classList.remove("selected");
      r.removeAttribute("aria-current");
    });
    row.classList.add("selected");
    row.setAttribute("aria-current", "true");
  }
  opening = { id, hash, push };
  return refresh(opening);
};
addEventListener("popstate", () => {
  const id = new URLSearchParams(location.search).get("task");
  if (id !== selected()) openTask(id, location.hash, false);
});
const plain = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

document.addEventListener("click", (e) => {
  if (e.defaultPrevented || !plain(e)) return;
  const key = e.target.closest(".card .name .key");
  if (key) return openSheet(key.textContent);
  if (e.target.closest(".sheet .close")) return closeSheet();
  // A lever in the sheet leaves the page; the sheet comes back with it.
  if (e.target.closest(".sheet a:not([href^='?task='])")) sessionStorage.setItem("router-sheet", sheet()?.dataset.key ?? "");
  const acct = e.target.closest(".acct");
  if (acct) {
    e.preventDefault();
    return setUsage(!usageOpen(), acct);
  }
  if (e.target.closest(".usage .close")) {
    e.preventDefault();
    return setUsage(false);
  }
  const toggle = e.target.closest(".usage .toggle");
  const block = toggle && document.getElementById(toggle.getAttribute("aria-controls"));
  if (block) return keepBlock(block, block.hidden);
  const days = e.target.closest(".usage .days");
  const older = days && $(".older", days.closest("table"));
  if (older) return keepBlock(older, true);
  if (usageOpen() && !e.target.closest(".usage")) setUsage(false);
  const link = e.target.closest('a[href^="?task="]');
  if (link) {
    e.preventDefault();
    const url = new URL(link.href);
    peek()?.setAttribute("hidden", "");
    openTask(url.searchParams.get("task"), url.hash);
  }
});

document.addEventListener("input", (e) => {
  const field = e.target;
  if (field.matches(".filter input")) return filter();
  if (!field.matches(DRAFTED)) return;
  if (field.value) sessionStorage.setItem(draftKey(field), JSON.stringify({ item: itemOf(field), text: field.value }));
  else sessionStorage.removeItem(draftKey(field));
});

// A post ends its drafts, and the page it returns to reopens its task.
document.addEventListener("submit", (e) => {
  if (e.defaultPrevented) return;
  $$("textarea, input[name=to]", e.target).forEach((field) => sessionStorage.removeItem(draftKey(field)));
  sessionStorage.setItem("router-task", selected() ?? "");
  sessionStorage.setItem("router-sheet", sheet()?.dataset.key ?? "");
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".notice a")) {
    e.preventDefault();
    $(".notice").remove();
    history.replaceState(null, "", selected() ? "?task=" + encodeURIComponent(selected()) : location.pathname);
    return;
  }
  const head = e.target.closest(".group > h3");
  if (!head) return;
  const name = head.parentElement.dataset.group;
  const shut = [].concat(stored(localStorage, "router-collapsed", [])).filter((n) => n !== name);
  if (!head.parentElement.classList.contains("collapsed")) shut.push(name);
  localStorage.setItem("router-collapsed", JSON.stringify(shut));
  fold();
});

// The keys the footer and the help name (v0.13). Each returns whether it
// did something.
const typing = (el) => el?.matches("input, textarea, select");
// ↑ ↓ move between the rows from a row, a card or nothing in particular;
// on a button, a link or a scrolling table they are the browser's.
const move = (step, el) => {
  if (el && el !== document.body && !el.matches(".task a.id, .card")) return false;
  const links = $$(".group:not(.collapsed) .task:not([hidden]) a.id");
  const at = links.indexOf(document.activeElement);
  const next = at < 0 ? $(".task[aria-current] a.id") ?? links[0] : links[Math.min(links.length - 1, Math.max(0, at + step))];
  next?.focus();
  return Boolean(next);
};
const press = (el) => {
  el?.click();
  return Boolean(el);
};
// The focused agent's card, the open sheet's, or the card of the agent
// working on the selected task.
const agentCard = (el) =>
  el?.closest(".card") ??
  (sheet() && cardFor(sheet().dataset.key)) ??
  $$(".card").find((c) => $("a.id", c)?.textContent === selected());
// ↵ or →: the focused row's task, or the focused card's sheet.
const openKey = (row, el) => {
  if (row) {
    peek()?.setAttribute("hidden", "");
    openTask(row.dataset.task);
    return true;
  }
  const key = el?.matches(".card") && $(".name .key", el)?.textContent;
  return key ? openSheet(key) : false;
};
// ← or esc: close the help, then the usage, then the peek, then the sheet.
const back = () => {
  if (!$(".help").hidden) $(".help").hidden = true;
  else if (usageOpen()) setUsage(false);
  else if (peek()) closePeek();
  else if (sheet()) closeSheet();
  else return false;
  return true;
};
// In the usage pop-up: ↑ ↓ move between the accounts, → or ↵ open the
// focused account's details, ← closes them, or the pop-up when they are
// shut.
const USAGE_KEYS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"];
const usageKey = (key, el) => {
  const toggles = $$(".usage .toggle");
  const at = toggles.indexOf(el);
  const block = at >= 0 && document.getElementById(el.getAttribute("aria-controls"));
  if (key === "ArrowUp" || key === "ArrowDown") {
    const next = at < 0 ? toggles[0] : toggles[Math.min(toggles.length - 1, Math.max(0, at + (key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    return Boolean(next);
  }
  if (key === "ArrowLeft") {
    if (block && !block.hidden) keepBlock(block, false);
    else setUsage(false);
    return true;
  }
  if (!block) return false;
  keepBlock(block, true);
  return true;
};
const KEYS = {
  ArrowDown: (row, el) => move(1, el),
  ArrowUp: (row, el) => move(-1, el),
  Enter: openKey,
  ArrowRight: openKey,
  ArrowLeft: back,
  " ": (row) => {
    const p = row && $(".peek", row);
    if (!p) return false;
    if (p === peek()) closePeek(); else openPeek(p);
    return true;
  },
  a: () => {
    const field = peek() ? $("textarea", peek()) : $(".detail form[id^='answer-'] textarea");
    field?.focus();
    return Boolean(field);
  },
  c: () => press($(".detail .actions button")),
  // The focused agent, or the one working on the selected task.
  p: (row, el) => press(agentCard(el) && $("button[data-path$='.hold']", agentCard(el))),
  s: (row, el) => {
    const key = agentCard(el) && $(".name .key", agentCard(el))?.textContent;
    if (!key) return false;
    if (sheet()?.dataset.key === key) closeSheet(); else openSheet(key);
    return true;
  },
  r: toggleLog,
  u: () => setUsage(!usageOpen()),
  "/": () => {
    const input = $(".filter input");
    input?.focus();
    return Boolean(input);
  },
  "?": () => { $(".help").hidden = !$(".help").hidden; return true; },
};
// A screen without a keyboard still opens the log and the help, where the
// theme switch is: the footer's r and ? take a tap.
document.addEventListener("click", (e) => {
  const key = e.target.closest(".keys > span[data-key]")?.dataset.key;
  if (key) KEYS[key]();
});
document.addEventListener("keydown", (e) => {
  // A key that ends an IME composition (a Hangul syllable, a kana
  // conversion) belongs to the text; Safari marks it only by keyCode 229.
  if (e.isComposing || e.keyCode === 229) return;
  const el = document.activeElement;
  if (e.key === "Escape") {
    if (!back() && typing(el)) el.blur();
    return;
  }
  if (e.key === "Enter" && el?.matches("form textarea")) {
    // ⌘↩ sends the form; in the peek ↵ alone sends and ⇧↵ breaks the line.
    if (e.metaKey || e.ctrlKey || (el.closest(".peek") && !e.shiftKey)) {
      e.preventDefault();
      el.form.requestSubmit();
    }
    return;
  }
  if (typing(el) || e.metaKey || e.ctrlKey || e.altKey) return;
  // ⇧ with an arrow or ↵ is the browser's (selecting, a new window).
  if (e.shiftKey && (e.key.startsWith("Arrow") || e.key === "Enter")) return;
  // While the pop-up is open, and the help is not over it, its arrows and
  // ↵ move between its accounts from a toggle, the pop-up or nothing in
  // particular.
  const inUsage = !el || el === document.body || el === usage() || el.matches(".usage .toggle");
  if (usageOpen() && $(".help").hidden && USAGE_KEYS.includes(e.key) && inUsage) {
    if (usageKey(e.key, el)) e.preventDefault();
    return;
  }
  const row = el?.matches(".task a.id") ? el.closest(".task") : null;
  if (KEYS[e.key]?.(row, el)) e.preventDefault();
});

// An action returns to the bare page with its notice; reopen the task it
// was taken on. A page drawn with the pop-up open (?usage, the link a page
// without a script follows) keeps it open and drops the parameter.
const returned = sessionStorage.getItem("router-task");
sessionStorage.removeItem("router-task");
const sheetBack = sessionStorage.getItem("router-sheet");
sessionStorage.removeItem("router-sheet");
if (sheetBack) openSheet(sheetBack);
const params = new URLSearchParams(location.search);
if (params.has("usage")) {
  params.delete("usage");
  history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params : ""));
}
if (returned && params.has("notice") && !params.has("task") && returned !== selected() && $('.task[data-task="' + CSS.escape(returned) + '"]')) {
  history.replaceState(null, "", "?task=" + encodeURIComponent(returned) + "&notice=" + encodeURIComponent(params.get("notice")));
  openTask(returned, "", false);
}
paint();
fold();
showLog();
unfold();
syncUsage();
filter();
drafts();
`;
