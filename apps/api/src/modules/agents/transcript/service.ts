// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { db, agentRun, agentChatMessage, agentChatThread, agentTranscriptSegment } from '@repo/db';
import { getObject, putObject, deleteObjects } from '@repo/storage';
import { HttpError } from '#shared/lib';
import type { TeamMembership } from '#shared/access';
import { runsTeam } from '#modules/teams/service';
import { memberProjectIds } from '../core/service';
import type { TranscriptBody, TranscriptPage } from './model';

// The raw stream of one chat answer or one agent run, kept as the coding agent wrote
// it: the lines go to the object store gzipped, one object per segment, and this
// module's tables hold the index — which scope a segment belongs to, its position in
// the stream, and how to find and verify the bytes. Nothing here truncates and nothing
// expires; the segments of an answer that was retried simply follow the ones of the
// attempt that failed.

// One segment more than a page holds, to tell whether another follows.
const READ_AHEAD = 2;

const runKey = (runId: number, seq: number) => `transcripts/runs/${runId}/${seq}.jsonl.gz`;
const messageKey = (messageId: number, seq: number) =>
  `transcripts/chats/${messageId}/${seq}.jsonl.gz`;

// Writes one segment's bytes and its index row. A repeat of the same (scope, seq) is
// ignored rather than refused: the runner retries an upload it could not see the
// answer to, and the second copy holds the same lines.
async function storeSegment(
  scope: { key: (seq: number) => string; runId?: number; messageId?: number },
  body: TranscriptBody,
): Promise<void> {
  const text = body.lines.join('\n');
  const bytes = gzipSync(Buffer.from(text, 'utf8'));
  const key = scope.key(body.seq);
  try {
    await putObject(key, bytes, 'application/gzip');
  } catch (error) {
    // Refused rather than indexed without bytes: a transcript the store will not take
    // is an error the runner sees and logs, never a silent gap.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[planner] transcript PUT failed (bucket=${process.env.S3_BUCKET}, key=${key}):`,
      error,
    );
    throw new HttpError(502, `Object store error: ${message}`);
  }
  await db
    .insert(agentTranscriptSegment)
    .values({
      runId: scope.runId,
      messageId: scope.messageId,
      harness: body.harness,
      seq: body.seq,
      lineCount: body.lines.length,
      byteSize: Buffer.byteLength(text, 'utf8'),
      storageKey: key,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    .onConflictDoNothing();
}

// Where a scope's stream continues: one past the highest seq it holds. Both claims
// hand this to the runner, so an attempt of a re-claimed task numbers its segments
// after the ones already stored — the attempts append in order instead of the newest
// starting over at seq 0 and overwriting the oldest.
export async function nextTranscriptSeq(scope: {
  runId?: number;
  messageId?: number;
}): Promise<number> {
  const rows = await db
    .select({ next: sql<number>`coalesce(max(${agentTranscriptSegment.seq}), -1) + 1` })
    .from(agentTranscriptSegment)
    .where(
      and(
        scope.runId != null ? eq(agentTranscriptSegment.runId, scope.runId) : undefined,
        scope.messageId != null ? eq(agentTranscriptSegment.messageId, scope.messageId) : undefined,
      ),
    );
  return rows[0]?.next ?? 0;
}

// The run a runner is recording, checked against the agent its key identifies.
export async function storeRunTranscript(
  agentId: number,
  runId: number,
  body: TranscriptBody,
): Promise<void> {
  const rows = await db
    .select({ id: agentRun.id })
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), eq(agentRun.agentId, agentId)))
    .limit(1);
  if (!rows[0]) throw new HttpError(404, 'Run not found');
  await storeSegment({ key: (seq) => runKey(runId, seq), runId }, body);
  if (body.sessionId) {
    // First report wins, the same way a chat thread binds: a run is recorded once.
    await db
      .update(agentRun)
      .set({ cliSessionId: body.sessionId })
      .where(and(eq(agentRun.id, runId), isNull(agentRun.cliSessionId)));
  }
}

// The answer a runner is recording, checked the same way.
export async function storeChatTranscript(
  agentId: number,
  messageId: number,
  body: TranscriptBody,
): Promise<void> {
  const rows = await db
    .select({ id: agentChatMessage.id })
    .from(agentChatMessage)
    .where(and(eq(agentChatMessage.id, messageId), eq(agentChatMessage.agentId, agentId)))
    .limit(1);
  if (!rows[0]) throw new HttpError(404, 'Message not found');
  await storeSegment({ key: (seq) => messageKey(messageId, seq), messageId }, body);
}

