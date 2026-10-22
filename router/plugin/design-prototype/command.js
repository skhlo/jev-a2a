// THROWAWAY design study. Bases are responsibilities, missions connect them,
// and machines locate agents. Every scene is fictional and read-only.
const bases = {
  office: {
    name: "Office",
    purpose: "Knowledge & decisions",
    description:
      "Keep useful knowledge connected, current and easy to carry forward.",
    color: "cc-mint",
    number: "01",
    people: ["keeper", "local"],
    output: "A shared body of knowledge",
  },
  computers: {
    name: "Computers",
    purpose: "Tools & environments",
    description:
      "Keep the way you work familiar across machines, while respecting each machine's needs.",
    color: "cc-blue",
    number: "02",
    people: ["linux", "mac"],
    output: "A dependable working environment",
  },
  studio: {
    name: "Studio",
    purpose: "Design & interfaces",
    description:
      "Turn a shared intention into something people can see, understand and use.",
    color: "cc-lilac",
    number: "03",
    people: ["designer"],
    output: "A reviewed design",
  },
  ops: {
    name: "Ops",
    purpose: "Services & continuity",
    description:
      "Look after the systems the society depends on and make changes that can be understood and recovered.",
    color: "cc-sand",
    number: "04",
    people: ["operator"],
    output: "A service people can depend on",
  },
};
const people = {
  keeper: {
    name: "Office",
    role: "Shared knowledge",
    host: "mini",
    base: "office",
    symbol: "K",
    description:
      "Maintains the shared Office and passes useful changes to the local Office.",
  },
  local: {
    name: "Office local",
    role: "Local knowledge",
    host: "MBA",
    base: "office",
    symbol: "L",
    description:
      "Brings shared knowledge into your local workspace and contributes discoveries back.",
  },
  linux: {
    name: "Dotfiles",
    role: "Linux environment",
    host: "MBP",
    base: "computers",
    symbol: "L",
    description:
      "Checks shared configuration against the Linux machine's needs.",
  },
  mac: {
    name: "Dotfiles",
    role: "Mac environment",
    host: "MBA",
    base: "computers",
    symbol: "M",
    description:
      "Looks after the Mac's configuration and coordinates changes with the other device agents.",
  },
  designer: {
    name: "Designer",
    role: "Interface design",
    host: "MBP",
    base: "studio",
    symbol: "D",
    description:
      "An imagined future teammate turning an Office brief into a readable field guide.",
  },
  operator: {
    name: "Ops",
    role: "Service operations",
    host: "VPS",
    base: "ops",
    symbol: "O",
    description:
      "An imagined future teammate preparing a home for the approved field guide.",
  },
};
const scenes = {
  today: {
    label: "Current crew",
    title: "A small society. Shared work.",
    description:
      "Two bases, four agents. Office keeps knowledge in step. Computers cares for the environments around it.",
    select: "mission:sync",
    transmission: "Office on MBA reported the shared changes applied.",
    stamp: "SAMPLE · 09:14",
    population: "4 agents · 2 active bases",
  },
  handoff: {
    label: "Future cooperation",
    title: "One mission. Three bases.",
    description:
      "An imagined future: Office prepares a brief, Studio gives it shape, and Ops prepares a place for it to live.",
    select: "mission:guide",
    transmission: "Office → Studio · the field-guide brief was received.",
    stamp: "FUTURE SAMPLE · 10:06",
    population: "6 agents · 4 active bases",
  },
  question: {
    label: "Needs you",
    title: "A little direction from you.",
    description:
      "Office has gathered the material. One decision about how to organize it will let the work continue.",
    select: "mission:research",
    transmission:
      "Office asks: should the research be organized by project or topic?",
    stamp: "SAMPLE · 09:22",
    population: "4 agents · 2 active bases",
  },
};

export function commandSceneSelection(scene) {
  return scenes[scene]?.select ?? scenes.today.select;
}

