/** @type {import('next').NextConfig} */
export default {
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
