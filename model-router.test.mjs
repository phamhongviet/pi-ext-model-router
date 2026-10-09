import assert from "node:assert/strict";
import test from "node:test";

import modelRouter from "./model-router.ts";

test("sends recent conversation state to TypeSafe", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalApiKey;
  });

  process.env.TYPESAFE_API_KEY = "test-key";
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      answers: { model: { choice: "fast", confidence: 0.9 } },
    }));
  };

  let inputHandler;
  const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
  const pi = {
    registerCommand() {},
    on(event, handler) {
      assert.equal(event, "input");
      inputHandler = handler;
    },
    getThinkingLevel: () => "low",
    setThinkingLevel: (level) => assert.equal(level, "low"),
    async setModel(selected) {
      assert.equal(selected, model);
      return true;
    },
  };
  modelRouter(pi);

  const entries = [
    { type: "compaction", summary: "Earlier summary" },
    {
      type: "message",
      message: {
        role: "user",
        content: "Refactor the deployment command to preserve environment variables.",
      },
    },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "I found  extra\nspaces." }, { type: "image" }] },
    },
    { type: "message", message: { role: "user", content: "implement that" } },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: [{ type: "text", text: "Updated model-router.ts" }] },
    },
    {
      type: "message",
      message: { role: "bashExecution", command: "git status --short", output: " M model-router.ts", exitCode: 0 },
    },
  ];
  const notifications = [];
  const result = await inputHandler(
    { text: "now write a test", source: "user" },
    {
      isIdle: () => true,
      sessionManager: { buildContextEntries: () => entries },
      model,
      modelRegistry: { find: () => model },
      ui: { notify: (...args) => notifications.push(args) },
    },
  );

  assert.deepEqual(result, { action: "continue" });
  assert.deepEqual(requestBody.state, {
    request:
      "Refactor the deployment command to preserve environment variables.\n\nsummary: Earlier summary user: Refactor the deployment command to preserve environment variables. assistant: I found extra spaces. user: implement that toolResult: Updated model-router.ts bashExecution: Ran `git status --short` ``` M model-router.ts ```\n\nnow write a test",
  });
  assert.deepEqual(notifications, [["TypeSafe routed to fast: gpt-6.1-sol, thinking low", "info"]]);
});

test("uses the current model when TypeSafe times out", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalApiKey;
  });

  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };

  let inputHandler;
  let setModelCalled = false;
  const model = { provider: "openai-codex", id: "gpt-5.6-terra" };
  const pi = {
    registerCommand() {},
    on(_event, handler) {
      inputHandler = handler;
    },
    async setModel() {
      setModelCalled = true;
      return true;
    },
  };
  modelRouter(pi);

  const notifications = [];
  const result = await inputHandler(
    { text: "fix the timeout", source: "user" },
    {
      isIdle: () => true,
      sessionManager: { buildContextEntries: () => [] },
      model,
      ui: { notify: (...args) => notifications.push(args) },
    },
  );

  assert.deepEqual(result, { action: "continue" });
  assert.equal(setModelCalled, false);
  assert.deepEqual(notifications, [[
    "TypeSafe routing failed: The operation was aborted due to timeout. Using current model.",
    "warning",
  ]]);
});


test("routes the same model with different thinking levels", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalApiKey;
  });
  process.env.TYPESAFE_API_KEY = "test-key";

  for (const [choice, confidence, currentLevel, selected, expectedLevel] of [
    ["smart", 0.9, "low", undefined, "xhigh"],
    ["fast", 0.9, "xhigh", undefined, "low"],
    ["smart", 0.5, "low", "smart", "xhigh"],
    ["smart", 0.5, "low", "fast", "low"],
    ["smart", 0.5, "xhigh", undefined, "xhigh"],
    ["smart", 0.5, "low", undefined, "low"],
  ]) {
    globalThis.fetch = async (_url, options) => {
      const criteria = JSON.parse(options.body).questions.model.criteria;
      assert.match(criteria.fast, /gpt-6\.1-sol, thinking low/);
      assert.match(criteria.smart, /gpt-6\.1-sol, thinking xhigh/);
      return new Response(JSON.stringify({ answers: { model: { choice, confidence } } }));
    };
    let handler;
    let level = currentLevel;
    const calls = [];
    const model = { provider: "openai-codex", id: "gpt-6.1-sol" };
    modelRouter({
      registerCommand() {},
      on: (_event, fn) => { handler = fn; },
      getThinkingLevel: () => level,
      setThinkingLevel: (value) => { calls.push("thinking"); level = value; },
      setModel: async (value) => {
        assert.equal(value, model);
        calls.push("model");
        return true;
      },
    });
    const needsPrompt = confidence < 0.65 && currentLevel !== "xhigh";
    const result = await handler({ text: "debug this", source: "interactive" }, {
      isIdle: () => true,
      model,
      sessionManager: { buildContextEntries: () => [] },
      modelRegistry: { find: (provider, id) => {
        assert.equal(provider, model.provider);
        assert.equal(id, model.id);
        return model;
      } },
      ui: {
        notify: (_text, severity) => assert.equal(severity, "info"),
        select: async (_title, choices) => {
          assert.equal(needsPrompt, true);
          assert.deepEqual(choices, ["smart", "fast"]);
          calls.push("select");
          return selected;
        },
      },
    });
    assert.equal(level, expectedLevel);
    const applied = confidence > 0.65 || (needsPrompt && selected);
    assert.deepEqual(calls, [
      ...(needsPrompt ? ["select"] : []),
      ...(applied ? ["model", "thinking"] : []),
    ]);
    assert.deepEqual(result, { action: needsPrompt && !selected ? "handled" : "continue" });
  }
});

