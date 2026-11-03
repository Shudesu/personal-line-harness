const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
if (!process.argv[2]) throw new Error('Pass source-vfs.json from fetch-runtime-source.py');
const { files } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const aliases = {
  '@evex/linejs-types': 'packages/types/line_types.ts',
  '@evex/linejs-types/thrift': 'packages/types/thrift.ts',
};
esbuild
  .build({
    entryPoints: ['packages/linejs/base/mod.ts'],
    outfile: root + '/vendor/linejs-runtime.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    plugins: [
      {
        name: 'virtual-linejs',
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            let resolved =
              aliases[args.path] ||
              (args.path.startsWith('.')
                ? path.posix.normalize(
                    path.posix.join(path.posix.dirname(args.importer), args.path),
                  )
                : args.path);
            if (files[resolved] !== undefined) return { path: resolved, namespace: 'vfs' };
            if (args.path.startsWith('node:')) return { path: args.path, external: true };
            if (args.namespace === 'vfs')
              return { path: require.resolve(args.path, { paths: [root] }) };
          });
          b.onLoad({ filter: /.*/, namespace: 'vfs' }, (args) => ({
            contents: files[args.path],
            loader: args.path.endsWith('.json') ? 'json' : 'ts',
          }));
        },
      },
    ],
  })
  .then(() => console.log('bundle ready'))
  .catch(() => process.exit(1));
