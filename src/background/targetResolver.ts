import type {
  ComputerUsePhase,
  ComputerUsePhaseMemory,
  ComputerUsePageContext,
  ComputerUseRunState,
  ObservedCollection,
  ObservedCollectionItem,
  ObservedCollectionType,
  ObservedElement,
  PlannedStep,
} from '../shared/automationTypes';

type ResolutionCandidate = {
  elementId?: string;
  selector?: string;
  text?: string;
  href?: string;
  purpose?: string;
  x?: number;
  y?: number;
  source?: 'collection' | 'element' | 'coordinate';
  matchedBy?: string;
  score?: number;
  verificationHint?: string;
};

export type RejectedTargetCandidate = {
  text: string;
  purpose?: string;
  collectionType?: ObservedCollectionType;
  score?: number;
  reason: string;
};

export type TargetResolution = {
  step: PlannedStep;
  element?: ObservedElement;
  candidate?: ResolutionCandidate;
  blocked?: boolean;
  reason?: string;
  matchedBy?: string;
  score?: number;
  rejectedCandidates?: RejectedTargetCandidate[];
  verificationHint?: string;
};

function verificationHint(step: PlannedStep): string {
  if (step.action === 'download_file') return 'download event completed or partial';
  if (step.action === 'type' || step.action === 'select_option') return 'target value equals requested value';
  return step.verify?.type || 'page or target state changed';
}

function compact(text?: string): string {
  return String(text || '').replace(/\s+/g, '').trim();
}

function includesTarget(text: string | undefined, target: string | undefined): boolean {
  const haystack = compact(text);
  const needle = compact(target);
  return Boolean(haystack && needle && haystack.includes(needle));
}

function itemText(item: ObservedCollectionItem): string {
  return [item.text, item.parentText, item.context, item.href].filter(Boolean).join(' ');
}

function itemPurpose(item: ObservedCollectionItem): string {
  return String(item.purpose || item.metadata?.purpose || '');
}

function rowActionPurpose(action: any): string {
  return String(action?.purpose || action?.metadata?.purpose || '');
}

function elementText(element: ObservedElement): string {
  return [element.text, element.parentText, element.context, element.href, element.purpose].filter(Boolean).join(' ');
}

function isFailed(phaseMemory: ComputerUsePhaseMemory | undefined, candidate: { elementId?: string; selector?: string; text?: string }): boolean {
  if (!phaseMemory?.failedCandidates?.length) return false;
  const text = compact(candidate.text);
  return phaseMemory.failedCandidates.some((failed) => {
    if (failed.elementId && candidate.elementId && failed.elementId === candidate.elementId) return true;
    if (failed.selector && candidate.selector && failed.selector === candidate.selector) return true;
    if (!failed.elementId && !failed.selector && failed.text && text && compact(failed.text) === text) return true;
    return false;
  });
}

function phaseLeaf(phase?: ComputerUsePhase): string | undefined {
  return phase?.navigationPath?.[phase.navigationPath.length - 1] || phase?.targets?.[phase.targets.length - 1];
}

function phaseParents(phase?: ComputerUsePhase): string[] {
  const path = phase?.navigationPath || [];
  return path.slice(0, -1);
}

function downloadFileName(runState?: ComputerUseRunState): string | undefined {
  const filename = runState?.downloadResult?.filename || runState?.downloadResult?.assetTitle;
  return filename ? String(filename).split(/[\\/]/).filter(Boolean).pop() || filename : undefined;
}

function collectionPriority(type: ObservedCollectionType, phase?: ComputerUsePhase): number {
  if (phase?.type === 'navigate_to_page' && type === 'menu_group') return 100;
  if (phase?.type === 'open_page_or_center' && type === 'menu_group') return 80;
  if (phase?.type === 'click_latest_download' && type === 'file_list') return 100;
  if (phase?.type === 'download_file' && type === 'action_group') return 120;
  if (phase?.type === 'download_file' && type === 'list') return -40;
  return 10;
}

