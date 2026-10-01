'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { resetAiAgentThreadSession } from '@/lib/api/endpoints/agentChat';
import { qk } from '@/services/queryKeys';
import { InputGroupButton } from '@/components/ui/input-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

// Clears the coding agent session this conversation is bound to on the runner's
// machine, so the next message is answered by a session started anew over the framed
// conversation instead of a resume. The transcript of every earlier answer stays
// readable — it is kept per answer, not per session.
export function AiChatSessionReset({
  projectKey,
  agentId,
  threadId,
}: {
  projectKey: string;
  agentId: number;
  threadId: string;
}) {
  const t = useTranslations('aiChat');
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  function reset() {
    setBusy(true);
    // The thread list is refetched because the session badge it carries disappears
    // with the binding.
    resetAiAgentThreadSession(projectKey, agentId, threadId)
      .then(() => qc.invalidateQueries({ queryKey: qk.agentThreads(projectKey, agentId) }))
      .catch((err) => console.error('Could not start a new session', err))
      .finally(() => setBusy(false));
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InputGroupButton
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={busy}
          className="rounded-md text-muted-foreground hover:text-foreground"
          onClick={reset}
        >
          <RotateCcw className="shrink-0" />
          <span className="sr-only">{t('resetSession')}</span>
        </InputGroupButton>
      </TooltipTrigger>
      <TooltipContent className="max-w-56">{t('resetSessionHint')}</TooltipContent>
    </Tooltip>
  );
}
