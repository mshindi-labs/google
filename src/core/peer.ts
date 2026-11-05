import { MissingPeerDependencyError } from "./errors.js";

/**
 * Dynamically imports an optional peer dependency. `installName` is the
 * package to suggest in the `npm i` hint when it differs from the specifier.
 */
export async function loadPeer<T>(
  specifier: string,
  installName: string = specifier,
): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (err) {
    const { code, message } = (err ?? {}) as {
      code?: unknown;
      message?: unknown;
    };
    const notFound =
      code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
    // Only blame the peer when the unresolved name is the peer itself, not a
    // module the peer failed to resolve internally.
    const missing =
      typeof message === "string"
        ? /Cannot find (?:package|module) '([^']+)'/.exec(message)?.[1]
        : undefined;
    if (
      notFound &&
      missing !== undefined &&
      (specifier === missing || specifier.startsWith(`${missing}/`))
    ) {
      throw new MissingPeerDependencyError(installName, { cause: err });
    }
    throw err;
  }
}
