#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, RequestError, type ChatMessage, type Run } from './client';
import { loadConfig, type RunnerConfig } from './config';
import { handle, handleChat, runOnce } from './tasks';

// The runner holds no state — the queue is the server's — so stopping it mid-task only
// means that task's lease expires and another runner picks it up.
//
// Two feeds are drained side by side per agent: triggered runs, polled, and chat
// messages, claimed by a call that waits on the server for one. A config that lists
// several agents runs that pair for each of them, in the one process.
//
// `--once` turns the loops off: one claim pass, one task, one exit code (see tasks.ts
// and the README for what the code says — itsaplan stays the retry authority).

const ERROR_BACKOFF_MS = 5_000;

type Log = (message: string) => void;

function prefixOf(name: string): string {
  return name ? `[itsaplan-runner ${name}]` : '[itsaplan-runner]';
}

function log(message: string): void {
  console.log(`${prefixOf('')} ${message}`);
}

// Both feeds are drained the same way; they differ in what asking for work means — a poll
// for runs, a waiting claim for chat. `onEmpty` waits before asking again, and returns
// false to give the feed up entirely.
async function drain<T>(
  state: { stopping: boolean },
  log: Log,
  concurrency: number,
  take: () => Promise<T | null>,
  // The handler's return value (the task's reported outcome) is for --once's exit
  // code; the daemon loop drops it.
  run: (item: T) => Promise<unknown>,
  onEmpty: () => Promise<boolean>,
): Promise<void> {
  const active = new Set<Promise<unknown>>();
  let done = false;
  while (!state.stopping && !done) {
    if (active.size >= concurrency) {
      await Promise.race(active);
      continue;
    }
    let item: T | null = null;
    try {
      item = await take();
    } catch (err) {
      // A key the server refuses will be refused just as much on the next poll, so
      // stop instead of hiding it in a log line every few seconds.
      if (err instanceof RequestError && (err.status === 401 || err.status === 403)) throw err;
      log(`claim failed: ${String(err)}`);
      // Backing off here and not in onEmpty: a claim that waits on the server returns
      // instantly when it fails, and retrying it at that rate would hammer both sides.
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    if (!item) {
      done = !(await onEmpty());
      continue;
    }
    const task = run(item).finally(() => active.delete(task));
    active.add(task);
  }
  await Promise.all(active);
}

function parseArgv(argv: string[]): {
  configPath?: string;
  agent?: string;
  args: string[];
  once: boolean;
  waitMs: number;
} {
  const parsed: {
    configPath?: string;
    agent?: string;
    args: string[];
    once: boolean;
    waitMs: number;
  } = { args: [], once: false, waitMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      parsed.args = argv.slice(i + 1);
      break;
    }
    if (arg === '--agent') {
      const value = argv[++i];
      if (value === undefined) throw new Error('--agent needs a value');
      parsed.agent = value;
      continue;
    }
    if (arg.startsWith('--agent=')) {
      parsed.agent = arg.slice('--agent='.length);
      continue;
    }
    if (arg === '--once') {
      parsed.once = true;
      continue;
    }
    if (arg === '--wait') {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) throw new Error('--wait needs ms');
      parsed.waitMs = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith('--wait=')) {
      const value = arg.slice('--wait='.length);
      if (!/^\d+$/.test(value)) throw new Error('--wait needs ms');
      parsed.waitMs = Number.parseInt(value, 10);
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    parsed.configPath ??= arg;
  }
  return parsed;
}

// Everything one agent needs: the two feeds, until the runner is stopped or the server
// refuses its key.
async function serve(state: { stopping: boolean }, config: RunnerConfig): Promise<void> {
  const client = new Client(config);
  const prefix = prefixOf(config.name);
  const log: Log = (message) => console.log(`${prefix} ${message}`);
  log(
    `running ${config.agent ?? 'the configured command'}, polling ${config.url} every ` +
      `${config.pollIntervalMs}ms, up to ${config.concurrency} at once`,
  );
  let chatSupported = true;
  await Promise.all([
    drain<Run>(
      state,
      log,
      config.concurrency,
      () => client.claim(),
      (run) => handle(config, client, log, run),
      async () => {
        await sleep(config.pollIntervalMs);
        return true;
      },
    ),
    // The claim already waits on the server, so an empty one means the wait ran out and
    // asking again is the whole delay there is. An instance too old to have the feed
    // answers 404, and that loop ends rather than asking forever.
    drain<ChatMessage>(
      state,
      log,
      config.concurrency,
      async () => {
        try {
          return await client.claimChat();
        } catch (err) {
          if (err instanceof RequestError && err.status === 404) {
            log('this instance has no chat feed — only queued runs will be answered');
            chatSupported = false;
            return null;
          }
          throw err;
        }
      },
      (message) => handleChat(config, client, log, message),
      () => Promise.resolve(chatSupported),
    ),
  ]);
}

// One claim pass per configured agent, in the config's order. The exit code follows the
// pass: 0 for a task that succeeded or a feed with nothing due, 1 for a task that failed
// or an agent the server refused — nothing more, because a retry is the server's to
// order, not the caller's.
async function serveOnce(config: RunnerConfig, waitMs: number): Promise<void> {
  const log: Log = (message) => console.log(`${prefixOf(config.name)} ${message}`);
  const outcome = await runOnce(config, new Client(config), log, waitMs);
  log(`--once: ${outcome}`);
  if (outcome === 'failed') process.exit(1);
}

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));
  const configPath =
    cli.configPath ?? process.env.ITSAPLAN_RUNNER_CONFIG ?? './itsaplan-runner.json';
  const configs = await loadConfig(configPath, { agent: cli.agent, args: cli.args });
  const state = { stopping: false };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      // The commands run in their own process groups, so quitting now leaves them running
      // with nobody to report their result: the lease expires and the run is handed out
      // again.
      if (state.stopping) {
        log('quitting now — the commands in flight keep running, their runs are retried');
        process.exit(1);
      }
      state.stopping = true;
      log('stopping — finishing the tasks in flight, press again to quit now');
    });
  }

  if (cli.once) {
    for (const config of configs) await serveOnce(config, cli.waitMs);
    return;
  }

  // One agent's key being refused says nothing about the others, so it does not take them
  // down with it; the runner still exits non-zero once they are all finished.
  const served = await Promise.all(
    configs.map((config) =>
      serve(state, config).then(
        () => true,
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`${prefixOf(config.name)} stopped — ${message}`);
          return false;
        },
      ),
    ),
  );
  if (served.includes(false)) process.exit(1);
}

main().catch((err) => {
  console.error(`[itsaplan-runner] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
