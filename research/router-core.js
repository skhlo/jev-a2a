// Jev router core: a pure, deterministic model of the communication contract.
// The shell authenticates callers, calls Jev and delivery adapters, and feeds
// their results back as events. This module decides; it performs no I/O.
// Contract: jev-router-spec.md. Tests: router-core.test.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RouterCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  const defaultConfig = {
    policy: {
      threshold: 0.9,
      maxJudgments: 1,
      deadline: 100,
      maxText: 4000,
      maxOpenTasks: 20,
    },
    participants: [
      {
        id: "orchestrator",
        name: "Orchestrator",
        kind: "agent",
        hosts: ["mbp"],
        idempotent: true,
        responsibility:
          "Coding across every skhlo repository, including changes to dotfiles source and harness settings, using its configured workflows. Not for inspecting what is applied on a device.",
      },
      {
        id: "knowledge",
        name: "Knowledge assistant",
        kind: "agent",
        hosts: ["mini"],
        idempotent: true,
        responsibility:
          "Notes, research and synthesis, including notes about Incus or any other technology. Not for live machine operations.",
      },
      {
        id: "environment",
        name: "Dotfiles service",
        kind: "service",
        hosts: ["mba", "mbp", "mini"],
        idempotent: true,
        responsibility:
          "Inspects the harness and environment configuration applied on mba, mbp and mini. Never changes dotfiles source.",
      },
      {
        id: "incus",
        name: "Incus service",
        kind: "service",
        hosts: ["lab01"],
        idempotent: true,
        responsibility:
          "Performs configured micro VM operations on lab01. Not for questions or notes about Incus.",
      },
    ],
    // idempotent: the adapter deduplicates by the router's message key (the
    // Paseo SDK's messageId receipts; router-owned services must do the same),
    // so an unknown send may be retried with the same key.
    // Which participants each authenticated principal may address.
    permissions: {
      you: ["orchestrator", "knowledge", "environment", "incus"],
      orchestrator: ["environment", "incus"],
      knowledge: [],
      environment: [],
      incus: [],
    },
  };

  const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
  const TERMINAL = ["completed", "failed", "canceled"];
  const clone = (value) => structuredClone(value);
  const placementKey = (participant, host) => `${participant}@${host}`;
  const digest = (value) => JSON.stringify(value);

  function initial(config = defaultConfig) {
    const placements = {};
    const sessions = {};
    for (const participant of config.participants)
      for (const host of participant.hosts) {
        const key = placementKey(participant.id, host);
        const session = `${key}#1`;
        placements[key] = {
          participant: participant.id,
          host,
          session,
          ready: true,
        };
        sessions[session] = { participant: participant.id, host };
      }
    return {
      config: clone(config),
      now: 0,
      boot: 1,
      placements,
      sessions,
      receipts: {},
      tasks: [],
      nextTask: 1,
      nextDelivery: 1,
      log: [],
      last: null,
    };
  }

  // ---- Queries shared by the reducer, the shell and the invariants ----

  const findTask = (state, id) => state.tasks.find((task) => task.id === id);
  const allDeliveries = (state) =>
    state.tasks.flatMap((task) => task.deliveries);
  const findDelivery = (state, id) =>
    allDeliveries(state).find((d) => d.id === id);
  const participant = (state, id) =>
    state.config.participants.find((entry) => entry.id === id);
  const currentSend = (delivery) => delivery.sends[delivery.sends.length - 1];
  const isOpen = (delivery) => delivery.end === null;
  // A send whose arrival is unconfirmed. It blocks other sends to its
  // placement: the participant may be starting a turn it must not lose.
  const inFlight = (delivery) =>
    isOpen(delivery) &&
    delivery.session !== null &&
    ["attempting", "unknown"].includes(currentSend(delivery).outcome);
  const isTerminal = (task) => task.final !== null;

  // Authenticated caller -> principal. Views authenticate as "you".
  function principalOf(state, by) {
    if (by === "you" || by === "operator") return by;
    return state.sessions[by]?.participant ?? null;
  }

  function mayAddress(state, principal, participantId) {
    return (state.config.permissions[principal] || []).includes(participantId);
  }

  // Why a delivery's current send cannot be attempted now, or null if it can.
  function blockedReason(state, delivery) {
    const task = findTask(state, delivery.taskId);
    const send = currentSend(delivery);
    const placement = state.placements[delivery.placement];
    if (isTerminal(task) || !isOpen(delivery)) return "closed";
    const retry =
      send.outcome === "unknown" &&
      participant(state, delivery.participant).idempotent;
    if (send.outcome !== "pending" && !retry) return "not_pending";
    if (!placement.ready) return "not_ready";
    if (delivery.session !== null && placement.session !== delivery.session)
      return "session_replaced";
    const holder = allDeliveries(state).find(
      (other) =>
        other !== delivery &&
        other.placement === delivery.placement &&
        inFlight(other),
    );
    if (holder) return "in_flight";
    if (delivery.session !== null) return null;
    const earlier = allDeliveries(state).find(
      (other) =>
        other.placement === delivery.placement &&
        other.session === null &&
        isOpen(other) &&
        !isTerminal(findTask(state, other.taskId)) &&
        other.seq < delivery.seq,
    );
    return earlier ? "queued_behind" : null;
  }

  // Work the shell should perform next. The core never performs it itself.
  function commands(state) {
    const work = [];
    for (const task of state.tasks) {
      if (task.routing?.state === "judging")
        work.push({
          type: "judge",
          taskId: task.id,
          question: judgmentQuestion(state, task),
        });
    }
    for (const delivery of allDeliveries(state)) {
      if (blockedReason(state, delivery) === null)
        work.push({
          type: "deliver",
          deliveryId: delivery.id,
          messageId: currentSend(delivery).messageId,
        });
    }
    return work;
  }

  // One Choice over the caller's permitted participants, plus an abstention.
  function judgmentQuestion(state, task) {
    const criteria = {};
    for (const id of state.config.permissions[task.source] || [])
      criteria[id] = participant(state, id).responsibility;
    criteria.none =
      "No listed responsibility clearly owns this request, or it lacks context.";
    return {
      state: { request: task.text },
      instructions:
        "Which participant owns this request? Choose by responsibility, not by technology names mentioned. Choose none when no owner is clear.",
      criteria,
    };
  }

  function status(task) {
    if (task.final) return task.final.status;
    if (task.routing)
      return task.routing.state === "judging" ? "routing" : "needs_recipient";
    const open = task.deliveries.filter(isOpen);
    if (open.some((d) => d.question)) return "needs_answer";
    const outcomes = open.map((d) => currentSend(d).outcome);
    if (outcomes.includes("unknown")) return "uncertain";
    if (outcomes.includes("accepted")) return "working";
    if (outcomes.includes("attempting")) return "delivering";
    return "queued";
  }

  // A2A v1.0 task state for a router status. Router detail travels in metadata.
  const A2A_STATE = {
    routing: "TASK_STATE_SUBMITTED",
    queued: "TASK_STATE_SUBMITTED",
    delivering: "TASK_STATE_SUBMITTED",
    working: "TASK_STATE_WORKING",
    uncertain: "TASK_STATE_WORKING",
    needs_recipient: "TASK_STATE_INPUT_REQUIRED",
    needs_answer: "TASK_STATE_INPUT_REQUIRED",
    completed: "TASK_STATE_COMPLETED",
    failed: "TASK_STATE_FAILED",
    canceled: "TASK_STATE_CANCELED",
  };

  // ---- Reducer ----

  function reduce(previous, event) {
    const state = clone(previous);
    state.last = null;
    const handler = handlers[event?.type];
    const outcome = handler
      ? handler(state, event)
      : reject("unknown_event", "Unknown event type.");
    if (!outcome.ok) {
      // A rejected event changes nothing except the log and its outcome.
      const unchanged = clone(previous);
      unchanged.last = outcome;
      unchanged.log.push({
        n: unchanged.log.length + 1,
        actor: "Router",
        text: outcome.message,
      });
      return unchanged;
    }
    for (const task of state.tasks) settle(state, task);
    state.last = outcome;
    if (outcome.message)
      state.log.push({
        n: state.log.length + 1,
        actor: outcome.actor || "Router",
        text: outcome.message,
      });
    return state;
  }

  const ok = (message, extra = {}) => ({ ok: true, message, ...extra });
  const reject = (code, message) => ({ ok: false, code, message });

  const handlers = {
    submit(
      state,
      { by, messageId, text, to = null, hosts = null, via = null },
    ) {
      const source = principalOf(state, by);
      if (!source || source === "operator")
        return reject(
          "unauthenticated",
          "Only the user or a current participant session can submit.",
        );
      if (
        state.sessions[by] &&
        state.placements[placementKey(source, state.sessions[by].host)]
          .session !== by
      )
        return reject(
          "unauthenticated",
          "A replaced session cannot submit new work.",
        );
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId))
        return reject(
          "invalid",
          "A message ID is 1-64 letters, digits or . _ : -",
        );
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > state.config.policy.maxText
      )
        return reject(
          "invalid",
          `Request text must be non-empty and at most ${state.config.policy.maxText} characters.`,
        );
      if (
        hosts !== null &&
        (to === null || !Array.isArray(hosts) || !hosts.length)
      )
        return reject(
          "invalid",
          "Hosts may only narrow an explicitly addressed request.",
        );
      const wanted = hosts === null ? null : [...new Set(hosts)].sort();
      const key = `${source}/${messageId}`;
      const content = digest({ text, to, hosts: wanted });
      const receipt = state.receipts[key];
      if (receipt) {
        if (receipt.digest !== content)
          return reject(
            "conflict",
            `${key} already identifies different content.`,
          );
        return ok(
          `Existing receipt ${receipt.taskId} for ${key}. Nothing repeated.`,
          { taskId: receipt.taskId, duplicate: true },
        );
      }
      if (to !== null) {
        if (!participant(state, to))
          return reject("invalid", `${to} is not a registered participant.`);
        if (!mayAddress(state, source, to))
          return reject("forbidden", `${source} may not address ${to}.`);
        if (
          wanted &&
          wanted.some((host) => !participant(state, to).hosts.includes(host))
        )
          return reject(
            "invalid",
            `${to} does not run on every requested host.`,
          );
      }
      const open = state.tasks.filter((task) => !isTerminal(task)).length;
      if (open >= state.config.policy.maxOpenTasks)
        return reject("capacity", "Too many open requests. Try again later.");

      const task = {
        id: `T${state.nextTask++}`,
        source,
        messageId,
        text,
        to,
        hosts: wanted,
        via,
        deadline: state.now + state.config.policy.deadline,
        routing: { state: "judging", suggestions: [], reason: null },
        judgments: [],
        recipient: null,
        chosenBy: null,
        deliveries: [],
        late: [],
        final: null,
        status: "routing",
      };
      state.tasks.push(task);
      state.receipts[key] = { taskId: task.id, digest: content };
      if (to !== null) select(state, task, to, "address");
      else if (!(state.config.permissions[source] || []).length)
        askForRecipient(task, "no_permitted_participants", []);
      return ok(`${task.id} recorded for ${key}. The caller may disconnect.`, {
        taskId: task.id,
      });
    },

    judged(state, { taskId, choice, probabilities, model = null }) {
      const task = findTask(state, taskId);
      if (!task || task.routing?.state !== "judging")
        return reject(
          "not_routing",
          "No judgment is pending for this request.",
        );
      if (task.judgments.length >= state.config.policy.maxJudgments)
        return reject("budget", "The judgment budget is spent.");
      const options = Object.keys(judgmentQuestion(state, task).criteria);
      const valid =
        options.includes(choice) &&
        probabilities &&
        typeof probabilities === "object" &&
        Object.keys(probabilities).length === options.length &&
        options.every((id) => id in probabilities) &&
        Object.values(probabilities).every(
          (p) => typeof p === "number" && p >= 0 && p <= 1,
        ) &&
        Math.abs(
          Object.values(probabilities).reduce((sum, p) => sum + p, 0) - 1,
        ) < 0.01;
      task.judgments.push({
        choice,
        probabilities: valid ? probabilities : null,
        model,
        valid,
      });
      const ranked = valid
        ? Object.entries(probabilities)
            .filter(([id]) => id !== "none")
            .sort((a, b) => b[1] - a[1])
        : [];
      const suggestions = ranked
        .filter(([, p]) => p >= 0.1)
        .slice(0, 2)
        .map(([id]) => id);
      if (!valid) {
        askForRecipient(task, "invalid_judgment", []);
        return ok(
          `${task.id}: Jev output was invalid. The sender must name a recipient.`,
          { actor: "Jev" },
        );
      }
      if (
        choice === "none" ||
        probabilities[choice] < state.config.policy.threshold
      ) {
        askForRecipient(
          task,
          choice === "none" ? "no_owner" : "low_confidence",
          suggestions,
        );
        return ok(
          `${task.id}: no confident owner (${choice} ${probabilities[choice] ?? 0}). The sender must choose.`,
          { actor: "Jev" },
        );
      }
      select(state, task, choice, "judgment");
      return ok(
        `${task.id}: Jev selected ${choice} at ${probabilities[choice]}.`,
        { actor: "Jev" },
      );
    },

    judgeFailed(state, { taskId, reason = "unavailable" }) {
      const task = findTask(state, taskId);
      if (!task || task.routing?.state !== "judging")
        return reject(
          "not_routing",
          "No judgment is pending for this request.",
        );
      askForRecipient(task, "routing_unavailable", []);
      return ok(
        `${task.id}: Jev ${reason}. The sender must name a recipient.`,
        { actor: "Jev" },
      );
    },

    choose(state, { by, taskId, to }) {
      const task = findTask(state, taskId);
      if (!task) return reject("not_found", "No such request.");
      if (principalOf(state, by) !== task.source)
        return reject(
          "forbidden",
          "Only the original sender can choose the recipient.",
        );
      if (isTerminal(task) || task.routing?.state !== "needs_recipient")
        return reject(
          "not_waiting",
          "This request is not waiting for a recipient.",
        );
      if (!participant(state, to) || !mayAddress(state, task.source, to))
        return reject("forbidden", `${task.source} may not address ${to}.`);
      select(state, task, to, "sender");
      return ok(`${task.id}: sender chose ${to}.`);
    },

    attempt(state, { deliveryId }) {
      const delivery = findDelivery(state, deliveryId);
      if (!delivery) return reject("not_found", "No such delivery.");
      const reason = blockedReason(state, delivery);
      if (reason)
        return reject(
          "not_eligible",
          `${deliveryId} cannot be attempted: ${reason.replaceAll("_", " ")}.`,
        );
      const send = currentSend(delivery);
      const retry = send.outcome === "unknown";
      delivery.session ??= state.placements[delivery.placement].session;
      send.outcome = "attempting";
      send.trail.push("attempting");
      // The session is about to start a turn. Only a newer observation can
      // report it idle again; a stale "ready" would let the next send interrupt it.
      state.placements[delivery.placement].ready = false;
      return ok(
        retry
          ? `Retrying ${delivery.id}/${send.messageId} with the same key. The adapter deduplicates, so this cannot run twice.`
          : `Recorded ${delivery.id}/${send.messageId} as attempting to ${delivery.session} before calling the adapter.`,
      );
    },

    adapterResult(state, { deliveryId, messageId, outcome }) {
      const delivery = findDelivery(state, deliveryId);
      const send = delivery && currentSend(delivery);
      if (!["accepted", "not_sent", "unknown"].includes(outcome))
        return reject("invalid", "Outcome is accepted, not_sent or unknown.");
      if (
        !send ||
        send.messageId !== messageId ||
        send.outcome !== "attempting"
      )
        return reject(
          "stale_ack",
          "This acknowledgment does not match an attempt in progress. It cannot overwrite later evidence.",
        );
      send.trail.push(outcome);
      if (outcome === "not_sent") {
        // Definitely not delivered: safe to queue again. An unpinned request can go to a new session.
        send.outcome = "pending";
        if (delivery.sends.length === 1) delivery.session = null;
      } else send.outcome = outcome;
      return ok(`${delivery.id}/${messageId}: adapter reported ${outcome}.`, {
        actor: "Adapter",
      });
    },

    update(state, { by, taskId, messageId, inReplyTo, kind, text = "" }) {
      const task = findTask(state, taskId);
      if (!task) return reject("not_found", "No such request.");
      const delivery = task.deliveries.find(
        (d) => d.session !== null && d.session === by,
      );
      if (!delivery)
        return reject(
          "wrong_session",
          "Only the session pinned to a delivery of this request can reply.",
        );
      if (!["working", "question", "completed", "failed"].includes(kind))
        return reject("invalid", "Unknown reply kind.");
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId))
        return reject("invalid", "A reply needs its own message ID.");
      const send = delivery.sends.find(
        (entry) => entry.messageId === inReplyTo,
      );
      if (!send || !send.trail.includes("attempting"))
        return reject(
          "wrong_message",
          "The reply does not answer a message sent on this delivery.",
        );
      const content = digest({ inReplyTo, kind, text });
      const seen = delivery.updates.find(
        (entry) => entry.messageId === messageId,
      );
      if (seen) {
        if (seen.digest !== content)
          return reject(
            "conflict",
            `Reply ${messageId} already has different content.`,
          );
        return ok(`Reply ${messageId} already recorded.`, { duplicate: true });
      }
      const current = isOpen(delivery) && send === currentSend(delivery);
      if (current && kind === "question" && delivery.question)
        return reject(
          "question_open",
          "One question may be outstanding per delivery.",
        );
      const record = {
        messageId,
        inReplyTo,
        kind,
        text,
        digest: content,
        effect: "history",
      };
      delivery.updates.push(record);

      if (!isOpen(delivery))
        return ok(
          `${delivery.id}: reply ${messageId} kept as evidence; the delivery is already closed.`,
        );
      if (!current)
        return ok(
          `${delivery.id}: reply to earlier message ${inReplyTo} kept as history. It cannot advance the current exchange.`,
        );
      // A matching reply proves receipt, even before or instead of the adapter's acknowledgment.
      if (send.outcome !== "accepted") {
        send.outcome = "accepted";
        send.trail.push("reply_seen");
      }
      if (kind === "working") {
        if (delivery.question)
          return ok(
            `${delivery.id}: progress kept as history while a question is open.`,
          );
        delivery.working = true;
        record.effect = "working";
        return ok(`${delivery.id}: ${text || "working"}.`, {
          actor: "Participant",
        });
      }
      if (kind === "question") {
        delivery.question = { id: messageId, text };
        record.effect = "question";
        return ok(`${delivery.id} asks: ${text}`, { actor: "Participant" });
      }
      delivery.question = null;
      delivery.end = { reason: kind, text, messageId, by };
      record.effect = "final";
      if (isTerminal(task)) {
        task.late.push({ deliveryId: delivery.id, kind, text });
        return ok(
          `${delivery.id}: late ${kind} result stored; ${task.id} stays ${task.final.status}.`,
          { actor: "Participant" },
        );
      }
      return ok(`${delivery.id}: ${kind} result stored.`, {
        actor: "Participant",
      });
    },

    answer(state, { by, taskId, messageId, questionId, text }) {
      const task = findTask(state, taskId);
      if (!task) return reject("not_found", "No such request.");
      if (principalOf(state, by) !== task.source)
        return reject("forbidden", "Only the original sender can answer.");
      if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId))
        return reject("invalid", "An answer needs its own message ID.");
      if (
        typeof text !== "string" ||
        !text.trim() ||
        text.length > state.config.policy.maxText
      )
        return reject("invalid", "Answer text is required.");
      const key = `${task.source}/${messageId}`;
      const content = digest({ taskId, questionId, text });
      const receipt = state.receipts[key];
      if (receipt) {
        if (receipt.digest !== content)
          return reject(
            "conflict",
            `${key} already identifies different content.`,
          );
        return ok(`Answer ${key} already recorded.`, { duplicate: true });
      }
      if (isTerminal(task))
        return reject(
          "terminal",
          `${task.id} is ${task.final.status} and accepts no further messages.`,
        );
      const delivery = task.deliveries.find(
        (d) => isOpen(d) && d.question?.id === questionId,
      );
      if (!delivery)
        return reject(
          "no_question",
          "That question is not open. It may already be answered.",
        );
      delivery.question = null;
      delivery.sends.push({
        messageId,
        kind: "answer",
        text,
        outcome: "pending",
        trail: [],
      });
      state.receipts[key] = { taskId: task.id, digest: content };
      return ok(
        `${task.id}: answer ${messageId} queued for the pinned session ${delivery.session}.`,
      );
    },

    cancel(state, { by, taskId }) {
      const task = findTask(state, taskId);
      if (!task) return reject("not_found", "No such request.");
      if (principalOf(state, by) !== task.source)
        return reject("forbidden", "Only the original sender can cancel.");
      if (isTerminal(task))
        return reject(
          "not_cancelable",
          `${task.id} is already ${task.final.status}.`,
        );
      if (task.deliveries.some((d) => d.session !== null || !isOpen(d)))
        return reject(
          "not_cancelable",
          "Work may have reached a participant. Only never-sent requests can be canceled.",
        );
      for (const delivery of task.deliveries)
        delivery.end = { reason: "canceled" };
      task.final = { status: "canceled", reason: "sender" };
      return ok(`${task.id} canceled before any delivery.`);
    },

    resolve(state, { by, deliveryId, messageId, outcome, evidence }) {
      if (by !== "operator")
        return reject(
          "forbidden",
          "Only an operator can reconcile a delivery.",
        );
      const delivery = findDelivery(state, deliveryId);
      if (!delivery || !isOpen(delivery) || delivery.session === null)
        return reject(
          "not_pinned",
          "Only an open, pinned delivery needs reconciliation.",
        );
      const send = currentSend(delivery);
      if (send.messageId !== messageId)
        return reject(
          "wrong_message",
          "Reconcile the delivery's current message.",
        );
      if (typeof evidence !== "string" || !evidence.trim())
        return reject("invalid", "Record the evidence checked.");
      const allowed =
        send.outcome === "accepted" ? ["finished"] : ["finished", "not_sent"];
      if (send.outcome === "attempting")
        return reject(
          "in_progress",
          "An attempt is in progress. Wait for its outcome or a restart.",
        );
      if (!allowed.includes(outcome))
        return reject(
          "invalid",
          `An ${send.outcome} message can only be resolved as ${allowed.join(" or ")}.`,
        );
      delivery.question = null;
      delivery.end = { reason: `resolved_${outcome}`, text: evidence, by };
      return ok(
        `${delivery.id} reconciled as ${outcome} by the operator. Nothing was resent.`,
      );
    },

    observe(state, { placement, ready, session }) {
      const entry = state.placements[placement];
      if (!entry) return reject("not_found", "No such placement.");
      if (ready !== undefined) entry.ready = Boolean(ready);
      if (session !== undefined && session !== entry.session) {
        if (typeof session !== "string" || state.sessions[session])
          return reject("invalid", "A new session needs a new identity.");
        entry.session = session;
        state.sessions[session] = {
          participant: entry.participant,
          host: entry.host,
        };
      }
      return ok(
        `${placement}: ${entry.ready ? "ready" : "not ready"}, session ${entry.session}.`,
        { actor: "Adapter" },
      );
    },

    restart(state) {
      state.boot++;
      let uncertain = 0;
      for (const delivery of allDeliveries(state))
        for (const send of delivery.sends)
          if (send.outcome === "attempting") {
            send.outcome = "unknown";
            send.trail.push("unknown");
            uncertain++;
          }
      return ok(
        `Router boot ${state.boot}: ${uncertain} interrupted attempt(s) marked unknown. Nothing replayed.`,
      );
    },

    tick(state, { now }) {
      if (typeof now !== "number" || now < state.now)
        return reject("invalid", "Time only moves forward.");
      state.now = now;
      const expired = [];
      for (const task of state.tasks)
        if (!isTerminal(task) && now >= task.deadline) {
          task.routing = null;
          task.final = { status: "failed", reason: "deadline" };
          expired.push(task.id);
        }
      return ok(
        expired.length
          ? `Deadline passed for ${expired.join(", ")}. Unconfirmed sends keep holding their sessions until they end or are reconciled.`
          : `Clock at ${now}.`,
      );
    },
  };

  function askForRecipient(task, reason, suggestions) {
    task.routing = { state: "needs_recipient", reason, suggestions };
  }

  function select(state, task, participantId, chosenBy) {
    const entry = participant(state, participantId);
    task.routing = null;
    task.recipient = participantId;
    task.chosenBy = chosenBy;
    task.deliveries = (task.hosts || entry.hosts).map((host) => ({
      id: `D${state.nextDelivery}`,
      seq: state.nextDelivery++,
      taskId: task.id,
      participant: participantId,
      host,
      placement: placementKey(participantId, host),
      session: null,
      sends: [
        {
          messageId: task.messageId,
          kind: "request",
          text: task.text,
          outcome: "pending",
          trail: [],
        },
      ],
      question: null,
      working: false,
      updates: [],
      end: null,
    }));
  }

  // Close what can no longer happen, then derive status.
  function settle(state, task) {
    if (isTerminal(task)) {
      // Nothing new is sent after a deadline: never-sent deliveries expire.
      for (const delivery of task.deliveries)
        if (isOpen(delivery) && delivery.session === null)
          delivery.end = { reason: "expired" };
    } else if (
      task.deliveries.length &&
      task.deliveries.every((d) => !isOpen(d))
    ) {
      const allCompleted = task.deliveries.every(
        (d) => d.end.reason === "completed",
      );
      task.final = allCompleted
        ? { status: "completed", reason: null }
        : { status: "failed", reason: "delivery" };
    }
    task.status = status(task);
  }

  return {
    defaultConfig,
    initial,
    reduce,
    commands,
    status,
    blockedReason,
    currentSend,
    isOpen,
    inFlight,
    principalOf,
    findTask,
    findDelivery,
    allDeliveries,
    judgmentQuestion,
    A2A_STATE,
    TERMINAL,
  };
});