function collectionMatches(collection: ObservedCollection, targetType?: ObservedCollectionType, collectionId?: string): boolean {
  if (collectionId && collection.id !== collectionId) return false;
  if (targetType && collection.type !== targetType) return false;
  return true;
}

function findExplicitCandidate(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  phaseMemory?: ComputerUsePhaseMemory;
}): ResolutionCandidate | null {
  const target = input.step.target;
  if (!target?.elementId && !target?.selector) return null;

  const element = input.context.observation.elements.find((item) => (
    target.elementId
      ? item.elementId === target.elementId
      : item.selector === target.selector || item.selectors?.includes(target.selector || '')
  ));
  const explicit = {
    elementId: target.elementId || element?.elementId,
    selector: target.selector || element?.selector,
    text: target.text || element?.text,
    purpose: target.purpose || element?.purpose,
  };
  if (isFailed(input.phaseMemory, explicit)) return null;
  if (input.step.action === 'download_file' && explicit.purpose !== 'download_button') return null;
  if (element && (!element.visible || !element.enabled)) return null;
  return {
    ...explicit,
    source: 'element',
    matchedBy: target.elementId ? 'explicit_element_id' : 'explicit_selector',
    score: 1000,
    verificationHint: verificationHint(input.step),
  };
}

function scoreCollectionItem(input: {
  item: ObservedCollectionItem;
  collection: ObservedCollection;
  step: PlannedStep;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
}): number {
  const target = input.step.target;
  let score = collectionPriority(input.collection.type, input.phase) + (input.item.confidence || 0) * 10;
  const text = itemText(input.item);
  const wantedText = target?.text || phaseLeaf(input.phase);
  if (wantedText && compact(input.item.text) === compact(wantedText)) score += 80;
  else if (wantedText && includesTarget(text, wantedText)) score += 40;
  if (wantedText && includesTarget(input.item.text, wantedText) && compact(input.item.text).length > compact(wantedText).length + 20) {
    score -= 70;
  }
  if (target?.purpose && includesTarget(itemPurpose(input.item), target.purpose)) score += 30;
  if (input.phase?.type === 'download_file' && itemPurpose(input.item) === 'download_button') score += 90;
  if (input.step.action === 'download_file' && itemPurpose(input.item) !== 'download_button') score -= 120;
  const parentPath = target?.parentPath || phaseParents(input.phase);
  for (const parent of parentPath) {
    if (includesTarget(text, parent) || includesTarget(input.collection.title, parent)) score += 24;
    else score -= 48;
  }
  const filename = downloadFileName(input.runState);
  if (input.phase?.type === 'click_latest_download' && filename && includesTarget(text, filename)) score += 70;
  if (target?.ordinal && input.item.index === target.ordinal) score += 80;
  if (target?.ordinal && input.item.index !== target.ordinal) score -= 20;
  return score;
}

