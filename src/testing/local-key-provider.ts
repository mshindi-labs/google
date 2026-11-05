import { randomBytes } from "node:crypto";
import { StaticKeyProvider } from "../core/crypto/static-key-provider.js";
import { InvalidConfigError } from "../core/errors.js";

/** Dev/test key provider (kid `static:local`). Refuses NODE_ENV=production. */
export class LocalKeyProvider extends StaticKeyProvider {
  constructor(opts: { key?: Uint8Array; allowInProduction?: boolean } = {}) {
    if (process.env.NODE_ENV === "production" && !opts.allowInProduction) {
      throw new InvalidConfigError(
        "LocalKeyProvider must not be used in production (pass allowInProduction: true to override)",
      );
    }
    super({ keys: { local: opts.key ?? randomBytes(32) }, current: "local" });
  }
}