function missions(scene) {
  return {
    sync: {
      title: "Keep Office in step",
      base: "Office",
      status: "Reported complete",
      tone: "cc-mint",
      description: "Bring the shared changes into both Office workspaces.",
      participants: ["keeper", "local"],
      output: "Shared Office changes",
      steps: [
        ["mini", "Shared the changes", "done"],
        ["MBA", "Applied and reported back", "done"],
      ],
    },
    research: {
      title: "Give the research a home",
      base: "Office",
      status:
        scene === "question" ? "Needs your direction" : "Gathering material",
      tone: scene === "question" ? "cc-sand" : "cc-mint",
      description:
        "Turn scattered notes into a collection you can find your way around.",
      participants: ["keeper", "local"],
      output: "A research collection",
      steps: [
        ["Office", "Gather the useful notes", "done"],
        [
          "You",
          scene === "question"
            ? "Choose project or topic"
            : "Review the proposed structure",
          scene === "question" ? "question" : "waiting",
        ],
        ["Office", "Organize the collection", "waiting"],
      ],
    },
    setup: {
      title: "A familiar setup, everywhere",
      base: "Computers",
      status: "Checking the changes",
      tone: "cc-blue",
      description:
        "Check the shared configuration on Linux and Mac before proposing the next change.",
      participants: ["linux", "mac"],
      output: "A checked configuration proposal",
      steps: [
        ["MBP", "Check Linux conventions", "done"],
        ["MBA", "Check Mac conventions", "active"],
      ],
    },
    guide: {
      title: "Publish the field guide",
      base: "Office → Studio → Ops",
      status: "Brief received by Studio",
      tone: "cc-lilac",
      description:
        "Make the useful research readable and give it a home the society can share.",
      participants: ["keeper", "designer", "operator"],
      output: "A published field guide",
      steps: [
        ["Office", "Prepare the brief", "done"],
        ["Studio", "Shape a readable guide", "active"],
        ["Ops", "Publish after design approval", "waiting"],
      ],
    },
  };
}

function portrait(id, small = false) {
  const person = people[id];
  return `<span class="cc-portrait ${bases[person.base].color} ${small ? "small" : ""}" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="M8 35V15L16 7h17l8 8v20l-8 7H16Z" fill="currentColor" opacity=".18"/><path d="M12 32V17l7-6h11l7 6v15l-7 5H19Z" stroke="currentColor"/><path d="M16 20h17v9H16z" fill="currentColor" opacity=".2"/><path d="M20 23v3m9-3v3M21 33h7M7 22H4m36 0h4" stroke="currentColor" stroke-width="2"/></svg><i>${person.symbol}</i></span>`;
}

function personButton(id) {
  const person = people[id];
  return `<button class="cc-person" data-command-select="agent:${id}">${portrait(id, true)}<span>${person.name}<small>${person.role}</small></span><span class="cc-host">${person.host}</span></button>`;
}

