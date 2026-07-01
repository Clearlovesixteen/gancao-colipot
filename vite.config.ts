import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function safeChunkName(name?: string) {
  const normalized = String(name || 'chunk')
    .replace(/^_+/, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'chunk';
}

// 自定义插件：复制 public 目录到 dist
function copyPublicPlugin() {
  return {
    name: 'copy-public',
    closeBundle() {
      const publicDir = resolve(__dirname, 'public');
      const distDir = resolve(__dirname, 'dist');
      
      if (!existsSync(publicDir)) {
        return;
      }

      if (!existsSync(distDir)) {
        mkdirSync(distDir, { recursive: true });
      }

      // 递归复制 public 目录下的所有文件
      function copyRecursive(src: string, dest: string) {
        const stat = statSync(src);
        if (stat.isDirectory()) {
          if (!existsSync(dest)) {
            mkdirSync(dest, { recursive: true });
          }
          const files = readdirSync(src);
          files.forEach((file) => {
            copyRecursive(resolve(src, file), resolve(dest, file));
          });
        } else {
          copyFileSync(src, dest);
        }
      }

      copyRecursive(publicDir, distDir);

      const tesseractDir = resolve(distDir, 'tesseract');
      const langDir = resolve(tesseractDir, 'lang-data');
      const coreDir = resolve(tesseractDir, 'core');
      mkdirSync(langDir, { recursive: true });
      mkdirSync(coreDir, { recursive: true });

      const maybeCopy = (src: string, dest: string) => {
        if (existsSync(src)) copyFileSync(src, dest);
      };
      const maybeCopyResolved = (specifier: string, dest: string) => {
        try {
          maybeCopy(require.resolve(specifier), dest);
        } catch {
          // Optional dependency layout can differ between package managers.
        }
      };

      maybeCopy(
        resolve(__dirname, 'node_modules/tesseract.js/dist/worker.min.js'),
        resolve(tesseractDir, 'worker.min.js')
      );
      maybeCopy(resolve(dirname(require.resolve('tesseract.js/package.json')), 'dist/worker.min.js'), resolve(tesseractDir, 'worker.min.js'));
      try {
        const corePackageDir = dirname(require.resolve('tesseract.js-core/package.json'));
        readdirSync(corePackageDir)
          .filter((file) => /^tesseract-core.*\.wasm(\.js)?$/.test(file))
          .forEach((file) => {
            maybeCopy(resolve(corePackageDir, file), resolve(coreDir, file));
          });
      } catch {
        maybeCopyResolved('tesseract.js-core/tesseract-core.wasm.js', resolve(coreDir, 'tesseract-core.wasm.js'));
        maybeCopyResolved('tesseract.js-core/tesseract-core.wasm', resolve(coreDir, 'tesseract-core.wasm'));
      }
      maybeCopy(
        resolve(__dirname, 'node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz'),
        resolve(langDir, 'eng.traineddata.gz')
      );
      maybeCopy(
        resolve(__dirname, 'node_modules/@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz'),
        resolve(langDir, 'chi_sim.traineddata.gz')
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), copyPublicPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidePanel: resolve(__dirname, 'src/sidePanel/index.tsx'),
        dashboard: resolve(__dirname, 'src/dashboard/index.tsx'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: (chunkInfo) => `chunks/chunk-${safeChunkName(chunkInfo.name)}-[hash].js`,
        assetFileNames: '[name].[ext]',
        format: 'es',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
