import type {
  AutomationErrorMessage,
  AutomationFinishedMessage,
  AutomationProgressMessage,
  AutomationStep,
  AutomationWorkflow,
} from '../shared/automationTypes';

type RunnerDeps = {
  tabId: number;
  runId: string;
  workflow: AutomationWorkflow;
  signal: AbortSignal;
  navigate: (tabId: number, url: string, waitFor: 'complete' | 'domcontentloaded' | 'none', timeoutMs: number, signal: AbortSignal) => Promise<void>;
  executeBrowserTool: (tabId: number, toolName: string, args: any) => Promise<any>;
  captureVisibleTab: (tabId: number, format: 'png' | 'jpeg', quality?: number) => Promise<string>;
  runComputerUse?: (goal: string, options: { tabId: number; maxSteps?: number; startUrl?: string; allowHighRisk?: boolean }) => Promise<unknown>;
  emit: (msg: AutomationProgressMessage | AutomationFinishedMessage | AutomationErrorMessage) => void;
};

function interpolate(value: string, vars: Record<string, unknown>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function interpolateStep(step: AutomationStep, vars: Record<string, unknown>): AutomationStep {
  if (step.type === 'navigate') {
    return { ...step, url: interpolate(step.url, vars) };
  }
  if (step.type === 'type') {
    return { ...step, text: interpolate(step.text, vars) };
  }
  if (step.type === 'computerTask') {
    return {
      ...step,
      goal: interpolate(step.goal, vars),
      startUrl: step.startUrl ? interpolate(step.startUrl, vars) : undefined,
    };
  }
  if (step.type === 'click') {
    return {
      ...step,
      selector: step.selector ? interpolate(step.selector, vars) : undefined,
      text: step.text ? interpolate(step.text, vars) : undefined,
    };
  }
  if (step.type === 'waitForElement') {
    return { ...step, selector: interpolate(step.selector, vars) };
  }
  if (step.type === 'extract') {
    return {
      ...step,
      selector: step.selector ? interpolate(step.selector, vars) : undefined,
      text: step.text ? interpolate(step.text, vars) : undefined,
      attribute: step.attribute ? interpolate(step.attribute, vars) : undefined,
      into: interpolate(step.into, vars),
    };
  }
  return step;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('已停止'));
    };

    if (signal.aborted) {
      clearTimeout(timer);
      reject(new Error('已停止'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isWorkflowLike(value: unknown): value is AutomationWorkflow {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return Array.isArray(v.steps);
}

export class AutomationRunner {
  private readonly controller = new AbortController();
  private readonly stepsResults: Array<{ stepIndex: number; step: AutomationStep; result?: unknown }> = [];
  private readonly vars: Record<string, unknown>;
  private last: unknown;

  constructor(private readonly deps: Omit<RunnerDeps, 'signal'>) {
    this.vars = { ...(deps.workflow.variables || {}) };
  }

  stop() {
    this.controller.abort();
  }

  async run(): Promise<void> {
    if (!isWorkflowLike(this.deps.workflow)) {
      this.deps.emit({ type: 'AUTOMATION_ERROR', runId: this.deps.runId, error: '工作流格式不正确' });
      return;
    }

    try {
      const steps = this.deps.workflow.steps || [];
      for (let i = 0; i < steps.length; i++) {
        if (this.controller.signal.aborted) throw new Error('已停止');

        const rawStep = steps[i] as AutomationStep;
        const step = interpolateStep(rawStep, this.vars);

        this.deps.emit({ type: 'AUTOMATION_PROGRESS', runId: this.deps.runId, stepIndex: i, step, state: 'running' });
        const result = await this.executeStep(step);
        this.last = result;
        this.stepsResults.push({ stepIndex: i, step, result });
        this.deps.emit({ type: 'AUTOMATION_PROGRESS', runId: this.deps.runId, stepIndex: i, step, state: 'done', result });
      }

      this.deps.emit({
        type: 'AUTOMATION_FINISHED',
        runId: this.deps.runId,
        result: { vars: this.vars, last: this.last, steps: this.stepsResults },
      });
    } catch (err: any) {
      const message = err?.message ? String(err.message) : '执行失败';
      this.deps.emit({ type: 'AUTOMATION_ERROR', runId: this.deps.runId, error: message });
    }
  }

  private async executeStep(step: AutomationStep): Promise<unknown> {
    switch (step.type) {
      case 'observe': {
        const result = await this.deps.executeBrowserTool(this.deps.tabId, 'observe_page', {
          includeScreenshot: step.includeScreenshot === true,
          limit: step.limit ?? 80,
        });
        if (step.into) this.vars[step.into] = result?.result || result;
        return result;
      }
      case 'wait': {
        await sleep(step.ms, this.controller.signal);
        return { ok: true };
      }
      case 'navigate': {
        const waitFor = step.waitFor ?? 'complete';
        const timeoutMs = step.timeoutMs ?? 30000;
        await this.deps.navigate(this.deps.tabId, step.url, waitFor, timeoutMs, this.controller.signal);
        return { ok: true, url: step.url };
      }
      case 'click': {
        return await this.deps.executeBrowserTool(this.deps.tabId, 'click_element', {
          elementId: step.elementId,
          selector: step.selector,
          text: step.text,
          x: step.x,
          y: step.y,
        });
      }
      case 'type': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'type_text', {
        elementId: step.elementId,
        selector: step.selector,
        text: step.text,
        clear: step.clear,
        delay: step.delay
      });
    }
    case 'pressKey': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'press_key', {
        key: step.key,
        elementId: step.elementId,
        selector: step.selector,
      });
    }
    case 'selectOption': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'select_option', {
        elementId: step.elementId,
        selector: step.selector,
        value: step.value,
        selectBy: step.selectBy,
      });
    }
    case 'hover': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'hover_element', step);
    }
    case 'uploadFile': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'upload_file', step);
    }
    case 'forms': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'fill_form', step);
    }
    case 'assert': {
      return await this.deps.executeBrowserTool(this.deps.tabId, 'assert_page', step);
    }
    case 'computerTask': {
      if (!this.deps.runComputerUse) throw new Error('Computer Use runner 未配置');
      return await this.deps.runComputerUse(step.goal, {
        tabId: this.deps.tabId,
        maxSteps: step.maxSteps,
        startUrl: step.startUrl,
        allowHighRisk: step.allowHighRisk,
      });
    }
    case 'waitForElement': {
        return await this.deps.executeBrowserTool(this.deps.tabId, 'wait_for_element', {
          selector: step.selector,
          timeout: step.timeoutMs ?? 5000,
        });
      }
      case 'scroll': {
        return await this.deps.executeBrowserTool(this.deps.tabId, 'scroll_page', {
          direction: step.direction,
          pixels: step.pixels,
        });
      }
      case 'extract': {
        const raw = await this.deps.executeBrowserTool(this.deps.tabId, 'query_elements', {
          selector: step.selector,
          text: step.text,
          limit: step.limit ?? 10,
        });

        const elements = Array.isArray((raw as any)?.elements) ? (raw as any).elements : [];
        const values = elements.map((el: any) => {
          if (step.attribute) return el?.attributes?.[step.attribute];
          return el?.text;
        });
        const result = { count: (raw as any)?.count ?? values.length, values };
        if (step.into) this.vars[step.into] = result;
        return result;
      }
      case 'screenshot': {
        const format = step.format ?? 'png';
        const quality = step.quality ?? 90;
        const dataUrl = await this.deps.captureVisibleTab(this.deps.tabId, format, format === 'jpeg' ? quality : undefined);
        const result = { dataUrl };
        if (step.into) this.vars[step.into] = result;
        return result;
      }
    }
  }
}