// Original vector facilities: a quiet strategy-game motif, no game assets.
function facility(id) {
  const structures = {
    office: `<path d="m66 78 64-35 63 35-63 36Z" fill="#354d48"/><path d="M66 78v44l64 36v-44Z" fill="#243c37"/><path d="m130 114 63-36v44l-63 36Z" fill="#172d29"/><path d="m75 70 55-31 54 31-54 31Z" fill="#53756a"/><path d="M75 70v12l55 31v-12Zm55 31 54-31v12l-54 31Z" fill="#2d4a40"/><path d="m97 63 33-18 33 18-33 19Z" fill="#8fb79e"/><path d="M91 100v19m15-10v19m39-8v17m17-27v17" stroke="#9ed1b8" stroke-width="5"/><path d="M130 45V13m-10 15 10-6 10 6-10 6Z" stroke="#b4d5bc"/><circle cx="130" cy="12" r="3" fill="#d4eac8"/>`,
    computers: `<path d="m55 90 48-27 47 27-47 27Z" fill="#526b7b"/><path d="M55 90v40l48 27v-40Z" fill="#293b4a"/><path d="m103 117 47-27v40l-47 27Z" fill="#1e2e3e"/><path d="m135 69 37-21 36 21-36 20Z" fill="#536b7f"/><path d="M135 69v46l37 21V89Z" fill="#334858"/><path d="m172 89 36-20v46l-36 21Z" fill="#263747"/><path d="m65 92 28 16v19l-28-16Z" fill="#8eb8cb" opacity=".8"/><path d="m144 72 20 11v27l-20-11Z" fill="#709eb6"/><path d="m153 63 19-11 17 10-18 11Z" fill="#a1bacd"/><path d="M171 54V28m-9 5 9-5 10 5" stroke="#98c9dc"/><path d="m113 130 25-14" stroke="#91c8d2" stroke-width="4"/>`,
    studio: `<path d="m63 101 67-39 67 39-67 38Z" fill="#5a5268"/><path d="M63 101v22l67 38v-22Z" fill="#3e354c"/><path d="m130 139 67-38v22l-67 38Z" fill="#2d2839"/><path d="M88 90V60l42-25 42 25v30l-42 24Z" fill="#635570"/><path d="m88 60 42 24 42-24-42-25Z" fill="#9380a1"/><path d="M130 84v30l42-24V60Z" fill="#463d57"/><path d="m101 60 29-17 29 17-29 16Z" fill="#c3b1d1"/><path d="m74 107 39 23m29 0 43-24" stroke="#d5b4df" stroke-width="3"/>`,
    ops: `<path d="m63 103 67-38 67 38-67 39Z" fill="#6b5d43"/><path d="M63 103v24l67 38v-23Z" fill="#453c2f"/><path d="m130 142 67-39v24l-67 38Z" fill="#322f28"/><path d="M86 93V47l23-13 23 13v46l-23 13Z" fill="#7f7257"/><path d="m109 60 23-13v46l-23 13Z" fill="#4d4737"/><path d="m86 47 23-13 23 13-23 13Z" fill="#b4a381"/><path d="M136 110V64l24-14 23 14v46l-23 13Z" fill="#807153"/><path d="m160 77 23-13v46l-23 13Z" fill="#4a4436"/><path d="m136 64 24-14 23 14-23 13Z" fill="#b9a380"/><path d="m92 65 11 6m-11 4 11 6m40 1 11 6m-11 4 11 6" stroke="#dfc38c" stroke-width="3"/>`,
  };
  return `<svg class="cc-facility" viewBox="0 0 260 190" fill="none" aria-hidden="true"><ellipse cx="130" cy="145" rx="110" ry="38" fill="#060d11" opacity=".5"/><path d="m20 125 110-63 110 63-110 64Z" fill="currentColor" fill-opacity=".06" stroke="currentColor" stroke-opacity=".25"/><path d="m36 125 94-54 94 54-94 54Z" stroke="currentColor" stroke-opacity=".15"/>${structures[id]}<path d="m20 119 0 12 16 9m188 0 16-9v-12M113 180l17 9 17-9" stroke="currentColor" stroke-opacity=".65"/></svg>`;
}

function sector(id, scene, selected) {
  const base = bases[id];
  const future = id === "studio" || id === "ops";
  const active = !future || scene === "handoff";
  const involved =
    selected === `base:${id}` ||
    (selected.startsWith("agent:") &&
      people[selected.split(":")[1]].base === id);
  return `<div class="cc-sector cc-${id} ${base.color} ${active ? "" : "planned"} ${involved ? "selected" : ""}"><button class="cc-base" data-command-select="base:${id}" aria-pressed="${selected === `base:${id}`}">${facility(id)}<span class="cc-base-label"><i class="cc-dot"></i><strong>${base.name}</strong><small>${active ? base.purpose : "Future base"}</small></span>${scene === "question" && id === "office" ? '<span class="cc-question-flag">? <span>Needs you</span></span>' : ""}</button>${active ? `<div class="cc-residents">${base.people.map((personId) => `<button data-command-select="agent:${personId}" aria-label="Inspect ${people[personId].name} on ${people[personId].host}">${portrait(personId, true)}<span>${people[personId].host}</span></button>`).join("")}</div>` : '<span class="cc-planned-label">Not yet part of the crew</span>'}</div>`;
}

