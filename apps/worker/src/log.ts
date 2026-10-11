// Readable one-line logs for the demo laptop: `14:03:07 INFO  [worker:merchants] merchant live {"merchantId":"ahseng"}`.
// Never log request bodies, seeds, tokens or bank numbers: pass ids and statuses only.

export type LogFields = Record<string, unknown>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Same sink, narrower scope: `log.child("settle")` → `[worker:settle]`. */
  child(scope: string): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  /** Lowest level printed. Default: LOG_LEVEL env or "info". "silent" prints nothing (tests). */
  level?: LogLevel | "silent";
  /** Where lines go. Default: console (warn/error → stderr). */
  sink?: (level: LogLevel, line: string) => void;
}

function serialize(fields: LogFields | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return "";
  const plain: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    plain[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 4).join(" | ") } : v;
  }
  try {
    return " " + JSON.stringify(plain);
  } catch {
    return " [unserializable fields]";
  }
}

const consoleSink = (level: LogLevel, line: string) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export function createLogger(scope = "worker", opts: LoggerOptions = {}): Logger {
  const levelOpt = opts.level ?? ((process.env.LOG_LEVEL as LogLevel | undefined) || "info");
  const min = levelOpt === "silent" ? Infinity : (ORDER[levelOpt] ?? ORDER.info);
  const sink = opts.sink ?? consoleSink;

  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    const time = new Date().toISOString().slice(11, 19);
    sink(level, `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${serialize(fields)}`);
  };

  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (sub) => createLogger(`${scope}:${sub}`, opts),
  };
}
