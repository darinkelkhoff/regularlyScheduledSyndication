import { copyFile } from 'node:fs/promises';
import { build } from 'esbuild';
await build({ entryPoints: ['src/client/main.tsx'], loader: { '.svg': 'dataurl', '.png': 'file' }, publicPath: '/assets', assetNames: '[name]-[hash]', bundle: true, outfile: 'dist/public/assets/app.js', format: 'esm', platform: 'browser', target: 'es2023', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, minify: true });
await copyFile('src/client/assets/regsched-hourglass.png', 'dist/public/assets/favicon.png');
await build({ entryPoints: ['src/worker.ts'], bundle: true, outfile: 'dist/worker.js', format: 'esm', platform: 'browser', target: 'es2023', external: ['node:*'] });
