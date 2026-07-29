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
    expect(snapshot.rowCount).toBe(1);
    expect(snapshot.text).toContain('name|count');
    expect(snapshot.text).toContain('a|1');
  });

  it('supports contains and numeric threshold rules', () => {
    const snapshot = createPageMonitorSnapshot({
      mode: 'page_text',
      title: '库存',
      url: 'https://example.com/inventory',
      text: '库存状态：异常，剩余数量 12',
      capturedAt: 1,
    });

    expect(comparePageMonitorSnapshots(undefined, snapshot, { type: 'contains', value: '异常' }).matched).toBe(true);
    expect(comparePageMonitorSnapshots(undefined, snapshot, { type: 'number_threshold', value: '10', operator: 'gte' }).matched).toBe(true);
  });

  it('detects new rows and status transitions', () => {
    const previous = createPageMonitorSnapshot({
      mode: 'table_summary',
      title: '任务',
      url: 'https://example.com/tasks',
      text: '状态：处理中',
      tables: [{ rows: [['a']] }],
      capturedAt: 1,
    });
    const next = createPageMonitorSnapshot({
      mode: 'table_summary',
      title: '任务',
      url: 'https://example.com/tasks',
      text: '状态：已完成',
      tables: [{ rows: [['a'], ['b']] }],
      capturedAt: 2,
    });

    expect(comparePageMonitorSnapshots(previous, next, { type: 'new_records' }).matched).toBe(true);
    const transitionPrevious = { ...previous, text: '状态：处理中' };
    const transitionNext = { ...next, text: '状态：已完成' };
    expect(comparePageMonitorSnapshots(transitionPrevious, transitionNext, {
      type: 'status_transition',
      from: '处理中',
      to: '已完成',
    }).matched).toBe(true);
  });
});