function world(scene, selected) {
  return `<section class="cc-world ${scene}" aria-label="Society map"><div class="cc-map-top"><span><i class="cc-crosshair"></i> SOCIETY / SECTOR 01</span><button data-command-select="model">Map key <span>↗</span></button></div><div class="cc-field"><svg class="cc-terrain" viewBox="0 0 980 650" preserveAspectRatio="none" aria-hidden="true"><defs><pattern id="cc-grid" width="48" height="48" patternUnits="userSpaceOnUse" patternTransform="rotate(30)"><path d="M48 0H0V48" fill="none" stroke="#91b1aa" stroke-opacity=".055"/></pattern><radialGradient id="cc-glow"><stop stop-color="#2e4942" stop-opacity=".5"/><stop offset="1" stop-color="#101c22" stop-opacity="0"/></radialGradient></defs><rect width="980" height="650" fill="url(#cc-grid)"/><ellipse cx="480" cy="320" rx="480" ry="320" fill="url(#cc-glow)"/><g fill="none" stroke="#6d8d86" stroke-opacity=".11"><path d="m30 140 85-50 90 5 35-55 100 30 100-20 80 30 200-25 125 60 35 110-35 65 60 85-45 170-100 70-100-25-75 35-120-25-110 30-100-30-120 5-85-90 10-80-45-65 40-100Z"/><path d="m60 160 80-40 70 20 55-65 75 25 90-30 90 40 180-45 120 70 25 80-20 65 60 90-55 145-75 55-115-25-70 35-120-25-110 30-100-30-100 5-75-80 10-80-45-65 40-100Z"/><path d="M490 60v530M100 325h780" stroke-dasharray="3 10"/></g>${scene === "handoff" ? '<path class="cc-route" d="M280 210C380 160 590 180 625 280S660 390 735 450"/><path class="cc-route waiting" d="M735 450C600 560 420 560 245 470"/><circle class="cc-packet" r="5" fill="#c3e7cc"/><text class="cc-route-caption" x="410" y="183">OFFICE → STUDIO</text><text class="cc-route-caption queued" x="440" y="552">AFTER APPROVAL</text>' : '<path class="cc-local-route" d="M218 285Q260 310 296 285"/>'}</svg>${Object.keys(
    bases,
  )
    .map((id) => sector(id, scene, selected))
    .join(
      "",
    )}<button class="cc-command-center" data-command-select="command" aria-pressed="${selected === "command"}"><svg viewBox="0 0 110 100" fill="none" aria-hidden="true"><path d="m10 65 45-26 45 26-45 26Z" stroke="currentColor" opacity=".4"/><path d="M28 55V36l27-16 27 16v19L55 71Z" fill="#38534e" stroke="#8ca99b"/><path d="m28 36 27 16 27-16M55 52v19" stroke="#8ca99b"/><path d="M55 29V7m-7 9 7-4 7 4" stroke="#c8ddc6"/><path d="m36 47 12 7m14 1 12-7" stroke="#b5d0ac" stroke-width="3"/></svg><strong>MBA</strong><span>YOUR COMMAND CENTER</span></button><span class="cc-map-coordinate">28.06 / 41.92<br>LOCAL SECTOR</span></div><div class="cc-map-bottom"><span><i class="cc-dot"></i> ${scene === "handoff" ? "Future crew · imagined cooperation" : "Current crew · illustrative activity"}</span><span>Select a base or agent to inspect</span></div></section>`;
}

function missionRail(scene, selection) {
  const all = missions(scene);
  const ids =
    scene === "handoff"
      ? ["guide", "sync", "setup"]
      : ["sync", "research", "setup"];
  return `<aside class="cc-missions" aria-label="Shared missions"><div class="cc-section-label"><span>SHARED MISSIONS</span><span>0${ids.length}</span></div>${ids.map((id, index) => `<button class="cc-mission ${selection === `mission:${id}` ? "selected" : ""}" data-command-select="mission:${id}" aria-pressed="${selection === `mission:${id}`}" ><span class="cc-mission-number">0${index + 1}<i class="cc-dot ${all[id].tone}"></i></span><span class="cc-mission-copy"><small>${all[id].base}</small><strong>${all[id].title}</strong><span class="cc-mission-state ${all[id].tone}">${all[id].status}</span></span></button>`).join("")}<div class="cc-rail-note"><span class="cc-crosshair"></span><p>Every mission holds one shared outcome.<br>Several agents can carry it forward.</p></div></aside>`;
}

function missionInspector(id, scene) {
  const mission = missions(scene)[id];
  return `<span class="cc-kicker">SHARED MISSION</span><h2 id="cc-inspector-title" tabindex="-1">${mission.title}</h2><span class="cc-status ${mission.tone}"><i class="cc-dot"></i>${mission.status}</span><p class="cc-description">${mission.description}</p>${id === "research" && scene === "question" ? '<div class="cc-question"><span>YOUR PERSPECTIVE</span><p>Should we organize the research by project or by topic?</p><small>Decision pending · observation-only study</small></div>' : ""}<div class="cc-section-label">PEOPLE CARRYING IT</div><div class="cc-crew-list">${mission.participants.map(personButton).join("")}</div><div class="cc-section-label">THE WORK SO FAR</div><ol class="cc-steps">${mission.steps.map(([who, text, status]) => `<li class="${status}"><span class="cc-step-dot">${status === "done" ? "✓" : status === "question" ? "?" : ""}</span><div><strong>${who}</strong><p>${text}</p></div></li>`).join("")}</ol><div class="cc-output"><span>WORKING TOWARD</span><strong>↳ ${mission.output}</strong></div><details class="cc-record"><summary>Underlying sample record <span>+</span></summary><dl><dt>Mission</dt><dd>${id}</dd><dt>Participants</dt><dd>${mission.participants.map((key) => `${people[key].name}@${people[key].host}`).join(" · ")}</dd><dt>State</dt><dd>${mission.status}</dd><dt>Source</dt><dd>Fictional design scenario. No live router data.</dd></dl></details>`;
}