function findCollectionCandidate(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}): ResolutionCandidate | null {
  const target = input.step.target;
  const inferredType: ObservedCollectionType | undefined = target?.collectionType
    || (input.phase?.type === 'navigate_to_page' || input.phase?.type === 'open_page_or_center' ? 'menu_group' : undefined)
    || (input.phase?.type === 'download_file' || input.step.action === 'download_file' ? 'action_group' : undefined)
    || (input.phase?.type === 'click_latest_download' ? 'file_list' : undefined);
  const collections = (input.context.collections || [])
    .filter((collection) => collectionMatches(collection, inferredType, target?.collectionId));

  const rowActionCandidates = collections
    .filter((collection) => collection.type === 'table_row_group')
    .flatMap((collection) => collection.items.map((item) => ({ collection, item })))
    .filter(({ item }) => !target?.ordinal || item.index === target.ordinal)
    .flatMap(({ collection, item }) => {
      const actions = Array.isArray(item.metadata?.actions) ? item.metadata.actions as any[] : [];
      return actions.map((action) => {
        let score = scoreCollectionItem({ item, collection, step: input.step, phase: input.phase, runState: input.runState });
        const actionText = [action?.text, rowActionPurpose(action)].filter(Boolean).join(' ');
        if (target?.purpose && includesTarget(rowActionPurpose(action), target.purpose)) score += 90;
        if (target?.text && includesTarget(actionText, target.text)) score += 60;
        if ((input.step.action === 'download_file' || input.phase?.type === 'download_file') && rowActionPurpose(action) === 'download_button') score += 110;
        if (target?.ordinal && item.index === target.ordinal) score += 80;
        return { collection, item, action, score };
      });
    })
    .filter(({ action }) => Boolean(action?.elementId || action?.selector))
    .filter(({ action }) => input.step.action !== 'download_file' || rowActionPurpose(action) === 'download_button')
    .filter(({ action }) => !isFailed(input.phaseMemory, action))
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index);
  const bestRowAction = rowActionCandidates[0];
  if (bestRowAction && bestRowAction.score >= 30) {
    return {
      elementId: bestRowAction.action.elementId,
      selector: bestRowAction.action.selector,
      text: bestRowAction.action.text || bestRowAction.item.text,
      purpose: rowActionPurpose(bestRowAction.action) || target?.purpose || '',
      source: 'collection',
      matchedBy: 'collection_row_action',
      score: bestRowAction.score,
      verificationHint: verificationHint(input.step),
    };
  }

  const candidates = collections.flatMap((collection) => (
    collection.items.map((item) => ({ collection, item, score: scoreCollectionItem({ item, collection, step: input.step, phase: input.phase, runState: input.runState }) }))
  ))
    .filter(({ collection, item }) => {
      if (collection.type !== 'menu_group' || !target?.text) return true;
      return includesTarget(item.text, target.text);
    })
    .filter(({ item }) => Boolean(item.elementId || item.selector))
    .filter(({ item }) => input.step.action !== 'download_file' || itemPurpose(item) === 'download_button')
    .filter(({ collection, item }) => (
      collection.type !== 'action_group'
      || input.step.action !== 'download_file'
      || Boolean(target?.ordinal)
      || !Number(item.metadata?.rowIndex || 0)
    ))
    .filter(({ item }) => !isFailed(input.phaseMemory, item))
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index);
  const best = candidates[0];
  if (!best || best.score < 15) return null;
  return {
    elementId: best.item.elementId,
    selector: best.item.selector,
    text: best.item.text,
    href: best.item.href,
    purpose: itemPurpose(best.item) || target?.purpose || '',
    source: 'collection',
    matchedBy: target?.ordinal ? 'collection_ordinal' : target?.purpose ? 'collection_purpose' : 'collection_semantic_text',
    score: best.score,
    verificationHint: verificationHint(input.step),
  };
}

