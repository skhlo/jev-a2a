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
    select: "base:office",
    transmission:
      "Computers → Office · Linux checks are back. The Mac check is in progress.",
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
      title: "A setup guide that works everywhere",
      base: "Office → Computers",
      status: "Checking the draft on each machine",
      tone: "cc-blue",
      description:
        "Office drafts the setup guide. Computers checks it on Linux and Mac, then sends findings back to improve the shared instructions.",
      participants: ["keeper", "local", "linux", "mac"],
      output: "A checked setup guide",
      steps: [
        ["Office", "Share the draft guide", "done"],
        ["Computers", "Linux checked; Mac in progress", "active"],
        ["Office", "Keep the reviewed guide", "waiting"],
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

// Original vector scenery. The facilities are candidate visual roles, not live infrastructure.
const facilities = {
  archive: {
    name: "Archive",
    role: "Keep what we learn",
    base: "office",
    kind: "archive",
    crew: ["keeper"],
    description:
      "The lasting memory of Office. Research, decisions and finished work return here so the next mission starts with context.",
    output: "Research collection · 8 sample notes",
    x: 465,
    y: 237,
    width: 246,
  },
  workshop: {
    name: "Workshop",
    role: "Turn notes into useful work",
    base: "office",
    kind: "workshop",
    crew: ["local"],
    description:
      "A place to bring ideas together, draft an artifact and prepare it for someone else to use.",
    output: "Setup field guide · draft 03",
    x: 675,
    y: 352,
    width: 236,
  },
  review: {
    name: "Review room",
    role: "Bring your judgment",
    base: "office",
    kind: "review",
    crew: ["keeper", "local"],
    description:
      "Where a proposal becomes a decision. See the alternatives, the people involved and the question that needs your perspective.",
    output: "A decision everyone can carry forward",
    x: 359,
    y: 380,
    width: 170,
  },
  engineering: {
    name: "Engineering bay",
    role: "Check it on each machine",
    base: "computers",
    kind: "engineering",
    crew: ["linux", "mac"],
    description:
      "The Computers crew checks shared changes against the different machines they look after. Findings travel back to the people preparing the work.",
    output: "Linux check complete · Mac check in progress",
    x: 1030,
    y: 198,
    width: 252,
  },
};
const positions = {
  keeper: [545, 390],
  local: [475, 480],
  linux: [900, 300],
  mac: [1150, 315],
  designer: [867, 485],
  operator: [1210, 485],
};
const roles = {
  keeper: "Archivist",
  local: "Writer",
  linux: "Engineer",
  mac: "Engineer",
  designer: "Designer",
  operator: "Operator",
};
const modelRows = [
  [
    "Base",
    "An ongoing responsibility. Office contains several places to work.",
  ],
  [
    "Facility",
    "A durable function: keep knowledge, make an artifact, review a decision.",
  ],
  [
    "Crew",
    "Named teammates. Their host label tells you which machine they work on.",
  ],
  [
    "Mission",
    "A shared outcome that can bring people from several bases together.",
  ],
];
function frame(body, cls = "", view = "0 0 260 220") {
  return `<svg class="${cls}" viewBox="${view}" fill="none" aria-hidden="true" ${cls === "cc-terrain" ? 'preserveAspectRatio="none"' : ""}>${body}</svg>`;
}
function building(kind, cls = "cc-building") {
  const common = `<ellipse cx="130" cy="180" rx="112" ry="27" fill="#071010" opacity=".48"/><path d="m15 161 113-60 117 60-113 62Z" fill="#47534a" stroke="#7f8973" stroke-opacity=".4"/><path d="m25 161 103-54 106 54-102 55Z" fill="#3b463e"/><path d="m43 178 36 19m108-20 24-13" stroke="#c1b685" stroke-width="3" opacity=".55"/>`;
  const shapes = {
    index: `<path d="m32 124 96-54 103 54v49l-101 55-98-55Z" fill="#6a7f65"/><path d="m130 179 101-55v49l-101 55Z" fill="#344c3a"/><path d="m25 119 103-57 111 57-109 60Z" fill="#b2b98d" stroke="#d0d0a6"/><path d="m48 117 80-44 84 44-82 45Z" fill="#708767"/><path d="m65 109 81 43m-57-56 81 43m-57-57 81 43" stroke="#bac49e" stroke-width="5"/><path d="m49 147 61 33v31l-61-33Z" fill="#263d2d"/><path d="m58 157 43 23m-43-12 43 23" stroke="#c0c995" stroke-width="5"/><path d="m149 180 59-32v27l-59 32Z" fill="#97b190"/><path d="m6 145 30-17 12 7-31 18v17L6 162Z" fill="#9da27c"/><path d="m164 179 0 18m17-28v18" stroke="#496249" stroke-width="3"/>`,
    archive: `<path d="m55 91 79-44 76 44v68l-77 44-78-44Z" fill="#738577"/><path d="m133 135 77-44v68l-77 44Z" fill="#3a5047"/><path d="m55 91 78 44v68l-78-44Z" fill="#697a68"/><path d="m43 85 91-52 88 52-89 52Z" fill="#97a185" stroke="#bac1a4"/><path d="m43 85 0 10 90 51v-9Zm90 52 89-52v10l-89 51Z" fill="#546659"/><path d="m63 84 70-39 68 39-68 40Z" fill="#637d6d"/><path d="m66 81 67-38 67 38-67 35Z" fill="#768c77"/><path d="m80 75 53-30 54 30M96 86l38-22 37 22M111 95l23-14 23 14" stroke="#a6b298" stroke-width="2"/><path d="m67 113 53 30v37l-53-30Z" fill="#202f2b" stroke="#b6bba0"/><path d="m72 122 43 24m-43-12 43 24m-43-12 43 24" stroke="#6d8e76" stroke-width="2"/><path d="m76 124 0 8m7-4v8m8-4v8m9-3v8m9-4v8M76 137v8m7-4v8m8-4v8m9-3v8m9-4v8" stroke="#c6ba87" stroke-width="4"/><path d="m151 137 35-20v44l-35 20Z" fill="#182f2a" stroke="#b5c7a0"/><path d="m157 140 22-13v28l-22 13Z" fill="#adc59e" opacity=".65"/><path d="m165 133 0 29m-9-13 23-13" stroke="#426053"/><path d="m144 184 43-25 12 7-44 25Z" fill="#9b9f88"/><path d="m144 191 43-25 12 7-44 25Z" fill="#727e6a"/><path d="M139 43V15m0 2 25 5-25 11Z" fill="#c6b97f" stroke="#b4c2a2"/><path d="m192 128 8-5v14l-8 5Z" fill="#bbcdad"/><path d="m24 164 25-14 17 10-25 14Z" fill="#7e7756"/><path d="M24 164v13l17 10v-13l25-14v13l-25 14" fill="#5a5844"/>`,
    workshop: `<path d="m37 111 91-49 94 49v57l-93 51-92-51Z" fill="#79776a"/><path d="m129 161 93-50v57l-93 51Z" fill="#454e43"/><path d="m37 111 92 50v58l-92-51Z" fill="#6f7461"/><path d="m29 104 97-53 104 53-101 56Z" fill="#7f8a70" stroke="#b0b394"/><path d="m36 103 90-50 97 50-94 51Z" fill="#849078"/><path d="m57 94 90 48m-69-60 91 48m-69-61 91 49" stroke="#4c6355" stroke-width="5"/><path d="m54 134 60 32v43l-60-33Z" fill="#243a31" stroke="#a7b28f"/><path d="m60 143 49 27v30l-49-26Z" fill="#b4bd8c" opacity=".32"/><path d="m61 155 45 25m-45-14 45 25" stroke="#35493c" stroke-width="3"/><path d="m66 167 33 18v8l-33-18Z" fill="#d1bf86"/><path d="M72 176v14m23-1v12" stroke="#c3b98d" stroke-width="3"/><path d="m151 165 50-27v15l-50 27Z" fill="#a9c19c" stroke="#c2d0af"/><path d="m166 157 0 15m16-23v15" stroke="#43594a" stroke-width="3"/><path d="m156 75 18-10 18 10v29l-18 10-18-10Z" fill="#54685a"/><path d="m156 75 18 10 18-10-18-10Z" fill="#a5af97"/><path d="M174 85v29" stroke="#283f34"/><path d="M220 137V70l-41-23" stroke="#c3ae72" stroke-width="6"/><path d="m211 132 9-6 9 6M181 49v18l-5 6" stroke="#d6c48e" stroke-width="2"/><path d="m195 172 26-14 19 11-27 14Z" fill="#b9a16b"/><path d="M195 172v12l18 11 27-15v-11l-27 14Z" fill="#88784f"/>`,
    review: `<path d="m39 121 91-49 91 49v52l-91 50-91-50Z" fill="#617c70"/><path d="m130 171 91-50v52l-91 50Z" fill="#25483e"/><path d="m39 121 91 50v52l-91-50Z" fill="#3c6251"/><path d="m30 118 100-55 100 55-100 55Z" fill="#a7ba9b" stroke="#cdd7b6"/><path d="m45 117 85-46 85 46-85 47Z" fill="#5f9a8a"/><path d="m72 102 85 47m-56-63 85 47m-115-1 85-47m-56 63 85-47" stroke="#bbd1b4" stroke-width="2"/><path d="m51 137 65 36v32l-65-36Z" fill="#b7c5a2" opacity=".6"/><path d="m146 176 62-34v31l-62 34Z" fill="#8db49a" opacity=".6"/><path d="M74 151v31m22-18v31m69-30v31m21-43v31" stroke="#d0d5b8" stroke-width="3"/><path d="m75 170 40-14 35 21-38 16Z" fill="#dbcc9d"/><path d="M112 193v18" stroke="#c1b286" stroke-width="3"/><path d="M226 149v43m-10-23 10-18 10 7-10 15Z" fill="#759073" stroke="#96aa7b"/>`,
    engineering: `<path d="m30 115 100-54 102 54v51l-102 55-100-55Z" fill="#6b7d7e"/><path d="m130 169 102-54v51l-102 55Z" fill="#34494e"/><path d="m30 115 100 54v52l-100-55Z" fill="#647275"/><path d="m23 112 107-78 110 78-110 59Z" fill="#819496" stroke="#b4c8c2"/><path d="m130 34 110 78-110 59Z" fill="#526e76"/><path d="m34 109 96-66 97 66" stroke="#acbfba" stroke-width="3"/><path d="m52 137 56 30v39l-56-30Z" fill="#162b32" stroke="#adc4c2"/><path d="m59 145 42 23v9l-42-23Z" fill="#92b4b7"/><path d="m62 163 34 18v13l-34-18Z" fill="#455e64"/><path d="m148 172 62-34v27l-62 34Z" fill="#1c353d" stroke="#9db7b8"/><path d="m155 172 15-9v15l-15 8Zm23-13 23-12v15l-23 12Z" fill="#7daab0"/><path d="m160 90 30-17 20 14-29 16Z" fill="#c6bf8b"/><path d="m167 87 18-10m-10 14 18-10" stroke="#6b806c" stroke-width="2"/><path d="M222 116V41m-13 20 13-20 13 6" stroke="#bdc8a8" stroke-width="3"/><path d="m206 26 35 20-32 18Z" fill="#92a9a6" stroke="#c1c9ad"/><path d="m218 45 18-11" stroke="#d9d3ab" stroke-width="3"/><path d="m12 158 25-14 19 10-25 15Z" fill="#879694"/><path d="M12 158v22l19 10 25-14v-22l-25 15Z" fill="#566e6e"/><path d="m17 166 9 5m-9 1 9 5" stroke="#b8d3ae" stroke-width="2"/>`,
    command: `<path d="m35 131 44-56 102-1 47 57-9 53-87 37-88-37Z" fill="#5b655b" stroke="#96a08a"/><path d="m44 151 88 39 87-39v33l-87 37-88-37Z" fill="#3e4f45"/><path d="m50 126 38-46h87l38 47-81 37Z" fill="#a0a085" stroke="#c8c3a1"/><path d="m69 115 28-27h68l27 28-60 28Z" fill="#5c7368"/><path d="m80 111 25-18h53l24 18-50 24Z" fill="#96b5a6"/><path d="m81 111 51 24 50-24v19l-50 24-51-24Z" fill="#24473f"/><path d="m87 116 39 18v11l-39-17Zm52 19 36-17v11l-36 17Z" fill="#c9d6a0"/><path d="m97 119 0 12m15-5v13m41-11v12m13-19v12" stroke="#536d58" stroke-width="3"/><path d="m60 160 25 11v12l-25-10Zm117 9 25-11v12l-25 12Z" fill="#c5b47e"/><path d="m109 180 23 10 22-10v29l-22 10-23-10Z" fill="#1c322c" stroke="#abb58f"/><path d="m108 210 24 11 23-11 17 8-40 20-41-20Z" fill="#9c9f7e"/><path d="M161 86V18l-4-7m4 16 37 20-31 18Z" fill="#8e9c89" stroke="#c2c6a5" stroke-width="3"/><path d="m163 40 25-19" stroke="#e0d8ad" stroke-width="3"/><path d="M82 81V46m0 0-10 5m10-5 10 5" stroke="#bec8a6" stroke-width="3"/><circle class="cc-beacon" cx="82" cy="45" r="4" fill="#ddc787"/><path d="m22 143 22-12v42l-17 10-5-7Z" fill="#687c6c"/><path d="m224 134 15 8-1 35-18 10Z" fill="#516b5c"/>`,
    studio: `<path d="m48 117 82-45 83 45v55l-83 46-82-46Z" fill="#8a828b"/><path d="m130 162 83-45v55l-83 46Z" fill="#514a61"/><path d="m38 113 92-70 94 70-94 52Z" fill="#b6a3a9" stroke="#d0c3bb"/><path d="m130 43 94 70-94 52Z" fill="#85798d"/><path d="m68 141 47 26v34l-47-26Z" fill="#d9c7ac"/><path d="m146 165 51-28v28l-51 28Z" fill="#bdbbd0"/><path d="m88 100 41-32 43 32-43 24Z" fill="#637c84" stroke="#c4c9ba"/><path d="m103 88 43 23m-41 0 40-23" stroke="#c4c9ba"/><path d="M224 148v44m-9-38 18-10v25l-18 10Z" fill="#d1b09a" stroke="#a98e88"/>`,
    ops: `<path d="m54 137 76-41 77 41v40l-77 42-76-42Z" fill="#95896c"/><path d="m130 177 77-40v40l-77 42Z" fill="#554e3e"/><path d="m66 113 64-36 64 36-64 36Z" fill="#b4a88a"/><path d="m96 61 34-19 35 19v79l-35 20-34-20Z" fill="#b0a58a"/><path d="m130 80 35-19v79l-35 20Z" fill="#796d53"/><path d="m96 61 34-19 35 19-35 19Z" fill="#dac8a1"/><path d="m104 83 18 10v13l-18-10Zm35 10 18-10v13l-18 10Z" fill="#9eb8a7"/><path d="M131 44V15l25 15-25 17Z" fill="#d7ba83" stroke="#dccba4"/><path d="m74 157 37 20v20l-37-20Zm73 21 40-22v20l-40 22Z" fill="#2e4a41"/><path d="m80 164 23 12m51 5 25-13" stroke="#c5cf98" stroke-width="3"/>`,
  };
  return frame(
    common + shapes[kind],
    cls,
    kind === "command" ? "0 0 260 240" : "0 0 260 230",
  );
}
function portrait(id, small = false) {
  const p = people[id];
  const gear = {
    keeper:
      '<path d="M12 34 23 29l12 5v15l-12-5-11 5Z" fill="#d5c39a" stroke="#eee0b5"/><path d="M23 29v15" stroke="#61705c"/>',
    local:
      '<path d="m29 31 14 5-7 16-14-5Z" fill="#a8c3b1" stroke="#d5dec2"/><path d="m28 39 10 3m-11 2 9 3" stroke="#516b5a"/>',
    linux:
      '<path d="M39 27v22m-5-24 5 7 6-7m-11 22 5-5 6 5" stroke="#d8c99c" stroke-width="4"/>',
    mac: '<path d="m33 29 12 7v17l-12-7Z" fill="#a7c5cc" stroke="#d2e0ca"/><path d="m36 35 6 4m-6 1 6 4" stroke="#4f7076"/>',
    designer:
      '<path d="m32 31 15 6-8 17-15-6Z" fill="#d7c3d9"/><path d="m27 49 15-21" stroke="#daca9e" stroke-width="3"/>',
    operator:
      '<path d="M41 27v21m-5-19 5-4 5 4m-10 7 5-4 5 4" stroke="#ddc28b" stroke-width="3"/>',
  };
  return `<span class="cc-portrait ${bases[p.base].color} ${small ? "small" : ""}">${frame(`<ellipse cx="28" cy="58" rx="22" ry="5" fill="#071411" opacity=".5"/><path d="M19 44v11l-5 3m17-14v11l5 3" stroke="#a0ab92" stroke-width="6"/><path d="m15 28 11-5 11 5 3 20-14 5-14-6Z" fill="currentColor"/><path d="m15 30-7 14 8 4m22-17 7 14-7 3" stroke="currentColor" stroke-width="5"/><path d="M16 18a10 10 0 0 1 20 0v8l-10 5-10-5Z" fill="#c8cfaf"/><path d="M15 18h22v8H15Z" fill="#2d4942"/><path d="M19 21h12" stroke="#d0ddad" stroke-width="2"/>${id === "linux" || id === "mac" ? '<path d="M13 17h26m-24-1 3-7h17l3 7" stroke="#c6b57f" stroke-width="3"/>' : ""}${gear[id]}`, "", "0 0 56 64")}</span>`;
}
function personButton(id) {
  const p = people[id];
  return `<button class="cc-person" data-command-select="agent:${id}">${portrait(id, true)}<span>${p.name}<small>${roles[id]} · ${p.host}</small></span><span aria-hidden="true">↗</span></button>`;
}
function nodeButton(
  key,
  title,
  sub,
  art,
  x,
  y,
  width,
  selected,
  color = "cc-mint",
  extra = "",
) {
  return `<button class="cc-node ${color} ${selected === key ? "selected" : ""} ${extra}" data-command-select="${key}" data-map-node style="--x:${x / 12.8}%;--y:${y / 6.1}%;--w:${width / 12.8}%;--size:${width}" aria-pressed="${selected === key}" aria-label="Inspect ${title}. ${sub}">${art}<span class="cc-node-label"><strong>${title}</strong><small>${sub}</small></span></button>`;
}
function terrain(scene, selection) {
  const stones = [
    [90, 96],
    [132, 106],
    [244, 174],
    [190, 550],
    [710, 105],
    [743, 119],
    [781, 519],
    [814, 530],
    [1190, 380],
    [1215, 395],
    [63, 272],
  ];
  const tufts = [
    [40, 190],
    [80, 185],
    [205, 250],
    [250, 120],
    [264, 475],
    [313, 513],
    [670, 535],
    [743, 154],
    [784, 132],
    [802, 378],
    [1220, 340],
    [1237, 355],
    [750, 559],
    [70, 505],
    [1160, 70],
  ];
  return frame(
    `<defs><pattern id="cc-ground" width="34" height="29" patternUnits="userSpaceOnUse"><path d="m3 6 3-1m17 17 3 1m-8-13 2 1" stroke="#a4a380" stroke-opacity=".12"/></pattern><radialGradient id="cc-ground-light"><stop stop-color="#53624d"/><stop offset="1" stop-color="#1b2c29"/></radialGradient></defs><path d="M0 0h1280v610H0Z" fill="url(#cc-ground-light)"/><path d="M0 0h1280v610H0Z" fill="url(#cc-ground)"/><path d="m-80 410 321 174 624-352 520 278" stroke="#111f1e" stroke-width="64"/><path d="m-80 410 321 174 624-352 520 278" stroke="#56604d" stroke-width="53"/><path d="m-80 410 321 174 624-352 520 278" stroke="#8c8d6b" stroke-opacity=".5" stroke-width="1" stroke-dasharray="8 12"/><path d="m244 532 9-261 260-157 311 168 265-145" stroke="#20372c" stroke-width="32"/><path d="m244 532 9-261 260-157 311 168 265-145" stroke="#70765a" stroke-opacity=".5" stroke-width="24"/><path d="m264 236 239-132 302 167 0 122-209 121-332-184Z" fill="#4e604b" stroke="#a1af81" stroke-opacity=".45" stroke-width="2"/><path d="m279 243 224-124 287 160v103L596 496 279 322Z" fill="#4b5945" stroke="#a6ac82" stroke-opacity=".16"/><path d="m310 270 201-111m-150 155 204-119m-146 161 202-117m-151 158 208-119m-151 158 200-117m-146 159 161-93" stroke="#a7ab82" stroke-opacity=".08"/><path d="m848 139 203-103 212 120v94l-202 115-213-118Z" fill="#435754" stroke="#9fb6ab" stroke-opacity=".4"/><path d="m864 149 185-96 199 113v73l-188 109-196-110Z" stroke="#afc5bb" stroke-opacity=".16"/><path d="m56 362 102-59 116 64v87l-108 64-110-61Z" fill="#56634d" stroke="#b9b58a" stroke-opacity=".4"/><path d="m873 446 81-45 88 50v58l-82 47-87-49Zm186 5 84-47 93 51v58l-87 50-90-49Z" fill="#3e4940" stroke="#a9a48a" stroke-opacity=".3" stroke-dasharray="6 6"/>${stones.map(([x, y]) => `<g transform="translate(${x} ${y})"><path d="m-15 7 9-17 20 2 9 16-18 9Z" fill="#182b27"/><path d="m-15 7 12-6 17-9-20-2Z" fill="#61705a"/><path d="m-3 1 17-9 9 16-18 9Z" fill="#3a4e42"/></g>`).join("")}${tufts.map(([x, y]) => `<path d="m${x} ${y} -5-12 8 8 3-17 3 18 8-10-4 15" fill="#65764e" opacity=".6"/>`).join("")}<path d="m308 442 13-7 10 6-13 7Zm14 8 13-7 10 6-13 7Zm19 10 13-7 10 6-13 7Z" fill="#a5a581"/><path d="m720 301 23-13 20 11-22 13Z" fill="#bab48a" opacity=".6"/><path d="m724 301 0 25m14-18v24m14-31v24" stroke="#797f60" stroke-width="4"/><path d="m650 370 120 65 180-102 77-44" class="cc-route ${selection === "mission:setup" ? "" : "muted"}"/><path d="m650 370 120 65 155 37" class="cc-future-route ${selection === "mission:guide" ? "active" : ""}"/><circle class="cc-packet" r="5" fill="#f3d49c" cx="650" cy="370"/>`,
    "cc-terrain",
    "0 0 1280 610",
  );
}
function world(scene, selection) {
  const future = scene === "handoff";
  const activeMission =
    scene === "question" ? "research" : future ? "guide" : "setup";
  return `<section class="cc-world" aria-label="Society map"><div class="cc-map-top"><div><span class="cc-kicker">HOME SECTOR / 01</span><h1>Room to do good work.</h1></div><button data-command-select="model">Map key <span>↗</span></button></div><div class="cc-map-viewport" tabindex="0" aria-label="Scrollable society scene"><div class="cc-field">${terrain(scene, selection)}<button class="cc-base-sign cc-office-sign ${selection === "base:office" ? "selected" : ""}" data-command-select="base:office"><span>01 / BASE</span><strong>Office</strong><small>Knowledge & decisions · 2 crew</small></button><button class="cc-base-sign cc-computers-sign ${selection === "base:computers" ? "selected" : ""}" data-command-select="base:computers"><span>02 / BASE</span><strong>Computers</strong><small>Tools & environments · 2 crew</small></button>${nodeButton("command", "MBA", "Your command center", building("command"), 148, 375, 265, selection, "cc-sand", "cc-anchor")}${nodeButton("capability:index", "Reference index", "Archive annex", building("index"), 570, 255, 108, selection, "cc-mint", "cc-attachment")}${Object.entries(
    facilities,
  )
    .map(([id, f]) =>
      nodeButton(
        `facility:${id}`,
        f.name,
        f.role,
        building(f.kind),
        f.x,
        f.y,
        f.width,
        selection,
        bases[f.base].color,
        "cc-facility-node",
      ),
    )
    .join(
      "",
    )}${["studio", "ops"].map((id, index) => nodeButton(`base:${id}`, bases[id].name, future ? bases[id].purpose : "Future base", future ? building(id) : frame('<path d="m45 145 85-47 85 47-85 47Z" stroke="currentColor" stroke-dasharray="5 5" opacity=".4"/><path d="M130 150V81m-25 14 25-14 25 14-25 14Z" fill="#293e35" stroke="currentColor"/><path d="M130 109v41" stroke="currentColor"/>', "cc-building"), index ? 1145 : 940, 461, future ? 157 : 130, selection, bases[id].color, future ? "cc-future-base" : "cc-planned")).join("")}${(future
    ? Object.keys(people)
    : ["keeper", "local", "linux", "mac"]
  )
    .map((id) => {
      const p = people[id];
      return nodeButton(
        `agent:${id}`,
        p.name,
        `${roles[id]} · ${p.host}`,
        portrait(id),
        ...positions[id],
        62,
        selection,
        bases[p.base].color,
        "cc-unit",
      );
    })
    .join(
      "",
    )}${scene === "question" ? '<button class="cc-decision-marker" data-command-select="mission:research"><b>?</b> Your perspective needed</button>' : ""}<span class="cc-ground-caption">OFFICE COMPOUND <b>·</b> THREE PLACES, ONE RESPONSIBILITY</span></div></div><div class="cc-map-bottom"><span>SELECT A BUILDING OR TEAMMATE <span class="cc-pan-hint">· Scroll sideways to explore</span></span><span>Illustrative facilities · fictional activity</span></div><button class="cc-mission-banner ${scene === "question" ? "cc-sand" : ""}" data-command-select="mission:${activeMission}"><span class="cc-mission-icon">${scene === "question" ? "?" : "↗"}</span><span><small>${scene === "question" ? "NEEDS YOU" : "SHARED MISSION"}</small><strong>${missions(scene)[activeMission].title}</strong></span><span class="cc-mission-progress">${scene === "question" ? "Waiting for direction" : future ? "Office → Studio · Ops waiting" : "Office → Computers · checking the draft"}</span><span aria-hidden="true">↗</span></button></section>`;
}
function record(title, pairs) {
  return `<details class="cc-record"><summary>${title} <span>+</span></summary><dl>${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}<dt>Source</dt><dd>Fictional design scenario. No live router data.</dd></dl></details>`;
}
function missionLink(id, scene) {
  const m = missions(scene)[id];
  return `<button class="cc-inline-link" data-command-select="mission:${id}"><span><small>SHARED MISSION</small>${m.title}</span><span>↗</span></button>`;
}
function currentMission(scene, id) {
  if (scene === "handoff" && missions(scene).guide.participants.includes(id))
    return "guide";
  if (scene === "question" && people[id].base === "office") return "research";
  return "setup";
}
function inspection(scene, selection) {
  const [kind, id] = selection.split(":");
  if (kind === "capability") {
    return {
      kicker: "ARCHIVE / ATTACHED CAPABILITY",
      title: "Reference index",
      art: building("index"),
      subtitle: "Connect what belongs together",
      description:
        "A small annex to the Archive. It connects related notes and decisions so the crew can find the context behind a piece of work.",
      body: `<div class="cc-output"><small>ILLUSTRATIVE CAPABILITY</small><strong>Part of the fictional Office study</strong></div><button class="cc-inline-link" data-command-select="facility:archive">Belongs to the Archive <span>↗</span></button>${record(
        "Underlying sample record",
        [
          ["Owner", "Archive"],
          [
            "Status",
            "Illustrative capability; no integration detected or installed",
          ],
        ],
      )}`,
      side: `<span class="cc-section-label">USED BY</span>${personButton("keeper")}<p class="cc-note">An attachment extends a place's purpose. Here, the index helps Office keep its knowledge connected.</p>`,
    };
  }
  if (kind === "facility") {
    const f = facilities[id];
    return {
      kicker: `${bases[f.base].name.toUpperCase()} / FACILITY`,
      title: f.name,
      art: building(f.kind),
      subtitle: f.role,
      description: f.description,
      body: `<div class="cc-output"><small>${scene === "question" && id === "review" ? "WAITING FOR YOU" : "SAMPLE WORK HERE"}</small><strong>${scene === "question" && id === "review" ? "Organize by project or by topic?" : f.output}</strong></div>${id === "archive" ? '<button class="cc-inline-link" data-command-select="capability:index">Reference index <span>Inspect annex ↗</span></button>' : ""}${record(
        "About this facility",
        [
          ["Role", f.role],
          ["Base", bases[f.base].name],
          ["Status", "Candidate visual role for this study"],
        ],
      )}`,
      side: `<span class="cc-section-label">CREW USING THIS PLACE</span>${f.crew.map(personButton).join("")}${missionLink(scene === "question" && f.base === "office" ? "research" : scene === "handoff" && id === "archive" ? "guide" : "setup", scene)}`,
    };
  }
  if (kind === "agent") {
    const p = people[id];
    const missionId = currentMission(scene, id);
    return {
      kicker: `RESIDENT CREW / ${p.host}`,
      title: p.name,
      art: portrait(id),
      subtitle: `${roles[id]} · ${bases[p.base].name}`,
      description: p.description,
      body: `<div class="cc-agent-facts"><span><small>HOME RESPONSIBILITY</small><button data-command-select="base:${p.base}">${bases[p.base].name} ↗</button></span><span><small>WORKS ON</small><strong>${p.host}</strong></span></div>${record(
        "Sample workbench",
        [
          ["Agent", `${p.name}@${p.host}`],
          ["Contribution", missions(scene)[missionId].title],
        ],
      )}`,
      side: `<span class="cc-section-label">CURRENT CONTRIBUTION</span>${missionLink(missionId, scene)}<p class="cc-note">A teammate keeps their identity while contributing to different missions.</p>`,
    };
  }
  if (kind === "mission") {
    const m = missions(scene)[id];
    return {
      kicker: "SHARED MISSION",
      title: m.title,
      art: `<div class="cc-mission-emblem">${scene === "question" && id === "research" ? "?" : "↗"}<small>${m.base}</small></div>`,
      subtitle: m.status,
      description: m.description,
      body: `${id === "research" && scene === "question" ? '<div class="cc-question">Organize the research by project or by topic?<small>Decision pending · observation-only study</small></div>' : ""}<ol class="cc-steps">${m.steps.map(([who, text, status]) => `<li class="${status}"><span>${status === "done" ? "✓" : status === "question" ? "?" : "·"}</span><div><strong>${who}</strong><p>${text}</p></div></li>`).join("")}</ol>${record(
        "Underlying sample record",
        [
          ["Mission", id],
          [
            "Participants",
            m.participants
              .map((key) => `${people[key].name}@${people[key].host}`)
              .join(" · "),
          ],
          ["State", m.status],
        ],
      )}`,
      side: `<span class="cc-section-label">PEOPLE CARRYING IT</span><div class="cc-crew-list">${m.participants.map(personButton).join("")}</div>`,
    };
  }
  if (kind === "base") {
    const b = bases[id];
    const planned = (id === "studio" || id === "ops") && scene !== "handoff";
    const places = Object.entries(facilities).filter(([, f]) => f.base === id);
    return {
      kicker: `${planned ? "FUTURE BASE" : "BASE / " + b.number}`,
      title: b.name,
      art: building(
        id === "office" ? "archive" : id === "computers" ? "engineering" : id,
      ),
      subtitle: b.purpose,
      description: b.description,
      body: places.length
        ? `<div class="cc-facility-choices">${places.map(([key, f], i) => `<button data-command-select="facility:${key}"><span>0${i + 1}</span><strong>${f.name}</strong><small>${f.role}</small></button>`).join("")}</div>`
        : `<p class="cc-note">${planned ? "A place for future teammates. Explore Future cooperation to see this base join a mission." : "An imagined future base, contributing to the field guide."}</p>`,
      side: `<span class="cc-section-label">${planned ? "NOT YET PART OF THE CREW" : "RESIDENT CREW"}</span>${planned ? '<p class="cc-note">No connected agent in the current-crew sample.</p>' : b.people.map(personButton).join("")}${planned ? "" : missionLink(scene === "handoff" && id !== "computers" ? "guide" : scene === "question" && id === "office" ? "research" : "setup", scene)}`,
    };
  }
  if (kind === "model")
    return {
      kicker: "READING THE SOCIETY",
      title: "A place for shared work",
      art: building("command"),
      subtitle: "Places, capabilities & people",
      description:
        "MBA is your home landmark. Around it, bases hold ongoing responsibilities. Select something in the scene to see its purpose and the people involved.",
      body: `<div class="cc-model-rows">${modelRows.map(([name, text]) => `<div class="cc-model-row"><strong>${name}</strong><p>${text}</p></div>`).join("")}</div>`,
      side: '<span class="cc-section-label">THIS DESIGN STUDY</span><p class="cc-note">All activity is fictional. Facilities are proposed visual roles. Host labels locate agents; the map does not represent network distance.</p><p class="cc-note">No build queues or unit orders. For now, look around and follow the work.</p>',
    };
  return {
    kicker: "YOUR FIRST FOOTHOLD",
    title: "MBA command center",
    art: building("command"),
    subtitle: "Your point of view",
    description:
      "See the society, follow its work, and bring your judgment where it is needed. The people here work across several machines.",
    body: `<div class="cc-home-choices"><button data-command-select="base:office">01 · Office <span>↗</span></button><button data-command-select="base:computers">02 · Computers <span>↗</span></button></div><p class="cc-note">A machine is a location. A base is a shared responsibility.</p>`,
    side: `<span class="cc-section-label">CREW WORKING ON MBA</span>${personButton("local")}${personButton("mac")}`,
  };
}
function inspector(scene, selection) {
  const p = inspection(scene, selection);
  return `<aside class="cc-inspector" aria-labelledby="cc-inspector-title"><div class="cc-inspector-art"><span class="cc-section-label">SELECTED / ${selection.split(":")[0]}</span>${p.art}<button class="cc-return-map" data-command-map>Return to scene ↑</button></div><div class="cc-inspector-main"><span class="cc-kicker">${p.kicker}</span><h2 id="cc-inspector-title" tabindex="-1">${p.title}</h2><span class="cc-subtitle">${p.subtitle}</span><p class="cc-description">${p.description}</p>${p.body}</div><div class="cc-inspector-side">${p.side}</div></aside>`;
}
export function commandHome(state) {
  const scene = state.commandScene;
  const future = scene === "handoff";
  return `<div class="command-app"><div class="cc-prototype-bar"><span><i></i> DESIGN STUDY <b>/</b> FICTIONAL SCENARIOS</span><div class="cc-scene-switch" role="group" aria-label="Sample scenarios">${Object.entries(
    scenes,
  )
    .map(
      ([key, value], i) =>
        `<button data-command-scene="${key}" aria-pressed="${scene === key}"><span>0${i + 1}</span> ${value.label}</button>`,
    )
    .join(
      "",
    )}</div><button class="cc-motion" data-action="motion">Motion ${state.motion ? "on" : "off"}</button></div><header class="cc-header"><button class="cc-identity" data-command-select="command"><span class="cc-logo">j<span>↗</span></span><span>JEV <b>/</b> SOCIETY<small>MBA COMMAND CENTER</small></span></button><div class="cc-system-status"><span><i class="cc-dot"></i> ${future ? "4" : "2"} bases</span><span>${future ? "6" : "4"} crew</span><button data-command-select="${scene === "question" ? "mission:research" : "command"}">${scene === "question" ? "1 NEEDS YOU" : "NO QUESTIONS WAITING"}</button></div></header><main class="cc-main">${world(scene, state.commandSelection)}${inspector(scene, state.commandSelection)}<footer class="cc-transmission"><span class="cc-transmission-label">${scene === "question" ? "QUESTION" : "LATEST EXCHANGE"}</span><p>${scenes[scene].transmission}</p>${future ? "<button data-command-replay>↻ Replay handoff</button>" : '<span class="cc-stamp">SAMPLE / 09:14</span>'}</footer><p class="cc-state-caption">${scenes[scene].label} · ${scenes[scene].population} · ${scene === "question" ? "1 question" : "0 questions"} · ${state.commandSelection.replace(":", " / ")} selected · no live connections</p></main></div>`;
}
