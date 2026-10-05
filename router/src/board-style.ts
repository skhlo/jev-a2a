// The board page's CSS: the generator's, then what the live page adds.
export const STYLE = `
/* Tokens. Hierarchy comes from weight and surface, one accent means "needs you", hairlines separate. */
:root {
  --body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --std: cubic-bezier(.4, 0, .2, 1); --emph: cubic-bezier(.2, 0, 0, 1); --t-fast: 150ms; --t-mid: 200ms;
  --fs: 13px; --fs-mono: 11.5px; --fs-small: 12px; --pad: 12px; --row-pad: 7px 10px; --card-gap: 6px;
}
/* Flexoki dark: bg black, bg-2 base-950, ui base-900/850/800, tx base-200/500/700, accent blue-400; roles green/orange/red-400. */
:root, html[data-theme="flexoki"] {
  --canvas: #100F0F; --surface: #1C1B1A; --surface-2: #282726; --text: #CECDC3; --text-2: #878580; --text-3: #575653;
  --hair: #282726; --hair-soft: #1F1E1D; --hair-strong: #403E3C;
  --wash: rgba(206,205,195,.05); --press: rgba(206,205,195,.10);
  --accent: #4385BE; --accent-soft: rgba(67,133,190,.16); --accent-line: rgba(67,133,190,.4); --on-accent: #FFFCF0;
  --ok: #879A39; --warn: #DA702C; --err: #D14D41;
  --shadow: rgba(0,0,0,.45);
}
/* Flexoki light: bg paper, bg-2 base-50, ui base-100/150/200, tx black/base-600/base-300, accent blue-600; roles green/orange/red-600. */
@media (prefers-color-scheme: light) {
  html[data-theme="flexoki"] {
    --canvas: #FFFCF0; --surface: #F2F0E5; --surface-2: #E6E4D9; --text: #100F0F; --text-2: #6F6E69; --text-3: #B7B5AC;
    --hair: #E6E4D9; --hair-soft: #ECEAE0; --hair-strong: #CECDC3;
    --wash: rgba(16,15,15,.04); --press: rgba(16,15,15,.08);
    --accent: #205EA6; --accent-soft: rgba(32,94,166,.10); --accent-line: rgba(32,94,166,.35); --on-accent: #FFFCF0;
    --ok: #66800B; --warn: #BC5215; --err: #AF3029;
    --shadow: rgba(16,15,15,.18);
  }
}
/* One Dark, from Zed's assets/themes/one/one.json: editor.background, surface, border.variant, border, text, text.muted, text.placeholder, element.active, text.accent; roles success, warning, error. */
html[data-theme="one-dark"] {
  --canvas: #282C33; --surface: #2F343E; --surface-2: #363C46; --text: #DCE0E5; --text-2: #A9AFBC; --text-3: #878A98;
  --hair: #363C46; --hair-soft: #30353F; --hair-strong: #464B57;
  --wash: rgba(220,224,229,.05); --press: #454A56;
  --accent: #74ADE8; --accent-soft: rgba(116,173,232,.14); --accent-line: rgba(116,173,232,.4); --on-accent: #282C33;
  --ok: #A1C181; --warn: #DEC184; --err: #D07277;
  --shadow: rgba(0,0,0,.45);
}
@media (prefers-reduced-motion: reduce) { * { transition-duration: 0ms !important; animation: none !important; } }

* { box-sizing: border-box; }
html, body { height: 100%; background: var(--canvas); color: var(--text); }
body { margin: 0; font: 400 var(--fs)/1.5 var(--body); overflow: hidden; }
a { color: var(--text); text-decoration: underline; text-decoration-color: var(--hair-strong); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--text); }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
h1, h2, h3, p { margin: 0; }
.mono { font-family: var(--mono); font-size: .92em; }
.num { font-variant-numeric: tabular-nums; }
.id { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); }

/* Frame: nav, bento, key line; the bento fills what is left and its panels scroll inside. */
#app { position: relative; height: 100vh; display: grid; grid-template-rows: 52px 1fr 40px; grid-template-columns: minmax(0, 1fr); }
/* min-width: 0, so the page's grid lets the nav be narrower than its
   children's full text and .who truncates instead of widening the page. */
.nav { display: flex; align-items: center; gap: 14px; padding: 0 20px; min-width: 0; background: var(--canvas); border-bottom: 1px solid var(--hair); }
.nav .brand { font-weight: 500; font-size: 17px; letter-spacing: -.2px; }
.nav .who { flex: 0 1 auto; min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-small); color: var(--text-3); }
.nav .counts { display: flex; gap: 6px; margin-left: 4px; }
.nav .br { display: none; }
.nav .counts > span { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; padding: 4px 10px; border-radius: 100px; border: 1px solid var(--hair); color: var(--text-2); white-space: nowrap; }
.nav .counts > span b { font-weight: 500; color: var(--text); margin-right: 4px; }
.nav .counts .attn { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.nav .counts .attn b { color: var(--accent); }
/* The rail's Usage section (v0.13): pinned under the cards, above the router log; one two-line row per subscription
   account, from the card's parts. Colour per figure only; a stale row dims; a passed window keeps its track only. */
.agents .usage-rail { flex: none; border-top: 1px solid var(--hair); padding-top: 4px; }
.accts { display: grid; gap: 2px; padding: 0 10px 8px; }
.acct { display: grid; gap: 5px; width: 100%; min-width: 0; padding: 7px 10px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--text); font: inherit; text-align: left; cursor: pointer; transition: background var(--t-fast) var(--std); }
.acct:hover { background: var(--wash); }
.acct .l1 { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--fs); }
.acct .mark { width: 12px; height: 12px; flex: 0 0 12px; color: var(--text); }
.acct .nm { font-weight: 500; letter-spacing: -.1px; white-space: nowrap; }
.acct .st { font-size: var(--fs-small); color: var(--text-3); white-space: nowrap; }
.acct .st.off { color: var(--text-2); }
.acct .rs { margin-left: auto; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.acct .l2 { display: flex; gap: 14px; min-width: 0; padding-left: 20px; }
.acct .win { flex: 1 1 0; min-width: 0; display: flex; align-items: center; gap: 6px; }
.acct .win .w { flex: none; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.acct .win .meter { flex: 1 1 auto; min-width: 0; font-variant-numeric: tabular-nums; }
.acct .win .meter .bar { flex: 1 1 auto; width: auto; min-width: 20px; }
.acct .win.dim .meter { color: var(--text-3); }
.acct .none { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.acct.stale > * { opacity: .55; }
.nav .spacer, .row .spacer, .col-h .spacer, .keys .spacer { flex: 1; }
.nav .tick { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; cursor: help; }
.nav nav { display: flex; gap: 4px; align-items: center; }
.nav nav a { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); padding: 6px 11px; border-radius: 8px; text-decoration: none; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.nav nav a:hover { background: var(--wash); color: var(--text); }
.nav nav a.active { background: var(--press); color: var(--text); }
.themes { display: flex; border: 1px solid var(--hair); border-radius: 100px; padding: 2px; }
.themes button { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-2); background: transparent; border: 0; border-radius: 100px; padding: 3px 10px; cursor: pointer; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.themes button:hover { color: var(--text); }
.themes button.on { background: var(--press); color: var(--text); }

.bento { min-height: 0; width: 100%; max-width: 1600px; margin: 0 auto; padding: 10px 12px; display: grid; grid-template-columns: 3fr 4fr 5fr; gap: 10px; }
.bento > .agents { grid-area: 1 / 1; } .bento > .tasks { grid-area: 1 / 2; } .bento > .detail { grid-area: 1 / 3; }
.panel { position: relative; min-height: 0; overflow: hidden; background: var(--surface); border: 1px solid var(--hair); border-radius: 12px; display: flex; flex-direction: column; }
.scroll { min-height: 0; overflow-y: auto; flex: 1; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.kicker { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .6px; text-transform: uppercase; color: var(--text-3); }
.kicker.attn { color: var(--accent); }
.col-h { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px 8px; }
.col-h .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }

/* Dots: one accent for what needs you; everything else is a shape in the text colour. */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: 0 0 8px; margin-top: 6px; }
.dot.ask, .dot.fail { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.dot.work, .dot.busy { background: var(--text); animation: pulse 2s var(--std) infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
.dot.ready, .dot.wait { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-2); }
.dot.wait { box-shadow: inset 0 0 0 1.5px var(--text-3); }
.dot.held { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-2); position: relative; }
.dot.held::after { content: ""; position: absolute; inset: 2px 3px; border-left: 1.5px solid var(--text-2); border-right: 1.5px solid var(--text-2); }
.dot.off { background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-3); }
.dot.done { background: var(--text-3); }
.badge { display: inline-block; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; line-height: 1.2; padding: 3px 8px; border-radius: 100px; border: 1px solid var(--hair); color: var(--text-2); white-space: nowrap; }
.badge.ask { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.tag { display: inline-block; font-family: var(--mono); font-size: calc(var(--fs-mono) - 1px); font-weight: 500; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--hair-soft); color: var(--text-3); white-space: nowrap; }

.btn { font-family: var(--body); font-size: var(--fs-small); font-weight: 500; line-height: 1.2; padding: 6px 12px; border-radius: 100px; border: 1px solid transparent; background: var(--wash); color: var(--text); cursor: pointer; white-space: nowrap; transition: background var(--t-fast) var(--std); }
.btn:hover { background: var(--press); }
.btn.accent { background: var(--accent); color: var(--on-accent); }
.btn.accent:hover { filter: brightness(1.08); }
.btn.danger { background: transparent; color: var(--text-2); border-color: var(--hair); }
.btn.danger:hover { color: var(--text); background: var(--wash); }
.btn.ghost { background: transparent; border-color: var(--hair); }
.btn.sm { font-size: calc(var(--fs-small) - 1px); padding: 4px 10px; }

/* Agents: one card per placement. */
.cards { display: grid; gap: var(--card-gap); padding: 0 10px 10px; }
.card { border: 1px solid var(--hair); border-radius: 10px; padding: var(--pad); display: flex; gap: 10px; cursor: pointer; transition: background var(--t-fast) var(--std), border-color var(--t-fast) var(--std); }
.card:hover { background: var(--wash); border-color: var(--hair-strong); }
.card.warm { background: var(--accent-soft); border-color: var(--accent-line); }
.card.off { opacity: .7; }
.card.idle { padding: 9px var(--pad); }
.card.idle .body { grid-template-columns: 1fr auto; align-items: center; }
.card.focused { outline: 2px solid var(--text); outline-offset: 2px; }
.card .body { flex: 1; min-width: 0; display: grid; gap: 2px; }
.card .name { font-weight: 500; font-size: var(--fs); letter-spacing: -.1px; display: flex; align-items: baseline; gap: 8px; }
.card .name .key { cursor: pointer; text-decoration: underline; text-decoration-color: transparent; text-underline-offset: 3px; transition: text-decoration-color var(--t-fast) var(--std); }
.card .name .key:hover { text-decoration-color: var(--hair-strong); }
.card .name .age { margin-left: auto; font-family: var(--mono); font-weight: 500; font-size: var(--fs-mono); color: var(--text-3); }
.card .what { font-size: var(--fs-small); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .what.ask { color: var(--accent); }
.card .what .id { color: inherit; font-size: inherit; }
.card .what.busy { color: var(--text); }
.card .stats { display: flex; gap: 6px; align-items: baseline; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-2); white-space: nowrap; }
.card .stats .k { color: var(--text-3); }
.card .stats .ask { color: var(--accent); }
.card .lever { flex: 0 0 auto; display: flex; gap: 6px; }
/* Health: placements[].agent closes the card as one row with the lever at its end; the meter sits in the
   name row, or in this row on an idle card. Only a pending permission takes the accent; a status with an
   error is dotted and carries the error as its tooltip; stale work and a window at 80% take the warning role. */
.card .name .meter { margin-left: auto; align-self: center; }
.card .name .meter + .age { margin-left: 0; }
.card .tele { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.card.idle .tele { grid-column: 1 / -1; }
/* A status line too long to share the row with the levers keeps the row; the levers wrap under it, right-aligned. */
.card .tele .line { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card .tele .lever { margin-left: auto; }
.card .tele .ask { color: var(--accent); font-weight: 500; }
.card .tele .err { text-decoration: underline dotted var(--text-3); text-underline-offset: 3px; cursor: help; }
.card .tele .seen, .card .tele .k { color: var(--text-3); }
.meter { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-2); }
.meter .bar { width: 44px; height: 4px; border-radius: 2px; background: var(--hair-strong); overflow: hidden; }
.meter .bar i { display: block; height: 100%; background: var(--text-2); }
.meter.warn { color: var(--warn); }
.meter.warn .bar i { background: var(--warn); }
/* The router log, collapsed: its kicker line and the newest line under the cards, which take the rest. */
.agents .scroll { flex: 1 1 auto; }
.agents .foot { flex: none; padding: 10px 16px 12px; border-top: 1px solid var(--hair); font-family: var(--mono); font-size: var(--fs-mono); line-height: 1.6; color: var(--text-3); display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
.agents .foot .k { margin-left: 2px; }
.agents .foot:not(.open) .tail > div:not(:last-child) { display: none; }
/* Open (r): the cards take what they need; the log fills the rest, newest line at the bottom, at least four lines. */
.agents:has(.foot.open) .scroll { flex: 0 1 auto; }
.agents .foot.open { flex: 1 1 0; min-height: calc(4 * 1.6 * var(--fs-mono) + 46px); /* four lines plus the heading line and padding */ }
/* A line clipped at the top fades out instead of showing half its height. */
.agents .foot.open .lines { flex: 1; min-height: 0; position: relative; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, transparent, #000 1.6em); mask-image: linear-gradient(to bottom, transparent, #000 1.6em); }
.agents .foot.open .lines .tail { position: absolute; left: 0; right: 0; bottom: 0; }
.agents .foot div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agents .foot b { font-weight: 500; color: var(--text-2); }

/* Tasks: three groups, rows of two lines. */
.filter { margin: 0 10px 4px; display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border: 1px solid var(--hair); border-radius: 100px; background: var(--canvas); color: var(--text-3); font-size: var(--fs-small); }
.filter input { flex: 1; border: 0; background: transparent; padding: 0; min-width: 0; }
.filter kbd, kbd.k { font-family: var(--mono); font-size: calc(var(--fs-mono) - 1px); border: 1px solid var(--hair); border-radius: 4px; padding: 1px 5px; color: var(--text-3); }
textarea::placeholder, .filter input::placeholder { color: var(--text-3); }
.group { margin-top: 6px; }
.group > h3 { display: flex; align-items: baseline; gap: 8px; padding: 6px 16px 4px; cursor: pointer; }
.group > h3 .n { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.group > h3 .chev { font-family: var(--mono); color: var(--text-3); transition: transform var(--t-fast) var(--std); display: inline-block; }
.group.collapsed > h3 .chev { transform: rotate(-90deg); }
.group.collapsed .task { display: none; }
.group .empty { padding: 2px 16px 6px; font-size: var(--fs-small); color: var(--text-3); }
.task { position: relative; display: grid; grid-template-columns: 8px 1fr auto; column-gap: 10px; margin: 0 10px; padding: var(--row-pad); border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background var(--t-fast) var(--std); }
.task:hover { background: var(--wash); }
.task.selected { background: var(--press); border-color: var(--hair-strong); }
.task.focused { outline: 2px solid var(--text); outline-offset: 1px; }
.task .line1 { grid-column: 2; display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.task .line1 .excerpt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs); color: var(--text); }
.task .age { grid-column: 3; grid-row: 1; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; }
.task .line2 { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; font-size: var(--fs-small); color: var(--text-2); min-width: 0; margin-top: 1px; }
.task .line2 .state { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; white-space: nowrap; color: var(--text-2); }
/* The line wraps rather than squeeze the sub below 8em: the route (the sender, the recipient, a late warning) moves
   under it whole, still at the right, and a name too long for the line ends in an ellipsis, whole in its title. */
.task .line2 .sub { flex: 1 1 8em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task .line2 .route { display: flex; gap: 0 8px; align-items: baseline; max-width: 100%; margin-left: auto; }
.task .line2 .to { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.task .line2 .to + .to::before, .task .line2 .to + .stale::before { content: "· "; }
.task .line2 .to + .stale::before { color: var(--text-3); }
.task .line2 .stale { white-space: nowrap; flex: none; }
/* A notice never waits on the viewer: outcomes stay in the text colours, withdrawn muted. */
td .outcome.withdrawn { color: var(--text-3); }
.task.ask .state, .task.fail .state { color: var(--accent); }
.task.done .excerpt { color: var(--text-2); }
.task.done.canceled .state { color: var(--text-3); }

/* Detail: head, transcript, the one form the viewer can act with, then the facts. */
.detail .head { padding: 14px 18px 12px; border-bottom: 1px solid var(--hair); }
.detail .head .title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail .head h2 { flex: 1 1 0; min-width: 0; font-size: calc(var(--fs) + 4px); font-weight: 500; letter-spacing: -.3px; line-height: 1.25; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.detail .head h2 .id { color: var(--text-3); margin-right: 6px; }
.detail .head .meta { margin-top: 4px; font-size: var(--fs-small); color: var(--text-2); }
.detail .head .meta [title] { cursor: help; }
.detail .head .meta .end { white-space: nowrap; }
.detail .head .actions { display: flex; gap: 6px; margin-left: auto; }
.thread { padding: 14px 18px 4px; display: flex; flex-direction: column; gap: 8px; }
.msg { max-width: 90%; padding: 8px 12px; border-radius: 10px; white-space: pre-wrap; word-break: break-word; font-size: var(--fs); line-height: 1.5; color: var(--text-2); border: 1px solid var(--hair); }
.msg .who { display: block; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; color: var(--text-3); margin-bottom: 3px; }
.msg.you { align-self: flex-end; background: var(--surface-2); color: var(--text); border-bottom-right-radius: 4px; }
.msg.you .who { color: var(--text-2); }
.msg.agent { align-self: flex-start; border-bottom-left-radius: 4px; }
.msg.question { background: var(--accent-soft); border-color: var(--accent-line); color: var(--text); }
.msg.question .who { color: var(--accent); }
.sys { align-self: center; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); text-align: center; }
.form { margin: 12px 18px 6px; padding: 10px 12px; border: 1px solid var(--accent-line); border-radius: 12px; display: grid; gap: 6px; }
.form .to { font-size: var(--fs-small); color: var(--text-2); }
.form .to b { color: var(--accent); font-weight: 500; }
.form textarea, .peek textarea { width: 100%; min-height: 52px; resize: vertical; padding: 8px 10px; border: 1px solid var(--hair); border-radius: 10px; background: var(--canvas); color: var(--text); font-size: var(--fs); }
.form textarea:focus, .peek textarea:focus { outline: 2px solid var(--text); outline-offset: 0; border-color: transparent; }
.row { display: flex; gap: 8px; align-items: center; }
.hint { font-size: var(--fs-mono); color: var(--text-3); }
.choices { display: flex; gap: 6px; flex-wrap: wrap; }
.choices .btn { display: inline-flex; gap: 6px; align-items: baseline; }
.choices .btn .p { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.choices .btn.accent .p { color: var(--on-accent); opacity: .8; }
.facts { padding: 0 18px 16px; display: grid; gap: 12px; }
.facts h3 { margin-bottom: 4px; }
table { border-collapse: collapse; width: 100%; font-size: var(--fs-small); }
td, th { text-align: left; padding: 5px 10px 5px 0; border-bottom: 1px solid var(--hair-soft); vertical-align: middle; }
th { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; letter-spacing: .3px; color: var(--text-3); white-space: nowrap; }
td:last-child, th:last-child { text-align: right; padding-right: 0; }
.code { border: 1px solid var(--hair); border-radius: 10px; background: var(--canvas); overflow: hidden; }
.code .top { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--hair-soft); }
.code .top span { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.code pre { margin: 0; padding: 8px 12px; font-family: var(--mono); font-size: var(--fs-mono); line-height: 1.6; color: var(--text-2); white-space: pre-wrap; }

.keys { display: flex; gap: 16px; align-items: center; padding: 0 20px; border-top: 1px solid var(--hair); background: var(--canvas); font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.keys > span { white-space: nowrap; }
.keys kbd { font-family: var(--mono); font-weight: 500; color: var(--text-2); }

/* The peek, the sheet and the help are the three overlays, and the only places a shadow is allowed. */
.peek { position: fixed; z-index: 60; width: 420px; padding: 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); box-shadow: 0 24px 48px var(--shadow); display: grid; gap: 8px; cursor: default; animation: rise var(--t-fast) var(--std) both; }
.peek::before { content: ""; position: absolute; left: -6px; top: 22px; width: 10px; height: 10px; background: var(--surface-2); border-left: 1px solid var(--hair-strong); border-bottom: 1px solid var(--hair-strong); transform: rotate(45deg); }
.peek .top { display: flex; align-items: center; gap: 8px; }
.peek .top .spacer { flex: 1; }
.peek .q { white-space: pre-wrap; font-size: var(--fs); color: var(--text); line-height: 1.5; padding: 8px 10px; border-radius: 8px; background: var(--accent-soft); border: 1px solid var(--accent-line); }
/* The help: the keys in two columns, bottom right over the detail; the theme switch is its last row. */
.help { position: fixed; z-index: 70; right: 24px; bottom: 52px; width: 320px; padding: 12px 14px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--hair-strong); box-shadow: 0 24px 48px var(--shadow); display: grid; gap: 8px; animation: rise var(--t-fast) var(--std) both; }
.help[hidden] { display: none; }
.help .top { display: flex; align-items: center; }
.help .top .spacer { flex: 1; }
.help .grid { display: grid; grid-template-columns: 56px 1fr; column-gap: 12px; row-gap: 3px; align-items: baseline; font-size: var(--fs-small); color: var(--text-2); }
.help .grid kbd { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text); }
.help .grid .sub { grid-column: 1 / -1; margin-top: 6px; }
.help .theme { display: flex; align-items: center; justify-content: space-between; padding-top: 8px; border-top: 1px solid var(--hair); font-size: var(--fs-small); color: var(--text-2); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

/* The sheet: one placement's health, laid over the tasks column from the rail's right edge; nothing dims.
   Positioned in the tasks panel's grid area, it spans the board's full height and takes the column's width, at
   most 560px, so the detail stays whole; only from 901px to 1180px may it spill over the detail (see that query).
   Every placement's sheet is in the page, hidden, until the script shows one. */
.bento { position: relative; }
.bento > .sheet { grid-area: 1 / 2 / 2 / 3; position: absolute; inset: 0 auto 0 0; z-index: 50; width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--hair-strong); border-radius: 12px; box-shadow: 0 24px 48px var(--shadow); display: flex; flex-direction: column; overflow: hidden; animation: slide var(--t-mid) var(--emph) both; }
@keyframes slide { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
.sheet .head { padding: 14px 18px 12px; border-bottom: 1px solid var(--hair); display: grid; gap: 6px; }
.sheet .head .name { display: flex; align-items: center; gap: 10px; }
.sheet .head .name .dot { margin-top: 0; }
.sheet .head h2 { font-size: calc(var(--fs) + 4px); font-weight: 500; letter-spacing: -.3px; line-height: 1.25; }
.sheet .head h2 { flex: 1; min-width: 0; }
.sheet .close, .usage .close { width: 28px; height: 28px; border-radius: 8px; border: 0; background: transparent; color: var(--text-3); font-size: 18px; line-height: 1; cursor: pointer; transition: background var(--t-fast) var(--std), color var(--t-fast) var(--std); }
.sheet .close:hover, .usage .close:hover { background: var(--wash); color: var(--text); }
.sheet .head .tele { display: flex; gap: 10px; align-items: center; font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.sheet .head .tele .line { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sheet .head .tele .ask { color: var(--accent); font-weight: 500; }
.sheet .head .tele .err { text-decoration: underline dotted var(--text-3); text-underline-offset: 3px; cursor: help; }
.sheet .head .tele .k, .sheet .head .tele .seen { color: var(--text-3); }
.sheet .head .rig { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; }
.sheet .body { min-height: 0; overflow-y: auto; padding: 4px 18px 18px; display: grid; align-content: start; gap: 4px; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.sheet section { padding: 12px 0 8px; border-bottom: 1px solid var(--hair-soft); display: grid; gap: 6px; }
.sheet section:last-child { border-bottom: 0; }
.sheet section > h3 { display: flex; align-items: baseline; gap: 10px; }
.sheet section > h3 .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }
.sheet .none { font-size: var(--fs-small); color: var(--text-3); }
.sheet .muted { color: var(--text-3); }
/* Roles colour words, never fills. */
.role-ok { color: var(--ok); }
.role-warn { color: var(--warn); }
.role-err { color: var(--err); }
/* Checkout: label, value. */
.kv { display: grid; grid-template-columns: 84px 1fr; font-size: var(--fs-small); }
.kv > dt, .kv > dd { margin: 0; padding: 5px 0; border-bottom: 1px solid var(--hair-soft); min-width: 0; }
.kv > dt { color: var(--text-3); }
/* A value row keeps each part whole and wraps the next one under it; a part wider than the row ends in an ellipsis,
   whole in its title. An activity row does the same, its text taking the rest of a line or the next one. */
.kv > dd { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; color: var(--text); }
.kv > dt:nth-last-of-type(1), .kv > dd:last-of-type { border-bottom: 0; }
.kv > dd > * { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Subagents: a tree one level deep; a child hangs under its parent from a hairline guide. */
.counts-line { font-size: var(--fs-small); color: var(--text-2); }
.subs { display: grid; gap: 2px; }
.subs .kids { margin-left: 3px; padding-left: 16px; border-left: 1px solid var(--hair-strong); display: grid; gap: 2px; }
.subagent { display: grid; grid-template-columns: 8px auto 1fr 84px 84px; column-gap: 10px; align-items: center; padding: 5px 0; font-size: var(--fs-small); }
.subagent .dot { margin-top: 0; }
.subagent .title { font-weight: 500; color: var(--text); white-space: nowrap; }
.subagent .desc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.subagent .when { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; text-align: right; }
/* Activity: the last eight, oldest first; a running tool is the current row, in the text colour with the pulse dot. */
.feed { display: grid; }
.feed .item { display: grid; grid-template-columns: 8px 70px 76px 1fr; column-gap: 10px; align-items: baseline; padding: 4px 0; font-size: var(--fs-small); color: var(--text); }
.feed .item .mark { align-self: center; width: 6px; height: 6px; border-radius: 50%; }
.feed .item .mark.work { width: 8px; height: 8px; background: var(--text); animation: pulse 2s var(--std) infinite; }
.feed .item .at { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); }
.feed .item .kind { color: var(--text-2); }
.feed .item .what { display: flex; flex-wrap: wrap; gap: 0 8px; align-items: baseline; min-width: 0; }
.feed .item .tool { font-weight: 500; }
.feed .item .tool, .feed .item .status { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.feed .item .status { color: var(--text-2); }
.feed .item .status.running { color: var(--text); }
.feed .item .text { flex: 1 1 8em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.feed .item.error, .feed .item.error .kind, .feed .item.error .text { color: var(--err); }
.feed .item.quiet, .feed .item.quiet .kind, .feed .item.quiet .text { color: var(--text-3); }

/* Usage (v0.13): a pop-up beside the rail, over the tasks column as the health sheet, the board in view behind it (no
   scrim); the surface, border, radius and shadow of the sheet. Its body scrolls between the head and the key line. */
.usage { position: fixed; z-index: 65; top: 62px; left: 12px; width: min(640px, calc(100vw - 24px)); max-height: calc(100vh - 62px - 46px); display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--hair-strong); border-radius: 12px; box-shadow: 0 24px 48px var(--shadow); overflow: hidden; animation: rise var(--t-fast) var(--std) both; }
.usage[hidden] { display: none; }
.usage .top { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 16px; border-bottom: 1px solid var(--hair); }
.usage .top .spacer { flex: 1; }
.usage .fresh { font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); white-space: nowrap; cursor: help; }
.usage .body { min-height: 0; overflow-y: auto; padding-bottom: 8px; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
.usage .group-h { display: flex; align-items: baseline; gap: 10px; padding: 12px 10px 4px; }
.usage .group-h .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text-3); }
/* Ledger: one six-column grid for both groups, so subscriptions and balances align: lead 84 | name | figure 64 |
   meter 140 | note 72 | when 128, at the board's row density, a hairline between accounts. */
.ledger { display: grid; }
.account + .account { border-top: 1px solid var(--hair-soft); }
.entry { display: grid; grid-template-columns: 84px minmax(96px, 1fr) 64px 140px 72px 128px; column-gap: 6px; align-items: start; padding: var(--row-pad); font-size: var(--fs-small); color: var(--text-2); }
.entry > * { min-width: 0; line-height: 18px; }
.entry > .lead { display: grid; justify-items: start; }
.entry .toggle { display: flex; gap: 5px; align-items: baseline; max-width: 100%; padding: 0; border: 0; background: none; font-weight: 500; color: var(--text); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.entry .toggle::before { content: "▸"; flex: none; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text-3); transition: transform var(--t-fast) var(--std); }
.entry .toggle[aria-expanded="true"]::before { transform: rotate(90deg); }
.entry > .name { color: var(--text); overflow-wrap: anywhere; }
.entry > .name.muted { color: var(--text-2); cursor: help; }
.entry > .name.quiet { color: var(--text-3); }
.entry.bare > .name { grid-column: 2 / -1; }
.entry > .words { grid-column: 3 / -1; color: var(--text-2); cursor: help; overflow-wrap: anywhere; }
.entry > .figure { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); font-weight: 500; color: var(--text); white-space: nowrap; font-variant-numeric: tabular-nums; }
.entry > .meter { display: flex; height: 18px; }
.entry > .note { white-space: nowrap; color: var(--text-3); }
.entry > .note.ahead { color: var(--warn); }
.entry > .when { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--text-2); }
.entry > .when[title] { cursor: help; }
.entry > .when.quiet { color: var(--text-3); }
.entry.warn > .figure { color: var(--warn); }
.entry.err > .figure { color: var(--err); }
/* A passed reset says nothing of now: the figure and time in text-3, the meter's track alone. */
.entry.passed > .figure, .entry.passed > .when { color: var(--text-3); }
/* A stale account dims every cell but its lead, band hues with them; its status line stays at text-2. */
.account.stale .entry > :not(.lead) { opacity: .55; }
/* The note's warn hue reads strong even at .55; a stale account's note drops to text-2 with the rest. */
.account.stale .entry > .note.ahead { color: var(--text-2); }
.badge.sm { font-size: calc(var(--fs-mono) - 1.5px); padding: 1px 6px; line-height: 14px; }
.badge.at-narrow { display: none; }
.account .status { display: grid; grid-template-columns: 84px minmax(0, 1fr); column-gap: 6px; align-items: start; padding: 0 10px 8px; font-size: var(--fs-small); line-height: 18px; color: var(--text-2); overflow-wrap: anywhere; }
.account .status .mono { color: var(--text); }
/* The wide meter takes its cell; the 2px pace tick marks the elapsed share of the window. */
.meter.wide .bar { flex: 1; width: auto; }
.meter.err { color: var(--err); }
.meter.err .bar i { background: var(--err); }
.meter .bar.paced { position: relative; overflow: visible; }
.meter .bar.paced i { border-radius: 2px; }
.meter .bar .pace { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--text); }
/* Details: under the account's rows, indented to the name column. */
.more { display: grid; gap: 6px; padding: 0 10px 12px calc(10px + 84px + 6px); font-size: var(--fs-small); color: var(--text-2); min-width: 0; }
.more[hidden] { display: none; }
.more .dt { display: grid; gap: 6px; min-width: 0; padding-top: 4px; }
.more h4 { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin: 0; font-size: var(--fs-small); font-weight: 500; color: var(--text); }
.more h4 .n { font-family: var(--mono); font-size: var(--fs-mono); font-weight: 400; color: var(--text-3); }
.more h4.kicker { margin-top: 2px; }
.pairs { display: flex; flex-wrap: wrap; gap: 2px 16px; margin: 0; }
.pairs > div { display: flex; gap: 6px; align-items: baseline; min-width: 0; }
.pairs dt { color: var(--text-3); }
.pairs dd { margin: 0; font-family: var(--mono); font-size: var(--fs-mono); color: var(--text); font-variant-numeric: tabular-nums; }
/* A table is as wide as its content and scrolls sideways in its own box, never the page. */
.scroll-x { max-width: 100%; width: fit-content; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--hair-strong) transparent; }
table.data { width: fit-content; }
table.data td, table.data th { padding: 1px 14px 1px 0; line-height: 18px; }
.scroll-x td, .scroll-x th { white-space: nowrap; }
td.num, th.num { text-align: right; font-family: var(--mono); font-size: var(--fs-mono); font-variant-numeric: tabular-nums; }
table.data td:last-child, table.data th:last-child { text-align: left; }
table.data td.num:last-child, table.data th.num:last-child { text-align: right; }
table.data td.bar { width: 88px; padding-right: 0; }
table.data td.bar i { display: block; height: 4px; border-radius: 2px; background: var(--text-3); }
table.data tr.gap td { color: var(--text-3); }
table.data tr.all td { border-bottom: 0; }
.days { padding: 0; border: 0; background: none; color: var(--text-2); font-size: var(--fs-small); text-decoration: underline; text-decoration-color: var(--hair-strong); text-underline-offset: 3px; cursor: pointer; }

/* 901-1180px: the rail is a fixed 272px column, the tasks and detail share the rest. */
@media (min-width: 901px) and (max-width: 1180px) {
  .bento { grid-template-columns: 272px minmax(0, 4fr) minmax(0, 5fr); }
  .nav .who { max-width: 160px; }
  /* The sheet is an overlay, so it spills over the detail rather than hide its close button (design/README.md). */
  .bento > .sheet { min-width: 320px; }
}
/* 1279px and less: a card's first line holds the dot, the name (one line, ellipsized) and the meter; its status
   takes its own line under the name, then the health row with the lever, and the facts table's heads may wrap.
   The design draws the card this way from 1180px down; design/README.md says why the page starts higher. */
@media (max-width: 1279px) {
  .cards { grid-template-columns: minmax(0, 1fr); }
  .card .stats { min-width: 0; overflow: hidden; }
  .card .body { grid-template-columns: minmax(0, 1fr); }
  .card .name .key { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card.idle .body { grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; }
  .card.idle .tele { display: contents; }
  .card.idle .name { grid-area: 1 / 1; }
  .card.idle .tele > .meter { grid-area: 1 / 2; align-self: center; }
  .card.idle .what { grid-area: 2 / 1 / 3 / 3; }
  .card.idle .tele > .line { grid-area: 3 / 1; font-size: var(--fs-small); color: var(--text-2); }
  .card.idle .tele > .lever { grid-area: 3 / 2; align-self: center; }
  table.rec th { white-space: normal; }
}
/* 1180px and less: facts tables become records (the detail column is too narrow for six columns from here down):
   the key cells on the first line, the rest labelled on the second. */
@media (max-width: 1180px) {
  table.rec, table.rec tbody { display: block; }
  table.rec tr:has(> th) { display: none; }
  table.rec tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 6px 0; border-bottom: 1px solid var(--hair-soft); }
  table.rec tr::before { content: ""; order: 1; flex: 0 0 100%; }
  table.rec td { order: 2; display: block; min-width: 0; padding: 0; border: 0; text-align: left; overflow-wrap: anywhere; }
  table.rec td.key { order: 0; }
  table.rec td[data-label]::before { content: attr(data-label) " "; color: var(--text-3); }
}
/* 900px and less: one column that scrolls as a page, in DOM order (rail, tasks, detail). */
@media (max-width: 900px) {
  html, body { height: auto; }
  body { overflow: visible; }
  #app { height: auto; min-height: 100vh; grid-template-rows: auto auto auto; }
  /* The head wraps: brand, who and the links on the first line; the chips and the tick below. */
  .nav { flex-wrap: wrap; gap: 6px 10px; padding: 10px 14px; }
  .nav .who { flex: 1 1 0; max-width: none; }
  .nav .spacer { display: none; }
  .nav nav { order: 1; }
  .nav .br { display: block; order: 2; flex: 0 0 100%; height: 0; }
  .nav .counts { order: 3; flex-wrap: wrap; margin-left: 0; }
  .nav .tick { order: 4; }
  .bento { grid-template-columns: minmax(0, 1fr); padding: 8px; }
  .bento > .agents, .bento > .tasks, .bento > .detail { grid-area: auto; }
  .panel, .scroll { overflow: visible; }
  /* The sheet, the usage and the peek take the screen's width. */
  .bento > .sheet { grid-area: auto; position: fixed; inset: 0; max-width: none; border-radius: 0; }
  .peek { left: 12px; right: 12px; width: auto; top: 120px; }
  .peek::before { display: none; }
  /* The open usage is the page: the board under it hides, and the sheet scrolls as a page. */
  .usage { position: absolute; inset: 0 0 auto 0; min-height: 100vh; width: auto; max-height: none; overflow: visible; border: 0; border-radius: 0; box-shadow: none; }
  .usage .body { overflow: visible; }
  body:has(> .usage:not([hidden])) > #app { display: none; }
  .usage .top kbd { display: none; }
  /* The key line keeps only what a tap can do. */
  .keys { padding: 8px 14px; gap: 18px; }
  .keys > span:not([data-key]) { display: none; }
  .keys > span[data-key] { cursor: pointer; padding: 4px 0; }
  /* A ledger row wraps: the lead on its own line, then the name with its figure, the meter across, the note left
     and the time right; the status line and the details drop their indent. */
  .entry { display: flex; flex-wrap: wrap; gap: 4px 10px; }
  .entry > :empty { display: none; }
  .entry > .lead { flex: 1 1 100%; display: flex; align-items: baseline; gap: 8px; }
  .entry > .name { order: 1; flex: 1 1 0; }
  .entry > .figure, .entry > .words { order: 2; }
  .entry > .meter { order: 4; flex: 1 1 100%; height: 10px; }
  .entry > .note { order: 5; }
  .entry > .when { order: 6; margin-left: auto; }
  .account .status, .more { padding-left: 10px; }
  /* The badge follows the name; the second line's lead holds nothing then. */
  .badge.at-narrow { display: inline-block; }
  .entry > .lead.badge-lead { display: none; }
  .account .status { display: block; }
  .account .status > .lead { display: none; }
}

/* The live page. A row opens its task through the link on its id, stretched
   over the row, so rows work without a script; the row shows its focus. */
.task[hidden], .peek[hidden], .bento > .sheet[hidden] { display: none; }
.task a.id { text-decoration: none; }
.task a.id::after { content: ""; position: absolute; inset: 0; border-radius: 8px; }
.task a.id:focus-visible { outline: none; }
.task:has(a.id:focus-visible) { outline: 2px solid var(--text); outline-offset: 1px; }
a.btn, .card a.id { text-decoration: none; }
.card a.id:hover { text-decoration: underline; }
.lever form, .actions form, .peek form { display: contents; }
/* Blue is the viewer's: an item that waits on someone else, or that the
   viewer cannot act on here, drops it. */
.form.ro { border-color: var(--hair); }
.form.ro .to b { color: var(--text); }
.peek .q.wait { background: transparent; border-color: var(--hair-strong); }
.choices input { flex: 1; min-width: 10rem; padding: 6px 12px; border: 1px solid var(--hair); border-radius: 100px; background: var(--canvas); color: var(--text); }
.notice { position: fixed; z-index: 70; top: 60px; left: 50%; transform: translateX(-50%); display: flex; gap: 12px; align-items: baseline; max-width: calc(100vw - 32px); padding: 8px 14px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--hair-strong); font-size: var(--fs-small); }
.keys > span[data-key] { cursor: pointer; }
/* A usage row and the pop-up's close button are links, so a page without a script opens and closes the pop-up
   (?usage); the script toggles it in place. */
a.acct, .usage a.close { text-decoration: none; }
.usage a.close { display: inline-grid; place-items: center; }
/* A day table's older rows show without a script; "all n days" shows while the script keeps them shut. */
table.data:has(> tbody.older:not([hidden])) tr.all { display: none; }
`;
