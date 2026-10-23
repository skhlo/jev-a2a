// PROTOTYPE: in-memory sample stories, no router integration or persistence.
// Question: which home makes a small agent society understandable and inviting?
import { commandHome, commandSceneSelection } from "./command.js";
const app = document.querySelector("#app");
const layer = document.querySelector("#layer");
const announcer = document.querySelector("#announcer");
const variants = ["A", "B", "C", "D"];
const names = { A: "Commons", B: "Dispatch", C: "Constellation", D: "Command" };
const requested = new URLSearchParams(location.search).get("variant");
const state = {
  variant: variants.includes(requested) ? requested : "A",
  page: "home",
  commandScene: "today",
  commandSelection: "base:office",
  focus: "research",
  zoom: 1,
  layers: [],
  decision: null,
  requests: [],
  motion: !matchMedia("(prefers-reduced-motion: reduce)").matches,
};
let opener;
let handoffTimer;
let answerTimer;
let commandTimer;

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

const paths = {
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  book: '<path d="M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v14c-4-1-7 0-9 2-2-2-5-3-9-2Z"/>',
  computer:
    '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  document: '<path d="M14 3H5v18h14V8Zm0 0v5h5M8 12h8m-8 4h6"/>',
  spark:
    '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
  services:
    '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6h.01M8 17h.01m4-11h4m-4 11h4"/>',
  studio: '<path d="m4 18 1-5L16 2l6 6-11 11-5 1Zm1-5 6 6m2-14 6 6M2 23h20"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  pause: '<path d="M9 5v14m6-14v14"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18"/>',
};
function icon(name, cls = "") {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.spark}</svg>`;
}
function mark(kind = "office", cls = "") {
  const shapes = {
    office:
      '<path d="M13 12h20v26H13z" fill="currentColor"/><path d="M19 18h8m-8 5h8" stroke="var(--avatar-line, #fff)" stroke-width="2"/><circle cx="20" cy="29" r="1.7" fill="var(--avatar-line, #fff)"/><circle cx="27" cy="29" r="1.7" fill="var(--avatar-line, #fff)"/>',
    local:
      '<path d="M11 25c0-10 8-16 23-16 2 15-3 25-14 25H11Z" fill="currentColor"/><path d="m14 32 13-13" stroke="var(--avatar-line, #fff)" stroke-width="1.4"/><circle cx="22" cy="22" r="1.7" fill="var(--avatar-line, #fff)"/><circle cx="28" cy="22" r="1.7" fill="var(--avatar-line, #fff)"/>',
    linux:
      '<path d="m23 7 17 29H6Z" fill="currentColor"/><circle cx="19" cy="27" r="1.8" fill="var(--avatar-line, #fff)"/><circle cx="27" cy="27" r="1.8" fill="var(--avatar-line, #fff)"/>',
    mac: '<rect x="10" y="10" width="26" height="26" rx="13" fill="currentColor"/><circle cx="19" cy="23" r="1.8" fill="var(--avatar-line, #fff)"/><circle cx="27" cy="23" r="1.8" fill="var(--avatar-line, #fff)"/>',
  };
  return `<span class="agent-mark ${kind} ${cls}"><svg viewBox="0 0 46 46" aria-hidden="true">${shapes[kind] ?? shapes.office}</svg></span>`;
}
const agents = {
  office: {
    name: "Office",
    host: "mini",
    kind: "office",
    role: "The keeper of shared knowledge",
    place: "Office",
    description:
      "I look after the shared Office: its documents, decisions, and the connections between them. I coordinate with your local Office so useful work can travel with you.",
    contribution: "Shared the latest Office changes",
    partner: "local",
  },
  local: {
    name: "Office",
    host: "MacBook Air",
    kind: "local",
    role: "Where shared ideas meet your day",
    place: "Office",
    description:
      "I look after Office on your MacBook Air. I bring shared changes here, help with local material, and send useful discoveries back to Office on mini.",
    contribution: "Brought both Office checkouts up to date",
    partner: "office",
  },
  linux: {
    name: "Dotfiles",
    host: "Linux laptop",
    kind: "linux",
    role: "A familiar home on Linux",
    place: "Computers",
    description:
      "I care for the configuration on your Linux laptop. I work with the other device agents to share useful changes while preserving what belongs to this machine.",
    contribution: "Checked the shared configuration changes",
    partner: "mac",
  },
  mac: {
    name: "Dotfiles",
    host: "MacBook Air",
    kind: "mac",
    role: "A familiar home on your Mac",
    place: "Computers",
    description:
      "I care for this Mac's configuration and help shared changes fit its conventions. When this machine is available, I coordinate with the other device agents.",
    contribution: "Waiting to check the latest shared changes",
    partner: "linux",
  },
};
function agentButton(id, compact = false) {
  const agent = agents[id];
  return `<button class="agent-chip ${compact ? "compact" : ""}" data-open="agent:${id}">${mark(agent.kind)}<span>${agent.name}<small>${agent.host}</small></span></button>`;
}
function officeArt() {
  return `<svg class="place-art office-art" viewBox="0 0 520 210" fill="none" aria-hidden="true">
    <ellipse cx="260" cy="184" rx="153" ry="13" fill="#cadaCE" opacity=".45"/>
    <g class="sheet sheet-back" transform="rotate(-12 206 108)"><rect x="136" y="35" width="123" height="143" rx="8" fill="#e4e9d9" stroke="#aab7a3"/><path d="M156 62h73m-73 13h58m-58 13h67" stroke="#aab7a3" stroke-width="3"/></g>
    <g class="sheet sheet-front" transform="rotate(9 287 108)"><rect x="220" y="27" width="129" height="151" rx="8" fill="#fffef5" stroke="#aab7a3"/><path d="M241 54h35" stroke="#a5ae90" stroke-width="4"/><path d="M241 69h87m-87 11h74m-74 11h80" stroke="#d2d6c4" stroke-width="3"/><rect x="241" y="110" width="87" height="45" rx="3" fill="#e8eddc"/><path d="m253 143 20-17 16 9 25-16" stroke="#99ab86" stroke-width="2"/></g>
    <g class="art-spark" stroke="#85966f" stroke-width="1.5"><path d="M377 59v14m-7-7h14M111 126v10m-5-5h10"/></g>
    <path class="handoff-path" d="M83 156C114 95 380 212 437 132" stroke="#95ac92" stroke-dasharray="3 7"/>
    <g class="paper-parcel"><rect x="-8" y="-6" width="16" height="12" rx="2" fill="#60846b"/><path d="m-7-5 7 5 7-5" stroke="#fffef5"/></g>
  </svg>`;
}
function computerArt() {
  return `<svg class="place-art computer-art" viewBox="0 0 520 210" fill="none" aria-hidden="true">
    <ellipse cx="260" cy="185" rx="155" ry="12" fill="#d9c9ba" opacity=".45"/>
    <g transform="translate(100 39) rotate(-6 70 70)"><rect x="0" y="0" width="150" height="105" rx="8" fill="#e9d9c6" stroke="#b29b83"/><rect x="8" y="8" width="134" height="86" rx="3" fill="#f8efe0"/><path d="m25 37 13 9-13 9m23 0h27" stroke="#af896b" stroke-width="3"/><path d="M-13 109h176l-12 10H0Z" fill="#cdb69d" stroke="#b29b83"/></g>
    <g transform="translate(287 73) rotate(7 58 50)"><rect width="116" height="78" rx="6" fill="#dbc8b5" stroke="#b29b83"/><rect x="7" y="7" width="102" height="62" rx="2" fill="#fcf5e9"/><path d="M24 29h65M24 40h43m-43 11h51" stroke="#d0baa0" stroke-width="3"/><path d="M-12 82h140l-12 8H0Z" fill="#cdb69d" stroke="#b29b83"/></g>
    <path d="M238 63c24-30 44-25 62-3" stroke="#b08c69" stroke-dasharray="3 6"/><circle cx="266" cy="44" r="12" fill="#fbf4e7" stroke="#b7a38a"/><path d="m261 44 4 4 7-7" stroke="#8e9b6e" stroke-width="2"/>
    <g class="art-spark" stroke="#b3916e" stroke-width="1.5"><path d="M425 51v14m-7-7h14M75 132v10m-5-5h10"/></g>
  </svg>`;
}
function invitation() {
  return `<section class="invitation"><div class="section-label"><span>WITH YOU</span><span class="count">${state.decision ? "0" : "1"}</span></div>
    ${state.decision ? `<div class="invitation-face">${icon("check")}</div><h3>A little direction<br>goes a long way.</h3><p>Office has your preference: organize the research ${state.decision === "project" ? "by project" : "by topic"}.</p><button class="text-link" data-open="work:research">See the shared work ${icon("arrow")}</button>` : `<div class="invitation-face">${mark("office")}${mark("local")}</div><h3>A good place for<br>your scattered ideas.</h3><p>Office has gathered your research notes. How would you like to find them again?</p><button class="text-link" data-open="work:research">Give a little direction ${icon("arrow")}</button><span class="invitation-note">A question from Office · no rush</span>`}
  </section>`;
}
function futurePlaces() {
  return `<section class="future-places"><span class="eyebrow">ROOM TO GROW</span><button data-open="future:services">${icon("services")}<span>Services<small>A future home for Ops</small></span>${icon("plus")}</button><button data-open="future:studio">${icon("studio")}<span>Studio<small>A future home for Design</small></span>${icon("plus")}</button></section>`;
}
function promptButton() {
  return `<button class="intention" data-open="compose:new"><span class="intention-icon">${icon("spark")}</span><span>What would you like to happen?</span><span class="intention-go">${icon("arrow")}</span></button>`;
}
function worldScene() {
  return `<svg class="world-art" viewBox="0 0 1000 680" fill="none" aria-hidden="true">
    <defs>
      <pattern id="world-grid" width="64" height="36" patternUnits="userSpaceOnUse"><path d="m0 18 32-18 32 18-32 18Z" stroke="#c6d2b8" stroke-width=".6" opacity=".25"/></pattern>
      <linearGradient id="office-floor" x1="100" y1="150" x2="550" y2="500" gradientUnits="userSpaceOnUse"><stop stop-color="#e9ead7"/><stop offset="1" stop-color="#cfdcbc"/></linearGradient>
      <linearGradient id="computer-floor" x1="600" y1="300" x2="900" y2="540" gradientUnits="userSpaceOnUse"><stop stop-color="#ecdfc8"/><stop offset="1" stop-color="#d9c5a6"/></linearGradient>
      <linearGradient id="pool-water" x1="470" y1="480" x2="570" y2="560" gradientUnits="userSpaceOnUse"><stop stop-color="#a4bfb0"/><stop offset="1" stop-color="#7da598"/></linearGradient>
      <filter id="soft-shadow"><feGaussianBlur stdDeviation="8"/></filter>
      <g id="plant"><ellipse cx="0" cy="7" rx="16" ry="8" fill="#7d906840"/><path d="m-11-8 3 20 16 0 3-20Z" fill="#c8aa87"/><ellipse cy="-8" rx="11" ry="6" fill="#ad916f"/><path d="M0-8v-37" stroke="#6e8757" stroke-width="3"/><path d="M0-16C-24-20-22-37-19-37 0-34 2-26 0-16Z" fill="#7f9b62"/><path d="M0-26C22-29 24-46 20-47 3-45-1-36 0-26Z" fill="#94ab77"/><path d="M0-36C-11-47-8-57-3-59 8-52 9-43 0-36Z" fill="#b0bd86"/></g>
      <g id="desk"><path d="m-64 11 0 47 7 4 0-47m125-7v47l7-4V4" fill="#ab9472"/><path d="m-68 1 67-38 83 48-66 39Z" fill="#e9d2ae"/><path d="m-68 1 0 10 84 48V50Zm84 49 66-39v10L16 59Z" fill="#c4a781"/><path d="m-58 0 58-31 69 39" stroke="#f9e8cc" stroke-width="2"/><path d="m-3-14 29 17-21 13-29-17Z" fill="#fdf8df"/><path d="m-12-1 15 9m-8-13 15 9" stroke="#b4bd97" stroke-width="2"/><path d="m35 1 12-7 11 6-12 7Z" fill="#8caa87"/></g>
      <g id="workstation"><use href="#desk"/><path d="m-35-13 0-49 55 32v49Z" fill="#6c8170"/><path d="m-30-55 45 26v36L-30-19Z" fill="#cfddba"/><path d="m-22-40 22 13m-22-4 30 17m-30-7 17 10" stroke="#8fa786" stroke-width="2.4"/><path d="m-9 4 1 12 14 8 0-12" fill="#627a68"/><path d="m-18 15 14-8 28 17-14 7Z" fill="#7f9580"/></g>
      <g id="stool"><path d="m-14 0 2 27 6 3 0-27m19-6v26l6-4 0-26" fill="#a4997a"/><path d="m-20-4 19-11 23 13-19 11Z" fill="#c7c7a1"/><path d="m-20-4 0 7 23 13V9Zm23 13 19-11v7L3 16Z" fill="#a9b18c"/></g>
      <g id="bookshelf"><path d="m0-105 61 35v103L0-2Z" fill="#b1a07c"/><path d="m61-70 15-9V24l-15 9Z" fill="#8d886c"/><path d="m0-105 15-9 61 35-15 9Z" fill="#dfcfab"/><path d="m7-92 46 27v35L7-57Zm0 46 46 27v35L7-11Z" fill="#e8dfc1"/><path d="m13-81 5 3v27l-5-3m10-22 5 3v27l-5-3m13-20 7 4v27l-7-4" stroke="#98a77d" stroke-width="4"/><path d="m13-35 6 3v26l-6-3m14-19 7 4v26l-7-4m13-18 5 3v26l-5-3" stroke="#c39777" stroke-width="4"/></g>
    </defs>
    <rect width="1000" height="680" fill="url(#world-grid)"/>
    <ellipse cx="317" cy="390" rx="225" ry="87" fill="#9daf8150" filter="url(#soft-shadow)"/>
    <ellipse cx="748" cy="485" rx="185" ry="65" fill="#9c9d7750" filter="url(#soft-shadow)"/>
    <path d="M310 402 493 508 713 385" stroke="#d9dfc5" stroke-width="29" stroke-linecap="round"/>
    <path d="M310 402 493 508 713 385" stroke="#b8c6a2" stroke-width="1.5" stroke-dasharray="3 10"/>
    <path d="m92 305 226-130 230 133-228 133Z" fill="url(#office-floor)"/>
    <path d="m92 305 0 20 228 133v-17Z" fill="#b1c09c"/><path d="m320 441 228-133v21L320 458Z" fill="#a0b38b"/>
    <path d="m92 305 226-130 230 133" stroke="#f4f2df" stroke-width="3"/>
    <path d="m144 335 228-131m-171 164 228-131m-170 165 228-131M148 273l229 134m-172-166 230 134m-171-167 231 133" stroke="#b8c5a2" stroke-width=".75" opacity=".55"/>
    <path d="m92 305 0-88 226-130v88" fill="#dde2ca"/><path d="m92 217 226-130 7 4-226 131Z" fill="#f5f1db"/><path d="m99 222 0 84-7-1v-88Z" fill="#b3c19d"/>
    <path d="m121 221 0 47 69-40v-47Z" fill="#b7c9a3"/><path d="m126 222 59-34v36l-59 34Z" fill="#f2f2cf"/><path d="m155 205 0 36m-28-1 58-33" stroke="#ccdbb5" stroke-width="3"/>
    <use href="#bookshelf" transform="translate(239 203)"/>
    <use href="#plant" transform="translate(127 302)"/>
    <use href="#desk" transform="translate(284 278)"/>
    <use href="#stool" transform="translate(260 330)"/>
    <use href="#desk" transform="translate(424 347) scale(.72)"/>
    <use href="#stool" transform="translate(413 389) scale(.75)"/>
    <use href="#plant" transform="translate(492 313) scale(.75)"/>
    <path d="m585 391 160-92 193 111-161 94Z" fill="url(#computer-floor)"/>
    <path d="m585 391v19l192 113v-19Z" fill="#c2af8f"/><path d="m777 504 161-94v19l-161 94Z" fill="#b6a180"/>
    <path d="m585 391 160-92 193 111" stroke="#f5e8cc" stroke-width="3"/>
    <path d="m631 418 159-92m-110 121 160-92m-208-58 193 111m-142-140 193 111" stroke="#c0b295" stroke-width=".75" opacity=".6"/>
    <path d="m658 341 0-59 105-61 0 59" fill="#dccbb0"/><path d="m666 337 0-49 88-51v49Z" fill="#c5b998"/><path d="m676 291 29-17v28l-29 17Z" fill="#e9e9ca"/><path d="m714 268 29-17v28l-29 17Z" fill="#f3e3bd"/>
    <use href="#workstation" transform="translate(690 365) scale(.78)"/>
    <use href="#workstation" transform="translate(825 433) scale(.78)"/>
    <use href="#plant" transform="translate(894 417) scale(.8)"/>
    <use href="#stool" transform="translate(686 414) scale(.75)"/>
    <use href="#stool" transform="translate(806 480) scale(.75)"/>
    <path d="m430 530 80-45 83 47-80 46Z" fill="#e1e3c6"/><path d="m430 530v12l83 48v-12m0 0 80-46v12l-80 46" fill="#b8c5a2"/>
    <ellipse cx="513" cy="533" rx="43" ry="24" fill="#c3cbb0"/><ellipse cx="513" cy="529" rx="36" ry="18" fill="url(#pool-water)"/>
    <ellipse class="water-ring" cx="513" cy="529" rx="22" ry="10" stroke="#d8e7ca" stroke-width="1.5"/>
    <path d="m513 527 0-27" stroke="#a1b39a" stroke-width="6" stroke-linecap="round"/><ellipse cx="513" cy="499" rx="13" ry="6" fill="#d9dfbf"/>
    <use href="#plant" transform="translate(407 523) scale(.8)"/><use href="#plant" transform="translate(610 547) scale(.9)"/>
    <path d="m640 171 93-54 100 58-93 53Z" fill="#e1e5d2" opacity=".65"/><path d="m640 171 93-54 100 58-93 53Z" stroke="#b8c5a5" stroke-dasharray="4 6"/>
    <path d="m824 248 63-36 66 38-63 37Z" fill="#e1e5d2" opacity=".65"/><path d="m824 248 63-36 66 38-63 37Z" stroke="#b8c5a5" stroke-dasharray="4 6"/>
    <g fill="#adc091"><ellipse cx="161" cy="461" rx="20" ry="9"/><ellipse cx="845" cy="563" rx="27" ry="12"/><ellipse cx="81" cy="385" rx="14" ry="6"/><ellipse cx="635" cy="245" rx="16" ry="7"/></g>
    <use href="#plant" transform="translate(160 457) scale(1.2)"/><use href="#plant" transform="translate(844 555) scale(1.25)"/>
  </svg>`;
}
function sprite(id, position) {
  const agent = agents[id];
  return `<button class="world-agent ${id} ${state.focus === "computers" ? (agent.place === "Computers" ? "involved" : "") : agent.place === "Office" ? "involved" : ""}" style="left:${position[0]}%;top:${position[1]}%" data-open="agent:${id}" aria-label="Meet ${agent.name} on ${agent.host}">
    <svg viewBox="0 0 64 76" aria-hidden="true"><ellipse cx="32" cy="68" rx="22" ry="8" fill="#617d5730"/><g class="sprite-body"><path d="M19 46 16 62l9 4 7-8 8 8 9-4-4-18Z" fill="currentColor"/><rect x="12" y="12" width="40" height="39" rx="${id === "linux" ? "12" : "19"}" fill="currentColor"/><ellipse cx="30" cy="22" rx="14" ry="7" fill="#ffffff20"/><rect x="18" y="28" width="28" height="13" rx="6.5" fill="#f6f3dc"/><circle cx="25" cy="34" r="2.2" fill="#3f5143"/><circle cx="39" cy="34" r="2.2" fill="#3f5143"/><path d="m17 48-8 7m39-7 6 5" stroke="currentColor" stroke-width="7" stroke-linecap="round"/>${id === "office" || id === "local" ? '<path d="m40 45 15 5-5 18-15-5Z" fill="#f8f0d4"/><path d="m42 51 8 3m-10 2 8 3" stroke="#a9b58c"/>' : '<path d="m39 48 13 4-4 12-13-4Z" fill="#c3d5a3"/>'}</g></svg>
    <span class="sprite-name">${agent.name}<small>${agent.host}</small></span>
  </button>`;
}
function missionJournal() {
  return `<aside class="mission-journal"><div class="journal-heading"><span>Mission journal</span><span class="journal-count">3</span></div>${[
    "research",
    "computers",
    "sync",
  ]
    .map((id) => {
      const item = work[id];
      return `<button class="mission-entry ${state.focus === id ? "active" : ""}" data-mission="${id}" aria-pressed="${state.focus === id}"><span class="mission-glyph ${id}">${id === "research" ? (state.decision ? icon("check") : "?") : icon(id === "sync" ? "check" : "computer")}</span><span><small>${item.place}</small><strong>${item.title}</strong><span class="mission-caption">${id === "research" ? (state.decision ? "Direction received" : "Needs your perspective") : id === "sync" ? "Reported complete" : "Waiting for MacBook Air"}</span></span></button>`;
    })
    .join(
      "",
    )}<button class="journal-new" data-open="compose:new">${icon("plus")} Start a mission</button><div class="journal-roster"><span class="eyebrow">YOUR SOCIETY</span>${Object.keys(
    agents,
  )
    .map(
      (id) =>
        `<button data-open="agent:${id}">${mark(agents[id].kind)}<span>${agents[id].name}<small>${agents[id].host}</small></span><i class="tiny-dot ${id === "mac" ? "amber" : "green"}"></i></button>`,
    )
    .join("")}</div></aside>`;
}
function missionInspector() {
  const id = state.focus;
  const item = work[id];
  const question = id === "research" && !state.decision;
  return `<section class="mission-inspector" aria-label="Selected mission"><div class="mission-inspector-top"><div class="mission-portraits">${item.people.map((agent) => mark(agents[agent].kind)).join("")}</div><span class="eyebrow">${item.place} <span>/</span> ${question ? "YOUR TURN" : id === "sync" ? "A RESULT IS BACK" : id === "research" ? "DIRECTION RECEIVED" : "WAITING FOR A DEVICE"}</span><button class="text-link" data-open="work:${id}">Open mission ${icon("arrow")}</button></div><div class="mission-inspector-body"><div><h2>${question ? "How should we arrange your research?" : id === "research" ? `Office has your direction: by ${state.decision}.` : id === "sync" ? "Your Office is up to date on both computers." : "Linux is checked. The MacBook Air is next."}</h2><p>${question ? "Office has gathered the notes. Give them a useful home, and the next step is theirs." : id === "research" ? "Your answer has reached the Office agents. Follow the mission as the collection takes shape." : id === "sync" ? "Office on MacBook Air reported the update complete. Explore what came back, or replay their handoff." : "The request is waiting for the device to check in. There is no confirmed result from it yet."}</p></div><div class="mission-actions">${question ? `<button class="choice-button" data-decision="project">${icon("book")} By project ${icon("arrow")}</button><button class="choice-button" data-decision="topic">${icon("spark")} By topic ${icon("arrow")}</button>` : `<button class="choice-button" data-open="${id === "sync" ? "artifact:office" : `work:${id}`}">${icon(id === "sync" ? "document" : "arrow")} ${id === "sync" ? "Explore the result" : "Follow the work"}</button><button class="text-link" data-action="replay">${icon("play")} Replay Office handoff</button>`}</div></div></section>`;
}
function variantA() {
  return `<section class="game-home"><header class="game-heading"><div><span class="eyebrow">YOUR SOCIETY AT WORK</span><h1>The Commons<span class="title-period">.</span></h1></div><div class="world-status"><span><i class="tiny-dot green"></i> 4 agents</span><button data-mission="research"><span class="question-count">${state.decision ? "0" : "1"}</span> ${state.decision ? "questions" : "needs you"}</button><button class="world-add" data-open="compose:new">${icon("plus")} New mission</button></div></header>
    <div class="game-layout">${missionJournal()}<div class="game-main"><section class="world" aria-label="Interactive world: Office, Computers, and the agents working there"><div class="world-caption"><span class="world-time">A DAY IN YOUR SOCIETY</span><span>Sample world · click a place or an agent</span></div>
      <div class="world-canvas" style="--world-zoom:${state.zoom}">${worldScene()}
      <button class="world-place office-label" data-open="place:office">${icon("book")}<span>Office<small>Shared knowledge</small></span>${icon("arrow")}</button>
      <button class="world-place computers-label" data-open="place:computers">${icon("computer")}<span>Computers<small>A familiar way to work</small></span>${icon("arrow")}</button>
      ${sprite("office", [28.7, 45.5])}${sprite("local", [42.2, 58.2])}${sprite("linux", [68.7, 59.3])}${sprite("mac", [81, 70])}
      ${!state.decision ? '<button class="world-question" data-open="work:research" aria-label="Office has a question for you">?<span>Your perspective?</span></button>' : '<span class="world-received">✓ Direction received</span>'}
      <span class="world-device-wait" title="MacBook Air has not checked in">···</span>
      <button class="world-future studio-plot" data-open="future:studio">${icon("studio")}<span>Room for Studio</span></button><button class="world-future services-plot" data-open="future:services">${icon("services")}<span>Room for Ops</span></button>
      <button class="world-you" data-open="about:you"><span>Y</span><small>You’re here</small></button>
      <span class="world-message">${icon("document")}</span><span class="world-reply">${icon("check")}</span>
      </div><div class="world-bottom"><div class="world-event"><span class="tiny-dot green"></span><span>${state.decision ? `You gave Office a direction: organize by ${state.decision}.` : "Office on MacBook Air reported back · 18 min ago"}</span></div><div class="world-controls"><button data-action="replay" aria-label="Replay the sample Office handoff">${icon("play")}</button><button data-action="zoom-out" aria-label="Zoom out">−</button><button data-action="zoom-in" aria-label="Zoom in">+</button></div></div></section>${missionInspector()}</div></div></section>`;
}

function variantB() {
  return `<div class="dispatch"><header class="dispatch-masthead"><span class="eyebrow">A LETTER FROM YOUR SOCIETY</span><h1>Today, <em>together.</em></h1><div class="dispatch-rule"><span>Office & Computers</span><span>Three stories worth your time</span><button class="text-link" data-action="replay">${icon("play")} Replay Office handoff</button></div></header>
    <div class="dispatch-layout"><section class="dispatch-stories"><article class="lead-story"><span class="eyebrow">01 / WHAT FOUND ITS WAY HOME</span><button class="story-title" data-open="work:sync"><h2>A thought on one computer.<br>A useful thing on another.</h2>${icon("arrow")}</button><p>Office on mini shared the latest changes. Office on your MacBook Air brought them home and reported back. A small exchange. One less thing for you to carry.</p><div class="dispatch-art">${officeArt()}<div class="dispatch-agents">${agentButton("office")}${icon("arrow")}${agentButton("local")}</div></div></article>
    <article class="dispatch-story"><span class="eyebrow">02 / A QUESTION FOR YOU</span><button class="story-title" data-open="work:research"><h2>${state.decision ? "Your ideas have a direction." : "How do you like your ideas arranged?"}</h2>${icon("arrow")}</button><p>${state.decision ? "Office has your preference and the next step is clear." : "Office has gathered the research. A little guidance from you will give it a useful home."}</p></article>
    <article class="dispatch-story"><span class="eyebrow">03 / QUIETLY IN PROGRESS</span><button class="story-title" data-open="work:computers"><h2>A familiar setup is making the rounds.</h2>${icon("arrow")}</button><p>Linux has been checked. The next step waits for the MacBook Air to check in.</p></article></section>
    <aside class="dispatch-aside"><h2>The people-shaped part.</h2><p>Meet the agents behind the work.</p>${Object.keys(
      agents,
    )
      .map((id) => agentButton(id))
      .join(
        "",
      )}<div class="aside-divider"></div>${promptButton()}${futurePlaces()}</aside></div></div>`;
}
function variantC() {
  return `<div class="constellation"><header class="constellation-heading"><div><span class="eyebrow">FOLLOW THE CONNECTIONS</span><h1>A world of<br><em>shared possibilities.</em></h1></div><p>Every place has a purpose.<br>Every connection carries something forward.</p></header>
    <div class="constellation-layout"><section class="society-map" aria-label="Places connected around you"><svg class="map-lines" viewBox="0 0 720 570" preserveAspectRatio="none" aria-hidden="true"><path d="M360 285C290 285 210 185 180 150M360 285C430 285 510 185 540 150M360 285C280 300 220 410 180 430M360 285C440 300 510 410 540 430"/><path class="map-crossing" d="M180 150Q360 50 540 150"/></svg>
    <button class="map-you" data-open="compose:new"><span>You</span><small>Bring a little direction</small>${icon("plus")}</button>
    <button class="map-place map-office" data-open="place:office"><span class="map-emblem">${icon("book")}</span><strong>Office</strong><small>Ideas, made shared</small><span class="map-faces">${mark("office")}${mark("local")}</span></button>
    <button class="map-place map-computers" data-open="place:computers"><span class="map-emblem">${icon("computer")}</span><strong>Computers</strong><small>A familiar way to work</small><span class="map-faces">${mark("linux")}${mark("mac")}</span></button>
    <button class="map-place map-services planned" data-open="future:services"><span class="map-emblem">${icon("services")}</span><strong>Services</strong><small>Room for Ops · planned</small></button>
    <button class="map-place map-studio planned" data-open="future:studio"><span class="map-emblem">${icon("studio")}</span><strong>Studio</strong><small>Room for Design · planned</small></button><span class="map-caption">A society takes shape through what it shares.</span></section>
    <aside class="map-aside">${invitation()}<section class="map-thread"><span class="eyebrow">FOLLOW A THREAD</span><button data-open="work:sync"><h3>Your Office,<br>in step.</h3><p>A handoff between two agents. A useful result for you.</p><span class="text-link">Follow the work ${icon("arrow")}</span></button></section></aside></div></div>`;
}

const work = {
  sync: {
    title: "Your Office, in step.",
    place: "Office",
    state: "Reported complete",
    tone: "green",
    summary: "The shared Office changes are available on both computers.",
    people: ["office", "local"],
  },
  research: {
    title: "A home for scattered research.",
    place: "Office",
    state: "A question for you",
    tone: "amber",
    summary:
      "Gather the useful notes into a collection you can find your way around.",
    people: ["office", "local"],
  },
  computers: {
    title: "A familiar setup, everywhere.",
    place: "Computers",
    state: "Waiting for a device",
    tone: "amber",
    summary:
      "Bring the shared configuration changes to each computer, keeping its local conventions intact.",
    people: ["linux", "mac"],
  },
};
function workRow(id) {
  const item = work[id];
  const status =
    id === "research" && state.decision ? "Direction received" : item.state;
  return `<button class="work-row" data-open="work:${id}"><span class="file-icon ${item.place === "Office" ? "sage" : "sand"}">${icon(item.place === "Office" ? "document" : "computer")}</span><span><strong>${item.title}</strong><small>${item.summary}</small></span><span class="status ${item.tone}">${status}</span>${icon("arrow")}</button>`;
}
function workPage() {
  return `<section class="directory"><span class="eyebrow">INTENTIONS BECOMING REAL</span><h1>Shared <em>work.</em></h1><p>Follow an idea through the agents helping it along.</p>${promptButton()}<div class="work-list">${Object.keys(work).map(workRow).join("")}${state.requests.map((request, index) => `<button class="work-row" data-open="request:${index}"><span class="file-icon sage">${icon("spark")}</span><span><strong>${escape(request.text)}</strong><small>${escape(request.place)} · saved for this visit</small></span><span class="status">Sample request</span>${icon("arrow")}</button>`).join("")}</div></section>`;
}
function agentsPage() {
  return `<section class="directory"><span class="eyebrow">RECOGNIZABLE ROLES. DIFFERENT PERSPECTIVES.</span><h1>Meet your <em>society.</em></h1><p>Four agents, each caring for a part of your world in this sample.</p><div class="agent-directory">${Object.entries(
    agents,
  )
    .map(
      ([id, agent]) =>
        `<button class="agent-card" data-open="agent:${id}">${mark(agent.kind, "large")}<span class="eyebrow">${agent.place} · ${agent.host}</span><h2>${agent.role}</h2><p>${agent.description}</p><span class="text-link">Meet ${agent.name} ${icon("arrow")}</span></button>`,
    )
    .join("")}</div></section>`;
}
function switcher() {
  if (document.documentElement.dataset.production === "true") return "";
  return `<div class="prototype-switcher" aria-label="Prototype variations"><span class="switcher-caption">EXPLORE A HOME</span><button data-action="previous" aria-label="Previous design">${icon("back")}</button>${variants.map((variant, index) => `<button class="variant-choice ${state.variant === variant ? "selected" : ""}" data-variant="${variant}" aria-pressed="${state.variant === variant}"><span>0${index + 1}</span> ${names[variant]}</button>`).join("")}<button data-action="next" aria-label="Next design">${icon("arrow")}</button></div>`;
}
function render() {
  document.documentElement.dataset.variant = state.variant;
  document.documentElement.dataset.motion = state.motion ? "on" : "off";
  document.title = `Jev · ${names[state.variant]} · ${state.page}`;
  if (state.variant === "D") {
    app.innerHTML = commandHome(state) + switcher();
    const viewport = document.querySelector(".cc-map-viewport");
    const target =
      document.querySelector(
        `.cc-field [data-command-select="${state.commandSelection}"]`,
      ) ??
      document.querySelector(
        '.cc-field [data-command-select="facility:archive"]',
      );
    viewport.scrollLeft = target.offsetLeft - viewport.clientWidth / 2;
    console.debug("Command prototype state", {
      scene: state.commandScene,
      selection: state.commandSelection,
      motion: state.motion,
    });
    return;
  }
  app.innerHTML = `<div class="paseo-frame"><span>${icon("globe")} Paseo <span class="frame-separator">/</span> Jev</span><span>Design prototype · sample stories</span></div>
    <header class="site-header"><button class="brand" data-page="home" aria-label="Jev home"><span class="jev-symbol"><i></i><i></i><i></i></span>jev<span class="brand-description">a small society</span></button><nav aria-label="Main navigation">${["home", "work", "agents"].map((page) => `<button data-page="${page}" ${state.page === page ? 'aria-current="page"' : ""}>${page === "home" ? "Home" : page === "work" ? "Work" : "Agents"}</button>`).join("")}</nav><button class="you-badge" data-open="about:you"><span>Y</span><span>You’re part of this</span></button></header>
    <main id="main">${state.page === "home" ? { A: variantA, B: variantB, C: variantC }[state.variant]() : state.page === "work" ? workPage() : agentsPage()}</main>
    <footer class="site-footer"><span><span class="tiny-dot green"></span> An imagined day in your society</span><div><button data-action="motion">${icon(state.motion ? "pause" : "play")} Motion ${state.motion ? "on" : "off"}</button><button data-action="replay">Replay Office handoff</button><button data-action="reset">Reset sample</button></div><span class="prototype-state">${names[state.variant]} · ${state.page} · ${state.decision ? "0 questions" : "1 question"}${state.requests.length ? ` · ${state.requests.length} new requests` : ""}</span></footer>${switcher()}`;
  console.debug("Society prototype state", {
    variant: state.variant,
    page: state.page,
    layers: state.layers,
    decision: state.decision,
    requests: state.requests.length,
    motion: state.motion,
  });
}

function placeLayer(id) {
  const office = id === "office";
  return `<span class="eyebrow">${office ? "IDEAS & KNOWLEDGE" : "YOUR EVERYDAY TOOLS"}</span><h1 id="layer-title">${office ? "Office" : "Computers"}<span class="title-period">.</span></h1><p class="layer-intro">${office ? "A home for what you know. A place for what comes next." : "Different machines. A familiar way of working."}</p>
    <div class="place-layer-art ${office ? "sage" : "sand"}">${office ? officeArt() : computerArt()}</div>
    <section class="layer-section"><h2>What we look after</h2><p>${office ? "Your shared knowledge, the material on your own computer, and the useful connections between them. The two Office agents help discoveries travel while keeping local and shared responsibilities clear." : "The small details that make a computer feel like yours. Each device has an agent who understands its local needs and coordinates shared changes with the others."}</p><div class="collaborators">${office ? agentButton("office") + agentButton("local") : agentButton("linux") + agentButton("mac")}</div></section>
    <section class="layer-section"><div class="section-heading"><h2>Taking shape here</h2><button class="text-link" data-open="compose:${id}">${icon("plus")} Start something</button></div><div class="work-list">${(office ? ["research", "sync"] : ["computers"]).map(workRow).join("")}</div></section>
    <section class="layer-section"><h2>What stays with this place</h2><button class="artifact" data-open="artifact:${office ? "office" : "computers"}">${icon(office ? "book" : "document")}<span><strong>${office ? "How our Office stays connected" : "Shared baseline, local conventions"}</strong><small>${office ? "A decision carried forward into the work" : "Why the same change can look different on each device"}</small></span>${icon("arrow")}</button></section>`;
}
function timelineEntry(agentId, label, body, last = false) {
  return `<li class="timeline-entry ${last ? "last" : ""}"><button data-open="agent:${agentId}" aria-label="Meet ${agents[agentId].name} on ${agents[agentId].host}">${mark(agents[agentId].kind)}</button><div><span class="eyebrow">${label}</span><h3>${agents[agentId].name} <small>on ${agents[agentId].host}</small></h3><p>${body}</p></div></li>`;
}
function workLayer(id) {
  const item = work[id];
  if (!item) return "";
  let content;
  if (id === "sync") {
    content = `<section class="outcome"><span class="eyebrow">WHAT CAME OF IT</span><h2>Your Office changes are available on both computers.</h2><p>Office on MacBook Air reported the update complete and its checkout clean.</p><button class="text-link" data-open="artifact:office">Explore the result ${icon("arrow")}</button><small>Reported by the agent · no independent verification in this sample</small></section>
      <section class="layer-section"><div class="section-heading"><h2>How it came together</h2><button class="text-link" data-action="replay">${icon("play")} Replay Office handoff</button></div><div class="handoff-scene">${agentButton("office")}<div class="handoff-track"><span class="travelling-note">${icon("document")}</span></div>${agentButton("local")}</div>
      <ol class="timeline">${timelineEntry("office", "SHARED A CHANGE · 24 MIN AGO", "The shared Office has new changes. Please bring your local checkout up to date and let me know what happened.")}${timelineEntry("local", "BROUGHT IT HOME · 18 MIN AGO", "The changes are here. The checkout is clean, and I have read the updated working instructions.")}${timelineEntry("office", "HEARD BACK · 18 MIN AGO", "The result is back with the sender. Both agents now have the same point of reference.", true)}</ol></section>`;
  } else if (id === "research") {
    content = `<section class="decision-panel"><span class="eyebrow">${state.decision ? "YOUR DIRECTION" : "A LITTLE DIRECTION FROM YOU"}</span><h2>${state.decision ? `Organize the research by ${state.decision === "project" ? "project" : "topic"}.` : "How would you like to find these ideas again?"}</h2><p>${state.decision ? "Your choice is recorded in this sample. Office can use it as the starting point for the collection." : "Office has brought the research notes together. Both approaches keep the sources; the choice changes how you browse."}</p>
      ${state.decision ? `<div class="answered">${icon("check")} Direction received <button class="text-link" data-action="reconsider">Change your preference</button></div>` : `<div class="decision-options"><button data-decision="project">${icon("book")}<strong>By project</strong><span>Keep each effort and its supporting research together.</span>${icon("arrow")}</button><button data-decision="topic">${icon("spark")}<strong>By topic</strong><span>Let related ideas meet across different projects.</span>${icon("arrow")}</button></div>`}</section>
      <section class="layer-section"><h2>The work so far</h2><ol class="timeline">${timelineEntry("local", "GATHERED THE MATERIAL", "I found useful research in several local notes and passed the references to shared Office.")}${timelineEntry("office", "FOUND THE NEXT QUESTION", "The material is gathered. A collection organized around how you think will be easier to return to.", true)}</ol></section>`;
  } else {
    content = `<section class="outcome waiting"><span class="eyebrow">WHAT HAPPENS NEXT</span><h2>The next step waits for your MacBook Air.</h2><p>Its agent hasn't checked in since the request. The shared change is ready; its status is still unconfirmed on that device.</p><small>Last observed in this sample: 42 minutes ago</small></section><section class="layer-section"><h2>A shared change, two local perspectives</h2><ol class="timeline">${timelineEntry("linux", "CHECKED ON LINUX", "The shared configuration works here. I have kept the Linux-specific settings in place.")}${timelineEntry("mac", "WAITING FOR A CHECK-IN", "The request is waiting. There is no reported result for this device yet.", true)}</ol><button class="artifact" data-open="artifact:computers">${icon("document")}<span><strong>Shared baseline, local conventions</strong><small>The decision behind this work</small></span>${icon("arrow")}</button></section>`;
  }
  return `<button class="place-breadcrumb" data-open="place:${item.place === "Office" ? "office" : "computers"}">${icon(item.place === "Office" ? "book" : "computer")} ${item.place}</button><h1 id="layer-title">${item.title}</h1><p class="layer-intro">${item.summary}</p><div class="work-metadata"><span class="status ${item.tone}">${id === "research" && state.decision ? "Direction received" : item.state}</span><div class="collaborators">${item.people.map((agent) => agentButton(agent, true)).join("")}</div></div>${content}<details class="record"><summary>${icon("document")} The underlying record <span>Messages & delivery details</span></summary><div><p>This is a fictional record for exploring the interface. It is not connected to live sessions.</p><dl><dt>Work</dt><dd>Sample ${id}</dd><dt>Route</dt><dd>${item.people.map((agent) => `${agents[agent].name} on ${agents[agent].host}`).join(" → ")}</dd><dt>Evidence</dt><dd>${id === "sync" ? "Agent completion report; shared revision 8b6c2e1. No independent check." : id === "research" ? (state.decision ? "User preference recorded in this browser visit." : "Open question from Office. No preference recorded.") : "Linux reported checked. MacBook Air has not confirmed receipt."}</dd></dl><pre>${escape(id === "sync" ? 'request: "Apply the shared Office changes and report back."\nreply.kind: completed\nreply.text: "Updated to the shared revision. Checkout clean."\nnotice: completion reported to the sender' : id === "research" ? `request: "Give the research notes a useful home."\nreply.kind: question\nreply.text: "Organize by project or by topic?"\nanswer: ${state.decision ?? "waiting"}` : 'request: "Check the shared configuration on each device."\nlinux.reply: completed\nmacbook-air.reply: none\nnext: wait for an available session')}</pre></div></details>`;
}
function agentLayer(id) {
  const agent = agents[id];
  return `<div class="agent-profile-top">${mark(agent.kind, "portrait")}<span class="eyebrow">${agent.place.toUpperCase()} · ${agent.host.toUpperCase()}</span><h1 id="layer-title">${agent.role}<span class="title-period">.</span></h1><p class="layer-intro">${agent.description}</p></div><section class="layer-section"><h2>My latest contribution</h2><button class="artifact" data-open="work:${agent.place === "Office" ? "sync" : "computers"}">${icon("document")}<span><strong>${agent.contribution}</strong><small>Follow the shared work</small></span>${icon("arrow")}</button></section><section class="layer-section"><h2>Someone I work with</h2>${agentButton(agent.partner)}<p class="partner-explanation">${agent.place === "Office" ? "We keep the connection between shared knowledge and local work clear. Discoveries and results can travel in both directions." : "We coordinate shared changes and each take responsibility for our own machine."}</p></section><section class="layer-section"><h2>A way to begin</h2><button class="suggested-request" data-open="compose:${agent.place === "Office" ? "office" : "computers"}">“${agent.place === "Office" ? "Help me find a useful home for these notes." : "Help these computers feel more familiar."}” ${icon("arrow")}</button></section><details class="record"><summary>Where this agent works</summary><div><dl><dt>Place</dt><dd>${agent.place}</dd><dt>Device</dt><dd>${agent.host}</dd><dt>Identity</dt><dd>A sample role for this prototype; no live session is connected.</dd></dl></div></details>`;
}
function artifactLayer(id) {
  const office = id === "office";
  return `<span class="eyebrow">A DECISION THAT STAYS WITH THE PLACE</span><h1 id="layer-title">${office ? "How our Office stays connected." : "Shared baseline,<br>local conventions."}</h1><p class="layer-intro">${office ? "Shared knowledge and local work each have a home." : "Consistency has room for the differences that help you work."}</p><article class="artifact-paper"><span class="paper-label">${office ? "OFFICE" : "COMPUTERS"} / WORKING AGREEMENT</span><h2>${office ? "Keep the connection clear." : "Share the intention. Respect the machine."}</h2><p>${office ? "The shared Office holds the knowledge we develop together. The local Office looks after material and work on your own computer." : "Common configuration carries the way we want to work. Each device agent checks how that intention fits the machine it looks after."}</p><p>${office ? "When something useful changes, one agent tells the other. The receiving agent applies what belongs there and reports the result. The shared work keeps the exchange and its outcome together." : "A change can be complete on one machine while another still waits. We preserve that distinction, and we keep platform-specific behavior when it serves the same intention."}</p><div class="paper-signatures">${office ? mark("office") + mark("local") : mark("linux") + mark("mac")}<span>Carried forward by ${office ? "the Office agents" : "the device agents"}</span></div></article><p class="sample-caption">Illustrative artifact. In the live product, this would link to the document in its owning repository.</p><button class="text-link" data-open="work:${office ? "sync" : "computers"}">See this decision in practice ${icon("arrow")}</button>`;
}
function futureLayer(id) {
  const services = id === "services";
  return `<span class="future-icon">${icon(services ? "services" : "studio")}</span><span class="eyebrow">ROOM TO GROW · NOT CONNECTED</span><h1 id="layer-title">${services ? "Services" : "Studio"}<span class="title-period">.</span></h1><p class="layer-intro">${services ? "A future home for the systems you depend on." : "A future home for ideas taking a visible shape."}</p><section class="layer-section"><h2>${services ? "An Ops agent could look after…" : "Design agents could bring…"}</h2><p>${services ? "The services on your VPS, the changes proposed for them, and the questions that need your judgment. A place to understand what is being cared for and what needs attention." : "Visual proposals, alternative approaches, and work you can see and respond to. A brief from Office could become a proposal here, then travel on to implementation."}</p></section><div class="future-note">${icon("spark")} This place is a possibility for the society. There is no ${services ? "Ops" : "Design"} agent connected in this prototype.</div>`;
}
function composeLayer(place) {
  return `<span class="eyebrow">BRING A LITTLE DIRECTION</span><h1 id="layer-title">What would you<br>like to <em>happen?</em></h1><p class="layer-intro">An intention is enough to begin. You can work out the details together.</p><form id="intention-form"><label for="intention-text">Your intention</label><textarea id="intention-text" name="text" required maxlength="1000" placeholder="I have notes scattered across two computers. Help me make something useful from them." rows="5"></textarea><label for="intention-place">A place to begin</label><select id="intention-place" name="place"><option value="Office" ${place === "office" ? "selected" : ""}>Office · ideas and knowledge</option><option value="Computers" ${place === "computers" ? "selected" : ""}>Computers · your everyday tools</option><option value="Together" ${place === "new" ? "selected" : ""}>Help me find the right place</option></select><button class="primary-button" type="submit">Start a sample request ${icon("arrow")}</button><p class="sample-caption">This stays in this browser visit. Nothing is sent to an agent.</p></form>`;
}
function requestLayer(id) {
  const request = state.requests[Number(id)];
  return `<span class="eyebrow">AN INTENTION, GIVEN A PLACE</span><h1 id="layer-title">A beginning.</h1><div class="outcome"><span class="eyebrow">${escape(request.place)}</span><h2>${escape(request.text)}</h2><p>Your sample request is now in Work. In the live experience, this is where the agents involved and their next contribution would appear.</p></div><p class="sample-caption">Saved for this visit only. No agent has received this request.</p><button class="primary-button" data-page="work">Go to shared work ${icon("arrow")}</button>`;
}
function aboutLayer() {
  return `<span class="eyebrow">YOU BELONG HERE TOO</span><h1 id="layer-title">A society needs<br><em>your perspective.</em></h1><p class="layer-intro">Bring an intention. Answer a question. Explore what changed. You can join the work at the point that matters to you.</p><div class="layer-section"><h2>Find your way in</h2><p>Home shows the places being cared for. Each place holds its agents and shared work. A piece of work keeps its intention, contributions, and outcome together, with the record underneath.</p></div><button class="primary-button" data-open="compose:new">Start with an intention ${icon("arrow")}</button><p class="sample-caption">This is an interactive design study for Jev’s Paseo plugin. All agents, events, and actions shown here use sample data.</p>`;
}
function renderLayer() {
  const current = state.layers.at(-1);
  if (!current) return;
  const [kind, id] = current.split(":");
  const content = {
    place: placeLayer,
    work: workLayer,
    agent: agentLayer,
    artifact: artifactLayer,
    future: futureLayer,
    compose: composeLayer,
    request: requestLayer,
    about: aboutLayer,
  }[kind](id);
  layer.innerHTML = `<header class="layer-toolbar"><button class="icon-button" data-action="back" aria-label="${state.layers.length > 1 ? "Back to previous layer" : "Back to home"}">${icon("back")}</button><span>${state.layers.map((entry) => ({ place: "Place", work: "Shared work", agent: "Agent", artifact: "Shared memory", future: "A possibility", compose: "An intention", request: "A beginning", about: "You" })[entry.split(":")[0]]).join(' <span class="breadcrumb-divider">/</span> ')}</span><button class="icon-button" data-action="close" aria-label="Close layer">${icon("close")}</button></header><div class="layer-body">${content}</div>`;
  layer.scrollTop = 0;
  const title = layer.querySelector("#layer-title");
  title.tabIndex = -1;
  title.focus({ preventScroll: true });
}
function openLayer(target) {
  if (!layer.open) {
    opener = document.activeElement;
    state.layers = [];
  }
  state.layers.push(target);
  renderLayer();
  if (!layer.open) layer.showModal();
  document.body.classList.add("layer-open");
}
function closeLayer() {
  layer.close();
  state.layers = [];
  document.body.classList.remove("layer-open");
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  else
    document
      .querySelector('nav [aria-current="page"]')
      ?.focus({ preventScroll: true });
}
function changeVariant(variant) {
  if (layer.open) closeLayer();
  clearTimeout(commandTimer);
  document.body.classList.remove("command-transferring");
  state.variant = variant;
  const url = new URL(location.href);
  url.searchParams.set("variant", variant);
  history.replaceState({}, "", url);
  render();
  document
    .querySelector(`[data-variant="${variant}"]`)
    ?.focus({ preventScroll: true });
  announce(
    variant === "D"
      ? `Command design. ${state.commandScene} sample. ${state.commandSelection} selected.`
      : `${names[variant]} design. ${state.decision ? "No questions waiting" : "One question waiting"}.`,
  );
}
function announce(message) {
  announcer.textContent = message;
}
function replay() {
  clearTimeout(handoffTimer);
  document.body.classList.remove("replaying");
  requestAnimationFrame(() => {
    document.body.classList.add("replaying");
    announce(
      "Sample handoff: Office on mini shares a change. Office on MacBook Air receives it and reports completion.",
    );
    handoffTimer = setTimeout(
      () => document.body.classList.remove("replaying"),
      3600,
    );
  });
}
function commandReplay() {
  state.commandSelection = "mission:guide";
  render();
  document
    .querySelector("[data-command-replay]")
    .focus({ preventScroll: true });
  clearTimeout(commandTimer);
  document.body.classList.remove("command-transferring");
  requestAnimationFrame(() => {
    document.body.classList.add("command-transferring");
    announce(
      "Future sample: Office passes the brief to Studio. Ops waits for design approval.",
    );
    commandTimer = setTimeout(
      () => document.body.classList.remove("command-transferring"),
      3600,
    );
  });
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.commandScene) {
    clearTimeout(commandTimer);
    document.body.classList.remove("command-transferring");
    state.commandScene = button.dataset.commandScene;
    state.commandSelection = commandSceneSelection(state.commandScene);
    render();
    document
      .querySelector(`[data-command-scene="${state.commandScene}"]`)
      .focus({ preventScroll: true });
    announce(
      `${state.commandScene === "handoff" ? "Future crew, six agents across four bases" : "Current crew, four agents across two bases"}. ${state.commandScene === "question" ? "One question needs you." : "No questions waiting."}`,
    );
    return;
  }
  if (button.dataset.commandSelect) {
    clearTimeout(commandTimer);
    document.body.classList.remove("command-transferring");
    state.commandSelection = button.dataset.commandSelect;
    render();
    document
      .querySelector("#cc-inspector-title")
      .focus({ preventScroll: true });
    if (matchMedia("(max-width: 720px)").matches) {
      document
        .querySelector(".cc-inspector")
        .scrollIntoView({ block: "start", behavior: "instant" });
    }
    return;
  }
  if (button.hasAttribute("data-command-map")) {
    document.querySelector(".cc-map-top button").focus({ preventScroll: true });
    document
      .querySelector(".cc-world")
      .scrollIntoView({ block: "start", behavior: "instant" });
    return;
  }
  if (button.hasAttribute("data-command-replay")) return commandReplay();
  if (button.dataset.mission) {
    state.focus = button.dataset.mission;
    render();
    document
      .querySelector(`[data-mission="${state.focus}"]`)
      ?.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.open) return openLayer(button.dataset.open);
  if (button.dataset.variant) return changeVariant(button.dataset.variant);
  if (button.dataset.page) {
    if (layer.open) closeLayer();
    state.page = button.dataset.page;
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
    const heading = app.querySelector("h1");
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    return;
  }
  if (button.dataset.decision) {
    state.decision = button.dataset.decision;
    render();
    renderLayer();
    if (!layer.open) {
      const outcome = document.querySelector(".mission-inspector h2");
      outcome.tabIndex = -1;
      outcome.focus({ preventScroll: true });
    }
    clearTimeout(answerTimer);
    document.body.classList.add("answering");
    answerTimer = setTimeout(
      () => document.body.classList.remove("answering"),
      900,
    );
    announce(`Office has your preference: by ${state.decision}.`);
    return;
  }
  switch (button.dataset.action) {
    case "close":
      return closeLayer();
    case "back":
      if (state.layers.length < 2) return closeLayer();
      state.layers.pop();
      return renderLayer();
    case "next":
      return changeVariant(
        variants[(variants.indexOf(state.variant) + 1) % variants.length],
      );
    case "previous":
      return changeVariant(
        variants[
          (variants.indexOf(state.variant) + variants.length - 1) %
            variants.length
        ],
      );
    case "reconsider":
      state.decision = null;
      render();
      return renderLayer();
    case "motion":
      state.motion = !state.motion;
      render();
      document
        .querySelector('[data-action="motion"]')
        .focus({ preventScroll: true });
      return;
    case "zoom-in":
      state.zoom = Math.min(1.4, state.zoom + 0.1);
      render();
      document
        .querySelector('[data-action="zoom-in"]')
        .focus({ preventScroll: true });
      return;
    case "zoom-out":
      state.zoom = Math.max(0.8, state.zoom - 0.1);
      render();
      document
        .querySelector('[data-action="zoom-out"]')
        .focus({ preventScroll: true });
      return;
    case "replay":
      return replay();
    case "reset":
      state.decision = null;
      state.requests = [];
      if (layer.open) closeLayer();
      render();
      document
        .querySelector('[data-action="reset"]')
        .focus({ preventScroll: true });
      return announce("Sample reset. One question is waiting for you.");
  }
});
document.addEventListener("submit", (event) => {
  if (event.target.id !== "intention-form") return;
  event.preventDefault();
  const values = new FormData(event.target);
  const text = String(values.get("text") ?? "").trim();
  if (!text) {
    document
      .querySelector("#intention-text")
      .setCustomValidity("Write a little about what you would like to happen.");
    document.querySelector("#intention-text").reportValidity();
    return;
  }
  state.requests.push({ text, place: String(values.get("place")) });
  state.layers[state.layers.length - 1] =
    `request:${state.requests.length - 1}`;
  render();
  renderLayer();
  announce("Your sample request is in Work. Nothing was sent to an agent.");
});
document.addEventListener("input", (event) => {
  if (event.target.id === "intention-text") event.target.setCustomValidity("");
});
document.addEventListener("keydown", (event) => {
  if (
    document.documentElement.dataset.production === "true" ||
    layer.open ||
    event.target.closest('input, textarea, select, [contenteditable="true"]') ||
    event.altKey ||
    event.metaKey ||
    event.ctrlKey
  )
    return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  changeVariant(
    variants[
      (variants.indexOf(state.variant) +
        (event.key === "ArrowRight" ? 1 : variants.length - 1)) %
        variants.length
    ],
  );
});
layer.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeLayer();
});
layer.addEventListener("click", (event) => {
  if (event.target !== layer) return;
  const rect = layer.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    closeLayer();
});
render();