// The segments of a scope's stream from `seq` on, oldest first, one page of one
// segment with the seq of the one behind it. Null when the scope holds none from
// there.
async function readSegment(
  scope: { runId?: number; messageId?: number },
  seq: number,
): Promise<TranscriptPage | null> {
  const rows = await db
    .select()
    .from(agentTranscriptSegment)
    .where(
      and(
        scope.runId != null ? eq(agentTranscriptSegment.runId, scope.runId) : undefined,
        scope.messageId != null ? eq(agentTranscriptSegment.messageId, scope.messageId) : undefined,
        gte(agentTranscriptSegment.seq, seq),
      ),
    )
    .orderBy(asc(agentTranscriptSegment.seq))
    .limit(READ_AHEAD);
  if (rows.length === 0) return null;
  const row = rows[0];
  const object = await getObject(row.storageKey).catch(() => {
    throw new HttpError(502, `Could not read transcript segment ${row.seq}`);
  });
  const text = gunzipSync(Buffer.from(await new Response(object.body).arrayBuffer())).toString(
    'utf8',
  );
  return {
    harness: row.harness,
    seq: row.seq,
    lines: text.split('\n'),
    lineCount: row.lineCount,
    byteSize: row.byteSize,
    nextSeq: rows.length > 1 ? rows[1].seq : null,
  };
}

// A run's transcript for a member of the team, under the run history's visibility: an
// owner or a manager of the team reads every run, anyone else only one in a project
// they belong to. Null when the run is not this agent's, is not readable, or has no
// recorded segment from `seq` on.
export async function readRunTranscriptFor(
  membership: TeamMembership,
  agentId: number,
  runId: number,
  after = 0,
): Promise<TranscriptPage | null> {
  const rows = await db
    .select({ projectId: agentRun.projectId })
    .from(agentRun)
    .where(and(eq(agentRun.id, runId), eq(agentRun.agentId, agentId)))
    .limit(1);
  const run = rows[0];
  if (!run) return null;
  if (!runsTeam(membership.role)) {
    const mine = new Set(await memberProjectIds(membership.teamId, membership.userId));
    if (!mine.has(run.projectId)) return null;
  }
  return readSegment({ runId }, after);
}

// One answer's transcript, for its thread's owner only — the same scoping the answer's
// events read under. Null when the answer is not the caller's, or has no transcript.
export async function readChatTranscript(
  messageId: number,
  agentId: number,
  userId: string,
  after = 0,
): Promise<TranscriptPage | null> {
  const owned = await db
    .select({ id: agentChatMessage.id })
    .from(agentChatMessage)
    .innerJoin(agentChatThread, eq(agentChatThread.id, agentChatMessage.threadId))
    .where(
      and(
        eq(agentChatMessage.id, messageId),
        eq(agentChatMessage.agentId, agentId),
        eq(agentChatThread.userId, userId),
      ),
    )
    .limit(1);
  if (!owned[0]) return null;
  return readSegment({ messageId }, after);
}

// Which of these answers hold a recorded transcript, for the message list.
export async function messagesWithTranscript(messageIds: number[]): Promise<Set<number>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ messageId: agentTranscriptSegment.messageId })
    .from(agentTranscriptSegment)
    .where(inArray(agentTranscriptSegment.messageId, messageIds))
    .groupBy(agentTranscriptSegment.messageId);
  return new Set(rows.flatMap((row) => (row.messageId == null ? [] : [row.messageId])));
}

// Which of these runs hold a recorded transcript, for the run history.
export async function runsWithTranscript(runIds: number[]): Promise<Set<number>> {
  if (runIds.length === 0) return new Set();
  const rows = await db
    .select({ runId: agentTranscriptSegment.runId })
    .from(agentTranscriptSegment)
    .where(inArray(agentTranscriptSegment.runId, runIds))
    .groupBy(agentTranscriptSegment.runId);
  return new Set(rows.flatMap((row) => (row.runId == null ? [] : [row.runId])));
}

// Deletes the transcript objects of a thread's answers, best-effort, before the
// cascade takes the index rows that name them. Reads them through the ownership check
// so one member cannot purge another's.
export async function purgeThreadTranscripts(threadId: string, userId: string): Promise<void> {
  const rows = await db
    .select({ storageKey: agentTranscriptSegment.storageKey })
    .from(agentTranscriptSegment)
    .innerJoin(agentChatMessage, eq(agentChatMessage.id, agentTranscriptSegment.messageId))
    .innerJoin(agentChatThread, eq(agentChatThread.id, agentChatMessage.threadId))
    .where(and(eq(agentChatThread.id, threadId), eq(agentChatThread.userId, userId)));
  if (rows.length > 0) await deleteObjects(rows.map((row) => row.storageKey));
}
