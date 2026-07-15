import type { ComputerUseRunState, PlannedStep } from '../shared/automationTypes';

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function variableValue(expression: string, runState: ComputerUseRunState): unknown {
  const segments = expression.trim().split('.').filter(Boolean);
  if (!segments.length) return undefined;
  if (segments[0] === 'download') return readPath(runState.downloadResult, segments.slice(1));
  if (segments[0] === 'outputs') return readPath(runState.outputs, segments.slice(1));
  if (segments[0] === 'currentTab') {
    const current = runState.browserSession?.tabs.find((tab) => tab.current);
    return readPath(current, segments.slice(1));
  }
  return readPath(runState.outputs?.[segments[0]], segments.slice(1));
}

function printable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function resolveBrowserUseVariables(value: string | undefined, runState: ComputerUseRunState): string | undefined {
  if (!value || !value.includes('{{')) return value;
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, expression) => {
    const resolved = variableValue(String(expression), runState);
    return resolved === undefined ? match : printable(resolved);
  });
}

export function resolvePlannedStepVariables(step: PlannedStep, runState: ComputerUseRunState): PlannedStep {
  return {
    ...step,
    value: resolveBrowserUseVariables(step.value, runState),
    rationale: resolveBrowserUseVariables(step.rationale, runState) || step.rationale,
    summary: resolveBrowserUseVariables(step.summary, runState),
    target: step.target ? {
      ...step.target,
      text: resolveBrowserUseVariables(step.target.text, runState),
      href: resolveBrowserUseVariables(step.target.href, runState),
      purpose: resolveBrowserUseVariables(step.target.purpose, runState),
      parentPath: step.target.parentPath?.map((item) => resolveBrowserUseVariables(item, runState) || item),
    } : undefined,
  };
}

export function summarizeBrowserUseOutputs(runState?: ComputerUseRunState): Record<string, unknown> {
  if (!runState) return {};
  const currentTab = runState.browserSession?.tabs.find((tab) => tab.current);
  return {
    outputs: runState.outputs || {},
    download: runState.downloadResult ? {
      filename: runState.downloadResult.filename,
      downloadId: runState.downloadResult.downloadId,
      assetId: runState.downloadResult.assetId,
      status: runState.downloadResult.status,
    } : undefined,
    currentTab: currentTab ? {
      id: currentTab.tabId,
      url: currentTab.url,
      title: currentTab.title,
    } : undefined,
  };
}
