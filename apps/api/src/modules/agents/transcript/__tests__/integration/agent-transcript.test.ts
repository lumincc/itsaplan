import { describe, it, expect, beforeEach } from 'bun:test';
import { db, agentRun, agentChatMessage } from '@repo/db';
import { eq } from 'drizzle-orm';
import { apiKeyApi, authedApi, type Api } from '#tests/helpers/app';
import { signUpTestUser } from '#tests/helpers/auth';
import { resetDb } from '#tests/helpers/db';
import { addProjectMember } from '#tests/helpers/members';
import { createAgent, teamOf } from '#tests/helpers/agents';

// The raw transcript feed: a runner uploads the segments it recorded for a run or a
// chat answer, and the member who may see that work pages them back. The claim's
// fallback payload and the session reset are here too — they are what the fallback
// replays a broken resume with.
process.env.AGENT_CHAT_CLAIM_WAIT_MS = '50';
process.env.AGENT_CHAT_CLAIM_POLL_MS = '10';

async function setup() {
  const owner = await signUpTestUser({ name: 'Owner' });
  const asOwner = authedApi(owner.cookie);
  await asOwner.projects.post({ key: 'MKT', name: 'Marketing' });
  const view = await asOwner.projects({ projectKey: 'MKT' }).get();
  const columnId = view.data!.columns[0].id;
  const created = await createAgent(asOwner, 'MKT', {
    name: 'Ext Bot',
    username: 'ext',
    kind: 'external',
    triggerOnMention: true,
  });
  return {
    asOwner,
    columnId,
    agent: created.data!.agent,
    asRunner: apiKeyApi(created.data!.apiKey!),
  };
}

// Queues one run by mentioning the agent on a new issue, then claims it for the runner.
async function claimedRun(
  asOwner: Api,
  asRunner: Api,
  columnId: number,
  username: string,
): Promise<number> {
  const issue = (
    await asOwner.projects({ projectKey: 'MKT' }).issues.post({ columnId, title: 'Landing page' })
  ).data!;
  await asOwner.issues({ issueId: issue.id }).comments.post({ body: `please review @${username}` });
  return (await asRunner['agent-runs'].claim.post()).data!.run!.id;
}

// Sends a chat message and claims the answer, the two steps every chat case starts
// with. A threadId continues that conversation.
async function claimedAnswer(
  asOwner: Api,
  asRunner: Api,
  agentId: number,
  prompt: string,
  threadId?: string,
) {
  const sent = (
    await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId })
      .chat.post(threadId ? { prompt, threadId } : { prompt })
  ).data!;
  const claimed = (await asRunner['agent-chats'].claim.post()).data!.message!;
  return { threadId: sent.threadId, messageId: claimed.id, claimed };
}

// Closes a claimed answer the way a runner does, optionally binding the thread to a
// session first.
async function answerWithSession(asRunner: Api, messageId: number, sessionId: string) {
  await asRunner['agent-chats']({ messageId }).events.post({
    events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'done' }],
    sessionId,
  });
  await asRunner['agent-chats']({ messageId }).result.post({ status: 'success' });
}

