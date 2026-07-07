import { describe, expect, it } from 'vitest';
import { comparePageMonitorSnapshots, createPageMonitorSnapshot } from './pageMonitor';

describe('pageMonitor', () => {
  it('creates stable hashes for equivalent page text', () => {
    const a = createPageMonitorSnapshot({
      mode: 'page_text',
      title: 'Page',
      url: 'https://example.com',
      text: 'hello   world',
      capturedAt: 1,
    });
    const b = createPageMonitorSnapshot({
      mode: 'page_text',
      title: 'Page',
      url: 'https://example.com',
      text: 'hello world',
      capturedAt: 2,
    });

    expect(a.hash).toBe(b.hash);
    expect(comparePageMonitorSnapshots(a, b).changed).toBe(false);
  });

  it('marks changed content', () => {
    const previous = createPageMonitorSnapshot({
      mode: 'page_text',
      title: 'Page',
      url: 'https://example.com',
      text: 'old',
      capturedAt: 1,
    });
    const next = createPageMonitorSnapshot({
      mode: 'page_text',
      title: 'Page',
      url: 'https://example.com',
      text: 'new',
      capturedAt: 2,
    });

    const result = comparePageMonitorSnapshots(previous, next);
    expect(result.changed).toBe(true);
    expect(result.summary).toContain(previous.hash);
  });

  it('summarizes tables in table mode', () => {
    const snapshot = createPageMonitorSnapshot({
      mode: 'table_summary',
      title: 'Table',
      url: 'https://example.com',
      tables: [{ headers: ['name', 'count'], rows: [['a', 1]] }],
      capturedAt: 1,
    });

    expect(snapshot.tableCount).toBe(1);
    expect(snapshot.text).toContain('name|count');
    expect(snapshot.text).toContain('a|1');
  });
});
