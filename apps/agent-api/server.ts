import { createHash, randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as MultiBaas from "@curvegrid/multibaas-sdk";
import {
  AgenticWorld, type AgenticWorldConfig, type AuthenticationChallenge, type AuthenticationProof, type Session,
} from "agentic-world/service";
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hex } from "viem";
import { MATSURI_EVENTS } from "../web/src/data/events.ts";

// Matsuri's agent API: an agent signs in as its own Agentic World account, and its owner's wallet decides what it may do.
// Matsuri のエージェント API。エージェントは自身の Agentic World アカウントとしてサインインし、許可は所有者のウォレットが決める。

type Text = { en: string; ja: string };
type Permission = { id: string; group: "read" | "write"; route: string; label: Text; detail: Text };
type Grants = { wallets: Record<string, string[]>; agents: Record<string, { owner: Address; disabled: string[] }> };
type Body = Record<string, unknown>;
type Call = { target: Address; value: "0"; data: Hex; description: string };

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in apps/agent-api/.env`);
  return value;
}

function envAddress(name: string): Address {
  const value = env(name);
  if (!isAddress(value)) throw new Error(`${name} must be an address`);
  return getAddress(value);
}

const chainId = Number(env("AGENT_API_CHAIN_ID"));
const audience = env("AGENT_API_AUDIENCE");
const port = Number(process.env.AGENT_API_PORT ?? "4200");
const webOrigin = process.env.AGENT_API_WEB_ORIGIN ?? "http://localhost:5173";
const stablecoin = envAddress("MATSURI_STABLECOIN");
const voucher = envAddress("MATSURI_VOUCHER");
// The same MultiBaas address aliases as apps/web/src/lib/config.ts.
// apps/web/src/lib/config.ts と同じ MultiBaas アドレスエイリアス。
const ALIAS = { stablecoin: "matsuri_stablecoin", voucher: "matsuri_voucher" } as const;

// Matsuri's own MultiBaas key stays in this process; agents never see it.
// Matsuri 自身の MultiBaas キーはこのプロセス内に留まり、エージェントには渡らない。
const multibaas = new MultiBaas.Configuration({
  basePath: new URL("/api/v0", env("MB_BASE_URL")).toString(),
  accessToken: env("MB_API_KEY"),
});
const contractsApi = new MultiBaas.ContractsApi(multibaas);
const eventQueriesApi = new MultiBaas.EventQueriesApi(multibaas);

// Agent accounts are verified against the chain directly: MultiBaas has JSON-RPC only on Curvegrid Testnet.
// エージェントのアカウントはチェーンで直接検証する。MultiBaas の JSON-RPC は Curvegrid Testnet のみ。
const client = createPublicClient({ transport: http(env("AGENT_API_RPC_URL")) });
if (await client.getChainId() !== chainId) throw new Error("AGENT_API_RPC_URL is not on AGENT_API_CHAIN_ID");

const stablecoinAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
const voucherAbi = parseAbi([
  "function buyVoucher(uint256 eventId, uint256 quantity)",
  "function redeemVoucher(uint256 eventId, uint256 quantity)",
]);

async function read<T>(contract: keyof typeof ALIAS, method: string, args: unknown[]): Promise<T> {
  const response = await contractsApi.callContractFunction(ALIAS[contract], ALIAS[contract], method,
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
      { rule: "and", fieldType: "contract_address_alias", operator: "equal", value: ALIAS.voucher },
      { fieldType: "input", inputIndex: 0, operator: "equal", value: agent },
    ] },
  });
  const response = await eventQueriesApi.executeArbitraryEventQuery(
    { events: [byAgent("VoucherPurchased"), byAgent("VoucherRedeemed")], orderBy: "timestamp", order: "DESC" }, 0, 50);
  return response.data.result?.rows ?? [];
}

function positiveInteger(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `Expected an integer from 1 to ${max}`);
  }
  return value;
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
const PERMISSIONS = JSON.parse(readFileSync(new URL("./permissions.json", import.meta.url), "utf8")) as Permission[];
const permissionFor = new Map(PERMISSIONS.map(permission => [permission.route, permission]));
if (new Set(PERMISSIONS.map(permission => permission.id)).size !== PERMISSIONS.length || permissionFor.size !== PERMISSIONS.length ||
    PERMISSIONS.some(permission => !HANDLERS[permission.route] || !["read", "write"].includes(permission.group)) ||
    Object.keys(HANDLERS).some(route => !permissionFor.has(route))) {
  throw new Error("permissions.json must give every agent route exactly one read or write permission");
}

// grants.json: each wallet's switches, and every agent that has signed in with its verified owner and what that owner narrowed; saved on every change.
// grants.json：ウォレットごとのスイッチと、サインインしたエージェント（検証済みの所有者と絞り込んだ権限）。変更のたびに保存する。
const grantsFile = new URL("./grants.json", import.meta.url);
let grants: Grants = { wallets: {}, agents: {} };
try { grants = JSON.parse(readFileSync(grantsFile, "utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
function saveGrants(): void {
  const temporary = new URL("./grants.json.tmp", import.meta.url);
  writeFileSync(temporary, JSON.stringify(grants, null, 2));
  renameSync(temporary, grantsFile);
}

// A wallet's switches apply to all its agents, reads on until changed; an agent's own switches can only narrow them.
// ウォレットのスイッチは所有する全エージェントに適用され、変更するまで読み取りはオン。エージェント個別のスイッチは絞り込みのみ。
const READS = PERMISSIONS.filter(permission => permission.group === "read").map(permission => permission.id);
const walletEnabled = (wallet: string) => grants.wallets[wallet.toLowerCase()] ?? READS;
function agentPermissions(agentId: string): string[] {
  const agent = grants.agents[agentId.toLowerCase()];
  return agent ? walletEnabled(agent.owner).filter(id => !agent.disabled.includes(id)) : [];
}

const challenges = new Map<Hex, AuthenticationChallenge>();
const sessions = new Map<Hex, Session>();
const agentic = new AgenticWorld<{ wallet: Address }>({
  // Same viem version but a separate install, so the client types are identical yet not shared.
  // viem は同じバージョンだが別インストールのため、型は同一でも共有されない。
  client: client as unknown as AgenticWorldConfig<{ wallet: Address }>["client"],
  chainId,
  audience,
  pinnedImplementation: envAddress("AGENT_API_IMPLEMENTATION"),
  // Owner mode reads the verified account's owner(): the wallet that controls this agent's permissions.
  // owner モードは検証済みアカウントの owner()、つまりこのエージェントの権限を管理するウォレットを読む。
  association: { mode: "owner", resolveUser: async owner => ({ wallet: owner }) },
  challengeTtlSeconds: 120,
  sessionTtlSeconds: 300,
  challenges: {
    async put(challenge) { challenges.set(challenge.nonce, challenge); },
    async get(nonce) { return challenges.get(nonce); },
    async consume(nonce) { return challenges.delete(nonce); },
  },
  sessions: {
    async put(hash, session) { sessions.set(hash, session); },
    async get(hash) { return sessions.get(hash); },
  },
});

// Owners sign in with a wallet message signature (no transaction) to switch their agents' permissions.
// 所有者はウォレットのメッセージ署名（トランザクションなし）でサインインし、エージェントの権限を切り替える。
const ownerChallenges = new Map<string, { wallet: Address; message: string; expiresAt: number }>();
const ownerSessions = new Map<string, { wallet: Address; expiresAt: number }>();
const now = () => Math.floor(Date.now() / 1000);
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function ownerChallenge(body: Body) {
  if (typeof body.wallet !== "string" || !isAddress(body.wallet)) throw new HttpError(400, "Invalid wallet");
  const wallet = getAddress(body.wallet);
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = now() + 300;
  const message = `Matsuri: manage my agents' permissions\nWallet: ${wallet}\nAudience: ${audience}\nNonce: ${nonce}`;
  ownerChallenges.set(nonce, { wallet, message, expiresAt });
  return { nonce, message };
}