function baseInspector(id, scene) {
  const base = bases[id];
  const planned = scene !== "handoff" && (id === "studio" || id === "ops");
  const missionIds =
    id === "office"
      ? ["sync", "research"]
      : id === "computers"
        ? ["setup"]
        : scene === "handoff"
          ? ["guide"]
          : [];
  if (id === "office" && scene === "handoff") missionIds.unshift("guide");
  return `<span class="cc-kicker">${planned ? "FUTURE BASE" : "BASE / " + base.number}</span><h2 id="cc-inspector-title" tabindex="-1">${base.name}</h2><span class="cc-status ${base.color}">${base.purpose}</span><p class="cc-description">${base.description}</p><div class="cc-output"><span>ONGOING RESPONSIBILITY</span><strong>${base.output}</strong></div><div class="cc-section-label">${planned ? "A PLACE FOR FUTURE TEAMMATES" : "RESIDENT AGENTS"}</div>${planned ? '<p class="cc-description">No agent is connected here in the current-crew sample. Choose “Future cooperation” to imagine this base joining a mission.</p>' : `<div class="cc-crew-list">${base.people.map(personButton).join("")}</div>`}${missionIds.length ? `<div class="cc-section-label">MISSIONS HERE</div>${missionIds.map((key) => `<button class="cc-inline-link" data-command-select="mission:${key}">${missions(scene)[key].title}<span>↗</span></button>`).join("")}` : ""}<div class="cc-explanation">A base groups a lasting responsibility. Its agents can work on different machines.</div>`;
}

function agentInspector(id, scene) {
  const person = people[id];
  const missionId =
    person.base === "computers"
      ? "setup"
      : scene === "handoff" && missions(scene).guide.participants.includes(id)
        ? "guide"
        : scene === "question"
          ? "research"
          : "sync";
  return `<div class="cc-agent-heading">${portrait(id)}<span class="cc-kicker">AGENT / ${person.host}</span></div><h2 id="cc-inspector-title" tabindex="-1">${person.name}</h2><span class="cc-status ${bases[person.base].color}">${person.role}</span><p class="cc-description">${person.description}</p><dl class="cc-facts"><dt>Belongs to</dt><dd><button data-command-select="base:${person.base}">${bases[person.base].name} ↗</button></dd><dt>Works on</dt><dd>${person.host}</dd></dl><div class="cc-section-label">CURRENT CONTRIBUTION</div><button class="cc-inline-link" data-command-select="mission:${missionId}">${missions(scene)[missionId].title}<span>↗</span></button><details class="cc-record"><summary>Sample workbench <span>+</span></summary><pre>DESIGN SAMPLE · READ ONLY\n\n${person.name} @ ${person.host}\nrole: ${person.role}\nmission: ${missionId}\n\nThe live version would open\nthis agent's Paseo workspace.</pre></details><div class="cc-explanation">The agent keeps its identity across missions. Its session and machine are details you can inspect.</div>`;
}

function commandInspector(scene) {
  return `<span class="cc-kicker">YOUR POINT OF VIEW</span><h2 id="cc-inspector-title" tabindex="-1">MBA command center</h2><span class="cc-status cc-mint">First foothold</span><p class="cc-description">A place to see the society, follow its work and bring your judgment where it is needed.</p><div class="cc-output"><span>FROM HERE, YOU CAN SEE</span><strong>${scenes[scene].population}</strong></div><div class="cc-section-label">AGENTS WORKING ON MBA</div>${personButton("local")}${personButton("mac")}<div class="cc-explanation">MBA is your vantage point. The bases represent shared responsibilities; their work can continue across other machines.</div>`;
}

