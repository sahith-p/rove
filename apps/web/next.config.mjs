import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import('next').NextConfig} */
export default {
  // Monorepo: trace from the repo root, and ship the bundled fonts with every server function (OG images read them
  // with fs at runtime, which the tracer can't see).
  outputFileTracingRoot: root,
  outputFileTracingIncludes: { "/**": ["../../packages/imessage-apps/assets/fonts/**"] },
  transpilePackages: ["@rove/shared", "@rove/db", "@rove/imessage-apps", "@rove/xrpl"],
  // @rove/shared re-exports tokens.ts (node:crypto). Client bundles never call it, so stub it out in the browser build
  // instead of failing with `UnhandledSchemeError: Reading from "node:crypto"`.
  webpack(config, { isServer, webpack }) {
    if (!isServer) {
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:crypto$/, (r) => { r.request = "crypto"; }));
      config.resolve.fallback = { ...config.resolve.fallback, crypto: false };
    }
    return config;
  },
};
