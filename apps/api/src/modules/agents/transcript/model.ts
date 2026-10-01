// SPDX-License-Identifier: AGPL-3.0-only
import { t } from 'elysia';

// The raw output a runner records for one chat answer or one agent run, in segments:
// what the coding agent printed, before any parsing. Each upload is one segment of
// whole lines, addressed by its position in the stream.

// The most lines one segment may carry. The runner closes a segment at this cap and at
// its own byte cap, whichever comes first (SEGMENT_MAX_LINES in
// packages/runner/src/transcript.ts), so a valid stream never builds a segment this
// rejects; the cap bounds a body whose lines are one huge string.
const SEGMENT_MAX_LINES = 5000;

export const transcriptBody = t.Object({
  harness: t.String({
    maxLength: 100,
    description:
      "The output format the harness wrote, as the runner read it (e.g. 'claude-stream-json', 'text').",
  }),
  seq: t.Number({ minimum: 0, description: 'Position of this segment in the stream, from 0.' }),
  lines: t.Array(t.String(), { minItems: 1, maxItems: SEGMENT_MAX_LINES }),
  sessionId: t.Optional(
    t.Nullable(
      t.String({
        maxLength: 200,
        description:
          'The coding agent session the recorded lines named, when the format carries one.',
      }),
    ),
  ),
});

export type TranscriptBody = typeof transcriptBody.static;

export const runTranscriptParams = t.Object({ runId: t.Numeric() });

export const chatTranscriptParams = t.Object({ messageId: t.Numeric() });

// The run transcript read route, which addresses the agent through its team.
export const teamRunTranscriptParams = t.Object({
  teamId: t.Numeric(),
  agentId: t.Numeric(),
  runId: t.Numeric(),
});

export const transcriptQuery = t.Object({
  after: t.Optional(
    t.Numeric({
      minimum: 0,
      description: 'The seq to read from, inclusive. Absent reads from the start.',
    }),
  ),
});

// One segment of the raw stream, whole lines in order. `nextSeq` names the segment
// after this one, when there is one — the cursor a viewer pages with.
export const TranscriptResponse = t.Object({
  harness: t.String(),
  seq: t.Number(),
  lines: t.Array(t.String()),
  lineCount: t.Number(),
  byteSize: t.Number(),
  nextSeq: t.Nullable(t.Number()),
});

export type TranscriptPage = typeof TranscriptResponse.static;