function modelInspector() {
  return `<span class="cc-kicker">READING THE SOCIETY</span><h2 id="cc-inspector-title" tabindex="-1">Three things to know.</h2><div class="cc-model-row"><b>01</b><div><h3>Bases endure.</h3><p>Office, Computers, Studio and Ops each care for an ongoing responsibility.</p></div></div><div class="cc-model-row"><b>02</b><div><h3>Agents contribute.</h3><p>Recognizable teammates, each with a role and a machine they work on.</p></div></div><div class="cc-model-row"><b>03</b><div><h3>Missions connect.</h3><p>A piece of work brings agents together around one outcome, within or across bases.</p></div></div><div class="cc-explanation">MBA is your command center. Machine labels show where agents work. The underlying records sit beneath each mission.</div>`;
}

function inspector(scene, selection) {
  const [kind, id] = selection.split(":");
  const content =
    kind === "mission"
      ? missionInspector(id, scene)
      : kind === "base"
        ? baseInspector(id, scene)
        : kind === "agent"
          ? agentInspector(id, scene)
          : kind === "model"
            ? modelInspector()
            : commandInspector(scene);
  return `<aside class="cc-inspector" aria-labelledby="cc-inspector-title"><div class="cc-section-label"><span>INSPECT</span><button class="cc-return-map" data-command-map>Back to map ↑</button><span class="cc-inspector-glyph">⌁</span></div>${content}</aside>`;
}

export function commandHome(state) {
  const scene = state.commandScene;
  const info = scenes[scene];
  const selection = state.commandSelection;
  return `<div class="command-app"><div class="cc-prototype-bar"><span><i class="cc-demo-dot"></i> DESIGN STUDY <b>/</b> SAMPLE DATA</span><div class="cc-scene-switch" role="group" aria-label="Sample scenarios">${Object.entries(
    scenes,
  )
    .map(
      ([key, value], index) =>
        `<button data-command-scene="${key}" aria-pressed="${scene === key}"><span>0${index + 1}</span> ${value.label}</button>`,
    )
    .join(
      "",
    )}</div><button class="cc-motion" data-action="motion">Motion ${state.motion ? "on" : "off"}</button></div><header class="cc-header"><div class="cc-identity"><span class="cc-logo">j<span>↗</span></span><div><strong>JEV <span>/</span> COMMAND</strong><small>MBA · YOUR FIRST COMMAND CENTER</small></div></div><div class="cc-system-status"><span><i class="cc-dot cc-mint"></i> ${scene === "handoff" ? "4" : "2"} bases</span><span>${scene === "handoff" ? "6" : "4"} agents</span><button data-command-select="${scene === "question" ? "mission:research" : "command"}" class="${scene === "question" ? "cc-sand" : ""}">${scene === "question" ? "01 NEEDS YOU" : "NO QUESTIONS WAITING"}</button></div></header><main class="cc-main"><div class="cc-briefing"><div><span class="cc-kicker">${scene === "handoff" ? "FUTURE CREW / FICTIONAL SCENARIO" : "YOUR SOCIETY / FICTIONAL SCENARIO"}</span><h1>${info.title}</h1><p>${info.description}</p></div><span class="cc-sector-id">01<span>LOCAL SECTOR</span></span></div><div class="cc-layout">${missionRail(scene, selection)}${world(scene, selection)}${inspector(scene, selection)}</div><section class="cc-transmission" aria-label="Latest sample exchange"><span class="cc-transmission-label"><i class="cc-dot ${scene === "question" ? "cc-sand" : "cc-mint"}"></i> ${scene === "question" ? "QUESTION" : "LATEST EXCHANGE"}</span><p>${info.transmission}</p><span>${info.stamp}</span>${scene === "handoff" ? "<button data-command-replay>↻ Replay handoff</button>" : ""}</section><footer class="cc-support"><div><span>SUPPORTING MACHINES</span><button data-command-select="command">MBA <small>command center</small></button><span class="cc-machine">mini</span><span class="cc-machine">MBP</span>${scene === "handoff" ? '<span class="cc-machine">VPS</span>' : ""}</div><p>Bases hold responsibilities. Missions connect them.</p></footer><p class="cc-state-caption">${info.label} · ${info.population} · ${scene === "question" ? "1 question" : "0 questions"} · ${selection.replace(":", " / ")} selected · no live connections</p></main></div>`;
}
