import { invoke } from '@tauri-apps/api/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

interface RendererLogEntry {
  timestamp: number;
  level: LogLevel;
  subsystem: string;
  event: string;
  message: string;
  fields: unknown;
}

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_SIZE = 100;
const MAX_QUEUE_SIZE = 1_000;
const MAX_STRING_LENGTH = 16_384;
const MAX_SERIALIZE_DEPTH = 6;
const CONSOLE_STYLE_PATTERN = /^(?:\s*(?:color|background|font|padding|border|display|margin|line-height)\s*:)/i;
const SUBSYSTEM_PATTERN = /^\s*((?:\[[^\]]+\])+)/;
const PERFORMANCE_DURATION_PATTERN = /:\s*(\d+(?:\.\d+)?)\s*ms\s*$/i;
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|passkey|signature|authkey|rsskey|download[_-]?key|magnet)/i;
const REDACTED = '<redacted>';

const originalConsole = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let queue: RendererLogEntry[] = [];
let flushTimer: number | null = null;
let flushInProgress = false;
let droppedCount = 0;
let initialized = false;
let bridgeFailureReported = false;

function redactText(value: string): string {
  if (value.trimStart().toLowerCase().startsWith('magnet:?')) return 'magnet:?<redacted>';
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s"'},\]]+@/gi, `$1${REDACTED}@`)
    .replace(/(bearer\s+)[^\s,}\]]+/gi, `$1${REDACTED}`)
    .replace(/(api_?key|x-api-key|access_token|refresh_token|security_token|token|password|secret|authorization|cookie|set-cookie|signature|credential|key-pair-id|policy|sig|passkey|authkey|rsskey|download_key)(=|%3d|:)\s*[^&,\s"'}\]]+/gi, `$1$2${REDACTED}`);
}

function serializeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  key = '',
): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value ?? null;
  }
  if (typeof value === 'string') return redactText(value.slice(0, MAX_STRING_LENGTH));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (depth >= MAX_SERIALIZE_DEPTH) return '[Max depth]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    const error = value as Error & { cause?: unknown };
    return {
      name: error.name,
      message: redactText(error.message.slice(0, MAX_STRING_LENGTH)),
      stack: error.stack ? redactText(error.stack.slice(0, MAX_STRING_LENGTH)) : undefined,
      cause: serializeValue(error.cause, seen, depth + 1, 'cause'),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => serializeValue(item, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 100)) {
    try {
      output[childKey] = serializeValue(childValue, seen, depth + 1, childKey);
    } catch (error) {
      output[childKey] = `[Serialization failed: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  return output;
}

function subsystemFromMessage(message: string): string {
  const prefix = message.match(SUBSYSTEM_PATTERN)?.[1];
  if (!prefix) return 'renderer';
  const names = [...prefix.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
  return names
    .join('.')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '_')
    .replace(/^_|_$/g, '') || 'renderer';
}

function normalizeConsoleArguments(args: unknown[]): { message: string; fields: unknown } {
  if (typeof args[0] !== 'string') {
    return { message: 'Renderer console event', fields: { args: serializeValue(args) } };
  }

  const format = args[0];
  const styleCount = (format.match(/%c/g) || []).length;
  const remaining = args.slice(1);
  let removedStyles = 0;
  while (
    removedStyles < styleCount
    && typeof remaining[0] === 'string'
    && CONSOLE_STYLE_PATTERN.test(remaining[0])
  ) {
    remaining.shift();
    removedStyles += 1;
  }
  const message = redactText(format.replace(/%c/g, '').slice(0, MAX_STRING_LENGTH));
  const fields: LogFields = {};
  if (remaining.length > 0) fields.args = serializeValue(remaining);
  if (message.trimStart().startsWith('[Performance]')) {
    const duration = message.match(PERFORMANCE_DURATION_PATTERN)?.[1];
    if (duration !== undefined) fields.duration_ms = Number(duration);
  }
  return {
    message,
    fields,
  };
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    void flushRendererLogs();
  }, FLUSH_INTERVAL_MS);
}

function enqueue(entry: RendererLogEntry): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
    droppedCount += 1;
  }
  queue.push(entry);
  scheduleFlush();
}

function droppedEvent(): RendererLogEntry | null {
  if (droppedCount === 0) return null;
  const count = droppedCount;
  droppedCount = 0;
  return {
    timestamp: Date.now(),
    level: 'warn',
    subsystem: 'logging',
    event: 'logger.renderer_events_dropped',
    message: 'Renderer logging queue overflowed',
    fields: { dropped_count: count },
  };
}

export async function flushRendererLogs(): Promise<void> {
  if (flushInProgress || (queue.length === 0 && droppedCount === 0)) return;
  flushInProgress = true;
  const dropped = droppedEvent();
  const batch = queue.splice(0, MAX_BATCH_SIZE);
  if (dropped) batch.unshift(dropped);
  try {
    await invoke('write_renderer_log_batch', { entries: batch });
    bridgeFailureReported = false;
  } catch (error) {
    queue = [...batch, ...queue].slice(-MAX_QUEUE_SIZE);
    if (!bridgeFailureReported) {
      originalConsole.warn('[Logging] Renderer log bridge unavailable:', error);
      bridgeFailureReported = true;
    }
  } finally {
    flushInProgress = false;
    if (queue.length > 0 || droppedCount > 0) scheduleFlush();
  }
}

function write(level: LogLevel, event: string, message: string, fields: LogFields = {}, subsystem = 'renderer'): void {
  enqueue({
    timestamp: Date.now(),
    level,
    subsystem,
    event,
    message: redactText(message.slice(0, MAX_STRING_LENGTH)),
    fields: serializeValue(fields),
  });
}

export const logger = {
  debug: (event: string, message: string, fields?: LogFields, subsystem?: string) => write('debug', event, message, fields, subsystem),
  info: (event: string, message: string, fields?: LogFields, subsystem?: string) => write('info', event, message, fields, subsystem),
  warn: (event: string, message: string, fields?: LogFields, subsystem?: string) => write('warn', event, message, fields, subsystem),
  error: (event: string, message: string, fields?: LogFields, subsystem?: string) => write('error', event, message, fields, subsystem),
};

export function initializeRendererLogger(): void {
  if (
    initialized
    || typeof window === 'undefined'
    || typeof window.addEventListener !== 'function'
  ) return;
  initialized = true;
  const install = (level: LogLevel, original: (...args: unknown[]) => void) => (...args: unknown[]) => {
    original(...args);
    const normalized = normalizeConsoleArguments(args);
    enqueue({
      timestamp: Date.now(),
      level: level === 'info' ? 'info' : level,
      subsystem: subsystemFromMessage(normalized.message),
      event: 'console.message',
      message: normalized.message,
      fields: normalized.fields,
    });
  };
  console.debug = install('debug', originalConsole.debug);
  console.log = install('info', originalConsole.log);
  console.info = install('info', originalConsole.info);
  console.warn = install('warn', originalConsole.warn);
  console.error = install('error', originalConsole.error);
  window.addEventListener('pagehide', () => void flushRendererLogs());
  logger.info('logger.renderer_initialized', 'Renderer structured logging initialized', {
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
  }, 'logging');
}

export const rendererLoggerTestUtils = {
  normalizeConsoleArguments,
  serializeValue,
  subsystemFromMessage,
};

initializeRendererLogger();
