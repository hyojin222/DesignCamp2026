import { defineConfig } from 'vite';
import chokidar from 'chokidar';
import { generateAssets, SOURCE_DIR } from './scripts/generate-assets.mjs';

function foodAssetsPlugin() {
  let regenerating = null;
  const regenerate = () => {
    if (regenerating) return regenerating;
    regenerating = generateAssets().finally(() => {
      regenerating = null;
    });
    return regenerating;
  };

  return {
    name: 'food-assets',
    async buildStart() {
      await regenerate();
    },
    configureServer(server) {
      const watcher = chokidar.watch(SOURCE_DIR, { ignoreInitial: true });
      let timer = null;
      const scheduleRegenerate = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          await regenerate();
          server.ws.send({ type: 'full-reload' });
        }, 300);
      };
      watcher.on('add', scheduleRegenerate);
      watcher.on('unlink', scheduleRegenerate);
      watcher.on('addDir', scheduleRegenerate);
      watcher.on('unlinkDir', scheduleRegenerate);
      watcher.on('change', scheduleRegenerate);
      server.httpServer?.once('close', () => watcher.close());
    },
  };
}

export default defineConfig({
  base: process.env.GITHUB_PAGES ? '/DesignCamp2026/' : '/',
  plugins: [foodAssetsPlugin()],
});