async function ownerSession(body: Body) {
  const challenge = typeof body.nonce === "string" ? ownerChallenges.get(body.nonce) : undefined;
  if (challenge) ownerChallenges.delete(body.nonce as string);
  if (!challenge || challenge.expiresAt <= now() || typeof body.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.signature)) {
    throw new HttpError(401, "Unknown, used or expired sign-in challenge");
  }
  // Works for ordinary wallets and ERC-1271 smart wallets.
  // 通常のウォレットと ERC-1271 スマートウォレットの両方に対応する。
  if (!await client.verifyMessage({ address: challenge.wallet, message: challenge.message, signature: body.signature as Hex })) {
    throw new HttpError(401, "Signature does not match this wallet");
  }
  const token = randomBytes(32).toString("base64url");
  ownerSessions.set(hashToken(token), { wallet: challenge.wallet, expiresAt: now() + 1800 });
  return { token };
}

function ownerOf(request: IncomingMessage): Address {
  const token = request.headers["owner-session"];
  const session = typeof token === "string" ? ownerSessions.get(hashToken(token)) : undefined;
  if (!session || session.expiresAt <= now()) throw new HttpError(401, "Sign in with your wallet first");
  return session.wallet;
}

function ownerState(wallet: Address) {
  const agents = Object.entries(grants.agents)
    .filter(([, agent]) => same(agent.owner, wallet))
    .map(([agentId, agent]) => ({ agentId: getAddress(agentId), disabled: agent.disabled }));
  return { enabled: walletEnabled(wallet), agents };
}

