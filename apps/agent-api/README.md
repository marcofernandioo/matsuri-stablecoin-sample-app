# Matsuri agent API / エージェント API

**EN:** AI agents use Matsuri as their own [Agentic World](https://github.com/ryuux05/eth-tokyo-2026) account instead of borrowing a human's wallet or Matsuri's MultiBaas key. The agent's on-chain owner decides what it may do.

**JP:** AI エージェントは人間のウォレットや Matsuri の MultiBaas キーを借りず、自身の Agentic World アカウントとして Matsuri を利用します。許可はエージェントのオンチェーン所有者が決めます。

## Permissions / 権限

**EN:** [`permissions.json`](permissions.json) is the only list of permissions. Each entry assigns one agent route a `read` or `write` permission, with the label the web app shows; the server refuses to start if a route has none or two. Each owner wallet has one switch per permission that applies to all its agents: reads start on, writes start off. The owner can also switch a permission off for one agent, but never beyond the wallet switch. Agents are listed once they have signed in, recorded under their verified owner. The owner switches permissions in the web app's **Agent permissions** popup (wallet message signature, no transaction). Switches are saved in `grants.json` (git-ignored) and apply to the agent's next request.

**JP:** [`permissions.json`](permissions.json) が唯一の権限一覧です。各項目はエージェントのルート1つに `read` か `write` の権限と、Web アプリに表示するラベルを割り当てます。権限のないルートや重複があるとサーバーは起動しません。所有者のウォレットには権限ごとに1つのスイッチがあり、所有する全エージェントに適用されます（読み取りは最初からオン、書き込みはオフ）。所有者は1つのエージェントだけ権限をオフにすることもできますが、ウォレットのスイッチを超えることはできません。エージェントはサインイン後、検証済みの所有者の下に表示されます。所有者は Web アプリの「エージェントの権限」ポップアップ（ウォレットのメッセージ署名のみ、トランザクションなし）で切り替えます。切り替えは `grants.json`（Git 管理外）に保存され、エージェントの次のリクエストから反映されます。

## Routes / ルート

| Route | Who | Effect |
| --- | --- | --- |
| `POST /agent/challenge` `{ agentId }` | agent | One-time challenge / 一回限りのチャレンジ |
| `POST /agent/session` (signed proof) | agent | Verifies the proof; returns `Agent-Session` and the enabled permissions / 検証後にセッションと有効な権限を返す |
| Routes in `permissions.json` | agent + permission | Tickets, history, prepared purchase/redeem calls / チケット・履歴・購入/利用の呼び出し準備 |
| `GET /permissions` | anyone | The permission list / 権限一覧 |
| `POST /owner/challenge` `{ wallet }`, `POST /owner/session` `{ nonce, signature }` | owner | Wallet sign-in; returns an `Owner-Session` token / ウォレットでサインインしトークンを返す |
| `GET /owner/permissions` | owner | The wallet's switches and its agents' narrowed permissions / ウォレットのスイッチとエージェントごとの絞り込み |
| `POST /owner/permission` `{ permission, enabled, agentId? }` | owner | Switches one permission for the wallet, or for one agent if `agentId` is given / ウォレット、または `agentId` 指定時はそのエージェントの権限を1つ切り替える |

**EN:** Matsuri never pays or holds tickets: it prepares exact calls, and the agent executes them from its own account under its owner's on-chain policy.

**JP:** Matsuri は支払いもチケットの保管もしません。正確な呼び出しを準備し、エージェントが所有者のオンチェーンポリシーの下で自身のアカウントから実行します。

## Run / 起動

```bash
npm --prefix ../../../eth-tokyo-2026 run build:sdk   # builds the agentic-world package this app imports
cp .env.example .env                                 # then fill it in
npm install
npm start
```
