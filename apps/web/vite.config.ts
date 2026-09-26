import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createAgentApi } from './agent/api.js';

// Mounts Matsuri's agent API (agent/api.ts) in the dev and preview servers, as Vercel runs it in production.
// If it cannot start, it logs why and the human app still runs.
// Matsuri のエージェント API（agent/api.ts）を、本番の Vercel と同様に開発・プレビューサーバーへ組み込む。
// 起動できない場合は理由をログに出し、人間向けアプリはそのまま動く。
async function mountAgentApi({ config, middlewares }: ViteDevServer | PreviewServer) {
  try {
    middlewares.use(await createAgentApi(loadEnv(config.mode, config.envDir || config.root, '')));
  } catch (error) {
    config.logger.warn(`Matsuri agent API is off: ${(error as Error).message}`);
  }
}

// Vite config for a lightweight React + TypeScript frontend.
// 軽量な React + TypeScript フロントエンド向けの Vite 設定。
export default defineConfig({
  plugins: [react(), { name: 'matsuri-agent-api', configureServer: mountAgentApi, configurePreviewServer: mountAgentApi }],
  server: {
    port: 5173
  }
});
