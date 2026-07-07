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

      const ortDir = resolve(distDir, 'paddleocr/ort');
      mkdirSync(ortDir, { recursive: true });

      const maybeCopy = (src: string, dest: string) => {
        if (existsSync(src)) copyFileSync(src, dest);
      };

      try {
        const ortDistDir = dirname(require.resolve('onnxruntime-web'));
        readdirSync(ortDistDir)
          .filter((file) => /^ort-wasm.*\.(wasm|mjs)$/.test(file))
          .forEach((file) => {
            maybeCopy(resolve(ortDistDir, file), resolve(ortDir, file));
          });
      } catch {
        const ortDistDir = dirname(require.resolve('onnxruntime-web/wasm'));
        const maybeCopyResolved = (specifier: string, dest: string) => {
          try {
            maybeCopy(resolve(ortDistDir, specifier), dest);
          } catch {
            // Optional dependency layout can differ between package managers.
          }
        };
        [
          'ort-wasm.wasm',
          'ort-wasm-simd.wasm',
          'ort-wasm-threaded.wasm',
          'ort-wasm-simd-threaded.wasm',
        ].forEach((file) => {
          maybeCopyResolved(file, resolve(ortDir, file));
        });
      }

      const requiredModels = [
        'PP-OCRv5_mobile_det.tar',
        'PP-OCRv5_mobile_rec.tar',
      ];
      requiredModels.forEach((file) => {
        const modelPath = resolve(distDir, 'paddleocr/models', file);
        if (!existsSync(modelPath)) {
          throw new Error(`PaddleOCR model asset missing: public/paddleocr/models/${file}`);
        }
      });
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
        paddleocrSandbox: resolve(__dirname, 'src/sidePanel/utils/paddleocrSandbox.ts'),
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
