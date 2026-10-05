// A local check of the board page's script in a headless Chromium, over the
// DevTools protocol: what the unit tests cannot see, as they read the
// script as text. It serves the sample on a loopback port with the
// fixture's viewer, opens it, and checks opening a task in place with a
// refresh racing the fetch, Back and Forward after an open, the focus coming
// back from the usage pop-up after a refresh replaced its opener, and the
// arrow and esc basics. It is not part of `pnpm test`, which has no
// browser. Run it in router/ after a change to the script:
//
//   pnpm exec node src/board-check.ts
//
// It needs a Chromium on PATH (`chromium`, or $CHROMIUM), prints a line per
// check and exits non-zero when one fails. Nothing it writes outlives it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  config,
  NOW,
  sampleJournal,
  telemetry,
  usage,
} from "./board-fixture.ts";
import { boardListener } from "./server.ts";
import { writeTelemetry } from "./telemetry.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The sample's record in a scratch home, served as `router serve` serves it.
async function serveSample(home: string): Promise<{
  url: string;
  close: () => void;
}> {
  writeFileSync(
    join(home, "journal.jsonl"),
    sampleJournal.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
  );
  writeTelemetry(home, telemetry);
  const server = createServer(
    boardListener({
      config: { ...config, home },
      handle: () =>
        Promise.resolve({ outcome: { ok: true, message: "" }, report: [] }),
      now: () => NOW,
      usage: () => usage,
    }),
  );
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => server.close(),
  };
}

type Page = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  close(): Promise<void>;
};

// A headless Chromium on a loopback debugging port, and its one page.
async function launch(profile: string): Promise<Page> {
  const chromium = spawn(
    process.env.CHROMIUM ?? "chromium",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Its page's DevTools address; a start that fails stops the browser.
  const pageUrl = async (): Promise<string> => {
    const port = await new Promise<string>((resolve, reject) => {
      let text = "";
      chromium.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const found = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
        if (found?.[1]) resolve(found[1]);
      });
      chromium.on("exit", () => reject(new Error(`Chromium exited: ${text}`)));
    });
    const list: unknown = await (
      await fetch(`http://127.0.0.1:${port}/json/list`)
    ).json();
    const target = Array.isArray(list)
      ? list.find((t: unknown) => isRecord(t) && t.type === "page")
      : undefined;
    if (!isRecord(target) || typeof target.webSocketDebuggerUrl !== "string")
      throw new Error("no page to drive");
    return target.webSocketDebuggerUrl;
  };
  const socket = new WebSocket(
    await pageUrl().catch((error: unknown) => {
      chromium.kill();
      throw error;
    }),
  );
  await new Promise((resolve) =>
    socket.addEventListener("open", resolve, { once: true }),
  );
  let id = 0;
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  socket.addEventListener("message", (event: MessageEvent) => {
    const message: unknown = JSON.parse(String(event.data));
    if (isRecord(message) && typeof message.id === "number")
      waiting.get(message.id)?.(message);
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      id += 1;
      waiting.set(id, (message) => {
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (!isRecord(result) || result.exceptionDetails)
      throw new Error(`${expression}: ${JSON.stringify(result)}`);
    return isRecord(result.result) ? result.result.value : undefined;
  };
  await send("Page.enable");
  return {
    send,
    evaluate,
    // Resolves once the browser has exited, so its profile can go.
    close: () => {
      socket.close();
      if (chromium.exitCode !== null || chromium.signalCode !== null)
        return Promise.resolve();
      const exited = new Promise<void>((resolve) =>
        chromium.once("exit", () => resolve()),
      );
      chromium.kill();
      return exited;
    },
  };
}

// A key as a keyboard sends it: down (with its text when it has one), up.
const KEY_CODES: Record<string, number> = {
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Enter: 13,
  Escape: 27,
};
async function press(page: Page, key: string, shift = false): Promise<void> {
  const code = KEY_CODES[key] ?? key.toUpperCase().charCodeAt(0);
  const text = key.length === 1 ? { text: key } : {};
  const common = {
    key,
    windowsVirtualKeyCode: code,
    modifiers: shift ? 8 : 0,
  };
  await page.send("Input.dispatchKeyEvent", {
    type: key.length === 1 ? "keyDown" : "rawKeyDown",
    ...common,
    ...text,
  });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  await pause(100);
}

// Waits until `expression` is true in the page, or `ms` have passed.
async function until(page: Page, expression: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await page.evaluate(expression)) === true) return true;
    await pause(25);
  }
  return false;
}

