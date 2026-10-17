// Stand-in for the Telegram Bot API, for dev/selftest.sh only.
//   node dev/fake-telegram.mjs <port> <workdir>
// Accepts exactly one bot token (FAKE_TOKEN env). Delivers a "/start" from one private chat,
// then a "ping" once <workdir>/send-ping exists. Logs method names (never the token) to
// <workdir>/calls.log and every bot message text to <workdir>/sent.jsonl.
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";

const [port, dir] = process.argv.slice(2);
const token = process.env.FAKE_TOKEN;
const user = { id: 4242, is_bot: false, first_name: "Test", username: "kit_tester" };
const chat = { id: 4242, type: "private", first_name: "Test" };
let updateId = 100;
const queue = [{ update_id: ++updateId, message: { message_id: 1, from: user, chat, date: Math.floor(Date.now() / 1000), text: "/start" } }];
let pingQueued = false;

const read = (request) => new Promise((resolve) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk)).on("end", () => resolve(body));
});

createServer(async (request, response) => {
  const url = new URL(request.url, "http://x");
  const [, botPart, method] = url.pathname.split("/");
  const body = await read(request);
  appendFileSync(`${dir}/calls.log`, `${Date.now()} ${method}\n`);
  const send = (payload) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  if (botPart !== `bot${token}`) return send({ ok: false, error_code: 401, description: "Unauthorized" });

  let params = Object.fromEntries(url.searchParams);
  if (body) {
    try { params = { ...params, ...JSON.parse(body) }; } catch {
      params = { ...params, ...Object.fromEntries(new URLSearchParams(body)) };
    }
  }
  if (!pingQueued && existsSync(`${dir}/send-ping`)) {
    pingQueued = true;
    queue.push({ update_id: ++updateId, message: { message_id: 2, from: user, chat, date: Math.floor(Date.now() / 1000), text: "ping" } });
  }
  switch (method) {
    case "getMe":
      return send({ ok: true, result: { id: 777, is_bot: true, first_name: "Kit Test", username: "kit_test_bot" } });
    case "getWebhookInfo":
      return send({ ok: true, result: { url: "" } });
    case "getUpdates": {
      const offset = Number(params.offset ?? 0);
      while (queue.length && queue[0].update_id < offset) queue.shift();
      if (queue.length) return send({ ok: true, result: queue.slice() });
      return setTimeout(() => send({ ok: true, result: [] }), Math.min(Number(params.timeout ?? 0), 2) * 1000);
    }
    case "sendMessage":
    case "editMessageText":
      appendFileSync(`${dir}/sent.jsonl`, `${JSON.stringify({ method, chat_id: params.chat_id, text: params.text })}\n`);
      return send({ ok: true, result: { message_id: Math.floor(Math.random() * 1e6), chat, date: 0, text: params.text } });
    default:
      return send({ ok: true, result: true });
  }
}).listen(Number(port), "127.0.0.1");
