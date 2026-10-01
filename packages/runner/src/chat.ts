// SPDX-License-Identifier: AGPL-3.0-only
import { AnswerStream } from './agui';
import type { ChatMessage, Client } from './client';
import type { RunnerConfig } from './config';
import { execute, type Outcome } from './execute';
import { TranscriptRecorder } from './transcript';

// The command is the same one that handles a queued run; what differs is that its output
// is reported while it is still being written, so the person waiting in the chat reads
// the answer as it appears. What it returns is the outcome as it was reported, the
// handler's exit-code mapping in tasks.ts being its only reader.
//
// A thread with no session yet is answered by a command started without one, and the
// session it reports is sent with the first batch of events after it is named, which
// binds the thread.
//
// A thread bound to a session is answered by resuming it. A resume that the CLI cannot
// do — the session file is gone, another machine answered the thread — is retried once
// as a fresh session over the framed history the claim sent along, with a note in the
// answer that this happened; the session that retry starts rebinds the thread, the one
// it replaced being dead.
//
// `stop` is aborted when the server says the member stopped the answer — on the events
// report while the command is writing, on the heartbeat while it is silent. The server
// has already closed the answer by then, so the command is killed and nothing more is
// reported for it.

// Often enough to read as typing, rarely enough that a chatty command does not become a
// request per line.
const FLUSH_MS = 500;

export async function answer(
  config: RunnerConfig,
  client: Client,
  message: ChatMessage,
  stop: AbortController,
): Promise<'success' | 'failed' | 'stopped'> {
  // Reported once: repeating it on every batch is a field the server has to ignore.
  let reported = message.sessionId !== null;
  // True while the session a report carries replaces a dead one rather than filling an
  // empty thread.
  let rebind = false;
  const stream: AnswerStream = new AnswerStream(
    config.outputFormat,
    message.threadId,
    String(message.id),
    async (events) => {
      const started = reported ? undefined : (stream.startedSession() ?? undefined);
      // `rebind` says the session this report carries replaces a dead one; it is spent
      // on the first report that carries a session at all.
      const replaces = started != null && rebind;
      if (started != null) {
        reported = true;
        rebind = false;
      }
      if (await client.chatEvents(message.id, events, started, replaces)) stop.abort();
    },
  );
  // A flush that fails is not fatal: the next one carries what it left behind.
  const flushing = setInterval(() => {
    void stream.flush().catch(() => {});
  }, FLUSH_MS);
  const transcript = new TranscriptRecorder(
    config.outputFormat,
    (segment) => client.chatTranscript(message.id, { harness: config.outputFormat, ...segment }),
    (text) => console.log(`[itsaplan-runner] chat ${message.id}: ${text}`),
    message.transcriptSeq,
  );

  const taskOf = (fresh: boolean) => ({
    prompt: fresh ? message.freshPrompt : message.prompt,
    systemPrompt: fresh ? message.freshSystemPrompt : message.systemPrompt,
    sessionId: fresh ? null : message.sessionId,
    env: {
      ITSAPLAN_TRIGGER: 'chat',
      ITSAPLAN_SYSTEM_PROMPT: fresh ? message.freshSystemPrompt : message.systemPrompt,
      ITSAPLAN_THREAD_ID: message.threadId,
      ITSAPLAN_MESSAGE_ID: String(message.id),
      ITSAPLAN_SESSION_ID: fresh ? '' : (message.sessionId ?? ''),
    },
  });
  const runCommand = (fresh: boolean) =>
    execute(config, taskOf(fresh), {
      onData: (chunk) => {
        stream.write(chunk);
        transcript.write(chunk);
      },
      signal: stop.signal,
    });

  let outcome: Outcome;
  try {
    outcome = await runCommand(false);
    if (outcome.status === 'failed' && message.sessionId !== null && !stop.signal.aborted) {
      stream.note(
        'The previous session could not be resumed; the history was rebuilt from the stored conversation.',
      );
      stream.resetSession();
      reported = false;
      rebind = true;
      outcome = await runCommand(true);
    }
  } finally {
    clearInterval(flushing);
    // The last segment may name the session the answer ended on, and what was written
    // before a failure is worth keeping too. A failed upload is logged by the recorder
    // and changes nothing reported below.
    await transcript.close();
  }
  if (stop.signal.aborted) return 'stopped';
  // The context size is read after the stream is closed, which is where the last line of
  // the output is parsed. An answer that failed reports it too: what the command read
  // before it broke is still the size of its session's context.
  if (outcome.status === 'success') {
    await stream.finish(outcome.output);
    await client.chatResult(message.id, { status: 'success', usage: stream.contextUsage() });
    return 'success';
  }
  const error = outcome.error ?? 'The command failed';
  await stream.fail(error, outcome.output);
  await client.chatResult(message.id, { status: 'failed', error, usage: stream.contextUsage() });
  return 'failed';
}
