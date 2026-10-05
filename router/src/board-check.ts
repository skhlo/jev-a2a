// The board page's script, checked in a headless Chromium over the DevTools
// protocol. What it checks, how to run it and what it needs are in
// design/README.md ("The script in a browser").
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
import { boardListener, recordReader } from "./server.ts";
import { writeTelemetry } from "./telemetry.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
// `promise`, or a rejection naming `what` once `ms` have passed.
const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: no answer in ${ms} ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
// The page navigated while it was being asked something.
const navigated = (error: unknown): boolean =>
  /Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/.test(
    messageOf(error),
  );

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
  const served = { ...config, home };
  const server = createServer(
    boardListener({
      config: served,
      record: recordReader(served),
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
};

// One DevTools connection: each call is answered in time or rejected, and
// every call still waiting is rejected when the connection closes.
async function connect(url: string): Promise<{
  send: Page["send"];
  close(): void;
}> {
  const socket = new WebSocket(url);
  await within(
    new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error(url)), {
        once: true,
      });
    }),
    5000,
    "DevTools connection",
  );
  let id = 0;
  const waiting = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  socket.addEventListener("message", (event: MessageEvent) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message) || typeof message.id !== "number") return;
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) call?.reject(new Error(JSON.stringify(message.error)));
    else call?.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const call of waiting.values())
      call.reject(new Error("DevTools connection closed"));
    waiting.clear();
  });
  const send = (method: string, params: Record<string, unknown> = {}) => {
    id += 1;
    const mine = id;
    const answer = new Promise<unknown>((resolve, reject) => {
      waiting.set(mine, { resolve, reject });
      socket.send(JSON.stringify({ id: mine, method, params }));
    });
    return within(answer, 15_000, method).finally(() => waiting.delete(mine));
  };
  return { send, close: () => socket.close() };
}

// A headless Chromium on a loopback debugging port, its profile and its
// temporary files in `scratch`, and its one page. close() resolves once the
// browser has exited: asked to close, then sent SIGTERM, then SIGKILL.
async function launch(
  scratch: string,
): Promise<{ page: Page; close(): Promise<void> }> {
  const chromium = spawn(
    process.env.CHROMIUM ?? "chromium",
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(scratch, "chromium")}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, TMPDIR: scratch },
    },
  );
  let running = true;
  const exited = new Promise<void>((resolve) => {
    chromium.once("exit", () => resolve());
    chromium.once("error", () => resolve());
  }).then(() => {
    running = false;
  });
  let browserUrl = "";
  let page: Awaited<ReturnType<typeof connect>> | null = null;
  const close = async (): Promise<void> => {
    page?.close();
    if (!running) return;
    const quit = async (): Promise<boolean> =>
      within(exited, 3000, "Chromium exit").then(
        () => true,
        () => false,
      );
    if (browserUrl) {
      const browser = await connect(browserUrl).catch(() => null);
      await browser?.send("Browser.close").catch(() => undefined);
      browser?.close();
    }
    if (await quit()) return;
    chromium.kill("SIGTERM");
    if (await quit()) return;
    chromium.kill("SIGKILL");
    await exited;
  };
  try {
    browserUrl = await within(
      new Promise<string>((resolve, reject) => {
        let text = "";
        chromium.stderr.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const found = /DevTools listening on (ws:\/\/\S+)/.exec(text);
          if (found?.[1]) resolve(found[1]);
        });
        chromium.once("error", (error) =>
          reject(new Error(`cannot start Chromium: ${error.message}`)),
        );
        chromium.once("exit", () =>
          reject(new Error(`Chromium exited: ${text}`)),
        );
      }),
      15_000,
      "Chromium's DevTools address",
    );
    const list: unknown = await (
      await fetch(`http://${new URL(browserUrl).host}/json/list`)
    ).json();
    const target = Array.isArray(list)
      ? list.find((t: unknown) => isRecord(t) && t.type === "page")
      : undefined;
    if (!isRecord(target) || typeof target.webSocketDebuggerUrl !== "string")
      throw new Error("no page to drive");
    page = await connect(target.webSocketDebuggerUrl);
    await page.send("Page.enable");
  } catch (error: unknown) {
    await close();
    throw error;
  }
  const { send } = page;
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
  return { page: { send, evaluate }, close };
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

