// Rebuild the pinned LINEJS source for Workers without Node socket pools or disk storage.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const dependencies = createRequire(
  path.resolve(process.argv[3] || __dirname + "/../package.json"),
);
const esbuild = dependencies("esbuild");
const root = path.resolve(__dirname, "..");
const source = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (source.commit !== "4fc512ab8c19a2490ca73bb71777beb775ca3ae3")
  throw Error("Unexpected LINEJS revision");
const files = source.files;
files["packages/linejs/base/core/node_fetch.ts"] =
  "export function createNodeFetch(){ return async () => null; }";
files["packages/linejs/base/storage/mod.ts"] =
  'export { MemoryStorage } from "./memory.ts";';
// The adapter provides cancellable deadlines and clears every timer before idling.
// Avoid upstream AbortSignal.timeout timers preventing DO hibernation after a request.
for (const [name, text] of Object.entries(files)) {
  if (name.startsWith("packages/linejs/base/"))
    files[name] = text.replace(
      /AbortSignal\.timeout\((timeout|this\.client\.config\.timeout)\)/g,
      "undefined",
    );
}
const aliases = {
  "@evex/linejs-types": "packages/types/line_types.ts",
  "@evex/linejs-types/thrift": "packages/types/thrift.ts",
};
const thrift = path.dirname(dependencies.resolve("thrift"));
files["worker-thrift.ts"] = [
  "Thrift:thrift",
  "TBufferedTransport:buffered_transport",
  "TFramedTransport:framed_transport",
  "TCompactProtocol:compact_protocol",
  "TBinaryProtocol:binary_protocol",
]
  .map((x) => {
    const [name, file] = x.split(":");
    return `export {default as ${name}} from ${JSON.stringify(path.join(thrift, file + ".js"))};`;
  })
  .join("\n");
aliases.thrift = "worker-thrift.ts";
esbuild
  .build({
    entryPoints: ["packages/linejs/base/mod.ts"],
    outfile: root + "/vendor/linejs-worker.cjs",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    minify: true,
    plugins: [
      {
        name: "pinned-linejs-worker",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            const resolved =
              aliases[args.path] ||
              (args.path.startsWith(".")
                ? path.posix.normalize(
                    path.posix.join(
                      path.posix.dirname(args.importer),
                      args.path,
                    ),
                  )
                : args.path);
            if (files[resolved] !== undefined)
              return { path: resolved, namespace: "vfs" };
            if (args.path.startsWith("node:"))
              return { path: args.path, external: true };
            if (args.namespace === "vfs")
              return { path: dependencies.resolve(args.path) };
          });
          b.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => ({
            contents: files[args.path],
            loader: args.path.endsWith(".json") ? "json" : "ts",
          }));
        },
      },
    ],
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
