import { describe, it, expect } from 'bun:test';
import type { OutputFormat } from '../config';
import { TranscriptRecorder, type TranscriptSegment } from '../transcript';

// The recorder is what keeps a task's raw output: what it queued, what it split on,
// and what it survived. The segments it hands over are the bytes the server stores.

function collect(uploads: TranscriptSegment[]) {
  return async (segment: TranscriptSegment) => {
    uploads.push(segment);
  };
}

describe('transcript recorder', () => {
  it('keeps whole lines in order, across chunk boundaries', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('claude-stream-json', collect(uploads));

    recorder.write('{"type":"a"}\n{"ty');
    recorder.write('pe":"b"}\n');
    await recorder.close();

    expect(uploads).toEqual([{ seq: 0, lines: ['{"type":"a"}', '{"type":"b"}'], sessionId: null }]);
  });

  it('reads the last line even without a newline after it', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('claude-stream-json', collect(uploads));

    recorder.write('one\ntwo\nthree');
    await recorder.close();

    expect(uploads[0]!.lines).toEqual(['one', 'two', 'three']);
  });

  it('closes a segment once its lines pass a megabyte', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('claude-stream-json', collect(uploads));

    const line = 'x'.repeat(600 * 1024);
    recorder.write(`${line}\n${line}\n${line}\n`);
    await recorder.close();

    expect(uploads.length).toBe(2);
    expect(uploads[0]!.seq).toBe(0);
    expect(uploads[0]!.lines).toEqual([line, line]);
    expect(uploads[1]!.seq).toBe(1);
    expect(uploads[1]!.lines).toEqual([line]);
  });

  // The server refuses a segment over SEGMENT_MAX_LINES, and a lost segment is gone for
  // good — a stream of short lines must split on the line cap, not only on bytes.
  it('closes a segment at the line cap however short the lines are', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('text', collect(uploads));

    const count = 5001;
    recorder.write(`${Array.from({ length: count }, (_, i) => `l${i}`).join('\n')}\n`);
    await recorder.close();

    expect(uploads.length).toBe(2);
    expect(uploads[0]!.seq).toBe(0);
    expect(uploads[0]!.lines.length).toBe(5000);
    expect(uploads[1]!.seq).toBe(1);
    expect(uploads[1]!.lines).toEqual(['l5000']);
    expect(uploads.flatMap((s) => s.lines)).toEqual(
      Array.from({ length: count }, (_, i) => `l${i}`),
    );
  });

  it('numbers its segments from the seq the claim handed over', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('text', collect(uploads), () => {}, 3);

    recorder.write('a line\n');
    await recorder.close();

    expect(uploads).toEqual([{ seq: 3, lines: ['a line'], sessionId: null }]);
  });

  it('names the session each harness writes on its own line', async () => {
    const cases: [OutputFormat, string, string][] = [
      ['claude-stream-json', JSON.stringify({ type: 'system', session_id: 'cs' }), 'cs'],
      ['codex-jsonl', JSON.stringify({ type: 'thread.started', thread_id: 'cd' }), 'cd'],
      ['opencode-json', JSON.stringify({ sessionID: 'oc' }), 'oc'],
      ['antigravity-stream-json', JSON.stringify({ conversation_id: 'ag' }), 'ag'],
      ['copilot-json', JSON.stringify({ type: 'result', sessionId: 'cp' }), 'cp'],
      ['pi-json', JSON.stringify({ type: 'session', id: 'pi' }), 'pi'],
    ];
    for (const [format, line, id] of cases) {
      const uploads: TranscriptSegment[] = [];
      const recorder = new TranscriptRecorder(format, collect(uploads));
      recorder.write(`${line}\n`);
      await recorder.close();
      expect(`${format}: ${uploads[0]!.sessionId}`).toBe(`${format}: ${id}`);
    }
  });

  it('keeps plain text output as lines, with no session to read', async () => {
    const uploads: TranscriptSegment[] = [];
    const recorder = new TranscriptRecorder('text', collect(uploads));

    recorder.write('no format here\njust words\n');
    await recorder.close();

    expect(uploads[0]!.lines).toEqual(['no format here', 'just words']);
    expect(uploads[0]!.sessionId).toBeNull();
  });

  it('drops a segment whose upload fails twice, without failing close', async () => {
    const logs: string[] = [];
    let calls = 0;
    const recorder = new TranscriptRecorder(
      'text',
      async () => {
        calls++;
        throw new Error('server unreachable');
      },
      (message) => logs.push(message),
    );

    recorder.write('a line\n');
    await recorder.close();

    expect(calls).toBe(2);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('segment 0 lost');
  });

  it('sends a retried segment once when the first attempt fails', async () => {
    const uploads: TranscriptSegment[] = [];
    let calls = 0;
    const recorder = new TranscriptRecorder(
      'text',
      async (segment) => {
        calls++;
        if (calls === 1) throw new Error('flaky');
        uploads.push(segment);
      },
      () => {},
    );

    recorder.write('a line\n');
    await recorder.close();

    expect(calls).toBe(2);
    expect(uploads.map((s) => s.lines)).toEqual([['a line']]);
  });
});