// Loads `url` and waits for its script: the old page's mark is gone.
async function goto(page: Page, url: string): Promise<void> {
  await page.evaluate(`window.leaving = true`);
  await page.send("Page.navigate", { url });
  const loaded = await until(
    page,
    `!window.leaving && document.readyState === "complete" && typeof refresh === "function"`,
  );
  if (!loaded) throw new Error(`${url} did not load`);
  await pause(200);
}

const DETAIL = `document.querySelector(".detail").dataset.task`;
const FOCUS = `(document.activeElement?.closest(".task")?.dataset.task ?? "") + "|" + (document.activeElement?.dataset.path ?? document.activeElement?.className ?? "")`;
// The page's fetches wait `ms` before they leave, so a refresh can land
// while an open's fetch is on its way.
const slowFetch = (ms: number) =>
  `(() => { const f = window.fetch.bind(window); window.fetch = (...a) => new Promise((r) => setTimeout(r, ${ms})).then(() => f(...a)); })()`;

async function checks(page: Page, url: string): Promise<string[]> {
  const failed: string[] = [];
  const check = (name: string, ok: boolean, seen: unknown = "") => {
    console.log(
      `${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (${String(seen)})`}`,
    );
    if (!ok) failed.push(name);
  };
  const value = (expression: string) => page.evaluate(expression);

  // Opening in place while refreshes land: the Answer lever on the asking
  // card opens T2 from T6; two refreshes start while its fetch waits.
  await goto(page, `${url}?task=T6`);
  await value(`sessionStorage.clear(); localStorage.clear()`);
  await value(slowFetch(600));
  const depth = Number(await value(`history.length`));
  await value(
    `(() => { const a = document.querySelector('.card a.btn[href="?task=T2#answer-D1"]'); a.focus(); a.click(); })()`,
  );
  await pause(200);
  void value(`refresh()`);
  await pause(200);
  void value(`refresh()`);
  await until(page, `${DETAIL} === "T2"`);
  await pause(1500);
  check(
    "an open survives refreshes racing its fetch: T2 stays selected",
    (await value(DETAIL)) === "T2",
    await value(DETAIL),
  );
  check(
    "the Answer lever's form takes the focus",
    (await value(
      `document.activeElement?.matches("#answer-D1 textarea") ?? false`,
    )) === true,
    await value(FOCUS),
  );
  check(
    "the address is the lever's link, one entry further",
    (await value(`location.search + location.hash`)) === "?task=T2#answer-D1" &&
      Number(await value(`history.length`)) === depth + 1,
    await value(`location.search + location.hash + " " + history.length`),
  );

  // An open whose fetch fails follows its link, hash and all.
  await goto(page, `${url}?task=T6`);
  await value(
    `window.fetch = () => Promise.reject(new Error("offline")); window.leaving = true`,
  );
  await value(
    `document.querySelector('.card a.btn[href="?task=T2#answer-D1"]').click()`,
  );
  const followed = await until(
    page,
    `!window.leaving && document.readyState === "complete"`,
  );
  check(
    "an open that cannot fetch follows its link",
    followed &&
      (await value(`location.search + location.hash`)) === "?task=T2#answer-D1",
    await value(`location.search + location.hash`),
  );

  // Back returns to the task before the open, Forward to the opened one.
  await goto(page, `${url}?task=T6`);
  await value(`window.marker = 1`);
  await value(`document.querySelector('.task[data-task="T4"] a.id').click()`);
  await until(page, `${DETAIL} === "T4"`);
  await value(`history.back()`);
  const back = await until(page, `${DETAIL} === "T6"`);
  check(
    "Back after an open shows the task before it, in place",
    back &&
      (await value(`location.search`)) === "?task=T6" &&
      (await value(`window.marker`)) === 1,
    `${String(await value(DETAIL))} ${String(await value(`location.search`))}`,
  );
  await value(`history.forward()`);
  check(
    "Forward shows the opened task again",
    await until(page, `${DETAIL} === "T4"`),
    await value(DETAIL),
  );

  // The pop-up gives the focus back to its opener after a refresh
  // replaced it.
  await goto(page, `${url}?task=T2`);
  await value(`document.querySelector('.task[data-task="T2"] a.id').focus()`);
  await press(page, "u");
  await value(`refresh()`);
  await press(page, "Escape");
  check(
    "esc gives the focus back to the row that opened the pop-up, after a refresh",
    (await value(
      `document.activeElement?.matches('.task[data-task="T2"] a.id') ?? false`,
    )) === true &&
      (await value(`document.querySelector(".usage").hidden`)) === true,
    await value(FOCUS),
  );

  // The arrows and esc.
  await goto(page, `${url}?task=T2`);
  await press(page, "ArrowDown");
  await press(page, "ArrowDown");
  const next = await value(
    `document.activeElement?.closest(".task")?.dataset.task ?? ""`,
  );
  check("↓ moves from the selected row to the next", next === "T6", next);
  await press(page, "ArrowDown", true);
  check(
    "⇧↓ is left to the browser",
    (await value(
      `document.activeElement?.closest(".task")?.dataset.task ?? ""`,
    )) === next,
  );
  await press(page, "Enter");
  check(
    "↵ opens the focused row in place",
    await until(page, `${DETAIL} === ${JSON.stringify(next)}`),
    await value(DETAIL),
  );
  await value(
    `document.querySelector('.card button[data-path$=".hold"]').focus()`,
  );
  const lever = await value(FOCUS);
  await press(page, "ArrowDown");
  check(
    "↓ on a button is left to the browser",
    (await value(FOCUS)) === lever,
    await value(FOCUS),
  );
  await press(page, "u");
  await press(page, "?");
  await press(page, "ArrowLeft");
  check(
    "← closes the help before the pop-up behind it",
    (await value(
      `document.querySelector(".help").hidden && !document.querySelector(".usage").hidden`,
    )) === true,
  );
  await press(page, "ArrowDown");
  await press(page, "ArrowRight");
  check(
    "in the pop-up, ↓ then → open the second account's details",
    (await value(`!document.getElementById("usage-more-claude").hidden`)) ===
      true,
    await value(FOCUS),
  );
  await press(page, "ArrowLeft");
  await press(page, "ArrowLeft");
  check(
    "← closes the details, then the pop-up",
    (await value(`document.querySelector(".usage").hidden`)) === true,
  );
  await press(page, "s");
  await press(page, "Escape");
  check(
    "esc closes the sheet",
    (await value(
      `!document.querySelector(".bento > .sheet:not([hidden])")`,
    )) === true,
  );
  return failed;
}

if (import.meta.main) {
  const scratch = mkdtempSync(join(tmpdir(), "board-check-"));
  const home = join(scratch, "home");
  const profile = join(scratch, "chromium");
  mkdirSync(home);
  const served = await serveSample(home);
  const page = await launch(profile);
  // The browser would outlive a check that is interrupted: stop it first.
  const gone = () =>
    rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  // A signal can come twice (timeout sends it to the process and then its
  // group), so a later one waits for the first one's cleanup.
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      served.close();
      void page.close().then(() => {
        gone();
        process.exit(130);
      });
    });
  let failed: string[] = [];
  try {
    await page.send("Network.enable");
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { "tailscale-user-login": "me@example.com" },
    });
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    failed = await checks(page, served.url);
  } finally {
    served.close();
    await page.close();
    gone();
  }
  console.log(failed.length ? `${failed.length} failed` : "every check passed");
  process.exitCode = failed.length ? 1 : 0;
}
