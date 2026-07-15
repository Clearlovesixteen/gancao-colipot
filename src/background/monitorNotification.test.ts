import { describe, expect, it } from 'vitest';
import { buildMonitorNotificationText } from './monitorNotification';

describe('monitorNotification', () => {
  it('builds a concise notification with page context', () => {
    const text = buildMonitorNotificationText({
      run: { id: 'r1', title: '库存监控', kind: 'page_monitor', status: 'running', createdAt: 1, updatedAt: 1 },
      monitor: { url: 'https://example.com', intervalMinutes: 5, extractMode: 'page_text' },
      snapshot: { hash: 'h1', mode: 'page_text', title: '库存列表', url: 'https://example.com/list', text: '库存 3', capturedAt: 1 },
      summary: '库存数量发生变化',
      diffPreview: '5 -> 3',
    });
    expect(text).toContain('库存监控');
    expect(text).toContain('5 -> 3');
    expect(text).toContain('https://example.com/list');
  });
});
