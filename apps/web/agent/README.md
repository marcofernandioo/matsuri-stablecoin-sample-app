# Matsuri agent API / エージェント API

**EN:** AI agents use Matsuri as their own [Agentic World](https://github.com/ryuux05/eth-tokyo-2026) account instead of borrowing a human's wallet. The agent's on-chain owner decides what it may do. The same code ([`api.ts`](api.ts)) runs as a Vercel function in production ([`../api/agent.ts`](../api/agent.ts), routed by [`../vercel.json`](../vercel.json)) and inside the Vite dev server locally, at the same address as the page. If it cannot start, the popup says it is unavailable and the human app still runs.

**JP:** AI エージェントは人間のウォレットを借りず、自身の [Agentic World](https://github.com/ryuux05/eth-tokyo-2026) アカウントとして Matsuri を利用します。許可はエージェントのオンチェーン所有者が決めます。同じコード（[`api.ts`](api.ts)）が、本番では Vercel の関数（[`../api/agent.ts`](../api/agent.ts)、[`../vercel.json`](../vercel.json) で転送）、ローカルでは Vite の開発サーバー内で、ページと同じアドレスで動きます。起動できない場合、ポップアップは利用不可と表示し、人間向けアプリはそのまま動きます。

## Permissions / 権限

**EN:** [`permissions.json`](permissions.json) is the only list of permissions. Each entry assigns one agent route a `read` or `write` permission, with the label the web app shows; the API refuses to start if a route has none or two. Each owner wallet has one switch per permission that applies to all its agents: reads start on, writes start off. The owner can also switch a permission off for one agent, but never beyond the wallet switch. Agents are listed once they have signed in, recorded under their verified owner. Switches are made in the web app's **Agent permissions** popup (wallet message signature, no transaction) and apply to the agent's next request.

**JP:** [`permissions.json`](permissions.json) が唯一の権限一覧です。各項目はエージェントのルート1つに `read` か `write` の権限と、Web アプリに表示するラベルを割り当てます。権限のないルートや重複があると API は起動しません。所有者のウォレットには権限ごとに1つのスイッチがあり、所有する全エージェントに適用されます（読み取りは最初からオン、書き込みはオフ）。所有者は1つのエージェントだけ権限をオフにすることもできますが、ウォレットのスイッチを超えることはできません。エージェントはサインイン後、検証済みの所有者の下に表示されます。切り替えは Web アプリの「エージェントの権限」ポップアップ（ウォレットのメッセージ署名のみ、トランザクションなし）で行い、エージェントの次のリクエストから反映されます。

## How an agent signs in / エージェントのサインイン

**EN:** The Agentic World SDK middleware signs agents in on the protected route itself. Call a route with an `Agent-ID` header: the answer is `401` with a challenge. Sign it (the Agentic World MCP returns ready-to-send headers) and retry the same route with the proof headers: the answer is the resource plus an `Agent-Session` header to reuse. Without the owner's permission the answer is `403`.

**JP:** Agentic World SDK のミドルウェアが、保護されたルート上でサインインを行います。`Agent-ID` ヘッダー付きでルートを呼ぶとチャレンジ付きの `401` が返ります。署名して（Agentic World MCP が送信用ヘッダーを返します）証明ヘッダー付きで同じルートを再試行すると、リソースと再利用できる `Agent-Session` ヘッダーが返ります。所有者の許可がなければ `403` です。

## Routes / ルート

| Route | Who | Effect |
| --- | --- | --- |
| Routes in `permissions.json` (`/agent/tickets`, `/agent/history`, `/agent/purchase`, `/agent/redeem`) | agent + permission | Tickets, history, prepared purchase/redeem calls / チケット・履歴・購入/利用の呼び出し準備 |
| `GET /permissions` | anyone | The permission list / 権限一覧 |
| `POST /owner/challenge` `{ wallet }`, `POST /owner/session` `{ nonce, signature }` | owner | Wallet sign-in; returns an `Owner-Session` token / ウォレットでサインインしトークンを返す |
| `GET /owner/permissions` | owner | The wallet's switches and its agents' narrowed permissions / ウォレットのスイッチとエージェントごとの絞り込み |
| `POST /owner/permission` `{ permission, enabled, agentId? }` | owner | Switches one permission for the wallet, or for one agent if `agentId` is given / ウォレット、または `agentId` 指定時はそのエージェントの権限を1つ切り替える |

**EN:** Matsuri never pays or holds tickets: it prepares exact calls, and the agent executes them from its own account under its owner's on-chain policy.

**JP:** Matsuri は支払いもチケットの保管もしません。正確な呼び出しを準備し、エージェントが所有者のオンチェーンポリシーの下で自身のアカウントから実行します。

## Settings / 設定

**EN:** The API uses the web app's own `.env`: the MultiBaas URL, key, labels and aliases (the contract addresses are looked up from MultiBaas) and the Sepolia RPC. It adds three server-side settings: `KV_REST_API_URL` and `KV_REST_API_TOKEN` for Upstash Redis, which holds sign-ins, sessions and switches, and `AGENT_AUDIENCE`, the HTTPS origin agents sign for (the live site's address in production, `https://matsuri.example` by default). Redis keys are scoped to the audience, so local runs and the live site never mix.

**JP:** API は Web アプリ自身の `.env`（MultiBaas の URL・キー・ラベル・エイリアス、コントラクトのアドレスは MultiBaas から取得、Sepolia RPC）を使います。追加のサーバー側設定は3つです。サインイン・セッション・スイッチを保存する Upstash Redis 用の `KV_REST_API_URL` と `KV_REST_API_TOKEN`、エージェントが署名する HTTPS オリジンの `AGENT_AUDIENCE`（本番はサイトのアドレス、既定値は `https://matsuri.example`）。Redis のキーは audience ごとに分かれ、ローカルと本番のデータは混ざりません。

## Run locally / ローカルで起動

```bash
cd apps/web
npx vercel env pull .env.local   # Redis settings (or copy the two KV_ values into .env)
npm install
npm run dev                      # page and agent API at http://localhost:5173
```
