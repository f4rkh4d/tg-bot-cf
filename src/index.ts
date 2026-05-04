export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface MinimalKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface MinimalExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface BotCtx {
  chatId: string;
  message: { text: string; [k: string]: unknown };
  reply: (text: string) => Promise<void>;
  getHistory: () => Promise<ChatMessage[]>;
  resetMemory: () => Promise<void>;
}

export type CommandHandler = (args: string, ctx: BotCtx) => Promise<string | void>;

export interface BotEnv {
  memoryKv: MinimalKv;
  tgBotToken: string;
  webhookSecret: string;
  ownerChatIds: string | string[];
  systemPrompt?: string;
  historyLimit?: number;
  llm: (messages: ChatMessage[], ctx: BotCtx) => Promise<string>;
  commands?: Record<string, CommandHandler>;
}

const TG_CHUNK = 4000;
const DEFAULT_HISTORY_LIMIT = 20;

const historyKey = (chatId: string) => `chat:${chatId}:history`;

export function createBot(env: BotEnv): {
  fetch: (req: Request, _: unknown, ctx: MinimalExecutionContext) => Promise<Response>;
} {
  const allowlist = new Set(
    (Array.isArray(env.ownerChatIds) ? env.ownerChatIds : [env.ownerChatIds]).map(String),
  );
  const limit = env.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  const customCommands = env.commands ?? {};

  return {
    async fetch(req, _, ctx) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return new Response("ok\n", { status: 200 });
      }

      if (req.method !== "POST" || url.pathname !== "/webhook") {
        return new Response("not found\n", { status: 404 });
      }

      const sentSecret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
      if (!env.webhookSecret || sentSecret !== env.webhookSecret) {
        return new Response("forbidden\n", { status: 403 });
      }

      let update: any;
      try {
        update = await req.json();
      } catch {
        return new Response("bad json\n", { status: 400 });
      }

      const msg = update?.message ?? update?.edited_message;
      if (!msg || !msg.chat || typeof msg.text !== "string") {
        return new Response("ok\n", { status: 200 });
      }

      const chatId = String(msg.chat.id);
      if (!allowlist.has(chatId)) {
        return new Response("ok\n", { status: 200 });
      }

      const botCtx = makeCtx(env, chatId, msg);

      ctx.waitUntil(
        handle(env, botCtx, customCommands, limit).catch(async (e: any) => {
          try {
            await botCtx.reply("internal error: " + (e?.message || String(e)));
          } catch {}
        }),
      );

      return new Response("ok\n", { status: 200 });
    },
  };
}

function makeCtx(env: BotEnv, chatId: string, message: { text: string; [k: string]: unknown }): BotCtx {
  return {
    chatId,
    message,
    reply: (text: string) => sendMessage(env.tgBotToken, chatId, text),
    getHistory: () => getHistory(env.memoryKv, chatId),
    resetMemory: () => env.memoryKv.delete(historyKey(chatId)).then(() => undefined),
  };
}

async function handle(
  env: BotEnv,
  ctx: BotCtx,
  customCommands: Record<string, CommandHandler>,
  limit: number,
): Promise<void> {
  const text = ctx.message.text.trim();

  if (text.startsWith("/")) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = (rawCmd ?? "").split("@")[0] ?? "";
    const args = rest.join(" ");

    const custom = customCommands[cmd];
    if (custom) {
      const out = await custom(args, ctx);
      if (typeof out === "string") await ctx.reply(out);
      return;
    }

    if (cmd === "/reset") {
      await ctx.resetMemory();
      await ctx.reply("memory wiped");
      return;
    }

    if (cmd === "/help" || cmd === "/start") {
      const names = Object.keys(customCommands);
      const lines = ["commands:", "  /reset       wipe conversation memory"];
      for (const n of names) lines.push("  " + n);
      lines.push("");
      lines.push("anything else = chat");
      await ctx.reply(lines.join("\n"));
      return;
    }

    await ctx.reply("unknown command. /help for usage.");
    return;
  }

  const history = await ctx.getHistory();
  const userTurn: ChatMessage = { role: "user", content: text };

  const llmInput: ChatMessage[] = [];
  if (env.systemPrompt) llmInput.push({ role: "system", content: env.systemPrompt });
  for (const m of history) llmInput.push(m);
  llmInput.push(userTurn);

  const reply = await env.llm(llmInput, ctx);

  history.push(userTurn);
  history.push({ role: "assistant", content: reply });
  while (history.length > limit) history.shift();
  await env.memoryKv.put(historyKey(ctx.chatId), JSON.stringify(history));

  await ctx.reply(reply);
}

async function getHistory(kv: MinimalKv, chatId: string): Promise<ChatMessage[]> {
  const raw = await kv.get(historyKey(chatId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const chunks = chunkText(text, TG_CHUNK);
  for (const chunk of chunks) {
    await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });
  }
}

function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

/**
 * Convenience: build a partial BotEnv from a Cloudflare Workers `env` object
 * using conventional secret names. Lets users avoid wiring up the same
 * boilerplate in every bot.
 *
 * Reads:
 *   TG_BOT_TOKEN          -> tgBotToken
 *   TG_WEBHOOK_SECRET     -> webhookSecret
 *   TG_OWNER_CHAT_ID      -> ownerChatIds (single string; comma-separated for many)
 *   MEMORY (kv binding)   -> memoryKv
 *
 * The user is still responsible for supplying `llm` and optional `commands`.
 * Throws if any required secret/binding is missing or empty.
 */
export function loadFromEnv(env: Record<string, unknown>): {
  tgBotToken: string;
  webhookSecret: string;
  ownerChatIds: string[];
  memoryKv: MinimalKv;
} {
  const tgBotToken = readString(env, "TG_BOT_TOKEN");
  const webhookSecret = readString(env, "TG_WEBHOOK_SECRET");
  const ownerRaw = readString(env, "TG_OWNER_CHAT_ID");
  const ownerChatIds = ownerRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ownerChatIds.length) throw new Error("TG_OWNER_CHAT_ID resolved to empty list");

  const kv = env["MEMORY"];
  if (!isMinimalKv(kv)) throw new Error("MEMORY binding missing or not a KV namespace");

  return { tgBotToken, webhookSecret, ownerChatIds, memoryKv: kv };
}

function readString(env: Record<string, unknown>, key: string): string {
  const v = env[key];
  if (typeof v !== "string" || !v) throw new Error(`env.${key} missing or empty`);
  return v;
}

function isMinimalKv(v: unknown): v is MinimalKv {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as { get?: unknown }).get === "function" &&
    typeof (v as { put?: unknown }).put === "function" &&
    typeof (v as { delete?: unknown }).delete === "function"
  );
}