// Without agentId the switch is the wallet's own; with it, one agent is narrowed or restored.
// agentId がなければウォレット自身のスイッチ、あれば1つのエージェントを絞り込むか戻す。
function setPermission(wallet: Address, body: Body) {
  const id = body.permission as string;
  if (!PERMISSIONS.some(permission => permission.id === id) || typeof body.enabled !== "boolean") {
    throw new HttpError(400, "Expected permission and enabled");
  }
  const add = (list: string[]) => [...new Set([...list, id])];
  const remove = (list: string[]) => list.filter(item => item !== id);
  if (body.agentId === undefined) {
    grants.wallets[wallet.toLowerCase()] = (body.enabled ? add : remove)(walletEnabled(wallet));
  } else {
    const agent = typeof body.agentId === "string" ? grants.agents[body.agentId.toLowerCase()] : undefined;
    if (!agent || !same(agent.owner, wallet)) throw new HttpError(404, "This wallet does not own that agent at Matsuri");
    agent.disabled = (body.enabled ? remove : add)(agent.disabled);
  }
  saveGrants();
  return ownerState(wallet);
}

// The first sign-in records the agent under its verified owner, whose wallet switches then apply to it.
// 初回サインインで検証済みの所有者の下にエージェントを記録し、所有者のウォレットのスイッチを適用する。
async function agentSession(body: Body, response: ServerResponse) {
  let result: Awaited<ReturnType<typeof agentic.authenticate>>;
  try { result = await agentic.authenticate(body as unknown as AuthenticationProof); }
  catch { throw new HttpError(401, "Proof rejected"); }
  const { agentId, owner, expiresAt } = result.session;
  const key = agentId.toLowerCase();
  if (!grants.agents[key]) {
    grants.agents[key] = { owner: getAddress(owner!), disabled: [] };
    saveGrants();
  }
  response.setHeader("Agent-Session", result.token);
  return { agentId, owner, permissions: agentPermissions(agentId), expiresAt };
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

// Agent routes need an Agent-Session and the route's permission, rechecked on every request so a switch applies at once.
// エージェントのルートには Agent-Session とルートの権限が必要。毎回確認するため、切り替えは即時に反映される。
async function agentRoute(request: IncomingMessage, route: string) {
  const permission = permissionFor.get(route);
  if (!permission) throw new HttpError(404, "Unknown route");
  const token = request.headers["agent-session"];
  const authenticated = typeof token === "string" ? await agentic.readSession(token) : undefined;
  if (!authenticated) throw new HttpError(401, "A valid Agent-Session is required");
  const agentId = getAddress(authenticated.session.agentId);
  if (!agentPermissions(agentId).includes(permission.id)) {
    throw new HttpError(403, `The agent's owner has not enabled ${permission.id}`);
  }
  return HANDLERS[route](agentId, request.method === "POST" ? await readJson(request) : {});
}

async function handle(request: IncomingMessage, response: ServerResponse, route: string): Promise<unknown> {
  switch (route) {
    case "GET /permissions": return PERMISSIONS;
    case "POST /owner/challenge": return ownerChallenge(await readJson(request));
    case "POST /owner/session": return ownerSession(await readJson(request));
    case "GET /owner/permissions": return ownerState(ownerOf(request));
    case "POST /owner/permission": return setPermission(ownerOf(request), await readJson(request));
    case "POST /agent/challenge": {
      const { agentId } = await readJson(request);
      if (typeof agentId !== "string" || !isAddress(agentId)) throw new HttpError(400, "Invalid agent ID");
      try { return await agentic.createChallenge(agentId); }
      catch { throw new HttpError(401, "Could not issue a challenge for this agent"); }
    }
    case "POST /agent/session": return agentSession(await readJson(request), response);
    default: return agentRoute(request, route);
  }
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  // Only the permission list and owner routes are callable from the web app's browser origin.
  // ブラウザの Web アプリから呼べるのは権限一覧と所有者用ルートのみ。
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    ...(path === "/permissions" || path.startsWith("/owner/") ? {
      "access-control-allow-origin": webOrigin, "access-control-allow-headers": "content-type, owner-session", vary: "Origin",
    } : {}) };
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers).end();
    return;
  }
  try {
    const result = await handle(request, response, `${request.method} ${path}`);
    response.writeHead(200, headers).end(JSON.stringify(result));
  } catch (error) {
    // Never echo upstream MultiBaas/RPC messages: they can contain URLs or request data.
    // MultiBaas/RPC のエラー文は URL やリクエスト内容を含み得るため、そのまま返さない。
    if (!(error instanceof HttpError)) console.error(error);
    const status = error instanceof HttpError ? error.status : 502;
    response.writeHead(status, headers).end(JSON.stringify({ error: error instanceof HttpError ? error.message : "Matsuri could not complete this request" }));
  }
});

// Loopback only. Agents sign for the HTTPS audience; the local transport is HTTP. Do not deploy it this way.
// ループバック専用。エージェントは HTTPS の audience に署名するが、ローカル通信は HTTP。この形で公開しないこと。
server.listen(port, "127.0.0.1", () => console.log(`Matsuri agent API on http://127.0.0.1:${port}, audience ${audience}`));
