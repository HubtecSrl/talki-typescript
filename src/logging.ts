/**
 * Where the client writes what it does. Silent unless given a `logLevel` or
 * a `logger`.
 *
 * A request is logged by method and path only: never its query (`phone=`,
 * `q=`), headers or body, nor any key or token.
 */

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * `debug`: every answer, with its time. `info`: every retry and automatic
 * token renewal. `warn`: a renewal whose outcome is unknown. `error`: a
 * renewal refused for good. `off`: nothing.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, off: 100 };

/** A logger that drops what is below its level. */
export class Log {
  readonly #logger: Logger;
  readonly #rank: number;

  constructor(logger: Logger | undefined, level: LogLevel | undefined) {
    this.#logger = logger ?? console;
    const chosen = level ?? "off";
    if (!Object.hasOwn(RANK, chosen)) {
      throw new TypeError(`logLevel must be one of ${Object.keys(RANK).join(", ")}.`);
    }
    this.#rank = RANK[chosen];
  }

  enabled(level: Exclude<LogLevel, "off">): boolean {
    return RANK[level] >= this.#rank;
  }

  debug(message: () => string): void {
    if (this.enabled("debug")) this.#logger.debug(message());
  }

  info(message: string): void {
    if (this.enabled("info")) this.#logger.info(message);
  }

  warn(message: string): void {
    if (this.enabled("warn")) this.#logger.warn(message);
  }

  error(message: string): void {
    if (this.enabled("error")) this.#logger.error(message);
  }
}

export const SILENT = new Log(undefined, "off");
