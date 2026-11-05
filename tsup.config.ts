import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    core: "src/core/index.ts",
    gmail: "src/gmail/index.ts",
    postgres: "src/postgres/index.ts",
    testing: "src/testing/index.ts",
  },
  format: ["cjs", "esm"],
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  external: [
    "google-auth-library",
    "@googleapis/gmail",
    "nodemailer",
    "html-to-text",
    "mailparser",
    "@google-cloud/kms",
    "@aws-sdk/client-kms",
  ],
});
