# Agent society design prototype

Parked on 2026-10-23 for a later design session. The Tailscale preview and
preview server were stopped. The complete study is retained here, with its
original assets and all four variants. The latest direction is Command (D).

## Resume locally

From the repository root:

```sh
node docs/design-prototypes/agent-society/serve.mjs
```

Open <http://127.0.0.1:4318/?variant=D>. Only Node is required; there is no
build or install step. Stop the server with Ctrl-C. It binds to loopback and
does not enable Tailscale. Set `PORT` to use another port. The existing
`pnpm --dir router/plugin prototype:society` shortcut starts the same server.

The study is a standalone, fictional design prototype. It does not read live
router data or issue agent commands. A future implementation still needs a
decision on Paseo integration or a separate hosted surface.

## Session handoff

- Retained branch: `feat/agent-society-ui`; [draft PR #74](https://github.com/skhlo/jev-a2a/pull/74).
- Continue with the Command scene: the accepted working model distinguishes
  the command landmark, responsibility bases, facilities, attached capabilities,
  teammates, and missions. The next design session can assess that hierarchy
  before adding RTS-style controls or live data.
- The [RTS reference study](../../research/agent-society-rts-design.md) records
  the references and rationale. No game assets were copied.
- The archive move preserves the six prototype files byte-for-byte. Earlier
  visual checks covered desktop and phone layouts, selection, scenarios,
  replay, and reduced motion. Newcomer comprehension remains untested.

## Society home prototype

The throwaway society study in this directory asks which home
makes the agents' shared work understandable: Commons (`?variant=A`),
Dispatch (`?variant=B`), Constellation (`?variant=C`), or Command (`?variant=D`). Start it with
`pnpm --dir router/plugin prototype:society` from the repository root,
then open `http://127.0.0.1:4318/`. It needs only Node, uses no external
assets, and binds to loopback. `PORT` selects another port.

This is a standalone browser preview of a society surface and possible Paseo companion,
using fictional stories; it does not render in Paseo or contact the router.
Commons presents Office and Computers as a small game-like world, with
agent characters, a mission journal, and a selected mission you can answer
in place. Its zoom controls and replay make the sample handoff explorable.
Office and Computers open into shared work, agent profiles, artifacts,
and the underlying record. A sample answer updates the home, and a new
intention appears in Work. All state lasts only for the browser visit.
Services and Studio are explicitly future roles. The footer can replay
a handoff, disable motion, or reset the sample. Reduced-motion preferences
are respected. The bottom switcher and arrow keys select shareable home
variants; `NODE_ENV=production` hides the switcher and disables those keys.

The study is retained on `feat/agent-society-ui` for review. Commons
explores a game-like working surface; Dispatch and Constellation provide
alternative compositions. No variant has been selected for production.
The question is whether a newcomer can identify the agents' roles, follow
a handoff, and contribute a decision without needing the delivery details.

## Command study: the abstraction under the motif

Command (`?variant=D`) asks whether an inhabited compound makes the society
understandable: bases hold ongoing responsibilities, facilities express durable
functions, named agents contribute work, and missions connect them around an
outcome. MBA is the first command center, the human's point of view. A machine
is a location shown on an agent, rather than another navigation level. Office
therefore spans MBA and mini while remaining one base. This is a candidate
visual model, not a production domain change.

The [RTS reference study](../../research/agent-society-rts-design.md) informed
the rebuilt scene. Office has an Archive, Workshop, and Review room; a small
Reference index annex illustrates a capability belonging to the Archive.
Computers has an Engineering bay. Original vector buildings, ground, paths,
work areas, and role equipment distinguish places from crew. These facilities
and associations are illustrative. The annex does not represent a detected or
installed integration, and the map does not represent network distance.

The world occupies the main surface. Selecting a building, annex, agent, base,
or mission opens the bottom console with its purpose, people, and sample work.
The current sample mission carries a setup-guide draft from Office to
Computers for checks on Linux and Mac. A mission selection reveals its route.
On phones the scene scrolls horizontally; selection brings the console into
view, and Return to scene restores the map. All four home variants remain
available through the shared switcher.

Three scenarios show the current crew, future cooperation, and a question
needing the human. Studio and Ops are planned plots in the current scene. The
future scene explicitly introduces fictional Designer and Ops teammates. Its
brief travels from Office to Studio; Ops waits for design approval. Replay
selects that mission and animates one handoff. A slow command-center beacon is
an ambient accent. Motion can be disabled and respects reduced-motion
preferences. The study remains observational, without unit orders or live
mutations. Underlying sample records disclose the fictional source.

The question for user feedback is whether a newcomer can distinguish the
command landmark, bases, facilities, an attached capability, and teammates;
then follow who contributes to a shared outcome and what needs the human.
Visual and interaction checks verify the prototype runs, not that this
vocabulary has been validated with newcomers. A real implementation would
derive activity from router evidence.
