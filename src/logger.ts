// Compatibility shim: wraps the v2 log module to accept pino-style (data, msg) argument order.
// Used by src/db.ts and src/channels/whatsapp.ts which predate the v2 log module.
import { log } from './log.js';

type LogData = Record<string, unknown>;

function adaptArgs(
  msgOrData: string | LogData,
  msgArg?: string,
): [string, LogData | undefined] {
  if (typeof msgOrData === 'string') return [msgOrData, undefined];
  return [msgArg ?? '', msgOrData];
}

export const logger = {
  debug: (a: string | LogData, b?: string) => {
    const [m, d] = adaptArgs(a, b);
    log.debug(m, d);
  },
  info: (a: string | LogData, b?: string) => {
    const [m, d] = adaptArgs(a, b);
    log.info(m, d);
  },
  warn: (a: string | LogData, b?: string) => {
    const [m, d] = adaptArgs(a, b);
    log.warn(m, d);
  },
  error: (a: string | LogData, b?: string) => {
    const [m, d] = adaptArgs(a, b);
    log.error(m, d);
  },
  fatal: (a: string | LogData, b?: string) => {
    const [m, d] = adaptArgs(a, b);
    log.fatal(m, d);
  },
};
