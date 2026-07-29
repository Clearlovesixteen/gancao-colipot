import type { BrowserUseErrorCode, ComputerUsePageContext, ComputerUsePhase } from '../../../shared/automation/automationTypes';
import { isTransientObservationMessagingError } from '../messaging/browserMessagingErrors';

export class BrowserUseFailure extends Error {
  constructor(
    public readonly code: BrowserUseErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BrowserUseFailure';
  }
}

function relevantCollectionTypes(phase?: ComputerUsePhase): Set<string> | undefined {
  if (!phase) return undefined;
  if (phase.type === 'navigate_to_page' || phase.type === 'open_page_or_center') return new Set(['menu_group']);
  if (phase.type === 'download_file') return new Set(['action_group']);
  if (phase.type === 'click_latest_download') return new Set(['file_list', 'table_row_group']);
  if (phase.type === 'fill_form') return new Set(['form_group', 'action_group']);
  if (phase.type === 'click_action') return new Set(['action_group', 'table_row_group']);
  if (phase.type === 'select_collection_item') return new Set([phase.collectionType || 'search_results']);
  return undefined;
}

export function fingerprintComputerUseContext(context: ComputerUsePageContext, phase?: ComputerUsePhase): string {
  const relevant = relevantCollectionTypes(phase);
  const collections = (context.collections || [])
    .filter((collection) => !relevant || relevant.has(collection.type))
    .map((collection) => ({
      id: collection.id,
      type: collection.type,
      items: collection.items.slice(0, 20).map((item) => ({
        index: item.index,
        text: String(item.text || '').replace(/\s+/g, ' ').trim(),
        href: item.href,
        purpose: item.purpose || item.metadata?.purpose,
        active: item.active || item.metadata?.active,
        value: item.metadata?.currentValue || item.metadata?.value,
      })),
    }));
  return JSON.stringify({
    url: context.observation.url,
    title: context.observation.title,
    state: context.observation.pageState?.kind,
    modal: context.observation.pageState?.hasModal,
    collections,
  });
}

export interface StableBrowserStateResult<T> {
  value: T;
  attempts: number;
  stable: boolean;
  fingerprint: string;
}

export async function waitForStableBrowserState<T>(input: {
  observe: () => Promise<T>;
  isReady: (value: T) => boolean;
  fingerprint: (value: T) => string;
  attempts?: number;
  stableSamples?: number;
  delayMs?: number;
  signal?: AbortSignal;
  synchronize?: () => Promise<void>;
  description?: string;
}): Promise<StableBrowserStateResult<T>> {
  const attempts = Math.max(1, input.attempts ?? 6);
  const stableSamples = Math.max(1, input.stableSamples ?? 2);
  const delayMs = Math.max(0, input.delayMs ?? 300);
  let lastValue: T | undefined;
  let lastFingerprint = '';
  let stableCount = 0;
  let lastTransientError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (input.signal?.aborted) {
      throw new BrowserUseFailure('ACTION_EXECUTION_FAILED', 'Browser Use 已停止。', false);
    }
    if (attempt === 1 && input.synchronize) await input.synchronize();
    let value: T;
    try {
      value = await input.observe();
    } catch (error) {
      if (!isTransientObservationMessagingError(error)) throw error;
      lastTransientError = error;
      stableCount = 0;
      lastFingerprint = '';
      if (attempt < attempts) {
        await input.synchronize?.();
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      break;
    }
    lastValue = value;
    const ready = input.isReady(value);
    const fingerprint = ready ? input.fingerprint(value) : '';
    if (ready && fingerprint && fingerprint === lastFingerprint) stableCount += 1;
    else stableCount = ready && fingerprint ? 1 : 0;
    lastFingerprint = fingerprint;

    if (ready && stableCount >= stableSamples) {
      return { value, attempts: attempt, stable: true, fingerprint };
    }
    if (attempt < attempts && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new BrowserUseFailure(
    'PAGE_NOT_SETTLED',
    `${input.description || '页面'}在 ${attempts} 次观察后仍未稳定。`,
    true,
    {
      attempts,
      lastFingerprint,
      hasObservation: lastValue !== undefined,
      lastTransientError: lastTransientError instanceof Error ? lastTransientError.message : undefined,
    },
  );
}
