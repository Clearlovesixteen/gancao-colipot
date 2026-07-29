import { describe, expect, it } from 'vitest';
import {
  browserUseTraceStateFromBackground,
  compactBrowserUseEntries,
  getLatestDownloadResult,
  makeBrowserUseEntryFromEvent,
} from './browserUseTrace';

describe('browserUseTrace', () => {
  it('converts progress and error events without losing phase evidence', () => {
    const progress = makeBrowserUseEntryFromEvent({
      type: 'COMPUTER_USE_PROGRESS',
      runId: 'run_1',
      goal: '导出列表',
      state: 'acting',
      phaseIndex: 1,
      phaseType: 'download_file',
      phaseGoal: '点击导出',
      verification: { success: true, reason: '按钮已点击' },
      result: { summary: '等待下载' },
    });
    expect(progress).toMatchObject({
      state: 'acting',
      phaseIndex: 1,
      phaseType: 'download_file',
      phaseGoal: '点击导出',
      verification: { success: true },
    });

    const failed = makeBrowserUseEntryFromEvent({
      type: 'COMPUTER_USE_ERROR',
      error: '下载超时',
      resumeCheckpoint: { phaseIndex: 1 },
      lastObservation: { url: 'https://example.test/list', title: '列表' },
    });
    expect(failed).toMatchObject({
      error: '下载超时',
      observation: { title: '列表' },
      resumeCheckpoint: { phaseIndex: 1 },
    });
  });

  it('keeps the latest 80 entries and unwraps download results', () => {
    const entries = Array.from({ length: 85 }, (_, index) => ({
      timestamp: index,
      type: 'COMPUTER_USE_PROGRESS' as const,
      goal: 'test',
    }));
    expect(compactBrowserUseEntries(entries)).toHaveLength(80);
    expect(compactBrowserUseEntries(entries)[0].timestamp).toBe(5);

    expect(getLatestDownloadResult([
      { action: { action: 'click' } as any, result: { success: true } },
      {
        action: { action: 'download_file' } as any,
        result: { success: true, result: { filename: 'report.xlsx', downloadId: 7 } },
      },
    ])).toEqual({ filename: 'report.xlsx', downloadId: 7 });
  });

  it('rebuilds a persisted trace for the task card', () => {
    const state = browserUseTraceStateFromBackground({
      runId: 'run_2',
      goal: '打开页面',
      status: 'error',
      startedAt: 1,
      updatedAt: 2,
      entries: [
        {
          timestamp: 2,
          type: 'COMPUTER_USE_ERROR',
          goal: '打开页面',
          state: 'verifying',
          error: '页面未变化',
          observation: { url: 'https://example.test', title: 'Example' } as any,
        },
      ],
    });
    expect(state).toMatchObject({
      runId: 'run_2',
      status: 'error',
      currentStep: '校验结果',
      error: '页面未变化',
      lastObservation: { title: 'Example' },
    });
  });
});
