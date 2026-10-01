// SPDX-License-Identifier: AGPL-3.0-only
import { Elysia, t } from 'elysia';
import { noContent } from '#shared/http';
import { guards } from '#shared/guards';
import { authContext } from '#shared/auth-context';
import { requireUser } from '#shared/access';
import { HttpError } from '#shared/lib';
import { commonErrors, errors } from '#shared/responses';
import { runnerAuth } from '../runner-auth';
import { getAgentById, getAgentInProject, agentScopeOf } from '../core/service';
import { chatMessageParams } from '../chat/model';
import {
  TranscriptResponse,
  chatTranscriptParams,
  runTranscriptParams,
  teamRunTranscriptParams,
  transcriptBody,
  transcriptQuery,
} from './model';
import {
  readChatTranscript,
  readRunTranscriptFor,
  storeChatTranscript,
  storeRunTranscript,
} from './service';

// The raw transcripts of chat answers and agent runs: the runner's side uploads the
// segments it recorded, the member's side pages them back. Authorization follows the
// feed each scope belongs to — the agent's key to write, the thread's owner or the
// run's readers to read.

export const agentTranscriptRoutes = new Elysia({ name: 'agent-transcript' })
  .use(authContext)
  .use(guards)
  .use(runnerAuth)

  .post(
    '/agent-runs/:runId/transcript',
    async ({ agent, params, body }) => {
      await storeRunTranscript(agent.id, params.runId, body);
      return noContent();
    },
    {
      runnerAgent: true,
      params: runTranscriptParams,
      body: transcriptBody,
      response: { 204: t.Void(), ...commonErrors, ...errors(502) },
      detail: {
        tags: ['Agent Runner'],
        summary: 'Upload a run transcript segment',
        description:
          'Append one segment of a claimed run’s raw output, as the coding agent ' +
          'wrote it. Never truncated, never expired; a repeat of the same seq is ignored.',
      },
    },
  )

  .post(
    '/agent-chats/:messageId/transcript',
    async ({ agent, params, body }) => {
      await storeChatTranscript(agent.id, params.messageId, body);
      return noContent();
    },
    {
      runnerAgent: true,
      params: chatTranscriptParams,
      body: transcriptBody,
      response: { 204: t.Void(), ...commonErrors, ...errors(502) },
      detail: {
        tags: ['Agent Chat'],
        summary: 'Upload an answer transcript segment',
        description:
          'Append one segment of a claimed answer’s raw output. The twin of the ' +
          'run upload, for the chat feed.',
      },
    },
  )

  // A run's transcript, under the same visibility as the run history.
  .get(
    '/teams/:teamId/ai-agents/:agentId/runs/:runId/transcript',
    async ({ params, membership, query }) => {
      const agent = await getAgentById(params.agentId, membership.teamId, agentScopeOf(membership));
      if (!agent) throw new HttpError(404, 'Agent not found');
      const page = await readRunTranscriptFor(
        membership,
        params.agentId,
        params.runId,
        query.after ?? 0,
      );
      if (!page) throw new HttpError(404, 'Transcript not found');
      return page;
    },
    {
      params: teamRunTranscriptParams,
      query: transcriptQuery,
      teamPermission: ['ai_agents', 'read'],
      response: { 200: TranscriptResponse, ...commonErrors },
      detail: {
        tags: ['AI Agents'],
        summary: 'Read a run transcript segment',
        description:
          'One segment of a run’s raw output, from `after` on, with the seq of the ' +
          'segment behind it. 404 when the run has no recorded transcript.',
      },
    },
  )

  // One answer's transcript, for its thread's owner — the same scoping the answer's
  // events read under.
  .get(
    '/projects/:projectKey/ai-agents/:agentId/chat/:messageId/transcript',
    async ({ params, project, query, user }) => {
      const caller = requireUser(user);
      const agent = await getAgentInProject(params.agentId, project.id);
      if (!agent) throw new HttpError(404, 'Agent not found');
      const page = await readChatTranscript(
        params.messageId,
        params.agentId,
        caller.id,
        query.after ?? 0,
      );
      if (!page) throw new HttpError(404, 'Transcript not found');
      return page;
    },
    {
      params: chatMessageParams,
      query: transcriptQuery,
      permission: ['ai_agents', 'read'],
      response: { 200: TranscriptResponse, ...commonErrors },
      detail: {
        tags: ['Agent Chat'],
        summary: 'Read an answer transcript segment',
        description:
          'One segment of an answer’s raw output, from `after` on. 404 when the answer ' +
          'is not the caller’s or has no recorded transcript.',
      },
    },
  );
