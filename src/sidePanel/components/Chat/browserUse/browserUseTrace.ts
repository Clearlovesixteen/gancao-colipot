import type {
  BrowserObservation,
  ComputerUseAction,
  ComputerUseTrace,
  ComputerUseTraceEntry,
} from '../../../../shared/automation/automationTypes';
import type {
  ComputerUseTaskStatus,
  ComputerUseTaskTraceState,
} from '../types';

export function getBrowserUseActionLabel(action?: { action?: string; reason?: string }): string {
  if (!action) return '正在执行自动操作';
  if (action.action === 'extract_table') return '正在提取页面表格';
  if (action.action === 'download_file') return `正在导出文件：${action.reason || '点击导出/下载按钮'}`;
  if (action.action === 'click') return `正在点击：${action.reason || '目标元素'}`;
  if (action.action === 'type') return `正在输入：${action.reason || '文本'}`;
  return `正在执行：${action.reason || action.action}`;
}

export function getBrowserUseStatusMeta(status: ComputerUseTaskStatus): { label: string; color: string } {
  if (status === 'finished') return { label: '已完成', color: 'green' };
  if (status === 'error') return { label: '失败', color: 'red' };
  if (status === 'stopped') return { label: '已停止', color: 'orange' };
  if (status === 'waiting_confirmation') return { label: '待确认', color: 'gold' };
  return { label: '运行中', color: 'processing' };
}

export function getBrowserUseStateLabel(state?: string): string {
  const labels: Record<string, string> = {
    observing: '观察页面',
    planning: '分析规划',
    acting: '执行动作',
    verifying: '校验结果',
    recovering: '失败恢复',
    waiting_confirmation: '等待确认',
    done: '步骤完成',
  };
  return state ? labels[state] || state : '任务事件';
}

export function summarizeBrowserUseEntry(entry: ComputerUseTraceEntry): string {
  if (entry.error) return entry.error;
  if (entry.summary) return entry.summary;
  if (entry.action) return getBrowserUseActionLabel(entry.action);
  const result = entry.result as any;
  if (entry.phaseGoal && result?.summary) return `${entry.phaseGoal}：${result.summary}`;
  if (result?.filename || result?.assetId || result?.downloadId) {
    if (result.savedToDocumentCenter && result.assetId) {
      return `已导出 ${result.filename || result.assetTitle || '文件'}，资料 ID：${result.assetId}`;
    }
    return result.message || `已触发下载 ${result.filename || result.downloadId}`;
  }
  if (result?.summary) return String(result.summary);
  if (typeof result?.navigationCount === 'number' || typeof result?.tableCount === 'number') {
    return [
      typeof result.navigationCount === 'number' ? `导航 ${result.navigationCount}` : '',
      typeof result.tableCount === 'number' ? `表格 ${result.tableCount}` : '',
    ].filter(Boolean).join('，');
  }
  if (entry.observation?.title) return `页面：${entry.observation.title}`;
  return getBrowserUseStateLabel(entry.state);
}

export function getLatestDownloadResult(
  steps: Array<{ action?: ComputerUseAction; result?: unknown }> = [],
): any | null {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step?.action?.action !== 'download_file') continue;
    const result = step.result as any;
    if (!result) continue;
    return result?.success === true && result?.result ? result.result : result;
  }
  return null;
}

export function makeBrowserUseEntryFromEvent(event: any): ComputerUseTraceEntry {
  const base = {
    timestamp: Date.now(),
    type: event.type,
    goal: event.goal || '',
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
    rejectedPlanReason: event.rejectedPlanReason,
    fallbackUsed: event.fallbackUsed,
    phaseIndex: event.phaseIndex,
    phaseType: event.phaseType,
    phaseGoal: event.phaseGoal,
    phase: event.phase,
    runState: event.runState,
    resumeCheckpoint: event.resumeCheckpoint,
    result: {
      steps: event.steps,
      verification: event.verification,
      runState: event.runState,
      resumeCheckpoint: event.resumeCheckpoint,
    },
  };
}

export function compactBrowserUseEntries(entries: ComputerUseTraceEntry[]): ComputerUseTraceEntry[] {
  return entries.slice(-80);
}

export function browserUseTraceStateFromBackground(trace: ComputerUseTrace): ComputerUseTaskTraceState {
  const lastEntry = trace.entries[trace.entries.length - 1];
  return {
    runId: trace.runId,
    goal: trace.goal,
    status: trace.status,
    currentStep: lastEntry ? getBrowserUseStateLabel(lastEntry.state) : undefined,
    summary: lastEntry?.summary,
    error: lastEntry?.error,
    entries: trace.entries,
    lastObservation: [...trace.entries].reverse().find((entry) => entry.observation)?.observation as BrowserObservation | undefined,
    resumeCheckpoint: [...trace.entries].reverse().find((entry) => entry.resumeCheckpoint)?.resumeCheckpoint,
  };
}
