import { test, expect, beforeEach, mock } from "bun:test";
import { createBot, type BotEnv, type ChatMessage, type MinimalKv, type MinimalExecutionContext } from "../src/index";

function makeKv(): MinimalKv & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(k) {
      return store.get(k) ?? null;
    },
    async put(k, v) {
      store.set(k, v);
    },
    async delete(k) {
      store.delete(k);
    },
  };
}

function makeCtx(): MinimalExecutionContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    waitUntil(p) {
      waited.push(p);
    },
  };
}

type FetchCall = { url: string; body: any };

function installFetchMock(): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    let body: any = null;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(url), body });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function tgRequest(secret: string, update: unknown, path = "/webhook"): Request {
  return new Request("https://bot.example.com" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(update),
  });
}

function makeUpdate(chatId: number | string, text: string) {
  return { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: "private" }, text } };
}

const SECRET = "s3cret";
const TOKEN = "111:AAA";
const OWNER = "42";

function baseEnv(over: Partial<BotEnv> = {}): BotEnv {
  return {
    memoryKv: makeKv(),
    tgBotToken: TOKEN,
    webhookSecret: SECRET,
    ownerChatIds: OWNER,
    llm: async () => "default-reply",
    ...over,
  };
}

let fetchMock: ReturnType<typeof installFetchMock>;
beforeEach(() => {
  fetchMock = installFetchMock();
});

test("healthz returns 200 ok", async () => {
  const bot = createBot(baseEnv());
  const res = await bot.fetch(new Request("https://x/healthz"), null, makeCtx());
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok\n");
  fetchMock.restore();
});

test("non-webhook POST returns 404", async () => {
  const bot = createBot(baseEnv());
  const req = new Request("https://x/other", { method: "POST", body: "{}" });
  const res = await bot.fetch(req, null, makeCtx());
  expect(res.status).toBe(404);
  fetchMock.restore();
});

test("missing secret returns 403", async () => {
  const bot = createBot(baseEnv());
  const req = new Request("https://x/webhook", { method: "POST", body: "{}" });
  const res = await bot.fetch(req, null, makeCtx());
  expect(res.status).toBe(403);
  fetchMock.restore();
});

test("wrong secret returns 403", async () => {
  const bot = createBot(baseEnv());
  const res = await bot.fetch(tgRequest("nope", makeUpdate(OWNER, "hi")), null, makeCtx());
  expect(res.status).toBe(403);
  fetchMock.restore();
});

test("non-text update returns 200 silently, no LLM, no fetch", async () => {
  const llm = mock(async () => "x");
  const bot = createBot(baseEnv({ llm }));
  const ctx = makeCtx();
  const update = { update_id: 1, message: { chat: { id: OWNER }, photo: [{}] } };
  const res = await bot.fetch(tgRequest(SECRET, update), null, ctx);
  expect(res.status).toBe(200);
  await Promise.all(ctx.waited);
  expect(llm).not.toHaveBeenCalled();
  expect(fetchMock.calls.length).toBe(0);
  fetchMock.restore();
});

test("wrong chat_id returns 200, no LLM, no fetch to TG", async () => {
  const llm = mock(async () => "x");
  const bot = createBot(baseEnv({ llm }));
  const ctx = makeCtx();
  const res = await bot.fetch(tgRequest(SECRET, makeUpdate("9999", "hi")), null, ctx);
  expect(res.status).toBe(200);
  await Promise.all(ctx.waited);
  expect(llm).not.toHaveBeenCalled();
  expect(fetchMock.calls.length).toBe(0);
  fetchMock.restore();
});

test("ctx.waitUntil is registered for owner messages", async () => {
  const bot = createBot(baseEnv());
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "hi")), null, ctx);
  expect(ctx.waited.length).toBe(1);
  await Promise.all(ctx.waited);
  fetchMock.restore();
});

test("/reset clears KV", async () => {
  const kv = makeKv();
  await kv.put("chat:42:history", JSON.stringify([{ role: "user", content: "old" }]));
  const bot = createBot(baseEnv({ memoryKv: kv }));
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "/reset")), null, ctx);
  await Promise.all(ctx.waited);
  expect(kv.store.has("chat:42:history")).toBe(false);
  expect(fetchMock.calls.some((c) => c.body?.text === "memory wiped")).toBe(true);
  fetchMock.restore();
});