describe('agent transcripts', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('stores a run transcript segment and reads it back verbatim', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const teamId = await teamOf(asOwner, 'MKT');
    const runId = await claimedRun(asOwner, asRunner, columnId, agent.username);
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [] } }),
    ];

    const uploaded = await asRunner['agent-runs']({ runId }).transcript.post({
      harness: 'claude-stream-json',
      seq: 0,
      lines,
      sessionId: 'sess-1',
    });
    expect(uploaded.status).toBe(204);

    const read = await asOwner
      .teams({ teamId })
      ['ai-agents']({ agentId: agent.id })
      .runs({
        runId,
      })
      .transcript.get({ query: {} });
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({
      harness: 'claude-stream-json',
      seq: 0,
      lines,
      lineCount: 2,
      nextSeq: null,
    });

    // The session the lines named is recorded on the run, and the history says a
    // transcript exists.
    const runs = await asOwner.teams({ teamId })['ai-agents']({ agentId: agent.id }).runs.get({
      query: {},
    });
    expect(runs.data!.items[0]).toMatchObject({
      cliSessionId: 'sess-1',
      hasTranscript: true,
    });
  });

  it('ignores a repeat of the same segment and pages by seq', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const teamId = await teamOf(asOwner, 'MKT');
    const runId = await claimedRun(asOwner, asRunner, columnId, agent.username);

    for (const seq of [0, 1, 0, 2]) {
      const res = await asRunner['agent-runs']({ runId }).transcript.post({
        harness: 'text',
        seq,
        lines: [`line-${seq}`],
      });
      expect(res.status).toBe(204);
    }

    const runs = asOwner.teams({ teamId })['ai-agents']({ agentId: agent.id }).runs({ runId });
    expect((await runs.transcript.get({ query: {} })).data).toMatchObject({
      seq: 0,
      nextSeq: 1,
    });
    expect((await runs.transcript.get({ query: { after: 1 } })).data).toMatchObject({
      seq: 1,
      nextSeq: 2,
    });
    expect((await runs.transcript.get({ query: { after: 2 } })).data).toMatchObject({
      seq: 2,
      nextSeq: null,
    });
    // Past the last segment there is nothing: 404, not an empty page.
    expect((await runs.transcript.get({ query: { after: 3 } })).status).toBe(404);
  });

  it('refuses a transcript for another agent or a missing run', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const runId = await claimedRun(asOwner, asRunner, columnId, agent.username);

    const second = await createAgent(asOwner, 'MKT', {
      name: 'Other Bot',
      username: 'other',
      kind: 'external',
    });
    const asOtherRunner = apiKeyApi(second.data!.apiKey!);
    expect(
      (
        await asOtherRunner['agent-runs']({ runId }).transcript.post({
          harness: 'text',
          seq: 0,
          lines: ['not mine'],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await asRunner['agent-runs']({ runId: runId + 1000 }).transcript.post({
          harness: 'text',
          seq: 0,
          lines: ['no such run'],
        })
      ).status,
    ).toBe(404);
  });

  it('stores a chat transcript readable by the thread owner alone', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const { threadId, messageId } = await claimedAnswer(asOwner, asRunner, agent.id, 'hello');
    await answerWithSession(asRunner, messageId, 's1');

    const uploaded = await asRunner['agent-chats']({ messageId }).transcript.post({
      harness: 'pi-json',
      seq: 0,
      lines: [JSON.stringify({ type: 'session', id: 's1' }), 'plain tail'],
    });
    expect(uploaded.status).toBe(204);

    const read = await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id })
      .chat({ messageId })
      .transcript.get({ query: {} });
    expect(read.status).toBe(200);
    expect(read.data!.lines).toEqual([JSON.stringify({ type: 'session', id: 's1' }), 'plain tail']);

    // The thread's messages say the full record exists.
    const messages = await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({
        agentId: agent.id,
      })
      .threads({ threadId })
      .messages.get({ query: { page: 0 } });
    const answer = messages.data!.items.find((m) => m.role === 'assistant');
    expect(answer!.hasTranscript).toBe(true);

    // A member who did not send the question does not see the record.
    const asOther = await addProjectMember(asOwner, 'MKT');
    const foreign = await asOther
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({
        agentId: agent.id,
      })
      .chat({ messageId })
      .transcript.get({ query: {} });
    expect(foreign.status).toBe(404);
  });

  it('claims a resumed thread with the framed history as the fallback payload', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const first = await claimedAnswer(asOwner, asRunner, agent.id, 'first question');
    await answerWithSession(asRunner, first.messageId, 'sess-1');
    await asRunner['agent-chats']({ messageId: first.messageId }).transcript.post({
      harness: 'text',
      seq: 0,
      lines: ['first answer raw'],
    });

    const second = await claimedAnswer(
      asOwner,
      asRunner,
      agent.id,
      'second question',
      first.threadId,
    );
    // A resumed thread is sent only the question; the framed history rides along for
    // the retry that starts the session anew.
    expect(second.messageId).not.toBe(first.messageId);
    const message = second.claimed;
    expect(message.sessionId).toBe('sess-1');
    expect(message.prompt).toBe('second question');
    expect(message.systemPrompt).toBe('');
    expect(message.freshPrompt).toContain('first question');
    expect(message.freshPrompt).toContain('second question');
    expect(message.freshPrompt).toContain('The person writes:');
    expect(message.freshSystemPrompt).not.toBe('');

    // The first answer's transcript is still reachable after the thread moved on.
    const read = await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id })
      .chat({ messageId: first.messageId })
      .transcript.get({ query: {} });
    expect(read.data!.lines).toEqual(['first answer raw']);
  });

  it('rebinds the thread only when the runner says the old session is dead', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const first = await claimedAnswer(asOwner, asRunner, agent.id, 'hello');
    const events = asRunner['agent-chats']({ messageId: first.messageId }).events;

    // The first session report binds the thread.
    await events.post({
      events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'x' }],
      sessionId: 'sess-1',
    });
    const threads = asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id }).threads;
    expect((await threads.get({ query: { page: 0 } })).data!.items[0]!.cliSessionId).toBe('sess-1');

    // A session report without rebind leaves the recorded binding in place.
    await events.post({
      events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'x' }],
      sessionId: 'sess-other',
    });
    expect((await threads.get({ query: { page: 0 } })).data!.items[0]!.cliSessionId).toBe('sess-1');

    // The fallback's report says rebind, and the dead session gives way.
    await events.post({
      events: [{ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm3', delta: 'x' }],
      sessionId: 'sess-new',
      rebind: true,
    });
    expect((await threads.get({ query: { page: 0 } })).data!.items[0]!.cliSessionId).toBe(
      'sess-new',
    );
  });

  it('starts a new session on the member word and keeps the old transcript', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const first = await claimedAnswer(asOwner, asRunner, agent.id, 'hello');
    await answerWithSession(asRunner, first.messageId, 'sess-1');
    await asRunner['agent-chats']({ messageId: first.messageId }).transcript.post({
      harness: 'text',
      seq: 0,
      lines: ['the old raw output'],
    });

    const reset = await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id })
      .threads({ threadId: first.threadId })
      .session.delete();
    expect(reset.status).toBe(204);

    // The binding is gone: the next claim is sent the framed conversation, the way a
    // brand new thread is.
    await asOwner.projects({ projectKey: 'MKT' })['ai-agents']({ agentId: agent.id }).chat.post({
      prompt: 'again',
      threadId: first.threadId,
    });
    const claimed = (await asRunner['agent-chats'].claim.post()).data!.message!;
    expect(claimed.sessionId).toBeNull();
    expect(claimed.prompt).toContain('hello');
    expect(claimed.prompt).toContain('again');
    expect(claimed.systemPrompt).not.toBe('');

    // The transcript recorded before the reset is untouched.
    const read = await asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id })
      .chat({ messageId: first.messageId })
      .transcript.get({ query: {} });
    expect(read.data!.lines).toEqual(['the old raw output']);

    // A thread another member can read is not theirs to reset.
    const asMember = await addProjectMember(asOwner, 'MKT');
    expect(
      (
        await asMember
          .projects({ projectKey: 'MKT' })
          ['ai-agents']({ agentId: agent.id })
          .threads({ threadId: first.threadId })
          .session.delete()
      ).status,
    ).toBe(404);
  });

  // What a re-claim must hold: the attempt that takes over numbers its segments from
  // where the stream already ends, so the record keeps both attempts in order instead
  // of the newest overwriting the oldest from seq 0.
  it('continues a re-claimed run transcript after the failed attempt', async () => {
    const { asOwner, asRunner, agent, columnId } = await setup();
    const teamId = await teamOf(asOwner, 'MKT');
    const runId = await claimedRun(asOwner, asRunner, columnId, agent.username);

    for (const seq of [0, 1, 2]) {
      await asRunner['agent-runs']({ runId }).transcript.post({
        harness: 'text',
        seq,
        lines: [`attempt-1 line ${seq}`],
      });
    }
    // The lease runs out and the run is handed out again.
    await db
      .update(agentRun)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(agentRun.id, runId));
    const reclaimed = (await asRunner['agent-runs'].claim.post()).data!.run!;
    expect(reclaimed.id).toBe(runId);
    expect(reclaimed.transcriptSeq).toBe(3);
    expect(
      (
        await asRunner['agent-runs']({ runId }).transcript.post({
          harness: 'text',
          seq: 3,
          lines: ['attempt-2 line 0'],
        })
      ).status,
    ).toBe(204);

    const read = asOwner
      .teams({ teamId })
      ['ai-agents']({ agentId: agent.id })
      .runs({ runId }).transcript;
    expect(
      await wholeStream(async (after) => (await read.get({ query: { after } })).data!),
    ).toEqual(['attempt-1 line 0', 'attempt-1 line 1', 'attempt-1 line 2', 'attempt-2 line 0']);
  });

  it('continues a re-claimed answer transcript after the failed attempt', async () => {
    const { asOwner, asRunner, agent } = await setup();
    const { messageId } = await claimedAnswer(asOwner, asRunner, agent.id, 'hello');

    for (const seq of [0, 1, 2]) {
      await asRunner['agent-chats']({ messageId }).transcript.post({
        harness: 'text',
        seq,
        lines: [`attempt-1 line ${seq}`],
      });
    }
    await db
      .update(agentChatMessage)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) })
      .where(eq(agentChatMessage.id, messageId));
    const reclaimed = (await asRunner['agent-chats'].claim.post()).data!.message!;
    expect(reclaimed.id).toBe(messageId);
    expect(reclaimed.transcriptSeq).toBe(3);
    expect(
      (
        await asRunner['agent-chats']({ messageId }).transcript.post({
          harness: 'text',
          seq: 3,
          lines: ['attempt-2 line 0'],
        })
      ).status,
    ).toBe(204);

    const read = asOwner
      .projects({ projectKey: 'MKT' })
      ['ai-agents']({ agentId: agent.id })
      .chat({ messageId }).transcript;
    expect(
      await wholeStream(async (after) => (await read.get({ query: { after } })).data!),
    ).toEqual(['attempt-1 line 0', 'attempt-1 line 1', 'attempt-1 line 2', 'attempt-2 line 0']);
  });
});

// Pages a transcript read from the start to the end of its stream, checking on every
// page that the index row's counts describe the bytes it read back.
async function wholeStream(
  fetch: (
    after: number,
  ) => Promise<{ lines: string[]; lineCount: number; byteSize: number; nextSeq: number | null }>,
): Promise<string[]> {
  const lines: string[] = [];
  let after = 0;
  for (;;) {
    const page = await fetch(after);
    expect(page.lineCount).toBe(page.lines.length);
    expect(page.byteSize).toBe(Buffer.byteLength(page.lines.join('\n'), 'utf8'));
    lines.push(...page.lines);
    if (page.nextSeq == null) return lines;
    after = page.nextSeq;
  }
}
