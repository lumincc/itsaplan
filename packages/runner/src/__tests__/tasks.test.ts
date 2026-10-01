import { describe, it, expect } from 'bun:test';
import type { ChatMessage, Client, Run } from '../client';
import type { RunnerConfig } from '../config';
import { runOnce } from '../tasks';

// What one --once pass holds: a due run is claimed, worked and reported before the
// process exits; an empty run feed falls through to the chat feed for as long as the
// caller budgeted; the return value says which of those happened, for the exit code.

const config: RunnerConfig = {
  name: '',
  url: 'http://localhost:9999',
  apiKey: 'key',
  command: "printf '%s\\n' 'line one' 'line two'",
  args: [],
  env: {},
  concurrency: 1,
  pollIntervalMs: 1000,
  timeoutMs: 10_000,
  outputFormat: 'text',
};

const run: Run = {
  id: 11,
  trigger: 'manual',
  prompt: 'the task',
  systemPrompt: '',
  issueId: null,
  issueIdentifier: null,
  transcriptSeq: 0,
};

const message: ChatMessage = {
  id: 7,
  threadId: 'chat:1:u:x',
  prompt: 'the question',
  systemPrompt: '',
  freshPrompt: 'the question',
  freshSystemPrompt: '',
  sessionId: null,
  transcriptSeq: 0,
};

interface Calls {
  claims: number;
  chatClaims: number;
  reported: { status: string }[];
  chatResults: { status: string }[];
}

function fakeClient(over: Partial<Calls & { run: Run | null; chats: (ChatMessage | null)[] }>) {
  const calls: Calls = { claims: 0, chatClaims: 0, reported: [], chatResults: [] };
  let run = 'run' in over ? over.run! : null;
  const chats = over.chats ?? [];
  const client = {
    claim: async () => {
      calls.claims++;
      const claimed = run;
      run = null;
      return claimed;
    },
    claimChat: async () => {
      calls.chatClaims++;
      return chats.length > 0 ? chats.shift()! : null;
    },
    heartbeat: async () => {},
    report: async (_id: number, result: { status: string }) => {
      calls.reported.push(result);
    },
    runTranscript: async () => {},
    chatHeartbeat: async () => false,
    chatEvents: async () => false,
    chatResult: async (_id: number, result: { status: string }) => {
      calls.chatResults.push(result);
    },
    chatTranscript: async () => {},
  };
  return { client: client as unknown as Client, calls };
}

describe('runOnce', () => {
  it('claims a due run, reports its outcome, and says it succeeded', async () => {
    const { client, calls } = fakeClient({ run });
    const outcome = await runOnce(config, client, () => {}, 0);
    expect(outcome).toBe('success');
    expect(calls.claims).toBe(1);
    expect(calls.reported[0]).toMatchObject({ status: 'success' });
    expect(calls.chatClaims).toBe(0);
  });

  it('maps a run whose command failed to the failed outcome', async () => {
    const failing = { ...config, command: 'echo boom >&2; exit 3' };
    const { client, calls } = fakeClient({ run });
    const outcome = await runOnce(failing, client, () => {}, 0);
    expect(outcome).toBe('failed');
    expect(calls.reported[0]!.status).toBe('failed');
  });

  it('exits idle without asking the chat feed when no run is due and no wait is given', async () => {
    const { client, calls } = fakeClient({ run: null, chats: [message] });
    const outcome = await runOnce(config, client, () => {}, 0);
    expect(outcome).toBe('idle');
    expect(calls.chatClaims).toBe(0);
  });

  it('falls through to the chat feed within the wait and answers what it finds', async () => {
    const { client, calls } = fakeClient({ run: null, chats: [message] });
    const outcome = await runOnce(config, client, () => {}, 60_000);
    expect(outcome).toBe('success');
    expect(calls.chatClaims).toBe(1);
    expect(calls.chatResults[0]).toMatchObject({ status: 'success' });
  });

  it('says idle when the wait runs out with no chat message either', async () => {
    const { client, calls } = fakeClient({ run: null, chats: [null] });
    const outcome = await runOnce(config, client, () => {}, 5);
    expect(outcome).toBe('idle');
    expect(calls.chatClaims).toBeGreaterThan(0);
  });
});
