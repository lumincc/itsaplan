import { describe, it, expect } from 'bun:test';
import type { AgUiEvent } from '../agui';
import type { ChatMessage, Client } from '../client';
import type { RunnerConfig } from '../config';
import { answer } from '../chat';

// What the fallback in answer() has to hold: a resume that the command cannot do is
// retried as a fresh session, the person waiting is told, the new session is reported
// so the thread rebinds, and a failure on both attempts stays a failure.
//
// The command stands in for a coding agent: it fails while a session is set, and on the
// fresh attempt it prints the session it "started" and some text, in the pi format.

const config: RunnerConfig = {
  name: '',
  url: 'http://localhost:9999',
  apiKey: 'key',
  command:
    'if [ -n "$ITSAPLAN_SESSION_ID" ]; then echo "no session to resume" >&2; exit 1; fi; ' +
    "printf '%s\\n' " +
    '\'{"type":"session","id":"new-session"}\' ' +
    '\'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"rebuilt answer"}}\'',
  args: [],
  env: {},
  concurrency: 1,
  pollIntervalMs: 1000,
  timeoutMs: 10_000,
  outputFormat: 'pi-json',
};

const resumed: ChatMessage = {
  id: 7,
  threadId: 'chat:1:u:x',
  prompt: 'the question',
  systemPrompt: '',
  freshPrompt:
    'Earlier in this conversation:\n\nPerson: earlier\n\nThe person writes:\n\nthe question',
  freshSystemPrompt: 'the system prompt',
  sessionId: 'dead-session',
  transcriptSeq: 0,
};

function fakeClient() {
  const events: { events: AgUiEvent[]; sessionId?: string; rebind?: boolean }[] = [];
  const results: { status: string; error?: string }[] = [];
  const transcripts: number[] = [];
  const client = {
    chatEvents: async (_id: number, batch: AgUiEvent[], sessionId?: string, rebind?: boolean) => {
      events.push({ events: batch, sessionId, rebind });
      return false;
    },
    chatHeartbeat: async () => false,
    chatResult: async (_id: number, result: { status: 'success' | 'failed'; error?: string }) => {
      results.push(result);
    },
    chatTranscript: async (id: number) => {
      transcripts.push(id);
    },
  };
  return { client: client as unknown as Client, events, results, transcripts };
}

const text = (calls: { events: AgUiEvent[] }[]) =>
  calls
    .flatMap((call) => call.events)
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => (e as { delta: string }).delta)
    .join('');

describe('chat answer', () => {
  it('falls back to a fresh session when the resume fails, and rebinds', async () => {
    const fake = fakeClient();

    await answer(config, fake.client, resumed, new AbortController());

    expect(fake.results).toEqual([{ status: 'success' }]);
    // The person is told what happened, then reads the answer the fresh session gave.
    expect(text(fake.events)).toContain('could not be resumed');
    expect(text(fake.events)).toContain('rebuilt answer');
    // The session the retry started is reported so the thread leaves the dead one.
    expect(
      fake.events.some((call) => call.sessionId === 'new-session' && call.rebind === true),
    ).toBe(true);
    // The raw output of both attempts was recorded against the answer.
    expect(fake.transcripts).toEqual([7]);
  });

  it('does not fall back when the thread had no session', async () => {
    const fake = fakeClient();
    const fresh: ChatMessage = { ...resumed, sessionId: null };

    await answer(config, fake.client, fresh, new AbortController());

    // Without a session the command succeeds on the first attempt.
    expect(fake.results[0]!.status).toBe('success');
    expect(text(fake.events)).not.toContain('could not be resumed');
  });

  it('reports a failure when the fresh attempt fails too', async () => {
    const fake = fakeClient();
    const failing: RunnerConfig = { ...config, command: 'echo "broken" >&2; exit 3' };

    await answer(failing, fake.client, resumed, new AbortController());

    expect(fake.results).toEqual([{ status: 'failed', error: 'broken' }]);
  });
});