test("pauses routing without changing user selections and resumes on command", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.TYPESAFE_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = originalApiKey;
  });

  let inputHandler;
  let command;
  let level = "high";
  const calls = [];
  const notifications = [];
  const routedModel = { provider: "openai-codex", id: "gpt-6.1-sol" };
  modelRouter({
    registerCommand(name, options) {
      assert.equal(name, "model-router");
      command = options.handler;
    },
    on: (_event, handler) => { inputHandler = handler; },
    getThinkingLevel: () => level,
    setThinkingLevel: (value) => { calls.push("thinking"); level = value; },
    setModel: async (model) => {
      calls.push("model");
      ctx.model = model;
      return true;
    },
  });
  const ctx = {
    isIdle: () => true,
    model: { provider: "manual", id: "user-model" },
    sessionManager: { buildContextEntries: () => { calls.push("context"); return []; } },
    modelRegistry: { find: () => { calls.push("registry"); return routedModel; } },
    ui: {
      notify: (...args) => notifications.push(args),
      select: async () => { calls.push("select"); return "smart"; },
    },
  };
  const send = () => inputHandler({ text: "debug this", source: "interactive" }, ctx);
  const answer = (confidence = 0.9) => new Response(JSON.stringify({
    answers: { model: { choice: "smart", confidence } },
  }));
  globalThis.fetch = async () => { calls.push("fetch"); return answer(); };

  await command("", ctx);
  assert.deepEqual(notifications.pop(), ["TypeSafe routing enabled.", "info"]);
  await command(" off ", ctx);
  assert.deepEqual(notifications.pop(), [
    "TypeSafe routing disabled. Using current model and thinking level.", "info",
  ]);
  delete process.env.TYPESAFE_API_KEY;
  assert.deepEqual(await send(), { action: "continue" });
  assert.equal(ctx.model.id, "user-model");
  assert.equal(level, "high");

  ctx.model = { provider: "another", id: "new-user-model" };
  level = "medium";
  await command("invalid", ctx);
  assert.deepEqual(notifications.pop(), ["Usage: /model-router [on|off]", "warning"]);
  await command("", ctx);
  assert.match(notifications.pop()[0], /routing disabled/);
  assert.deepEqual(await send(), { action: "continue" });
  assert.equal(ctx.model.id, "new-user-model");
  assert.equal(level, "medium");
  assert.deepEqual(calls, []);
  assert.deepEqual(notifications, []);

  process.env.TYPESAFE_API_KEY = "test-key";
  await command("on", ctx);
  assert.deepEqual(notifications.pop(), ["TypeSafe routing enabled.", "info"]);
  assert.deepEqual(await send(), { action: "continue" });
  assert.equal(ctx.model, routedModel);
  assert.equal(level, "xhigh");
  assert.deepEqual(calls, ["context", "fetch", "registry", "model", "thinking"]);

  // A pause during a pending request or uncertainty prompt must also keep the current selection.
  for (const pauseDuring of ["fetch", "select"]) {
    calls.length = 0;
    ctx.model = { provider: "manual", id: "user-model" };
    level = "high";
    await command("on", ctx);
    globalThis.fetch = async () => {
      calls.push("fetch");
      if (pauseDuring === "fetch") await command("off", ctx);
      return answer(pauseDuring === "select" ? 0.5 : 0.9);
    };
    ctx.ui.select = async () => {
      calls.push("select");
      await command("off", ctx);
      return undefined;
    };
    assert.deepEqual(await send(), { action: "continue" });
    assert.equal(ctx.model.id, "user-model");
    assert.equal(level, "high");
    assert.deepEqual(calls, ["context", "fetch", ...(pauseDuring === "select" ? ["select"] : [])]);
  }
});
