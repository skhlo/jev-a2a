// Jev router core: a pure, deterministic model of the communication contract.
// The shell authenticates callers, calls Jev and delivery adapters, and feeds
// their results back as events. This module decides; it performs no I/O.
// Contract: jev-router-spec.md. Tests: router-core.test.js.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RouterCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  // The core carries no deployment. A configuration supplies:
  //   policy        threshold, deadline, maxText, maxOpenTasks
  //   principals    authenticated non-participant identities -> "requester" | "operator"
  //   participants  { id, name, kind, hosts, idempotent, responsibility }
  //                 idempotent: the adapter deduplicates by the router's message
  //                 key, so an unknown send may be retried with the same key
  //   permissions   principal or participant id -> participant ids it may address
  // router-example-config.js is one deployment, used by the page and the tests.
  const ROLES = ["requester", "operator"];

  function validateConfig(config) {
    const fail = (message) => {
      throw new Error(`Invalid router configuration: ${message}`);
    };
    const isRecord = (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const positive = (value) => Number.isFinite(value) && value > 0;
    if (!isRecord(config)) fail("a configuration object is required");
    const { policy, participants, principals = {}, permissions = {} } = config;
    if (!isRecord(policy)) fail("policy is required");
    if (
      typeof policy.threshold !== "number" ||
      !(policy.threshold > 0 && policy.threshold <= 1)
    )
      fail("policy.threshold must be in (0, 1]");
    for (const key of ["deadline", "maxText", "maxOpenTasks"])
      if (!positive(policy[key]))
        fail(`policy.${key} must be a positive number`);
    if (!Array.isArray(participants) || !participants.length)
      fail("at least one participant is required");
    const ids = new Set();
    for (const p of participants) {
      if (!isRecord(p) || typeof p.id !== "string" || !p.id || ids.has(p.id))
        fail(`participant ids must be unique non-empty strings (${p?.id})`);
      ids.add(p.id);
      if (!["agent", "service"].includes(p.kind))
        fail(`${p.id} kind must be agent or service`);
      if (
        !Array.isArray(p.hosts) ||
        !p.hosts.length ||
        p.hosts.some((host) => typeof host !== "string" || !host) ||
        new Set(p.hosts).size !== p.hosts.length
      )
        fail(`${p.id} needs a non-empty list of distinct host names`);
      if (typeof p.responsibility !== "string" || !p.responsibility.trim())
        fail(`${p.id} needs a responsibility`);
      if (typeof p.idempotent !== "boolean")
        fail(`${p.id} must declare idempotent: true | false`);
    }
    if (!isRecord(principals)) fail("principals must be an object");
    for (const [id, role] of Object.entries(principals)) {
      if (!ROLES.includes(role))
        fail(`principal ${id} has unknown role ${role}`);
      if (ids.has(id)) fail(`principal ${id} collides with a participant id`);
    }
    if (!isRecord(permissions)) fail("permissions must be an object");
    for (const [id, targets] of Object.entries(permissions)) {
      if (!ids.has(id) && !(id in principals))
        fail(`permissions name unknown principal ${id}`);
      if (!Array.isArray(targets)) fail(`permissions for ${id} must be a list`);
      for (const target of targets)
        if (!ids.has(target))
          fail(`${id} may address unknown participant ${target}`);
    }
    return config;
  }

  const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
  const clone = (value) => structuredClone(value);
  const placementKey = (participant, host) => `${participant}@${host}`;
  const digest = (value) => JSON.stringify(value);

  function initial(config) {
    validateConfig(config);
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
          hold: false,
        };
        sessions[session] = { participant: participant.id, host };
      }
    return {
      config: { principals: {}, permissions: {}, ...clone(config) },
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
  // A withdrawn answer never left the router; the exchange continues on the
  // message before it.
  const currentSend = (delivery) =>
    delivery.sends.findLast((send) => send.outcome !== "withdrawn");
  const isOpen = (delivery) => delivery.end === null;
  // The pinned session is no longer the placement's current one.
  const sessionReplaced = (state, delivery) =>
    delivery.session !== null &&
    state.placements[delivery.placement].session !== delivery.session;
  // An unknown send may be repeated with the same key only when the adapter
  // deduplicates by it.
  const retryable = (state, delivery, send) =>
    send.outcome === "unknown" &&
    participant(state, delivery.participant).idempotent;
  // A send whose arrival is unconfirmed. It blocks other sends to its
  // placement: the participant may be starting a turn it must not lose.
  const inFlight = (delivery) =>
    isOpen(delivery) &&
    delivery.session !== null &&
    ["attempting", "unknown"].includes(currentSend(delivery).outcome);
  const isTerminal = (task) => task.final !== null;

  // Authenticated caller -> principal: a configured principal id, or the
  // participant that owns the calling session.
  function principalOf(state, by) {
    if (typeof by !== "string") return null;
    if (state.config.principals[by]) return by;
    return state.sessions[by]?.participant ?? null;
  }
  const roleOf = (state, principal) =>
    state.config.principals[principal] ||
    (participant(state, principal) ? "participant" : null);

  function mayAddress(state, principal, participantId) {
    return (state.config.permissions[principal] || []).includes(participantId);
  }

  // Shared checks. Each returns a rejection, or null when the input is fine.
  const badMessageId = (id) =>
    typeof id === "string" && MESSAGE_ID.test(id)
      ? null
      : reject("invalid", "A message ID is 1-64 letters, digits or . _ : -");
  const badText = (state, text) =>
    typeof text === "string" &&
    text.trim() &&
    text.length <= state.config.policy.maxText
      ? null
      : reject(
          "invalid",
          `Text must be non-empty and at most ${state.config.policy.maxText} characters.`,
        );
  const notSender = (state, by, task) =>
    principalOf(state, by) === task.source
      ? null
      : reject("forbidden", "Only the original sender can do this.");
  // Same key and content: the earlier receipt. Same key, other content: conflict.
  const priorReceipt = (state, key, content) => {
    const receipt = state.receipts[key];
    if (!receipt) return null;
    return receipt.digest === content
      ? ok(`${key} already recorded as ${receipt.taskId}. Nothing repeated.`, {
          taskId: receipt.taskId,
          duplicate: true,
        })
      : reject("conflict", `${key} already identifies different content.`);
  };

  // Why a delivery's current send cannot be attempted now, or null if it can.
  function blockedReason(state, delivery) {
    const task = findTask(state, delivery.taskId);
    const send = currentSend(delivery);
    const placement = state.placements[delivery.placement];
    if (isTerminal(task) || !isOpen(delivery)) return "closed";
    if (send.outcome !== "pending" && !retryable(state, delivery, send))
      return "not_pending";
    if (sessionReplaced(state, delivery)) return "session_replaced";
    const holder = allDeliveries(state).find(
      (other) =>
        other !== delivery &&
        other.placement === delivery.placement &&
        inFlight(other),
    );
    if (holder) return "in_flight";
    if (placement.hold) return "held";
    if (!placement.ready) return "not_ready";
    if (delivery.session !== null) return null;
    // Deliveries are created in order, so position is arrival order.
    const all = allDeliveries(state);
    const earlier = all
      .slice(0, all.indexOf(delivery))
      .find(
        (other) =>
          other.placement === delivery.placement &&
          other.session === null &&
          isOpen(other) &&
          !isTerminal(findTask(state, other.taskId)),
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

  // Why an open, pinned delivery needs an operator, or null if it does not:
  // the router cannot confirm its send after the task ended, its session was
  // replaced, or its send is unknown with no deduplicating retry.
  function stuckReason(state, delivery) {
    if (!isOpen(delivery) || delivery.session === null) return null;
    const send = currentSend(delivery);
    if (send.outcome === "attempting") return null;
    if (isTerminal(findTask(state, delivery.taskId)))
      return send.outcome === "accepted" ? null : "task_ended";
    if (sessionReplaced(state, delivery)) return "session_replaced";
    if (send.outcome === "unknown" && !retryable(state, delivery, send))
      return "unknown_send";
    return null;
  }

  // What a principal must decide, in task order. A requester gets its own
  // tasks waiting for a recipient or for an answer the router can still
  // deliver. An operator gets the stuck deliveries.
  function needsYou(state, principal) {
    const items = [];
    if (roleOf(state, principal) === "operator") {
      for (const delivery of allDeliveries(state)) {
        const reason = stuckReason(state, delivery);
        if (reason)
          items.push({
            kind: "resolve",
            taskId: delivery.taskId,
            deliveryId: delivery.id,
            messageId: currentSend(delivery).messageId,
            reason,
          });
      }
      return items;
    }
    for (const task of state.tasks) {
      if (task.source !== principal || isTerminal(task)) continue;
      if (task.routing?.state === "needs_recipient")
        items.push({
          kind: "choose",
          taskId: task.id,
          reason: task.routing.reason,
          suggestions: task.routing.suggestions,
        });
      for (const delivery of task.deliveries)
        if (
          isOpen(delivery) &&
          delivery.question &&
          !sessionReplaced(state, delivery)
        )
          items.push({
            kind: "answer",
            taskId: task.id,
            deliveryId: delivery.id,
            questionId: delivery.question.id,
            text: delivery.question.text,
          });
    }
    return items;
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
    partial: "TASK_STATE_COMPLETED",
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
      if (!source || roleOf(state, source) === "operator")
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
      const invalid = badMessageId(messageId) || badText(state, text);
      if (invalid) return invalid;
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
      const prior = priorReceipt(state, key, content);
      if (prior) return prior;
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
      if (to === null && !(state.config.permissions[source] || []).length)
        return reject(
          "forbidden",
          `${source} may not address any participant, so there is nobody to route to.`,
        );
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
      // Suggestions are the permitted options in Jev's order; the sender decides.
      const suggestions = valid
        ? Object.entries(probabilities)
            .filter(([id]) => id !== "none")
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id)
        : [];
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
      const forbidden = notSender(state, by, task);
      if (forbidden) return forbidden;
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
        // Definitely not delivered: safe to queue again. The request may move to
        // a new session only if no earlier attempt could have reached this one.
        send.outcome = "pending";
        if (delivery.sends.length === 1 && !send.trail.includes("unknown"))
          delivery.session = null;
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
      const invalid = badMessageId(messageId);
      if (invalid) return invalid;
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
      // A reply to the message before an answer that never left the router
      // means the participant moved on: the question was settled in the
      // session, and the queued answer is withdrawn.
      const queued = isOpen(delivery) && currentSend(delivery);
      if (
        queued &&
        queued !== send &&
        queued.kind === "answer" &&
        queued.outcome === "pending" &&
        !queued.trail.length &&
        delivery.sends[delivery.sends.indexOf(queued) - 1] === send
      ) {
        queued.outcome = "withdrawn";
        queued.trail.push("withdrawn");
      }
      const current = isOpen(delivery) && send === currentSend(delivery);
      if (current && kind === "question" && delivery.question)
        return reject(
          "question_open",
          "One question may be outstanding per delivery.",
        );
      delivery.updates.push({
        messageId,
        inReplyTo,
        kind,
        text,
        digest: content,
      });

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
        // Progress after a question means it was settled in the session.
        const settled = delivery.question !== null;
        delivery.question = null;
        return ok(
          `${delivery.id}: ${text || "working"}.${settled ? " The open question was settled in the session." : ""}`,
          { actor: "Participant" },
        );
      }
      if (kind === "question") {
        delivery.question = { id: messageId, text };
        return ok(`${delivery.id} asks: ${text}`, { actor: "Participant" });
      }
      delivery.question = null;
      delivery.end = { reason: kind, text, messageId, by };
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
      const invalid =
        notSender(state, by, task) ||
        badMessageId(messageId) ||
        badText(state, text);
      if (invalid) return invalid;
      const key = `${task.source}/${messageId}`;
      const content = digest({ taskId, questionId, text });
      const prior = priorReceipt(state, key, content);
      if (prior) return prior;
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
      const forbidden = notSender(state, by, task);
      if (forbidden) return forbidden;
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
      task.final = { ...verdict(task), status: "canceled", reason: "sender" };
      return ok(`${task.id} canceled before any delivery.`);
    },

    resolve(state, { by, deliveryId, messageId, outcome, evidence }) {
      if (roleOf(state, principalOf(state, by)) !== "operator")
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

    // ready: the adapter saw the session idle. hold: a person is using the
    // session and the router must not send to it, idle or not.
    observe(state, { placement, ready, hold, session }) {
      const entry = state.placements[placement];
      if (!entry) return reject("not_found", "No such placement.");
      if (session !== undefined && session !== entry.session) {
        if (typeof session !== "string" || state.sessions[session])
          return reject("invalid", "A new session needs a new identity.");
        entry.session = session;
        // A new session has not been observed idle yet. A hold belongs to
        // the person, not the session, so it stays until released.
        entry.ready = ready === true;
        state.sessions[session] = {
          participant: entry.participant,
          host: entry.host,
        };
      } else if (ready !== undefined) entry.ready = Boolean(ready);
      if (hold !== undefined) entry.hold = Boolean(hold);
      return ok(
        `${placement}: ${entry.ready ? "ready" : "not ready"}${entry.hold ? ", held" : ""}, session ${entry.session}.`,
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
          task.final = verdict(task, "deadline");
          expired.push(`${task.id} ${task.final.status}`);
        }
      return ok(
        expired.length
          ? `Deadline passed: ${expired.join(", ")}. Unconfirmed sends keep holding their sessions until they end or are reconciled.`
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
      id: `D${state.nextDelivery++}`,
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
      updates: [],
      end: null,
    }));
  }

  // The final word on a task from its deliveries so far: completed when every
  // host answered, partial when some did (the record says which), failed when
  // none did. Results after this point are kept as evidence, not counted.
  function verdict(task, reason = "delivery") {
    const of = task.deliveries.length;
    const completed = task.deliveries.filter(
      (d) => d.end?.reason === "completed",
    ).length;
    const status =
      of && completed === of ? "completed" : completed ? "partial" : "failed";
    return {
      status,
      reason: status === "completed" ? null : reason,
      completed,
      of,
    };
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
    )
      task.final = verdict(task);
    task.status = status(task);
  }

  return {
    validateConfig,
    initial,
    reduce,
    commands,
    blockedReason,
    currentSend,
    isOpen,
    inFlight,
    findTask,
    findDelivery,
    allDeliveries,
    judgmentQuestion,
    needsYou,
    A2A_STATE,
  };
});
