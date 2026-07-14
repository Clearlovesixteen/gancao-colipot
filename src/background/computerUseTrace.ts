import type {
  ComputerUseErrorMessage,
  ComputerUseFinishedMessage,
  ComputerUseNeedsConfirmationMessage,
  ComputerUseProgressMessage,
  ComputerUseTrace,
  ComputerUseTraceEntry,
} from '../shared/automationTypes';

type ComputerUseEvent =
  | ComputerUseProgressMessage
  | ComputerUseNeedsConfirmationMessage
  | ComputerUseFinishedMessage
  | ComputerUseErrorMessage;

const traces = new Map<string, ComputerUseTrace>();
const MAX_TRACES = 30;
const MAX_ENTRIES_PER_TRACE = 120;

function statusFromEvent(event: ComputerUseEvent): ComputerUseTrace['status'] {
  if (event.type === 'COMPUTER_USE_FINISHED') return 'finished';
  if (event.type === 'COMPUTER_USE_ERROR') return event.error === '已停止' ? 'stopped' : 'error';
  if (event.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') return 'waiting_confirmation';
  if (event.type === 'COMPUTER_USE_PROGRESS' && event.state === 'waiting_confirmation') return 'waiting_confirmation';
  return 'running';
}

function entryFromEvent(event: ComputerUseEvent): ComputerUseTraceEntry {
  const base = {
    timestamp: Date.now(),
    type: event.type,
    goal: event.goal,
  };
  if (event.type === 'COMPUTER_USE_PROGRESS') {
    return {
      ...base,
      stepIndex: event.stepIndex,
      state: event.state,
      observation: event.observation,
      action: event.action,
      intent: event.intent,
      navigationPath: event.intent?.navigationPath,
      plan: event.plan,
      chosenElement: event.chosenElement,
      beforeObservation: event.beforeObservation,
      afterObservation: event.afterObservation,
      verification: event.verification,
      targetResolution: event.targetResolution,
      rejectedPlanReason: event.rejectedPlanReason,
      fallbackUsed: event.fallbackUsed,
      phaseIndex: event.phaseIndex,
      phaseType: event.phaseType,
      phaseGoal: event.phaseGoal,
      phase: event.phase,
      runState: event.runState,
      result: event.result,
    };
  }
  if (event.type === 'COMPUTER_USE_NEEDS_CONFIRMATION') {
    return {
      ...base,
      stepIndex: event.stepIndex,
      state: 'waiting_confirmation',
      action: event.action,
      result: { reason: event.reason },
    };
  }
  if (event.type === 'COMPUTER_USE_FINISHED') {
    return {
      ...base,
      state: 'done',
      summary: event.summary,
      runState: event.runState,
      result: { steps: event.steps, runState: event.runState },
    };
  }
  return {
    ...base,
    error: event.error,
    observation: event.lastObservation,
    intent: event.intent,
    navigationPath: event.intent?.navigationPath,
    plan: event.plan,
    chosenElement: event.chosenElement,
    beforeObservation: event.beforeObservation,
    afterObservation: event.afterObservation,
    verification: event.verification,
    targetResolution: event.targetResolution,
    rejectedPlanReason: event.rejectedPlanReason,
    fallbackUsed: event.fallbackUsed,
    phaseIndex: event.phaseIndex,
    phaseType: event.phaseType,
    phaseGoal: event.phaseGoal,
    phase: event.phase,
    runState: event.runState,
    result: {
      steps: event.steps,
      verification: event.verification,
      runState: event.runState,
    },
  };
}

function pruneTraces(): void {
  if (traces.size <= MAX_TRACES) return;
  const sorted = Array.from(traces.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  sorted.slice(0, traces.size - MAX_TRACES).forEach((trace) => traces.delete(trace.runId));
}

export function recordComputerUseTraceEvent(event: ComputerUseEvent): ComputerUseTrace {
  const now = Date.now();
  const current = traces.get(event.runId) || {
    runId: event.runId,
    goal: event.goal,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    entries: [],
  } satisfies ComputerUseTrace;

  current.goal = event.goal || current.goal;
  current.status = statusFromEvent(event);
  current.updatedAt = now;
  if (event.type === 'COMPUTER_USE_FINISHED' || event.type === 'COMPUTER_USE_ERROR') {
    current.finishedAt = now;
  }
  current.entries.push(entryFromEvent(event));
  if (current.entries.length > MAX_ENTRIES_PER_TRACE) {
    current.entries.splice(0, current.entries.length - MAX_ENTRIES_PER_TRACE);
  }

  traces.set(event.runId, current);
  pruneTraces();
  return current;
}

export function getComputerUseTrace(runId: string): ComputerUseTrace | null {
  return traces.get(runId) || null;
}

export function listComputerUseTraces(limit = 10): ComputerUseTrace[] {
  return Array.from(traces.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(limit, MAX_TRACES)));
}
