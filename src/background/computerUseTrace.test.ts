import { describe, expect, it } from 'vitest';
import { getComputerUseTrace, listComputerUseTraces, recordComputerUseTraceEvent } from './computerUseTrace';

describe('computerUseTrace', () => {
  it('records progress and finished events by run id', () => {
    const runId = `trace_${Date.now()}_${Math.random()}`;
    recordComputerUseTraceEvent({
      type: 'COMPUTER_USE_PROGRESS',
      runId,
      goal: '搜索并点击第一个结果',
      stepIndex: 0,
      state: 'acting',
      action: { action: 'click', reason: '打开搜索页' },
      targetResolution: {
        matchedBy: 'collection_ordinal',
        score: 98,
        verificationHint: 'page changed',
      },
    });
    recordComputerUseTraceEvent({
      type: 'COMPUTER_USE_FINISHED',
      runId,
      goal: '搜索并点击第一个结果',
      summary: '已完成',
      steps: [],
    });

    const trace = getComputerUseTrace(runId);
    expect(trace).toEqual(expect.objectContaining({
      runId,
      status: 'finished',
      goal: '搜索并点击第一个结果',
    }));
    expect(trace?.entries).toHaveLength(2);
    expect(trace?.entries[0]?.targetResolution).toMatchObject({
      matchedBy: 'collection_ordinal',
      score: 98,
    });
    expect(listComputerUseTraces(5).some((item) => item.runId === runId)).toBe(true);
  });
});
