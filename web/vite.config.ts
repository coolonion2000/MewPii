import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { listAssetFiles, retainWebAssets } from '../scripts/retain-web-assets.mjs';

function assetRetention(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'mewpii-bounded-asset-retention',
    apply: 'build',
    configResolved(value) { config = value; },
    async writeBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => name.startsWith('assets/') && !/\.(?:br|gz)$/.test(name));
      // Public assets are also current, even though Rollup does not include them in its bundle.
      if (config.publicDir) assets.push(...(await listAssetFiles(config.publicDir)).map((file) => file.name).filter((name) => !/\.(?:br|gz)$/.test(name)));
      if (!assets.length) return;
      const result = await retainWebAssets({ root: resolve(config.root, config.build.outDir), assets, dryRun: false });
      console.log(`[build] asset_retention removed=${result.removed.length} bytes=${result.removedBytes} days=14 minimum_builds=3`);
    },
  };
}

export default defineConfig({
  plugins: [react(), assetRetention()],
  server: {
    host: '127.0.0.1',
    port: 31042,
    proxy: {
      // Preserve the browser Host so strict same-origin checks also work in development.
      '/api': { target: 'http://127.0.0.1:31041', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:31041', ws: true },
    },
  },
  // Open tabs still import fingerprinted chunks from the version they loaded.
  // Keep those immutable assets available when rebuilding a running instance.
  build: { outDir: 'dist', emptyOutDir: false },
});
