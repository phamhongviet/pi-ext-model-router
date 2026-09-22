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
      answers: { model: { choice: "gpt-5.6-luna", confidence: 0.9 } },
    }));
  };

  let inputHandler;
  const model = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const pi = {
    on(event, handler) {
      assert.equal(event, "input");
      inputHandler = handler;
    },
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
    current_request: "now write a test",
    conversation_context:
      "summary: Earlier summary user: Refactor the deployment command to preserve environment variables. assistant: I found extra spaces. user: implement that toolResult: Updated model-router.ts",
    current_task: "Refactor the deployment command to preserve environment variables.",
    recent_result: "edit: Updated model-router.ts",
  });
  assert.deepEqual(notifications, [["TypeSafe routed to gpt-5.6-luna", "info"]]);
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