function findElementCandidate(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}): ResolutionCandidate | null {
  const target = input.step.target;
  const targetText = target?.text || phaseLeaf(input.phase) || downloadFileName(input.runState);
  const parentPath = target?.parentPath || phaseParents(input.phase);
  const elements = input.context.observation.elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => input.step.action !== 'download_file' || element.purpose === 'download_button')
    .filter((element) => input.step.action !== 'download_file' || Boolean(target?.ordinal) || element.region !== 'table_area')
    .filter((element) => !isFailed(input.phaseMemory, element))
    .map((element) => {
      let score = (element.score || 0) * 10;
      const text = elementText(element);
      if (target?.elementId && element.elementId === target.elementId) score += 100;
      if (target?.selector && (element.selector === target.selector || element.selectors?.includes(target.selector))) score += 90;
      if (targetText && includesTarget(text, targetText)) score += 36;
      if (target?.purpose && element.purpose === target.purpose) score += 30;
      if (input.step.action === 'download_file' && element.purpose === 'download_button') score += 70;
      if (input.phase?.type === 'navigate_to_page' && ['menu_item', 'navigation_item'].includes(element.purpose || '')) score += 30;
      if (input.phase?.type === 'open_page_or_center' && ['menu_item', 'navigation_item'].includes(element.purpose || '')) score += 20;
      for (const parent of parentPath) {
        if (includesTarget(text, parent)) score += 14;
      }
      if (element.active) score += 4;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = elements[0];
  if (!best || best.score < 20) return null;
  return {
    elementId: best.element.elementId,
    selector: best.element.selector,
    text: best.element.text,
    purpose: best.element.purpose,
    source: 'element',
    matchedBy: 'element_fallback',
    score: best.score,
    verificationHint: verificationHint(input.step),
  };
}

function rejectedCandidates(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
}): RejectedTargetCandidate[] {
  const target = input.step.target;
  return (input.context.collections || []).flatMap((collection) => collection.items.map((item) => {
    const score = scoreCollectionItem({ item, collection, step: input.step, phase: input.phase, runState: input.runState });
    const purpose = itemPurpose(item);
    let reason = '语义匹配分数不足';
    if (target?.collectionType && collection.type !== target.collectionType) reason = `集合类型不匹配，期望 ${target.collectionType}`;
    else if (target?.purpose && purpose !== target.purpose) reason = `动作用途不匹配，期望 ${target.purpose}`;
    else if (target?.ordinal && item.index !== target.ordinal) reason = `序号不匹配，期望第 ${target.ordinal} 项`;
    return { text: item.text, purpose, collectionType: collection.type, score, reason };
  }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 8);
}

function actionNeedsTarget(step: PlannedStep): boolean {
  if ([
    'finish', 'wait', 'scroll', 'extract_table', 'press_key', 'keyboard_shortcut',
    'open_tab', 'switch_tab', 'close_tab', 'go_back', 'go_forward', 'reload',
  ].includes(step.action)) return false;
  if (step.target?.x !== undefined && step.target?.y !== undefined) return false;
  return true;
}

export function resolvePlannedStepTarget(input: {
  step: PlannedStep;
  context: ComputerUsePageContext;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}): TargetResolution {
  if (!actionNeedsTarget(input.step)) return { step: input.step };
  const semanticTarget = Boolean(
    input.step.target?.collectionType
    || input.step.target?.collectionId
    || input.step.target?.ordinal
    || input.step.target?.parentPath?.length
  );
  const collectionCandidate = findCollectionCandidate(input);
  const explicitCandidate = findExplicitCandidate(input);
  const candidate = semanticTarget
    ? collectionCandidate || explicitCandidate || findElementCandidate(input)
    : explicitCandidate || collectionCandidate || findElementCandidate(input);
  if (!candidate) {
    const downloadTarget = input.step.action === 'download_file' || input.phase?.type === 'download_file';
    return {
      step: input.step,
      blocked: true,
      reason: downloadTarget
        ? '无法解析真实导出/下载按钮：当前语义集合中没有可用的 download_button。'
        : `无法解析动作目标：${input.step.target?.text || input.step.target?.purpose || input.phase?.goal || input.step.action}`,
      rejectedCandidates: rejectedCandidates(input),
      verificationHint: verificationHint(input.step),
    };
  }

  const nextStep: PlannedStep = {
    ...input.step,
    target: {
      ...input.step.target,
      elementId: candidate.elementId || input.step.target?.elementId,
      selector: candidate.selector || input.step.target?.selector,
      text: candidate.text || input.step.target?.text,
      href: candidate.href || input.step.target?.href,
      purpose: candidate.purpose || input.step.target?.purpose,
      x: candidate.x ?? input.step.target?.x,
      y: candidate.y ?? input.step.target?.y,
    },
  };
  const element = candidate.elementId
    ? input.context.observation.elements.find((item) => item.elementId === candidate.elementId)
    : candidate.selector
      ? input.context.observation.elements.find((item) => item.selector === candidate.selector || item.selectors?.includes(candidate.selector || ''))
      : undefined;
  return {
    step: nextStep,
    element,
    candidate,
    matchedBy: candidate.matchedBy,
    score: candidate.score,
    verificationHint: candidate.verificationHint || verificationHint(input.step),
  };
}