test("/help default lists custom commands", async () => {
  const bot = createBot(
    baseEnv({
      commands: {
        "/ping": async () => "pong",
      },
    }),
  );
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "/help")), null, ctx);
  await Promise.all(ctx.waited);
  const sent = fetchMock.calls[0]?.body?.text as string;
  expect(sent).toContain("/reset");
  expect(sent).toContain("/ping");
  expect(sent).toContain("anything else = chat");
  fetchMock.restore();
});

test("custom /help overrides default", async () => {
  const bot = createBot(
    baseEnv({
      commands: {
        "/help": async () => "custom help text",
      },
    }),
  );
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "/help")), null, ctx);
  await Promise.all(ctx.waited);
  expect(fetchMock.calls[0]?.body?.text).toBe("custom help text");
  fetchMock.restore();
});

test("custom command with args", async () => {
  let captured = "";
  const bot = createBot(
    baseEnv({
      commands: {
        "/echo": async (args) => {
          captured = args;
          return "echo: " + args;
        },
      },
    }),
  );
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "/echo hello world")), null, ctx);
  await Promise.all(ctx.waited);
  expect(captured).toBe("hello world");
  expect(fetchMock.calls[0]?.body?.text).toBe("echo: hello world");
  fetchMock.restore();
});

test("free text calls llm with system + history, saves to KV, replies", async () => {
  const kv = makeKv();
  let seen: ChatMessage[] = [];
  const bot = createBot(
    baseEnv({
      memoryKv: kv,
      systemPrompt: "be terse",
      llm: async (msgs) => {
        seen = msgs;
        return "hi back";
      },
    }),
  );
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "hi there")), null, ctx);
  await Promise.all(ctx.waited);

  expect(seen[0]).toEqual({ role: "system", content: "be terse" });
  expect(seen[seen.length - 1]).toEqual({ role: "user", content: "hi there" });

  const stored = JSON.parse(kv.store.get("chat:42:history") || "[]");
  expect(stored).toEqual([
    { role: "user", content: "hi there" },
    { role: "assistant", content: "hi back" },
  ]);

  expect(fetchMock.calls[0]?.body?.text).toBe("hi back");
  fetchMock.restore();
});

test("multi-turn: history grows and is capped at historyLimit", async () => {
  const kv = makeKv();
  let i = 0;
  const bot = createBot(
    baseEnv({
      memoryKv: kv,
      historyLimit: 4,
      llm: async () => "r" + i++,
    }),
  );
  for (let t = 0; t < 5; t++) {
    const ctx = makeCtx();
    await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "u" + t)), null, ctx);
    await Promise.all(ctx.waited);
  }
  const stored: ChatMessage[] = JSON.parse(kv.store.get("chat:42:history") || "[]");
  expect(stored.length).toBe(4);
  expect(stored[stored.length - 1]?.content).toBe("r4");
  expect(stored[stored.length - 2]?.content).toBe("u4");
  fetchMock.restore();
});

test("LLM throws -> user gets internal error message", async () => {
  const bot = createBot(
    baseEnv({
      llm: async () => {
        throw new Error("boom");
      },
    }),
  );
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "hi")), null, ctx);
  await Promise.all(ctx.waited);
  const sent = fetchMock.calls.map((c) => c.body?.text).join("\n");
  expect(sent).toContain("internal error: boom");
  fetchMock.restore();
});

test("text > 4000 chars splits into multiple sendMessage calls", async () => {
  const big = "a".repeat(9500);
  const bot = createBot(baseEnv({ llm: async () => big }));
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "give me a wall")), null, ctx);
  await Promise.all(ctx.waited);
  const sendCalls = fetchMock.calls.filter((c) => c.url.includes("sendMessage"));
  expect(sendCalls.length).toBe(3);
  expect((sendCalls[0]?.body?.text as string).length).toBe(4000);
  expect((sendCalls[1]?.body?.text as string).length).toBe(4000);
  expect((sendCalls[2]?.body?.text as string).length).toBe(1500);
  fetchMock.restore();
});

test("ownerChatIds accepts an array", async () => {
  const llm = mock(async () => "ok");
  const bot = createBot(baseEnv({ ownerChatIds: ["1", "2", "42"], llm }));
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate("2", "hi")), null, ctx);
  await Promise.all(ctx.waited);
  expect(llm).toHaveBeenCalled();
  fetchMock.restore();
});

test("unknown command replies with usage hint", async () => {
  const bot = createBot(baseEnv());
  const ctx = makeCtx();
  await bot.fetch(tgRequest(SECRET, makeUpdate(OWNER, "/nope")), null, ctx);
  await Promise.all(ctx.waited);
  expect(fetchMock.calls[0]?.body?.text).toContain("unknown command");
  fetchMock.restore();
});
