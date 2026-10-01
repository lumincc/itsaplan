'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiTranscriptPage } from '@/lib/api/endpoints/agents';
import { Button } from '@/components/ui/button';
import { useTranslations } from 'next-intl';

// The raw output of one chat answer or one agent run, as its coding agent wrote it:
// every line the harness printed, with no projection over it. Loaded one segment at a
// time — a long transcript costs a request per segment, not one for all of it.
//
// A line that is JSON is pretty-printed and labelled with its `type` field, which every
// harness the runner knows names on its event lines; anything else is shown as it came.
function TranscriptLine({ line, n }: { line: string; n: number }) {
  let pretty = line;
  let type: string | null = null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === 'object') {
      pretty = JSON.stringify(parsed, null, 2);
      if ('type' in parsed) type = String((parsed as { type: unknown }).type);
    }
  } catch {
    // Not JSON: shown as the plain text it is.
  }
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="tabular-nums">{n}</span>
        {type && <span className="rounded bg-muted px-1 font-medium">{type}</span>}
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap">
        {pretty}
      </pre>
    </div>
  );
}

export function RawTranscriptViewer({
  load,
}: {
  // Fetches the segment after `after` (null for the first), or null when the stream has
  // no segment past it.
  load: (after: number | null) => Promise<AiTranscriptPage | null>;
}) {
  const t = useTranslations('common.transcript');
  const [pages, setPages] = useState<AiTranscriptPage[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The guard keeps a `load` prop recreated on every render from fetching the first
  // segment twice.
  const started = useRef(false);

  const fetchMore = useCallback(
    async (after: number | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await load(after);
        if (!page) {
          setNext(null);
          return;
        }
        setPages((p) => [...p, page]);
        setNext(page.nextSeq);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [load],
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void fetchMore(null);
  }, [fetchMore]);

  return (
    <div className="flex flex-col gap-2">
      {pages.map((page, index) => {
        // The stream is one stream: numbering runs on across its segments.
        const before = pages.slice(0, index).reduce((sum, p) => sum + p.lines.length, 0);
        return (
          <div key={page.seq} className="flex flex-col gap-1.5">
            <div className="text-[10px] font-medium text-muted-foreground">
              {page.harness} · {t('segment', { seq: page.seq, count: page.lineCount })}
            </div>
            <div className="flex max-h-96 flex-col gap-2 overflow-y-auto pe-1">
              {page.lines.map((line, i) => (
                <TranscriptLine key={i} line={line} n={before + i + 1} />
              ))}
            </div>
          </div>
        );
      })}
      {error && <p className="text-xs text-destructive">{t('loadFailed')}</p>}
      {loading && <p className="text-xs text-muted-foreground">{t('loading')}</p>}
      {!loading && next != null && (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => void fetchMore(next)}>
          {t('loadMore')}
        </Button>
      )}
      {!loading && next == null && pages.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('end')}</p>
      )}
      {!loading && next == null && pages.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">{t('empty')}</p>
      )}
    </div>
  );
}
