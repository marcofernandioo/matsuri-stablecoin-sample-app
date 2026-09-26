import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as MultiBaas from "@curvegrid/multibaas-sdk";
import { Redis } from "@upstash/redis";
import { SEPOLIA_CHAIN_ID } from "agentic-world/core";
import { AgenticWorld, type AgenticRequest, type AuthenticationChallenge, type Session } from "agentic-world/service";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { MATSURI_EVENTS } from "../src/data/events.js";
import permissionsFile from "./permissions.json" with { type: "json" };

// Matsuri's agent API: an agent signs in as its own Agentic World account, and its owner's wallet decides what it may do.
// It runs as a Vercel function in production and inside the Vite dev server locally, with the same code and settings.
// Matsuri のエージェント API。エージェントは自身の Agentic World アカウントとしてサインインし、許可は所有者のウォレットが決める。
// 本番では Vercel の関数、ローカルでは Vite の開発サーバー内で、同じコードと設定で動く。

type Text = { en: string; ja: string };
type Permission = { id: string; group: "read" | "write"; route: string; label: Text; detail: Text };
type AgentRecord = { owner: Address; disabled: string[] };
type Owner = { wallet: Address };
type Body = Record<string, unknown>;
type Call = { target: Address; value: "0"; data: Hex; description: string };
export type Handler = (request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const PERMISSIONS = permissionsFile as Permission[];
const READS = PERMISSIONS.filter(permission => permission.group === "read").map(permission => permission.id);
const CHALLENGE_TTL = 120;
const SESSION_TTL = 300;
const stablecoinAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const voucherAbi = parseAbi([
  "function buyVoucher(uint256 eventId, uint256 quantity)",
  "function redeemVoucher(uint256 eventId, uint256 quantity)",
]);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const routeOf = (request: IncomingMessage) => `${request.method} ${new URL(request.url ?? "/", "http://localhost").pathname}`;

function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `Expected an integer from 1 to ${max}`);
  }
  return value;
}

async function readJson(request: IncomingMessage): Promise<Body> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new HttpError(400, "Use application/json");
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    length += part.length;
    if (length > 8192) throw new HttpError(400, "Request body exceeds 8 KiB");
    parts.push(part);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString("utf8")); }
  catch { throw new HttpError(400, "Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Expected a JSON object");
  return value as Body;
}

