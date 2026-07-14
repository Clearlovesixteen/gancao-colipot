import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../shared/automationTypes';
import { TaskExecutorRegistry } from './taskExecutorRegistry';

const run: AutomationRun = {
  id: 'run_1', title: 'test', kind: 'extract', status: 'draft', createdAt: 1, updatedAt: 1,
};

describe('TaskExecutorRegistry', () => {
  it('registers and resolves executors by kind', () => {
    const executor = { kind: 'extract' as const, validate: vi.fn(async () => undefined), run: vi.fn(async () => ({ status: 'success' as const, summary: 'ok' })) };
    const registry = new TaskExecutorRegistry().register(executor);
    expect(registry.get('extract')).toBe(executor);
    expect(registry.listKinds()).toEqual(['extract']);
  });

  it('rejects duplicate registrations and unsupported kinds', () => {
    const executor = { kind: 'extract' as const, validate: vi.fn(async () => undefined), run: vi.fn(async () => ({ status: 'success' as const, summary: 'ok' })) };
    const registry = new TaskExecutorRegistry().register(executor);
    expect(() => registry.register(executor)).toThrow('已注册');
    expect(() => registry.get(run.kind === 'extract' ? 'ocr' : run.kind)).toThrow('暂不支持');
  });
});