// Asks the page, again while it is between two documents.
async function ask(page: Page, expression: string): Promise<unknown> {
  for (let tries = 0; ; tries++)
    try {
      return await page.evaluate(expression);
    } catch (error: unknown) {
      if (!navigated(error) || tries >= 40) throw error;
      await pause(50);
    }
}

// Waits until `expression` is true in the page, or `ms` have passed.
async function until(page: Page, expression: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((await ask(page, expression)) === true) return true;
    await pause(25);
  }
  return false;
}

// Loads `url` and waits for its script: the old page's mark is gone.
async function goto(page: Page, url: string): Promise<void> {
  await ask(page, `window.leaving = true`);
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
  const value = (expression: string) => ask(page, expression);

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
  const before = Number(await value(`fetches`));
  await value(`refresh()`);
  check(
    "once the open has landed, the timed refreshes go on",
    Number(await value(`fetches`)) === before + 1,
    `${before} then ${String(await value(`fetches`))}`,
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

  // A failed open whose link differs from the address only by its hash
  // loads the page again there: assigning it would not.
  const loaded = `!window.leaving && document.readyState === "complete" && typeof refresh === "function"`;
  const failing = `window.fetch = () => Promise.reject(new Error("offline")); window.leaving = true`;
  await goto(page, `${url}?task=T2`);
  await value(failing);
  await value(
    `document.querySelector('.card a.btn[href="?task=T2#answer-D1"]').click()`,
  );
  check(
    "a failed open of the same task with a hash loads the page there",
    (await until(page, loaded)) &&
      (await value(`location.search + location.hash`)) === "?task=T2#answer-D1",
    await value(`location.search + location.hash`),
  );

  // Back to an entry with a hash, its fetch failing, loads that entry.
  await goto(page, `${url}?task=T6`);
  await goto(page, `${url}?task=T2#answer-D1`);
  await value(`document.querySelector('.task[data-task="T4"] a.id').click()`);
  await until(page, `${DETAIL} === "T4"`);
  await value(failing);
  await value(`history.back()`);
  check(
    "Back to an entry with a hash, its fetch failing, loads that entry",
    (await until(page, loaded)) &&
      (await value(`location.search + location.hash`)) ===
        "?task=T2#answer-D1" &&
      (await value(DETAIL)) === "T2",
    `${String(await value(`location.search + location.hash`))} ${String(await value(DETAIL))}`,
  );

  // An open whose fetch hangs gives up (here after 300 ms, not the page's
  // own wait) and follows its link.
  await goto(page, `${url}?task=T6`);
  await value(
    `(() => { const wait = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = () => wait(300); window.fetch = (u, o = {}) => new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(o.signal.reason))); window.leaving = true; })()`,
  );
  await value(`document.querySelector('.task[data-task="T4"] a.id').click()`);
  check(
    "an open whose fetch hangs gives up and follows its link",
    (await until(page, loaded, 5000)) &&
      (await value(`location.search`)) === "?task=T4" &&
      (await value(DETAIL)) === "T4",
    `${String(await value(`location.search`))} ${String(await value(DETAIL))}`,
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
  // Everything the check writes is in one scratch directory, removed once
  // the server and the browser have stopped: at the end, on a failure, or
  // on SIGINT or SIGTERM, which can come twice (timeout and a terminal send
  // a signal to the process and to its group).
  const scratch = mkdtempSync(join(tmpdir(), "board-check-"));
  let served: Awaited<ReturnType<typeof serveSample>> | null = null;
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> =>
    (stopping ??= (async () => {
      served?.close();
      await browser?.close();
      rmSync(scratch, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    })());
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => {
      void stop().then(() => process.exit(code));
    });
  let failed: string[] = [];
  try {
    const home = join(scratch, "home");
    mkdirSync(home);
    served = await serveSample(home);
    browser = await launch(scratch);
    const { page } = browser;
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
    console.log(
      failed.length ? `${failed.length} failed` : "every check passed",
    );
    process.exitCode = failed.length ? 1 : 0;
  } catch (error: unknown) {
    console.error(`The check could not run: ${messageOf(error)}`);
    process.exitCode = 2;
  } finally {
    await stop();
  }
}
