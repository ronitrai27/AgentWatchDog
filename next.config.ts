import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Temporal's client loads gRPC and protobuf files at run time; it is not bundled.
  serverExternalPackages: ["@temporalio/client"],
  experimental: {
    agentFeedback: true,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
