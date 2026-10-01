// SPDX-License-Identifier: AGPL-3.0-only
import type { OutputFormat } from './config';

// Records the raw output of one task as it is written, before any parsing: what the
// coding agent printed, in the order it printed it. Segments are handed to `upload`
// whole lines at a time, so the server stores exactly what the CLI wrote. A failed
// upload is logged and left behind — a lost segment never fails the task it records.

// A segment closes once its lines reach this many bytes: big enough that a request is
// not made per line, small enough that a viewer loads one without waiting.
const SEGMENT_BYTES = 1024 * 1024;

// The server refuses a segment over this many lines (SEGMENT_MAX_LINES in
// apps/api/src/modules/agents/transcript/model.ts), so the recorder closes at the line
// cap too, not just the byte cap: whichever is reached first ends the segment, and a
// stream of many short lines never builds a segment the server would reject.
const SEGMENT_MAX_LINES = 5000;

export interface TranscriptSegment {
  seq: number;
  lines: string[];
  // The session the CLI named in the lines recorded so far, when the format carries
  // one and it has appeared.
  sessionId: string | null;
}

// Where the session id lives differs per CLI; each reads it the same place the answer
// adapter does. A line that is not the configured format carries none.
function sessionIdOf(format: OutputFormat, line: unknown): string | null {
  if (!line || typeof line !== 'object') return null;
  const message = line as Record<string, unknown>;
  switch (format) {
    case 'claude-stream-json':
      return text(message.session_id);
    case 'codex-jsonl':
      return message.type === 'thread.started' ? text(message.thread_id) : null;
    case 'opencode-json':
      return text(message.sessionID);
    case 'antigravity-stream-json': {
      const step = message.step_update as Record<string, unknown> | undefined;
      const result = message.result as Record<string, unknown> | undefined;
      return (
        text(message.conversation_id) ??
        (step ? text(step.conversation_id) : null) ??
        (result ? text(result.conversation_id) : null)
      );
    }
    case 'copilot-json':
      return message.type === 'result' ? text(message.sessionId) : null;
    case 'pi-json':
      return message.type === 'session' ? text(message.id) : null;
    default:
      return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

export class TranscriptRecorder {
  private seq: number;
  private pending: string[] = [];
  private pendingBytes = 0;
  private partial = '';
  private sessionId: string | null = null;
  private uploading: Promise<void> = Promise.resolve();

  // `firstSeq` is where the claim said this task's stream continues: a task handed out
  // again appends after the segments its earlier attempt stored.
  constructor(
    private readonly format: OutputFormat,
    private readonly upload: (segment: TranscriptSegment) => Promise<void>,
    private readonly log: (message: string) => void = () => {},
    firstSeq = 0,
  ) {
    this.seq = firstSeq;
  }

  write(chunk: string): void {
    this.partial += chunk;
    const lines = this.partial.split('\n');
    this.partial = lines.pop() ?? '';
    for (const line of lines) this.push(line);
  }

  // Sends what is left as the last segment. The output's final line may arrive without
  // a newline after it, so it is read here rather than dropped.
  async close(): Promise<void> {
    if (this.partial) {
      this.push(this.partial);
      this.partial = '';
    }
    this.flush();
    await this.uploading;
  }

  private push(line: string): void {
    this.pending.push(line);
    this.pendingBytes += line.length + 1;
    if (!this.sessionId) {
      try {
        this.sessionId = sessionIdOf(this.format, JSON.parse(line));
      } catch {
        // Output that is not the configured format carries no session.
      }
    }
    if (this.pendingBytes >= SEGMENT_BYTES || this.pending.length >= SEGMENT_MAX_LINES)
      this.flush();
  }

  // Segments are sent one at a time, in sequence order; a viewer pages them by seq.
  // One retry covers a request that failed while the server was restarting — a repeat
  // of the same (scope, seq) is ignored by the server, so it is safe to send twice.
  private flush(): void {
    if (this.pending.length === 0) return;
    const segment: TranscriptSegment = {
      seq: this.seq++,
      lines: this.pending,
      sessionId: this.sessionId,
    };
    this.pending = [];
    this.pendingBytes = 0;
    this.uploading = this.uploading.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await this.upload(segment);
          return;
        } catch (err) {
          if (attempt > 0) {
            this.log(`transcript segment ${segment.seq} lost: ${String(err)}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    });
  }
}
