import type { IncomingMessage, ServerResponse } from "node:http";
import { createAgentApi } from "../agent/api.js";

// Vercel function for Matsuri's agent API; vercel.json rewrites /agent/*, /owner/* and /permissions here.
// Matsuri のエージェント API 用の Vercel 関数。vercel.json が /agent/*・/owner/*・/permissions をここへ書き換える。
const api = createAgentApi(process.env);

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  (await api)(request, response, () => {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: "Unknown route" }));
  });
}
