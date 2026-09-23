import { mkdir, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.13.0";
const MODEL_PROVIDER = "openai-codex";
const TIMEOUT_MS = 5_000;
const MIN_CONFIDENCE = 0.65;
const DEBUG = false;
const JEV_DEBUG_LOG_DIR = "/tmp/pi-ext-model-router";

const MODELS = {
  "gpt-5.6-luna":
    "Default. Use for straightforward questions, explanations, summarization, reading provided code, simple code edits, routine debugging, and tasks requiring little multi-step reasoning.",
  "gpt-5.6-terra":
    "Use when the task needs moderate multi-step reasoning, nontrivial debugging, several interacting constraints, or substantial code generation beyond routine edits.",
  "gpt-5.6-sol":
    "Use for difficult professional reasoning, complex architecture or debugging, ambiguous problems requiring careful synthesis, or demanding research.",
  "gpt-6-astra":
    "Reserve for exceptionally difficult end-to-end tasks, deep multi-stage reasoning, complex agentic/tool workflows, or problems where the other models are materially likely to fail.",
} as const;

type ModelId = keyof typeof MODELS;

type RoutingState = {
  request: string;
};

const MAX_CONTEXT_CHARS = 1_800;
const MAX_ITEM_CHARS = 600;

function clip(value: string, limit = MAX_ITEM_CHARS): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as {
    role?: string;
    content?: unknown;
    command?: unknown;
    output?: unknown;
    exitCode?: unknown;
    cancelled?: unknown;
    excludeFromContext?: boolean;
  };
  if (value.excludeFromContext) return "";
  if (value.role === "bashExecution" && typeof value.command === "string") {
    let text = `Ran \`${value.command}\`\n`;
    text += typeof value.output === "string" && value.output ? "```\n" + value.output + "\n```" : "(no output)";
    if (value.cancelled) text += "\n\n(command cancelled)";
    else if (typeof value.exitCode === "number" && value.exitCode !== 0)
      text += `\n\nCommand exited with code ${value.exitCode}`;
    return text;
  }
  const content = value.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } =>
      !!part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join(" ");
}

function buildRoutingState(ctx: ExtensionContext, request: string): RoutingState {
  const entries = ctx.sessionManager.buildContextEntries() as Array<{
    type?: string;
    message?: {
      role?: string;
      content?: unknown;
      isError?: boolean;
      toolName?: string;
      excludeFromContext?: boolean;
    };
    summary?: string;
  }>;
  const messages = entries
    .map((entry) => {
      if (entry.type === "compaction" || entry.type === "branch_summary") {
        return entry.summary ? { role: "summary", text: entry.summary } : undefined;
      }
      if (entry.type !== "message" || !entry.message) return undefined;
      const text = messageText(entry.message);
      return text ? { role: entry.message.role ?? "message", text, message: entry.message } : undefined;
    })
    .filter((item): item is { role: string; text: string; message?: { isError?: boolean; toolName?: string } } => !!item);

  const userMessages = messages.filter((item) => item.role === "user");
  // Short follow-ups such as “implement that” inherit the last substantive task.
  const substantiveTask = [...userMessages].reverse().find((item) => item.text.trim().length >= 24);
  const currentTask = substantiveTask?.text ?? userMessages.at(-1)?.text;
  const recent = messages.slice(-6).map((item) => `${item.role}: ${clip(item.text)}`);
  const conversationContext = recent.length
    ? clip(recent.join("\n"), MAX_CONTEXT_CHARS)
    : undefined;

  return {
    request: [currentTask && clip(currentTask), conversationContext, request].filter(Boolean).join("\n\n"),
  };
}

function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && Object.hasOwn(MODELS, value);
}

async function writeDebugLog(name: string, contents: string): Promise<void> {
  if (!DEBUG) return;
  try {
    await mkdir(JEV_DEBUG_LOG_DIR, { recursive: true });
    await writeFile(`${JEV_DEBUG_LOG_DIR}/${name}`, contents);
  } catch (error) {
    console.error("Failed to write Jev debug log:", error);
  }
}

async function chooseModel(
  state: RoutingState,
  signal?: AbortSignal,
): Promise<{ modelId: ModelId; confident: boolean }> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is not set");

  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const requestBody = {
    model: JEV_MODEL,
    state,
    questions: {
      model: {
        type: "choice",
        instructions: `Choose the most cost-efficient model that can reliably complete the request. Prioritize capability over cost.`,
        criteria: MODELS,
      },
    },
  };
  const debugId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await writeDebugLog(`${debugId}-request.json`, JSON.stringify(requestBody, null, 2));

  const response = await fetch(TYPESAFE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  const responseText = await response.text();
  await writeDebugLog(`${debugId}-response.json`, responseText);
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}`);

  const body: unknown = JSON.parse(responseText);
  const answer = (body as { answers?: { model?: { choice?: unknown; confidence?: unknown } } }).answers?.model;
  const confidence = answer?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence))
    throw new Error("TypeSafe returned an invalid model confidence");
  if (!isModelId(answer?.choice)) throw new Error("TypeSafe returned an invalid model choice");
  return { modelId: answer.choice, confident: confidence > MIN_CONFIDENCE };
}

export default function (pi: ExtensionAPI) {
  let routing = false;

  pi.on("input", async (event, ctx) => {
    if (
      routing ||
      event.source === "extension" ||
      event.streamingBehavior ||
      !ctx.isIdle() ||
      !event.text.trim() ||
      event.text.trimStart().startsWith("/")
    )
      return { action: "continue" as const };

    routing = true;
    try {
      const { modelId: suggestedModelId, confident } = await chooseModel(
        buildRoutingState(ctx, event.text),
        ctx.signal,
      );
      const currentModelId =
        ctx.model?.provider === MODEL_PROVIDER && isModelId(ctx.model.id) ? ctx.model.id : undefined;
      let modelId = suggestedModelId;

      if (!confident && currentModelId !== suggestedModelId) {
        const choices = [suggestedModelId, ...Object.keys(MODELS).filter((id) => id !== suggestedModelId)];
        const selected = await ctx.ui.select(
          `TypeSafe is uncertain. Suggested model: ${suggestedModelId}`,
          choices,
        );
        if (!selected) return { action: "handled" as const };
        if (!isModelId(selected)) throw new Error("Invalid model selected");
        modelId = selected;
      } else if (!confident) {
        return { action: "continue" as const };
      }

      const model = ctx.modelRegistry.find(MODEL_PROVIDER, modelId);
      if (!model) throw new Error(`${MODEL_PROVIDER}/${modelId} is not registered in pi`);
      if (!(await pi.setModel(model)))
        throw new Error(`${MODEL_PROVIDER}/${modelId} is not authenticated in pi`);

      ctx.ui.notify(`TypeSafe routed to ${modelId}`, "info");
      return { action: "continue" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`TypeSafe routing failed: ${message}. Using current model.`, "warning");
      return { action: "continue" as const };
    } finally {
      routing = false;
    }
  });
}
