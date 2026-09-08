import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";

import { build, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const WEBPACK_COMMENT_RE = /\/\*\s*webpack[\s\S]*?\*\//g;

const RUNTIME = {
  wasm: "binary/client/client_bg.wasm",
  wasmLegacy: "binary/client_legacy/client_bg.wasm",
  decodeWorker: "decodeWorker/decode.worker.js",
  lynxBg: "background/index.js",
} as const;

function webCoreRoot(): string {
  return path.dirname(require.resolve("@lynx-js/web-core/package.json"));
}

function stripWebpackComments(): Plugin {
  return {
    name: "strip-lynx-web-core-webpack-comments",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@lynx-js/web-core") || !code.includes("webpack")) {
        return;
      }
      const next = code.replace(WEBPACK_COMMENT_RE, "");
      if (next === code) {
        return;
      }
      return { code: next, map: null };
    },
  };
}

function rewriteNewUrl(code: string, relative: string, absolute: string): string {
  const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    String.raw`new URL\(\s*(?:/\*[\s\S]*?\*/\s*)*(['"\`])${escaped}\1\s*,\s*import\.meta\.url\s*\)`,
    "g",
  );
  return code.replace(re, `new URL(/* @vite-ignore */ "${absolute}", import.meta.url)`);
}

function rewriteToRuntimePaths(code: string): string {
  let next = code;
  next = rewriteNewUrl(next, "../../binary/client/client_bg.wasm", `/${RUNTIME.wasm}`);
  next = rewriteNewUrl(next, "../../binary/client_legacy/client_bg.wasm", `/${RUNTIME.wasmLegacy}`);
  next = rewriteNewUrl(next, "../decodeWorker/decode.worker.js", `/${RUNTIME.decodeWorker}`);
  next = rewriteNewUrl(next, "../background/index.js", `/${RUNTIME.lynxBg}`);
  return next;
}

async function bundleWorker(entry: string, root: string): Promise<string> {
  const result = await build({
    configFile: false,
    root,
    publicDir: false,
    logLevel: "error",
    plugins: [stripWebpackComments()],
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      lib: {
        entry,
        formats: ["es"],
        fileName: () => "worker.js",
      },
      rolldownOptions: {
        output: {
          codeSplitting: false,
        },
      },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!("output" in output)) {
    throw new Error(`worker bundle for ${entry} did not emit output`);
  }
  const entryChunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
  if (entryChunk == null || entryChunk.type !== "chunk") {
    throw new Error(`worker bundle for ${entry} produced no entry chunk`);
  }
  return entryChunk.code;
}

function pathnameOf(req: IncomingMessage): string {
  const url = req.url ?? "/";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

export function lynxWebCoreRuntimeAssets(showcaseRoot: string): Plugin {
  const root = webCoreRoot();
  const files = {
    wasm: path.join(root, RUNTIME.wasm),
    wasmLegacy: path.join(root, RUNTIME.wasmLegacy),
    decodeEntry: path.join(root, "dist/client/decodeWorker/decode.worker.js"),
    bgEntry: path.join(root, "dist/client/background/index.js"),
  };

  let decodeCode: string | undefined;
  let bgCode: string | undefined;
  let workers: Promise<void> | undefined;

  async function ensureWorkers(): Promise<void> {
    if (decodeCode != null && bgCode != null) {
      return;
    }
    workers ??= (async () => {
      const [decode, bg] = await Promise.all([
        bundleWorker(files.decodeEntry, showcaseRoot),
        bundleWorker(files.bgEntry, showcaseRoot),
      ]);
      decodeCode = decode;
      bgCode = bg;
    })();
    await workers;
  }

  function serveRuntime(
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void {
    const pathname = pathnameOf(req);
    if (pathname === `/${RUNTIME.wasm}`) {
      const body = fs.readFileSync(files.wasm);
      res.setHeader("Content-Type", "application/wasm");
      res.setHeader("Content-Length", String(body.byteLength));
      res.end(body);
      return;
    }
    if (pathname === `/${RUNTIME.wasmLegacy}`) {
      const body = fs.readFileSync(files.wasmLegacy);
      res.setHeader("Content-Type", "application/wasm");
      res.setHeader("Content-Length", String(body.byteLength));
      res.end(body);
      return;
    }
    if (pathname === `/${RUNTIME.decodeWorker}` || pathname === `/${RUNTIME.lynxBg}`) {
      ensureWorkers()
        .then(() => {
          const body = pathname === `/${RUNTIME.decodeWorker}` ? decodeCode : bgCode;
          if (body == null) {
            next(new Error(`missing bundled worker for ${pathname}`));
            return;
          }
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Content-Length", String(Buffer.byteLength(body)));
          res.end(body);
        })
        .catch(next);
      return;
    }
    next();
  }

  return {
    name: "lynx-web-core-runtime-assets",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@lynx-js/web-core")) {
        return;
      }
      const stripped = code.includes("webpack") ? code.replace(WEBPACK_COMMENT_RE, "") : code;
      const next = rewriteToRuntimePaths(stripped);
      if (next === code) {
        return;
      }
      return { code: next, map: null };
    },
    async buildStart() {
      await ensureWorkers();
      this.emitFile({
        type: "asset",
        fileName: RUNTIME.wasm,
        source: fs.readFileSync(files.wasm),
      });
      this.emitFile({
        type: "asset",
        fileName: RUNTIME.wasmLegacy,
        source: fs.readFileSync(files.wasmLegacy),
      });
      this.emitFile({
        type: "asset",
        fileName: RUNTIME.decodeWorker,
        source: decodeCode ?? "",
      });
      this.emitFile({
        type: "asset",
        fileName: RUNTIME.lynxBg,
        source: bgCode ?? "",
      });
    },
    configureServer(server) {
      server.middlewares.use(serveRuntime);
    },
    configurePreviewServer(server) {
      return () => {
        server.middlewares.use(serveRuntime);
      };
    },
  };
}
