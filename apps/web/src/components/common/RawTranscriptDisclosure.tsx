'use client';

import { ChevronRight, FileTerminal } from 'lucide-react';
import type { AiTranscriptPage } from '@/lib/api/endpoints/agents';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { RawTranscriptViewer } from './RawTranscriptViewer';

// The row that opens one raw transcript, shaped like the tool-call rows it sits among.
export function RawTranscriptDisclosure({
  label,
  load,
}: {
  label: string;
  load: (after: number | null) => Promise<AiTranscriptPage | null>;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex min-h-8 w-fit max-w-full items-center gap-1.5 rounded-md text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90 rtl:group-data-[state=closed]:rotate-180" />
        <FileTerminal className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden ps-5 motion-safe:data-[state=closed]:animate-collapsible-up motion-safe:data-[state=open]:animate-collapsible-down">
        <RawTranscriptViewer load={load} />
      </CollapsibleContent>
    </Collapsible>
  );
}
