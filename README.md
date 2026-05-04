# tg-bot-cf

tiny framework for owner-only telegram bots on cloudflare workers. zero deps.

```sh
npm i tg-bot-cf
```

```ts
import { createBot } from "tg-bot-cf";

export default createBot({
  memoryKv: MEMORY,
  tgBotToken: TG_BOT_TOKEN,
  webhookSecret: TG_WEBHOOK_SECRET,
  ownerChatIds: TG_OWNER_CHAT_ID,
  systemPrompt: "be terse. lowercase. no hedging.",
  async llm(messages) {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + DEEPSEEK_API_KEY },
      body: JSON.stringify({ model: "deepseek-chat", messages }),
    });
    const data = await res.json();
    return data.choices[0].message.content;
  },
  commands: {
    "/who": async (_args, ctx) => "chat_id: " + ctx.chatId,
  },
});
```

point telegram at it:

```sh
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/setWebhook" \
  -d url=https://your-worker.workers.dev/webhook \
  -d secret_token=$TG_WEBHOOK_SECRET
```

## what it is

a single function that returns a worker `fetch` handler. wires up:

- `GET /healthz` for uptime checks
- `POST /webhook` with `x-telegram-bot-api-secret-token` verification
- chat_id allowlist (single id or array). foreign chats get a silent 200
- KV-backed sliding window of the last N turns per chat
- `/reset` and `/help` built in. override either by passing your own
- free text gets routed to your `llm` callback with system prompt + history prepended
- replies chunked at 4000 chars so you don't hit telegram's 4096 cap
- async work runs under `ctx.waitUntil` so telegram sees a fast 200
- errors caught and posted back to the user as `internal error: ...`

## what it is not

- not multi-user. one owner, or a small allowlist. no per-user billing, no rate limits, no anti-abuse
- not a telegram client library. it knows about exactly two endpoints and ignores everything else
- not opinionated about your llm. you pass a function that takes messages and returns a string
- no images, voice, inline mode, or callback queries. text in, text out

## API

```ts
function createBot(env: BotEnv): { fetch: WorkerFetchHandler };

interface BotEnv {
  memoryKv: KVNamespace;
  tgBotToken: string;
  webhookSecret: string;
  ownerChatIds: string | string[];
  systemPrompt?: string;
  historyLimit?: number; // default 20
  llm: (messages: ChatMessage[], ctx: BotCtx) => Promise<string>;
  commands?: Record<string, (args: string, ctx: BotCtx) => Promise<string | void>>;
}

interface BotCtx {
  chatId: string;
  message: { text: string; [k: string]: unknown };
  reply: (text: string) => Promise<void>;
  getHistory: () => Promise<ChatMessage[]>;
  resetMemory: () => Promise<void>;
}
```

a command handler returning a string sends that string as a reply. returning `void` means you handled the reply yourself via `ctx.reply`.

## KV layout

one key per chat: `chat:<chatId>:history` holds a JSON array of `{ role, content }` messages, capped at `historyLimit`.

## wrangler

```toml
name = "my-bot"
main = "src/worker.ts"
compatibility_date = "2024-08-01"

kv_namespaces = [
  { binding = "MEMORY", id = "..." }
]

[vars]
# put real values in `wrangler secret put` instead
```


## the f4rkh4d ai-tooling stack

small, focused tools that compose. use any one alone, all together if you need:

- [`anchor`](https://github.com/fr-enterprises/anchor) - local proxy that caches AI API calls and tracks spend
- [`llm-pricing`](https://github.com/f4rkh4d/llm-pricing) - usd list prices for major LLM apis
- [`anthropic-sse`](https://github.com/f4rkh4d/anthropic-sse) - streaming sse parser for anthropic messages api
- [`openai-stream-parse`](https://github.com/f4rkh4d/openai-stream-parse) - same, for openai chat completions
- [`tg-bot-cf`](https://github.com/f4rkh4d/tg-bot-cf) - tiny telegram bot framework for cloudflare workers
- [`bun-spawn-safe`](https://github.com/f4rkh4d/bun-spawn-safe) - hardened wrapper around `Bun.spawn`

## license

MIT
