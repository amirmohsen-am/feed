import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: __dirname,
  },
  // Don't bundle Google Cloud SDKs / grpc — Turbopack mangles their native
  // bits and gRPC calls fail with empty Metadata at runtime.
  serverExternalPackages: [
    "@google-cloud/secret-manager",
    "@google-cloud/cloud-sql-connector",
    "@google-cloud/aiplatform",
    "@google-cloud/storage",
    "@grpc/grpc-js",
    "google-gax",
    "pg",
    "pg-native",
  ],
  allowedDevOrigins: ["192.168.*.*", "10.*.*.*", "172.16.*.*"],
};

export default nextConfig;
