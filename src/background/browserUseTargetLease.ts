import type {
  ComputerUsePageContext,
  ComputerUsePhase,
  ComputerUsePhaseMemory,
  ComputerUseRunState,
  ObservedCollectionType,
  PlannedStep,
} from '../shared/automationTypes';
import { BrowserUseFailure } from './browserUseReadiness';
import { resolvePlannedStepTarget, type TargetResolution } from './targetResolver';

export interface BrowserUseTargetLease {
  issuedAt: number;
  collectionType?: ObservedCollectionType;
  ordinal?: number;
  parentPath?: string[];
  purpose?: string;
  text?: string;
  href?: string;
  elementId?: string;
  selector?: string;
  pageUrl: string;
}

function compact(value?: string): string {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function comparableHref(value?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

export function createBrowserUseTargetLease(
  resolution: TargetResolution,
  context: ComputerUsePageContext,
): BrowserUseTargetLease {
  const target = resolution.step.target;
  return {
    issuedAt: Date.now(),
    collectionType: target?.collectionType,
    ordinal: target?.ordinal,
    parentPath: target?.parentPath,
    purpose: target?.purpose,
    text: target?.text,
    href: target?.href,
    elementId: target?.elementId,
    selector: target?.selector,
    pageUrl: context.observation.url,
  };
}

function hasSemanticIdentity(lease: BrowserUseTargetLease): boolean {
  return Boolean(lease.collectionType || lease.ordinal || lease.parentPath?.length || lease.purpose || lease.href || lease.text);
}

function assertSameSemanticTarget(lease: BrowserUseTargetLease, resolution: TargetResolution): void {
  const target = resolution.step.target;
  const previousHref = comparableHref(lease.href);
  const nextHref = comparableHref(target?.href);
  if (previousHref && nextHref && previousHref !== nextHref) {
    throw new BrowserUseFailure('TARGET_STALE', '页面重绘后，目标链接已经变化，已拒绝点击。', true, {
      previousHref,
      nextHref,
      ordinal: lease.ordinal,
    });
  }

  const previousText = compact(lease.text);
  const nextText = compact(target?.text);
  if (previousText && nextText && previousText !== nextText && lease.ordinal) {
    throw new BrowserUseFailure('TARGET_STALE', '页面重绘后，请求序号对应的内容已经变化，已拒绝点击。', true, {
      previousText: lease.text,
      nextText: target?.text,
      ordinal: lease.ordinal,
    });
  }

  if (!hasSemanticIdentity(lease)) {
    const sameElement = Boolean(lease.elementId && lease.elementId === target?.elementId);
    const sameSelector = Boolean(lease.selector && lease.selector === target?.selector);
    if (!sameElement && !sameSelector) {
      throw new BrowserUseFailure('TARGET_STALE', '页面重绘后，原目标元素已经失效。', true);
    }
  }
}

export function revalidateBrowserUseTargetLease(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  lease?: BrowserUseTargetLease;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}):
  | { ok: true; resolution: TargetResolution; rebound: boolean }
  | { ok: false; code: 'TARGET_AMBIGUOUS' | 'TARGET_STALE'; reason: string; resolution?: TargetResolution } {
  const resolution = resolvePlannedStepTarget({
    step: input.step,
    context: input.context,
    phase: input.phase,
    runState: input.runState,
    phaseMemory: input.phaseMemory,
  });
  if (resolution.blocked) {
    return {
      ok: false,
      code: resolution.ambiguous ? 'TARGET_AMBIGUOUS' : 'TARGET_STALE',
      reason: resolution.reason || '重新观察后无法解析原目标。',
      resolution,
    };
  }
  if (!input.lease) return { ok: true, resolution, rebound: false };

  try {
    assertSameSemanticTarget(input.lease, resolution);
  } catch (error) {
    if (error instanceof BrowserUseFailure) {
      return { ok: false, code: 'TARGET_STALE', reason: error.message, resolution };
    }
    throw error;
  }
  const nextTarget = resolution.step.target;
  return {
    ok: true,
    resolution,
    rebound: Boolean(
      (input.lease.elementId && nextTarget?.elementId && input.lease.elementId !== nextTarget.elementId)
      || (input.lease.selector && nextTarget?.selector && input.lease.selector !== nextTarget.selector)
    ),
  };
}