export async function createAgentApi(env: Record<string, string | undefined>): Promise<Handler> {
  const setting = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Set ${name}`);
    return value;
  };
  // The canonical HTTPS origin agents sign for: the live site's address in production, a fixed name locally.
  // エージェントが署名する正規の HTTPS オリジン。本番はサイトのアドレス、ローカルは固定の名前。
  const audience = env.AGENT_AUDIENCE?.trim() || "https://matsuri.example";

  // The web app's own MultiBaas deployment, key and aliases; the key is never sent to agents.
  // Web アプリと同じ MultiBaas のデプロイ・キー・エイリアス。キーはエージェントに渡さない。
  const multibaas = new MultiBaas.Configuration({
    basePath: new URL("/api/v0", setting("VITE_MB_BASE_URL")).toString(),
    accessToken: setting("VITE_MB_API_KEY"),
  });
  const contractsApi = new MultiBaas.ContractsApi(multibaas);
  const eventQueriesApi = new MultiBaas.EventQueriesApi(multibaas);
  const alias = {
    stablecoin: env.VITE_STABLECOIN_ADDRESS_ALIAS || "matsuri_stablecoin",
    voucher: env.VITE_VOUCHER_ADDRESS_ALIAS || "matsuri_voucher",
  };
  const label = {
    stablecoin: env.VITE_STABLECOIN_CONTRACT_LABEL || "matsuri_stablecoin",
    voucher: env.VITE_VOUCHER_CONTRACT_LABEL || "matsuri_voucher",
  };
  const addressesApi = new MultiBaas.AddressesApi(multibaas);
  const [stablecoin, voucher] = await Promise.all([alias.stablecoin, alias.voucher]
    .map(async name => getAddress((await addressesApi.getAddress(name)).data.result.address)));

  // Agent accounts are verified against Sepolia directly: MultiBaas has JSON-RPC only on Curvegrid Testnet.
  // エージェントのアカウントは Sepolia で直接検証する。MultiBaas の JSON-RPC は Curvegrid Testnet のみ。
  const client = createPublicClient({ transport: http(env.VITE_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com") });
  if (await client.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("VITE_SEPOLIA_RPC_URL is not a Sepolia RPC");

  // Upstash Redis holds sign-ins and switches, shared by every function instance and kept across restarts.
  // Keys are scoped to the audience, so local runs and the live site never mix.
  // Upstash Redis にサインインとスイッチを保存し、全インスタンスで共有して再起動後も保持する。
  // キーは audience ごとに分け、ローカルと本番のデータが混ざらないようにする。
  const redis = new Redis({ url: setting("KV_REST_API_URL"), token: setting("KV_REST_API_TOKEN") });
  const key = (...parts: string[]) => ["matsuri", audience, ...parts].join(":").toLowerCase();

  async function read<T>(contract: keyof typeof alias, method: string, args: unknown[]): Promise<T> {
    const response = await contractsApi.callContractFunction(alias[contract], label[contract], method,
      { args, contractOverride: true, formatInts: "as_strings" });
    return (response.data.result as unknown as { output?: unknown }).output as T;
  }

  async function tickets(agent: Address) {
    const mjpyBalance = await read<string>("stablecoin", "balanceOf", [agent]);
    const events = await Promise.all(MATSURI_EVENTS.map(async event => {
      const [price, available] = await read<[string, string]>("voucher", "eventInfo", [event.id]);
      const held = await read<string>("voucher", "balanceOf", [agent, event.id]);
      return { eventId: event.id, title: event.title.en, price, available, held };
    }));
    return { agentId: agent, mjpyBalance, events };
  }

  // The agent's own purchases and redemptions, from MultiBaas event indexing.
  // MultiBaas のイベントインデックスから、エージェント自身の購入・利用履歴を取得する。
  async function history(agent: Address) {
    const byAgent = (eventName: string): MultiBaas.EventQueryEvent => ({
      eventName,
      select: [
        { type: "event_signature", alias: "eventName" },
        { type: "input", inputIndex: 1, alias: "eventId" },
        { type: "input", inputIndex: 2, alias: "quantity" },
        { type: "triggered_at", alias: "timestamp" },
        { type: "tx_hash", alias: "txhash" },
      ],
      filter: { rule: "and", children: [
        { rule: "and", fieldType: "contract_address_alias", operator: "equal", value: alias.voucher },
        { fieldType: "input", inputIndex: 0, operator: "equal", value: agent },
      ] },
    });
    const response = await eventQueriesApi.executeArbitraryEventQuery(
      { events: [byAgent("VoucherPurchased"), byAgent("VoucherRedeemed")], orderBy: "timestamp", order: "DESC" }, 0, 50);
    return response.data.result?.rows ?? [];
  }

  // Matsuri only prepares the exact calls; the agent's own account pays, executes them, and receives the vouchers.
  // Matsuri は正確な呼び出しを準備するだけで、支払い・実行・バウチャーの受け取りはエージェント自身のアカウントが行う。
  async function preparePurchase(agent: Address, body: Body) {
    const eventId = positiveInteger(body.eventId, 1_000_000);
    const quantity = positiveInteger(body.quantity, 10);
    const [price, available] = await read<[string, string]>("voucher", "eventInfo", [eventId]);
    if (BigInt(price) === 0n) throw new HttpError(404, "Unknown Matsuri event");
    if (BigInt(available) < BigInt(quantity)) throw new HttpError(409, "Not enough vouchers left");
    const cost = BigInt(price) * BigInt(quantity);
    const calls: Call[] = [
      { target: stablecoin, value: "0", description: `Approve exactly ${cost} MJPY base units to the voucher contract`,
        data: encodeFunctionData({ abi: stablecoinAbi, functionName: "approve", args: [voucher, cost] }) },
      { target: voucher, value: "0", description: `Buy ${quantity} voucher(s) for event ${eventId}`,
        data: encodeFunctionData({ abi: voucherAbi, functionName: "buyVoucher", args: [BigInt(eventId), BigInt(quantity)] }) },
    ];
    return { agentId: agent, eventId, quantity, cost: cost.toString(), calls };
  }

  async function prepareRedemption(agent: Address, body: Body) {
    const eventId = positiveInteger(body.eventId, 1_000_000);
    const quantity = positiveInteger(body.quantity, 10);
    const held = await read<string>("voucher", "balanceOf", [agent, eventId]);
    if (BigInt(held) < BigInt(quantity)) throw new HttpError(409, `The agent holds ${held} voucher(s) for event ${eventId}`);
    const calls: Call[] = [
      { target: voucher, value: "0", description: `Redeem ${quantity} voucher(s) for event ${eventId}`,
        data: encodeFunctionData({ abi: voucherAbi, functionName: "redeemVoucher", args: [BigInt(eventId), BigInt(quantity)] }) },
    ];
    return { agentId: agent, eventId, quantity, calls };
  }

  // The server functions agents can call, keyed by the route that permissions.json assigns a permission to.
  // エージェントが呼べるサーバー関数。permissions.json が権限を割り当てるルートをキーとする。
  const HANDLERS: Record<string, (agent: Address, body: Body) => Promise<unknown>> = {
    "GET /agent/tickets": agent => tickets(agent),
    "GET /agent/history": agent => history(agent),
    "POST /agent/purchase": preparePurchase,
    "POST /agent/redeem": prepareRedemption,
  };

  // permissions.json is the only list of permissions, and every agent route must have exactly one.
  // permissions.json が唯一の権限一覧で、エージェントの各ルートにはちょうど1つの権限が必要。
  const permissionFor = new Map(PERMISSIONS.map(permission => [permission.route, permission]));
  if (new Set(PERMISSIONS.map(permission => permission.id)).size !== PERMISSIONS.length || permissionFor.size !== PERMISSIONS.length ||
      PERMISSIONS.some(permission => !HANDLERS[permission.route] || !["read", "write"].includes(permission.group)) ||
      Object.keys(HANDLERS).some(route => !permissionFor.has(route))) {
    throw new Error("permissions.json must give every agent route exactly one read or write permission");
  }

  // A wallet's switches apply to all its agents, reads on until changed; an agent's own switches can only narrow them.
  // ウォレットのスイッチは所有する全エージェントに適用され、変更するまで読み取りはオン。エージェント個別のスイッチは絞り込みのみ。
  async function walletEnabled(wallet: string): Promise<string[]> {
    return (await redis.get<string[]>(key("wallet", wallet))) ?? READS;
  }
  async function agentPermissions(agentId: string): Promise<string[]> {
    const agent = await redis.get<AgentRecord>(key("agent", agentId));
    return agent ? (await walletEnabled(agent.owner)).filter(id => !agent.disabled.includes(id)) : [];
  }

  // An agent is recorded under its verified owner the first time it signs in; SET NX makes that happen once.
  // エージェントは初回サインイン時に検証済みの所有者の下へ記録される。SET NX により1回だけ行われる。
  async function recordAgent(agentId: Address, owner: Address) {
    if (await redis.set(key("agent", agentId), { owner: getAddress(owner), disabled: [] }, { nx: true })) {
      await redis.sadd(key("owned", owner), agentId.toLowerCase());
    }
  }

  const agentic = new AgenticWorld<Owner>({
    client,
    chainId: SEPOLIA_CHAIN_ID,
    audience,
    // Owner mode reads the verified account's owner(): the wallet that controls this agent's permissions.
    // owner モードは検証済みアカウントの owner()、つまりこのエージェントの権限を管理するウォレットを読む。
    association: { mode: "owner", resolveUser: async owner => ({ wallet: owner }) },
    challengeTtlSeconds: CHALLENGE_TTL,
    sessionTtlSeconds: SESSION_TTL,
    challenges: {
      async put(challenge) { await redis.set(key("challenge", challenge.nonce), challenge, { ex: CHALLENGE_TTL }); },
      async get(nonce) { return (await redis.get<AuthenticationChallenge>(key("challenge", nonce))) ?? undefined; },
      // DEL reports whether the key existed, so each challenge is consumed exactly once, across instances.
      // DEL はキーの有無を返すため、複数インスタンスでも各チャレンジはちょうど1回だけ消費される。
      async consume(nonce) { return (await redis.del(key("challenge", nonce))) === 1; },
    },
    sessions: {
      async put(hash, session) { await redis.set(key("session", hash), session, { ex: SESSION_TTL }); },
      async get(hash) { return (await redis.get<Session>(key("session", hash))) ?? undefined; },
    },
  });

  // The SDK middleware signs agents in on the route itself: 401 with a challenge, then the signed retry passes.
  // Our only question is whether the owner has switched the route's permission on.
  // SDK のミドルウェアはルート上でサインインを行う（チャレンジ付きの 401、署名付きの再試行で通過）。
  // 判断するのは、所有者がルートの権限をオンにしているかどうかだけ。
  const requirePermission = agentic.middleware({ realm: "Matsuri", authorize: async ({ session }, request) => {
    await recordAgent(session.agentId, session.owner!);
    return (await agentPermissions(session.agentId)).includes(permissionFor.get(routeOf(request))!.id);
  } });

  // Owners sign in with a wallet message signature (no transaction) to switch their agents' permissions.
  // 所有者はウォレットのメッセージ署名（トランザクションなし）でサインインし、エージェントの権限を切り替える。
  async function ownerChallenge(body: Body) {
    if (typeof body.wallet !== "string" || !isAddress(body.wallet)) throw new HttpError(400, "Invalid wallet");
    const wallet = getAddress(body.wallet);
    const nonce = randomBytes(32).toString("hex");
    const message = `Matsuri: manage my agents' permissions\nWallet: ${wallet}\nAudience: ${audience}\nNonce: ${nonce}`;
    await redis.set(key("owner-challenge", nonce), { wallet, message }, { ex: 300 });
    return { nonce, message };
  }

  async function ownerSession(body: Body) {
    // GETDEL reads and removes in one step, so a sign-in challenge works only once.
    // GETDEL は読み取りと削除を1回で行うため、サインインのチャレンジは1回しか使えない。
    const challenge = typeof body.nonce === "string"
      ? await redis.getdel<{ wallet: Address; message: string }>(key("owner-challenge", body.nonce)) : null;
    if (!challenge || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
      throw new HttpError(401, "Unknown, used or expired sign-in challenge");
    }
    // Works for ordinary wallets and ERC-1271 smart wallets.
    // 通常のウォレットと ERC-1271 スマートウォレットの両方に対応する。
    if (!await client.verifyMessage({ address: challenge.wallet, message: challenge.message, signature: body.signature as Hex })) {
      throw new HttpError(401, "Signature does not match this wallet");
    }
    const token = randomBytes(32).toString("base64url");
    await redis.set(key("owner-session", hashToken(token)), { wallet: challenge.wallet }, { ex: 1800 });
    return { token };
  }

  async function ownerOf(request: IncomingMessage): Promise<Address> {
    const token = request.headers["owner-session"];
    const session = typeof token === "string" ? await redis.get<{ wallet: Address }>(key("owner-session", hashToken(token))) : null;
    if (!session) throw new HttpError(401, "Sign in with your wallet first");
    return session.wallet;
  }

  // Each owner keeps a set of the agents recorded under it, so listing needs no scan.
  // 所有者ごとに記録済みエージェントの集合を持つため、一覧に全件走査は不要。
  async function ownerState(wallet: Address) {
    const agentIds = await redis.smembers(key("owned", wallet));
    const agents = await Promise.all(agentIds.map(async agentId =>
      ({ agentId: getAddress(agentId), disabled: (await redis.get<AgentRecord>(key("agent", agentId)))?.disabled ?? [] })));
    return { enabled: await walletEnabled(wallet), agents };
  }

  // Without agentId the switch is the wallet's own; with it, one agent is narrowed or restored.
  // agentId がなければウォレット自身のスイッチ、あれば1つのエージェントを絞り込むか戻す。
  async function setPermission(wallet: Address, body: Body) {
    const id = body.permission as string;
    if (!PERMISSIONS.some(permission => permission.id === id) || typeof body.enabled !== "boolean") {
      throw new HttpError(400, "Expected permission and enabled");
    }
    const add = (list: string[]) => [...new Set([...list, id])];
    const remove = (list: string[]) => list.filter(item => item !== id);
    if (body.agentId === undefined) {
      await redis.set(key("wallet", wallet), (body.enabled ? add : remove)(await walletEnabled(wallet)));
    } else {
      const agentKey = typeof body.agentId === "string" ? key("agent", body.agentId) : "";
      const agent = agentKey ? await redis.get<AgentRecord>(agentKey) : null;
      if (!agent || !same(agent.owner, wallet)) throw new HttpError(404, "This wallet does not own that agent at Matsuri");
      await redis.set(agentKey, { ...agent, disabled: (body.enabled ? remove : add)(agent.disabled) });
    }
    return ownerState(wallet);
  }

  // A simple per-address limit: each unsigned agent request can cost Sepolia RPC calls.
  // アドレスごとの簡単な制限。署名前のエージェントのリクエストは Sepolia RPC を消費し得る。
  async function limitRate(request: IncomingMessage) {
    const forwarded = request.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" ? forwarded.split(",")[0] : request.socket.remoteAddress) ?? "unknown";
    const counter = key("rate", ip.trim(), String(Math.floor(Date.now() / 60_000)));
    const count = await redis.incr(counter);
    if (count === 1) await redis.expire(counter, 60);
    if (count > 60) throw new HttpError(429, "Too many requests; try again in a minute");
  }

  async function handle(request: IncomingMessage, route: string): Promise<unknown> {
    switch (route) {
      case "GET /permissions": return PERMISSIONS;
      case "POST /owner/challenge": return ownerChallenge(await readJson(request));
      case "POST /owner/session": return ownerSession(await readJson(request));
      case "GET /owner/permissions": return ownerState(await ownerOf(request));
      case "POST /owner/permission": return setPermission(await ownerOf(request), await readJson(request));
      default: throw new HttpError(404, "Unknown route");
    }
  }

  // Only the permission list, owner and agent routes are answered here; everything else is the web app.
  // ここで応答するのは権限一覧・所有者・エージェントのルートのみ。それ以外は Web アプリが処理する。
  return async (request, response, next) => {
    const route = routeOf(request);
    const path = route.slice(route.indexOf(" ") + 1);
    if (path !== "/permissions" && !path.startsWith("/owner/") && !path.startsWith("/agent/")) return next();
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      const resource = HANDLERS[route];
      if (!resource) {
        send(200, await handle(request, route));
        return;
      }
      await limitRate(request);
      await requirePermission(request as AgenticRequest<Owner>, response, async () => {
        const agentId = getAddress((request as AgenticRequest<Owner>).agentic!.session.agentId);
        send(200, await resource(agentId, request.method === "POST" ? await readJson(request) : {}));
      });
    } catch (error) {
      // Never echo upstream MultiBaas/RPC messages: they can contain URLs or request data.
      // MultiBaas/RPC のエラー文は URL やリクエスト内容を含み得るため、そのまま返さない。
      if (!(error instanceof HttpError)) console.error(error);
      if (response.headersSent) return;
      send(error instanceof HttpError ? error.status : 502,
        { error: error instanceof HttpError ? error.message : "Matsuri could not complete this request" });
    }
  };
}
