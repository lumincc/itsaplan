// SPDX-License-Identifier: AGPL-3.0-only
import { setTimeout as sleep } from 'node:timers/promises';
import { UsageReader } from './agui';
import { answer } from './chat';
import type { ChatMessage, Client, Run } from './client';
import type { RunnerConfig } from './config';
import { execute } from './execute';
import { TranscriptRecorder } from './transcript';

// The task handlers the daemon loops in cli.ts run per claimed item, and the one-shot
// pass --once makes of the same feeds.

const HEARTBEAT_MS = 60_000;

type Log = (message: string) => void;

// A task can take much longer than the server's lease; without this it would be handed
// out again mid-flight.
export async function withHeartbeat<T>(
  log: Log,
  beat: () => Promise<void>,
  work: Promise<T>,
): Promise<T> {
  const timer = setInterval(() => {
    beat().catch((err) => log(`heartbeat failed: ${String(err)}`));
  }, HEARTBEAT_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

function taskOf(run: Run) {
  return {
    prompt: run.prompt,
    systemPrompt: run.systemPrompt,
    env: {
      ITSAPLAN_RUN_ID: String(run.id),
      ITSAPLAN_TRIGGER: run.trigger,
      ITSAPLAN_SYSTEM_PROMPT: run.systemPrompt,
      ITSAPLAN_ISSUE: run.issueIdentifier ?? '',
      ITSAPLAN_ISSUE_ID: run.issueId == null ? '' : String(run.issueId),
    },
  };
}

// Works one claimed run and reports its outcome. The return value is that outcome as
// it was reported, for a caller that maps it to an exit code; the daemon loop ignores
// it, the server being where a retry comes from.
export async function handle(
  config: RunnerConfig,
  client: Client,
  log: Log,
  run: Run,
): Promise<'success' | 'failed'> {
  const label = run.issueIdentifier ?? `run ${run.id}`;
  log(`${label}: started (${run.trigger})`);
  // Read as the command writes, not off the outcome: only the tail of the output is
  // kept, and the line carrying the counts can fall outside it.
  const usage = new UsageReader(config.outputFormat);
  const transcript = new TranscriptRecorder(
    config.outputFormat,
    (segment) => client.runTranscript(run.id, { harness: config.outputFormat, ...segment }),
    (message) => log(`${label}: ${message}`),
    run.transcriptSeq,
  );
  try {
    const outcome = await withHeartbeat(
      log,
      () => client.heartbeat(run.id),
      execute(config, taskOf(run), {
        onData: (chunk) => {
          usage.write(chunk);
          transcript.write(chunk);
        },
      }),
    );
    usage.end();
    await client.report(run.id, { ...outcome, usage: usage.value() });
    log(`${label}: ${outcome.status}${outcome.error ? ` — ${outcome.error}` : ''}`);
    return outcome.status;
  } catch (err) {
    // The command itself never throws here; this is the runner failing to run or
    // report it. Reporting the failure keeps the run from being retried blindly.
    const message = err instanceof Error ? err.message : String(err);
    log(`${label}: runner error — ${message}`);
    await client.report(run.id, { status: 'failed', error: message }).catch(() => {});
    return 'failed';
  } finally {
    // The last segment may carry the session the run used; what was written before a
    // failure is worth keeping too. A failed upload is logged by the recorder and
    // changes nothing above.
    await transcript.close();
  }
}

// The stop the member pressed comes back on whichever call the runner was making: the
// events report while the command writes, the heartbeat while it is silent. Both abort
// the same controller, which kills the command.
export async function handleChat(
  config: RunnerConfig,
  client: Client,
  log: Log,
  message: ChatMessage,
): Promise<'success' | 'failed' | 'stopped'> {
  log(`chat ${message.id}: answering`);
  const stop = new AbortController();
  try {
    const outcome = await withHeartbeat(
      log,
      async () => {
        if (await client.chatHeartbeat(message.id)) stop.abort();
      },
      answer(config, client, message, stop),
    );
    log(`chat ${message.id}: ${stop.signal.aborted ? 'stopped' : 'answered'}`);
    return outcome;
  } catch (err) {
    // Without a reported failure the chat waits for an answer that is no longer coming.
    // A stopped answer is already closed, so nothing is reported for it.
    if (!stop.signal.aborted) {
      const text = err instanceof Error ? err.message : String(err);
      log(`chat ${message.id}: runner error — ${text}`);
      await client.chatResult(message.id, { status: 'failed', error: text }).catch(() => {});
      return 'failed';
    }
    return 'stopped';
  }
}

// A single pass over the feeds: a due queued run first, and when none is due a chat
// message waited for up to `waitMs` — each claim call holds on the server for most of
// that on its own, the gap below only spacing out the calls of an instance that answers
// an empty claim at once. What the pass returns is for an exit code: 'idle' when
// nothing was claimed, the task's own outcome otherwise. itsaplan stays the retry
// authority either way; the code is for the log a CI job shows, never a reason to run
// the pass again.
const ONCE_CLAIM_GAP_MS = 1000;

export async function runOnce(
  config: RunnerConfig,
  client: Client,
  log: Log,
  waitMs = 0,
): Promise<'idle' | 'success' | 'failed'> {
  const run = await client.claim();
  if (run) return (await handle(config, client, log, run)) === 'success' ? 'success' : 'failed';
  if (waitMs <= 0) return 'idle';
  const deadline = Date.now() + waitMs;
  for (;;) {
    const message = await client.claimChat();
    if (message) {
      const outcome = await handleChat(config, client, log, message);
      return outcome === 'failed' ? 'failed' : 'success';
    }
    const left = deadline - Date.now();
    if (left <= 0) return 'idle';
    await sleep(Math.min(left, ONCE_CLAIM_GAP_MS));
  }
}
