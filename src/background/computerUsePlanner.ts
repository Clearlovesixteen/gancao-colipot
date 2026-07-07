import type {
  BrowserActionType,
  ComputerUseAction,
  ComputerUsePhase,
  ComputerUsePhaseMemory,
  ComputerUseIntent,
  ComputerUsePageContext,
  ComputerUsePlan,
  ComputerUseRunState,
  PlannedStep,
} from '../shared/automationTypes';
import { extractTablesFromComputerUseResult, summarizeExtractedTables } from '../shared/computerUseResults';

type PlannerLLM = (input: {
  system: string;
  user: unknown;
}) => Promise<unknown>;

function compact(text?: string): string {
  return (text || '').replace(/\s+/g, '').trim();
}

function includesAnyTarget(text: string, targets: string[]): boolean {
  const haystack = compact(text);
  return targets.some((target) => target && haystack.includes(compact(target)));
}

function baseFileName(filename?: string): string {
  return String(filename || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function isDataTask(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'data_extraction'
    || intent.taskType === 'download'
    || intent.desiredOutput === 'table_data'
    || intent.desiredOutput === 'download_file'
    || /(列表|表格|数据|导出|下载|提取|获取|读取)/i.test(intent.rawGoal);
}

function isDownloadTask(intent: ComputerUseIntent): boolean {
  return intent.taskType === 'download'
    || intent.desiredOutput === 'download_file'
    || /(导出|下载|download|export)/i.test(intent.rawGoal);
}

function getOrderedTargets(targets: string[]): string[] {
  return [...targets].filter(Boolean).reverse();
}

function getNavigationPath(intent: ComputerUseIntent): string[] {
  return (intent.navigationPath || []).filter(Boolean);
}

function getPrimaryTarget(targets: string[]): string | undefined {
  return getOrderedTargets(targets)[0];
}

function getParentTargets(targets: string[]): string[] {
  const ordered = getOrderedTargets(targets);
  return ordered.slice(1);
}

function getParentPathForTarget(path: string[], target?: string): string[] {
  if (!path.length || !target) return [];
  const index = path.findIndex((item) => compact(item) === compact(target));
  if (index <= 0) return [];
  return path.slice(0, index);
}

function getObservedOrderIndex(elementOrId: any): number | null {
  const elementId = typeof elementOrId === 'string' ? elementOrId : elementOrId?.elementId;
  const match = String(elementId || '').match(/_(\d+)$/);
  return match ? Number(match[1]) : null;
}

function isFailedCandidate(phaseMemory: ComputerUsePhaseMemory | undefined, element: any): boolean {
  if (!phaseMemory?.failedCandidates?.length || !element) return false;
  const elementId = String(element.elementId || '');
  const selector = String(element.selector || '');
  const text = compact(element.text);
  return phaseMemory.failedCandidates.some((candidate) => {
    if (candidate.elementId && elementId && candidate.elementId === elementId) return true;
    if (candidate.selector && selector && candidate.selector === selector) return true;
    if (!candidate.elementId && !candidate.selector && candidate.text && text && compact(candidate.text) === text) return true;
    return false;
  });
}

function getLastClickedParentOrder(history: unknown[], path: string[], target: string): number | null {
  const targetIndex = path.findIndex((item) => compact(item) === compact(target));
  const parentTargets = targetIndex > 0 ? path.slice(0, targetIndex) : path.slice(0, -1);
  if (!parentTargets.length) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item: any = history[index];
    if (item?.action?.action !== 'click' || item?.verification?.success === false) continue;
    const actionText = compact(item.action?.text);
    if (parentTargets.some((parent) => actionText === compact(parent))) {
      const order = getObservedOrderIndex(item.action?.elementId);
      if (order !== null) return order;
    }
  }
  return null;
}

function isAfterClickedParent(element: any, path: string[], target: string, history: unknown[] = []): boolean {
  const parentOrder = getLastClickedParentOrder(history, path, target);
  const elementOrder = getObservedOrderIndex(element);
  return parentOrder !== null && elementOrder !== null && elementOrder > parentOrder;
}

function findBestTargetNavigation(context: ComputerUsePageContext, targets: string[], path: string[] = [], history: unknown[] = [], phaseMemory?: ComputerUsePhaseMemory): any | null {
  if (!targets.length) return null;
  for (const target of getOrderedTargets(targets)) {
    const matched = findNavigationForTarget(context, target, path, history, phaseMemory);
    if (matched) return matched;
  }

  return null;
}

function getNavigationContextText(element: any): string {
  return [
    element?.text,
    element?.parentText,
    Array.isArray(element?.parentPath) ? element.parentPath.join(' ') : undefined,
    element?.context,
    element?.selector,
  ].filter(Boolean).join(' ');
}

function getSemanticNavigationCandidates(context: ComputerUsePageContext): any[] {
  const seen = new Set<string>();
  const candidates = [
    ...context.navigationCandidates,
    ...(context.collections || [])
      .filter((collection) => collection.type === 'menu_group')
      .flatMap((collection) => collection.items.map((item) => ({
        elementId: item.elementId,
        selector: item.selector,
        text: item.text,
        purpose: item.purpose || item.metadata?.purpose || 'menu_item',
        parentText: item.parentText || item.parentPath?.join(' '),
        parentPath: item.parentPath,
        context: item.context || collection.title,
        bbox: item.bbox,
        active: item.active ?? item.metadata?.active,
        expanded: item.expanded ?? item.metadata?.expanded,
        clickable: item.clickable,
        score: (item.confidence || 0) * 10,
      }))),
  ];
  return candidates.filter((candidate) => {
    const key = candidate.elementId || candidate.selector || `${candidate.text}:${candidate.parentText}:${candidate.context}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isAggregateNavigationCandidate(element: any, target: string): boolean {
  const text = compact(element?.text);
  const targetText = compact(target);
  if (!text || !targetText || text === targetText) return false;
  const tooLongForLeaf = text.includes(targetText) && text.length > targetText.length + 16;
  const zeroHeightContainer = Number(element?.bbox?.height || 0) <= 4;
  const nonInteractiveContainer = !element?.clickable && ['div', 'list', 'group'].includes(String(element?.role || 'div'));
  return tooLongForLeaf && (zeroHeightContainer || nonInteractiveContainer);
}

function navigationMatchesParentPath(element: any, path: string[], target: string): boolean {
  const targetIndex = path.findIndex((item) => compact(item) === compact(target));
  const parentTargets = targetIndex > 0 ? path.slice(0, targetIndex) : path.slice(0, -1);
  if (!parentTargets.length) return true;
  const contextText = getNavigationContextText(element);
  return parentTargets.some((parent) => includesAnyTarget(contextText, [parent]));
}

function isLeafTarget(path: string[], target: string): boolean {
  return path.length > 1 && compact(path[path.length - 1]) === compact(target);
}

function navigationMatchesLeafText(element: any, target: string): boolean {
  const elementText = compact(element?.text);
  const targetText = compact(target);
  if (!elementText || !targetText) return false;
  return elementText === targetText || (elementText.includes(targetText) && elementText.length <= targetText.length + 8);
}

function findNavigationForTarget(context: ComputerUsePageContext, target: string, path: string[] = [], history: unknown[] = [], phaseMemory?: ComputerUsePhaseMemory): any | null {
  const compactTarget = compact(target);
  if (!compactTarget) return null;
  const targetIsLeaf = isLeafTarget(path, target);
  const candidates = getSemanticNavigationCandidates(context)
    .filter((element) => includesAnyTarget(`${element.text} ${element.context || ''}`, [target]))
    .filter((element) => !targetIsLeaf || navigationMatchesLeafText(element, target))
    .filter((element) => !isAggregateNavigationCandidate(element, target))
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .sort((a, b) => {
      const aExact = compact(a.text) === compactTarget ? 1 : 0;
      const bExact = compact(b.text) === compactTarget ? 1 : 0;
      const aParentMatch = navigationMatchesParentPath(a, path, target) ? 1 : 0;
      const bParentMatch = navigationMatchesParentPath(b, path, target) ? 1 : 0;
      const aAfterParent = isAfterClickedParent(a, path, target, history) ? 1 : 0;
      const bAfterParent = isAfterClickedParent(b, path, target, history) ? 1 : 0;
      const aActive = a.active ? 1 : 0;
      const bActive = b.active ? 1 : 0;
      return bParentMatch - aParentMatch
        || bAfterParent - aAfterParent
        || bExact - aExact
        || bActive - aActive
        || (b.score || 0) - (a.score || 0);
    });
  return candidates[0] || null;
}

function getNavigationCandidatesForTarget(context: ComputerUsePageContext, target: string): any[] {
  return getSemanticNavigationCandidates(context).filter((element) => includesAnyTarget(`${element.text} ${element.context || ''}`, [target]));
}

function hasClickedTargetWithoutAmbiguity(context: ComputerUsePageContext, history: unknown[], target: string, path: string[] = []): boolean {
  const pathAwareTarget = findNavigationForTarget(context, target, path, history);
  if (pathAwareTarget && hasClickedNavigation(history, pathAwareTarget)) return true;
  const candidates = getNavigationCandidatesForTarget(context, target);
  if (candidates.length <= 1) return hasClickedTargetText(history, target);
  return false;
}

function isNavigationActiveOrPageReady(context: ComputerUsePageContext, target: string): boolean {
  const navigation = findNavigationForTarget(context, target);
  return Boolean(navigation?.active)
    || includesAnyTarget([
      context.observation.title,
      context.observation.url,
      context.pageTextPreview,
      context.structuredData?.headings?.join(' '),
    ].filter(Boolean).join(' '), [target]);
}

function isNavigationTargetActive(context: ComputerUsePageContext, target: string): boolean {
  return getSemanticNavigationCandidates(context).some((element) => {
    if (!element.active) return false;
    return includesAnyTarget(getNavigationContextText(element), [target]);
  });
}

function isTargetInPageChrome(context: ComputerUsePageContext, target: string): boolean {
  return includesAnyTarget([
    context.observation.title,
    context.observation.url,
    context.structuredData?.headings?.join(' '),
  ].filter(Boolean).join(' '), [target]);
}

function hasReachedNavigationPath(intent: ComputerUseIntent, context: ComputerUsePageContext, history: unknown[]): boolean {
  const path = getNavigationPath(intent);
  if (!path.length) return false;
  const leaf = path[path.length - 1];
  const parentTargets = path.slice(0, -1);
  const activeLeafWithPath = context.navigationCandidates.some((element) => (
    element.active
    && includesAnyTarget(getNavigationContextText(element), [leaf])
    && navigationMatchesParentPath(element, path, leaf)
  ));
  const chromeText = [
    context.observation.title,
    context.observation.url,
    context.structuredData?.headings?.join(' '),
  ].filter(Boolean).join(' ');
  const pageChromeHasFullPath = includesAnyTarget(chromeText, [leaf])
    && (!parentTargets.length || parentTargets.some((parent) => includesAnyTarget(chromeText, [parent])));
  const leafReady = activeLeafWithPath
    || pageChromeHasFullPath;
  if (!leafReady) return false;

  if (!parentTargets.length) {
    return isNavigationActiveOrPageReady(context, leaf) || hasClickedTargetText(history, leaf);
  }

  return parentTargets.some((parent) => (
    isNavigationTargetActive(context, parent)
    || isTargetInPageChrome(context, parent)
    || hasClickedTargetText(history, parent)
  ));
}

function getNextNavigationPathTarget(intent: ComputerUseIntent, context: ComputerUsePageContext, history: unknown[], phaseMemory?: ComputerUsePhaseMemory): { target: string; element: any | null; missing?: boolean } | null {
  const path = getNavigationPath(intent);
  if (!path.length) return null;
  const leaf = path[path.length - 1];
  if (hasReachedNavigationPath(intent, context, history)) return null;

  const parentTargets = path.slice(0, -1);
  const leafElement = findNavigationForTarget(context, leaf, path, history, phaseMemory);
  if (
    leafElement
    && !hasClickedNavigation(history, leafElement)
    && (
      !parentTargets.length
      || navigationMatchesParentPath(leafElement, path, leaf)
      || parentTargets.some((target) => hasClickedTargetText(history, target) || isNavigationTargetActive(context, target) || isTargetInPageChrome(context, target))
    )
  ) {
    return { target: leaf, element: leafElement };
  }

  const nextParentTarget = parentTargets.find((target) => (
    !isNavigationTargetActive(context, target)
    && !isTargetInPageChrome(context, target)
    && !hasClickedTargetText(history, target)
  ));
  if (nextParentTarget) {
    const parentElement = findNavigationForTarget(context, nextParentTarget, path, history, phaseMemory);
    if (parentElement && !hasClickedNavigation(history, parentElement)) {
      return { target: nextParentTarget, element: parentElement };
    }
    if (
      hasReachedNavigationPath({ navigationPath: path } as ComputerUseIntent, context, history)
      && hasActionableEvidence(context, [leaf])
    ) {
      return null;
    }
  }

  if (leafElement && !hasClickedNavigation(history, leafElement)) return { target: leaf, element: leafElement };

  for (const target of path) {
    if (isNavigationTargetActive(context, target) || isTargetInPageChrome(context, target) || hasClickedTargetText(history, target)) continue;
    const element = findNavigationForTarget(context, target, path, history, phaseMemory);
    return { target, element, missing: !element };
  }

  return { target: leaf, element: null, missing: true };
}

function hasClickedNavigation(history: unknown[], navigation: any): boolean {
  const targetText = compact(navigation?.text);
  return history.some((item: any) => {
    if (item?.action?.action !== 'click' || item?.verification?.success === false) return false;
    if (navigation?.elementId && item.action.elementId === navigation.elementId) return true;
    if (navigation?.elementId && item.action.elementId) return false;
    const actionText = compact([
      item.action.text,
      item.action.selector,
    ].filter(Boolean).join(' '));
    return Boolean(targetText && actionText.includes(targetText));
  });
}

function hasClickedElement(history: unknown[], element: any): boolean {
  const targetText = compact(element?.text);
  return history.some((item: any) => {
    if (item?.action?.action !== 'click' && item?.action?.action !== 'download_file') return false;
    if (element?.elementId && item.action.elementId === element.elementId) return true;
    if (element?.elementId && item.action.elementId) return false;
    const actionText = compact([
      item.action.text,
      item.action.selector,
    ].filter(Boolean).join(' '));
    return Boolean(targetText && actionText.includes(targetText));
  });
}

function hasClickedTargetText(history: unknown[], target?: string): boolean {
  const targetText = compact(target);
  if (!targetText) return false;
  return history.some((item: any) => {
    if (item?.action?.action !== 'click' && item?.action?.action !== 'download_file') return false;
    if (item?.verification?.success === false) return false;
    const actionText = compact([
      item.action?.text,
      item.action?.selector,
    ].filter(Boolean).join(' '));
    return Boolean(actionText && actionText.includes(targetText));
  });
}

function hasActionableEvidence(context: ComputerUsePageContext, targets: string[]): boolean {
  return context.tableCandidates.length > 0
    || Boolean(findBestTargetNavigation(context, targets))
    || context.actionCandidates.length > 0;
}

function summarizeElement(element: any): any {
  return {
    elementId: element.elementId,
    role: element.role,
    tag: element.tag,
    text: element.text,
    purpose: element.purpose,
    score: element.score,
    selector: element.selector,
    visible: element.visible,
    enabled: element.enabled,
    value: element.value,
    placeholder: element.placeholder,
    parentText: element.parentText,
    level: element.level,
    expanded: element.expanded,
    active: element.active,
    region: element.region,
    context: element.context,
  };
}

function summarizeCollection(collection: any): any {
  return {
    id: collection.id,
    type: collection.type,
    title: collection.title,
    confidence: collection.confidence,
    metadata: collection.metadata,
    items: Array.isArray(collection.items)
      ? collection.items.slice(0, 20).map((item: any) => ({
        index: item.index,
        text: item.text,
        elementId: item.elementId,
        selector: item.selector,
        parentText: item.parentText,
        parentPath: item.parentPath,
        context: item.context,
        href: item.href,
        purpose: item.purpose,
        active: item.active,
        expanded: item.expanded,
        clickable: item.clickable,
        metadata: item.metadata,
        confidence: item.confidence,
      }))
      : [],
  };
}

function findBestDownloadAction(context: ComputerUsePageContext, phaseMemory?: ComputerUsePhaseMemory): any | null {
  const actionGroupCandidates = (context.collections || [])
    .filter((collection) => collection.type === 'action_group')
    .flatMap((collection) => collection.items)
    .filter((item) => (item.purpose || item.metadata?.purpose) === 'download_button')
    .filter((item) => Boolean(item.elementId || item.selector))
    .filter((item) => !isFailedCandidate(phaseMemory, item))
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  if (actionGroupCandidates[0]) {
    const item = actionGroupCandidates[0];
    return {
      elementId: item.elementId,
      selector: item.selector,
      text: item.text,
      purpose: item.purpose || item.metadata?.purpose,
      score: item.confidence,
    };
  }

  const candidates = [
    ...context.actionCandidates,
    ...context.observation.elements.filter((element) => element.purpose === 'download_button'),
  ]
    .filter((element) => element.visible && element.enabled && element.purpose === 'download_button')
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  return candidates[0] || null;
}

function findExpandableAction(context: ComputerUsePageContext, history: unknown[], phaseMemory?: ComputerUsePhaseMemory): any | null {
  const candidates = context.observation.elements
    .filter((element) => element.visible && element.enabled && ['button', 'link', 'menuitem'].includes(element.role))
    .filter((element) => /(更多|操作|批量操作|更多操作|展开|more|actions?)/i.test(`${element.text} ${element.context || ''}`))
    .filter((element) => !hasClickedElement(history, element))
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  return candidates[0] || null;
}

function findTextActionCandidate(context: ComputerUsePageContext, targets: string[], history: unknown[] = [], phaseMemory?: ComputerUsePhaseMemory): any | null {
  const candidates = [
    ...context.navigationCandidates,
    ...context.actionCandidates,
    ...context.observation.elements,
  ]
    .filter((element) => element.visible && element.enabled)
    .filter((element) => includesAnyTarget([
      element.text,
      element.context,
      element.parentText,
      element.href,
      element.selector,
    ].filter(Boolean).join(' '), targets))
    .filter((element) => !hasClickedElement(history, element))
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .sort((a, b) => {
      const aInteractive = a.clickable || ['button', 'link', 'menuitem', 'option'].includes(a.role) ? 1 : 0;
      const bInteractive = b.clickable || ['button', 'link', 'menuitem', 'option'].includes(b.role) ? 1 : 0;
      const aExact = targets.some((target) => compact(a.text) === compact(target)) ? 1 : 0;
      const bExact = targets.some((target) => compact(b.text) === compact(target)) ? 1 : 0;
      return bInteractive - aInteractive
        || bExact - aExact
        || (b.score || 0) - (a.score || 0)
        || compact(a.text).length - compact(b.text).length;
    });
  return candidates[0] || null;
}

function formFieldText(element: any): string {
  return [
    element.text,
    element.context,
    element.parentText,
    element.placeholder,
    element.name,
    element.selector,
    element.value,
  ].filter(Boolean).join(' ');
}

function isFormControl(element: any): boolean {
  const text = `${element.role || ''} ${element.tag || ''} ${element.selector || ''} ${element.context || ''} ${element.placeholder || ''}`;
  return /(textbox|combobox|spinbutton|searchbox|input|textarea|select|ant-select|ant-input|ant-picker)/i.test(text);
}

function findFormFieldCandidate(
  context: ComputerUsePageContext,
  formValue: NonNullable<ComputerUsePhase['formValues']>[number],
  phaseMemory?: ComputerUsePhaseMemory
): any | null {
  const label = formValue.label;
  const control = formValue.control || 'input';
  const formItems = (context.collections || [])
    .filter((collection) => collection.type === 'form_group')
    .flatMap((collection) => collection.items)
    .filter((item) => Boolean(item.elementId || item.selector))
    .filter((item) => !isFailedCandidate(phaseMemory, item))
    .map((item) => {
      let score = (item.confidence || 0) * 10;
      const metadata = item.metadata || {};
      const text = [
        item.text,
        item.context,
        item.parentText,
        metadata.label,
        metadata.placeholder,
        metadata.controlType,
      ].filter(Boolean).join(' ');
      if (includesAnyTarget(text, [label])) score += 90;
      if (compact(String(metadata.label || '')) === compact(label) || compact(item.text) === compact(label)) score += 70;
      if (control === 'select' && /select|combobox/.test(String(metadata.controlType || ''))) score += 45;
      if (control === 'select' && /input|textarea/.test(String(metadata.controlType || ''))) score -= 35;
      if (control === 'input' && /input|textarea|date/.test(String(metadata.controlType || ''))) score += 30;
      if (control === 'input' && /select|combobox/.test(String(metadata.controlType || ''))) score -= 25;
      if (!includesAnyTarget(text, [label])) score -= 50;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);
  const formItemMatch = formItems[0];
  if (formItemMatch && formItemMatch.score >= 45) {
    return {
      elementId: formItemMatch.item.elementId,
      selector: formItemMatch.item.selector,
      text: formItemMatch.item.text,
      purpose: formItemMatch.item.purpose,
      score: formItemMatch.score,
    };
  }

  const candidates = context.observation.elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => isFormControl(element))
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .map((element) => {
      let score = (element.score || 0) * 10;
      const text = formFieldText(element);
      if (includesAnyTarget(text, [label])) score += 80;
      if (compact(element.parentText) === compact(label) || compact(element.context) === compact(label)) score += 60;
      if (compact(element.placeholder) === compact(label) || includesAnyTarget(element.placeholder || '', [label])) score += 30;
      if (control === 'select' && /(combobox|select|ant-select)/i.test(`${element.role} ${element.selector} ${element.context}`)) score += 35;
      if (control === 'select' && /(input|textarea|ant-input)/i.test(`${element.tag} ${element.selector}`) && !/ant-select/i.test(`${element.selector} ${element.context}`)) score -= 35;
      if (control === 'input' && /(input|textarea|textbox|searchbox)/i.test(`${element.role} ${element.tag} ${element.selector}`)) score += 25;
      if (control === 'input' && /(combobox|ant-select)/i.test(`${element.role} ${element.selector} ${element.context}`)) score -= 25;
      if (!includesAnyTarget(text, [label])) score -= 50;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 45 ? best.element : null;
}

function findActionButtonCandidate(
  context: ComputerUsePageContext,
  targets: string[],
  phaseMemory?: ComputerUsePhaseMemory
): any | null {
  const actionItems = (context.collections || [])
    .filter((collection) => collection.type === 'action_group')
    .flatMap((collection) => collection.items)
    .filter((item) => Boolean(item.elementId || item.selector))
    .filter((item) => !isFailedCandidate(phaseMemory, item))
    .map((item) => {
      let score = (item.confidence || 0) * 10;
      const text = [item.text, item.context, item.parentText, item.purpose, item.metadata?.purpose].filter(Boolean).join(' ');
      if (includesAnyTarget(text, targets)) score += 80;
      if (targets.some((target) => /(搜索|查询|筛选)/.test(target)) && item.purpose === 'search_button') score += 50;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index);
  const itemMatch = actionItems[0];
  if (itemMatch && itemMatch.score >= 35) {
    return {
      elementId: itemMatch.item.elementId,
      selector: itemMatch.item.selector,
      text: itemMatch.item.text,
      purpose: itemMatch.item.purpose || itemMatch.item.metadata?.purpose,
      score: itemMatch.score,
    };
  }

  const candidates = [
    ...context.actionCandidates,
    ...context.observation.elements,
  ]
    .filter((element) => element.visible && element.enabled)
    .filter((element) => ['button', 'link', 'menuitem'].includes(element.role) || element.clickable)
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .map((element) => {
      let score = (element.score || 0) * 10;
      const text = [element.text, element.context, element.parentText, element.purpose, element.name, element.selector].filter(Boolean).join(' ');
      if (includesAnyTarget(text, targets)) score += 70;
      if (targets.some((target) => /(搜索|查询|筛选)/.test(target)) && element.purpose === 'search_button') score += 50;
      if (compact(element.text) && targets.some((target) => compact(element.text) === compact(target))) score += 40;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0] && candidates[0].score >= 45 ? candidates[0].element : null;
}

function findTableRowActionCandidate(
  context: ComputerUsePageContext,
  targets: string[],
  ordinal?: number,
  phaseMemory?: ComputerUsePhaseMemory
): any | null {
  if (!ordinal) return null;
  const row = (context.collections || [])
    .filter((collection) => collection.type === 'table_row_group')
    .flatMap((collection) => collection.items)
    .filter((item) => item.index === ordinal)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
  if (!row) return null;

  const actions = Array.isArray(row.metadata?.actions) ? row.metadata.actions as any[] : [];
  const matched = actions
    .filter((action) => action?.elementId)
    .filter((action) => !isFailedCandidate(phaseMemory, action))
    .map((action) => {
      let score = 0;
      const text = [action.text, action.purpose, action.riskLevel].filter(Boolean).join(' ');
      if (includesAnyTarget(text, targets)) score += 80;
      if (targets.some((target) => /(导出|下载|download|export)/i.test(target)) && action.purpose === 'download_button') score += 100;
      if (targets.some((target) => /(编辑|修改|edit)/i.test(target)) && /(编辑|修改|edit)/i.test(text)) score += 70;
      return { action, score };
    })
    .sort((a, b) => b.score - a.score)[0];

  if (!matched || matched.score < 40) return null;
  return {
    elementId: matched.action.elementId,
    selector: matched.action.selector,
    text: matched.action.text || targets[0],
    purpose: matched.action.purpose,
    score: matched.score,
    rowText: row.text,
  };
}

function findLatestDownloadCandidate(context: ComputerUsePageContext, runState?: ComputerUseRunState, phaseMemory?: ComputerUsePhaseMemory): any | null {
  const filename = baseFileName(runState?.downloadResult?.filename || runState?.downloadResult?.assetTitle);
  const targets = filename ? [filename, filename.replace(/\.[^.]+$/, '')] : [];
  const fileCollectionItems = (context.collections || [])
    .filter((collection) => collection.type === 'file_list')
    .flatMap((collection) => collection.items)
    .filter((item) => Boolean(item.elementId || item.selector))
    .filter((item) => !isFailedCandidate(phaseMemory, item))
    .map((item) => {
      const text = [
        item.text,
        item.context,
        item.href,
        item.metadata?.filename,
        item.metadata?.originalText,
      ].filter(Boolean).join(' ');
      let score = (item.confidence || 0) * 10;
      if (targets.length && includesAnyTarget(text, targets)) score += 100;
      if (!targets.length && item.index === 1) score += 20;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.index - b.item.index);
  const collectionMatch = fileCollectionItems[0];
  if (collectionMatch && collectionMatch.score >= (targets.length ? 80 : 20)) {
    return {
      elementId: collectionMatch.item.elementId,
      selector: collectionMatch.item.selector,
      text: collectionMatch.item.text,
      purpose: collectionMatch.item.purpose || collectionMatch.item.metadata?.purpose,
      score: collectionMatch.score,
    };
  }

  if (targets.length) {
    const matched = findTextActionCandidate(context, targets, [], phaseMemory);
    if (matched) return matched;
  }

  const fileLike = context.observation.elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => /\.(xlsx?|csv|pdf|docx?|pptx?|txt|zip)\b/i.test(`${element.text} ${element.context || ''}`))
    .filter((element) => !isFailedCandidate(phaseMemory, element))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  return fileLike[0] || null;
}

const SUPPORTED_ACTIONS = new Set<BrowserActionType | 'finish'>([
  'click',
  'double_click',
  'right_click',
  'click_by_coordinate',
  'type',
  'clear_input',
  'focus',
  'keyboard_shortcut',
  'press_key',
  'select_option',
  'check',
  'hover',
  'drag',
  'scroll',
  'wait',
  'wait_for_element',
  'upload_file',
  'download_file',
  'extract_table',
  'finish',
]);

function normalizeActionName(action: string): BrowserActionType | 'finish' | null {
  const normalized = action.trim().toLowerCase();
  const aliases: Record<string, BrowserActionType | 'finish'> = {
    fill: 'type',
    input: 'type',
    enter_text: 'type',
    fill_form: 'type',
    clear: 'clear_input',
    clear_text: 'clear_input',
    focus_element: 'focus',
    shortcut: 'keyboard_shortcut',
    hotkey: 'keyboard_shortcut',
    dblclick: 'double_click',
    doubleclick: 'double_click',
    rightclick: 'right_click',
    coordinate_click: 'click_by_coordinate',
    press: 'press_key',
    key: 'press_key',
    select: 'select_option',
    choose: 'select_option',
    download: 'download_file',
    export: 'download_file',
    export_file: 'download_file',
    click_download: 'download_file',
    extract: 'extract_table',
    extract_tables: 'extract_table',
    extract_page_tables: 'extract_table',
    done: 'finish',
    stop: 'finish',
  };
  const actionName = aliases[normalized] || normalized;
  return SUPPORTED_ACTIONS.has(actionName as BrowserActionType | 'finish')
    ? actionName as BrowserActionType | 'finish'
    : null;
}

function normalizePlan(raw: unknown): ComputerUsePlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<ComputerUsePlan>;
  const steps = Array.isArray(data.steps)
    ? data.steps
      .filter((step: any) => step && typeof step === 'object' && typeof step.action === 'string')
      .slice(0, 3)
      .map((step: any, index): PlannedStep | null => {
        const action = normalizeActionName(step.action);
        if (!action) return null;
        return {
          id: typeof step.id === 'string' ? step.id : `step_${index + 1}`,
          action,
          target: step.target && typeof step.target === 'object' ? step.target : undefined,
          value: typeof step.value === 'string' ? step.value : typeof step.text === 'string' ? step.text : undefined,
          rationale: typeof step.rationale === 'string' ? step.rationale : step.reason || action,
          verify: step.verify && typeof step.verify === 'object' ? step.verify : undefined,
          highRisk: step.highRisk === true,
          summary: typeof step.summary === 'string' ? step.summary : undefined,
        };
      })
      .filter((step): step is PlannedStep => Boolean(step))
    : [];
  if (!steps.length) return null;
  return {
    summary: typeof data.summary === 'string' ? data.summary : steps[0].rationale,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0.5,
    steps,
    successCriteria: Array.isArray(data.successCriteria) ? data.successCriteria.map(String).slice(0, 5) : [],
    needsUserInput: typeof data.needsUserInput === 'string' ? data.needsUserInput : undefined,
  };
}

function makeFinishPlan(summary: string): ComputerUsePlan {
  return {
    summary,
    confidence: 0.9,
    steps: [{ id: 'finish', action: 'finish', rationale: summary, summary }],
    successCriteria: [],
  };
}

function makeWaitPlan(ms: number): ComputerUsePlan {
  return {
    summary: `等待 ${ms}ms`,
    confidence: 0.95,
    steps: [{
      id: 'wait',
      action: 'wait',
      value: String(ms),
      rationale: `按任务要求等待 ${ms}ms`,
      summary: `等待 ${ms}ms`,
    }],
    successCriteria: ['等待完成'],
  };
}

function isExecutableRulePlan(plan: ComputerUsePlan): boolean {
  const firstStep = plan.steps[0];
  if (!firstStep || firstStep.action === 'finish') return false;
  return plan.confidence >= 0.7;
}

function getCompletedExtractTableSummary(history: unknown[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index] as {
      action?: ComputerUseAction;
      result?: unknown;
      verification?: { success?: boolean };
    };
    if (item?.action?.action !== 'extract_table' || item.verification?.success !== true) continue;
    const summary = summarizeExtractedTables(extractTablesFromComputerUseResult(item.result));
    if (summary) return `已完成表格提取：${summary.tableCount} 个表格，共 ${summary.rowCount} 行。`;
  }
  return null;
}

function getCompletedDownloadSummary(history: unknown[]): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index] as {
      action?: ComputerUseAction;
      result?: any;
      verification?: { success?: boolean };
    };
    if (item?.action?.action !== 'download_file' || item.verification?.success !== true) continue;
    const result = item.result?.success === true && item.result?.result ? item.result.result : item.result;
    if (result?.savedToDocumentCenter && result?.assetId) {
      return `已导出文件：${result.filename || result.assetTitle || '下载文件'}，并保存到资料中心（资料 ID：${result.assetId}）。`;
    }
    if (result?.filename || result?.downloadId) {
      return `已触发下载：${result.filename || '下载文件'}，但无法自动读取文件内容，请从下载目录手动添加。`;
    }
  }
  return null;
}

function shouldRejectPlan(plan: ComputerUsePlan, intent: ComputerUseIntent, context: ComputerUsePageContext, history: unknown[]): boolean {
  const firstStep = plan.steps[0];
  if (!firstStep || !isDataTask(intent)) return false;
  const navigationPath = getNavigationPath(intent);
  const targets = navigationPath.length ? navigationPath : intent.entities || [];
  const targetNavigation = findBestTargetNavigation(context, targets, navigationPath, history);
  const downloadTask = isDownloadTask(intent);

  if (firstStep.action === 'finish' && !getCompletedExtractTableSummary(history) && !getCompletedDownloadSummary(history)) {
    const summary = compact([plan.summary, firstStep.summary, firstStep.rationale, plan.needsUserInput].filter(Boolean).join(' '));
    const isGenericFinish = /^(finish|done|完成|任务完成|已完成)$/i.test(summary);
    return isGenericFinish || hasActionableEvidence(context, targets);
  }

  if (downloadTask && firstStep.action === 'extract_table') {
    return true;
  }

  if (firstStep.action === 'extract_table' && targetNavigation && !hasClickedNavigation(history, targetNavigation)) {
    return true;
  }

  return false;
}

function buildRulePlan(
  intent: ComputerUseIntent,
  context: ComputerUsePageContext,
  history: unknown[] = [],
  phase?: ComputerUsePhase,
  runState?: ComputerUseRunState,
  phaseMemory?: ComputerUsePhaseMemory
): ComputerUsePlan {
  if (phase?.type === 'wait') {
    return makeWaitPlan(Math.max(0, Number(phase.waitMs || 1000)));
  }

  if (phase?.type === 'fill_form') {
    const formValue = phase.formValues?.[0];
    if (!formValue) return makeFinishPlan(`阶段「${phase.goal}」缺少要填写的字段和值。`);
    const target = findFormFieldCandidate(context, formValue, phaseMemory);
    if (!target) {
      return makeFinishPlan(`未找到表单字段：${formValue.label}。请确认字段在当前页面可见，或补充字段位置。`);
    }
    const isSelect = formValue.control === 'select';
    return {
      summary: `${isSelect ? '选择' : '输入'}${formValue.label}`,
      confidence: 0.88,
      steps: [{
        id: `fill_${compact(formValue.label)}`,
        action: isSelect ? 'select_option' : 'type',
        target: {
          elementId: target.elementId,
          selector: target.selector,
          text: target.text || formValue.label,
        },
        value: formValue.value,
        rationale: `${isSelect ? '选择' : '输入'}字段「${formValue.label}」为「${formValue.value}」`,
        verify: { type: 'value_equals', value: formValue.value },
      }],
      successCriteria: [`${formValue.label} = ${formValue.value}`],
    };
  }

  if (phase?.type === 'click_action') {
    const targets = phase.targets?.length ? phase.targets : ['搜索', '查询'];
    const target = findTableRowActionCandidate(context, targets, phase.ordinal, phaseMemory)
      || findActionButtonCandidate(context, targets, phaseMemory);
    if (!target) {
      return makeFinishPlan(`未找到动作按钮：${targets.join('、')}。请确认按钮在当前页面可见。`);
    }
    return {
      summary: `点击${targets[0]}`,
      confidence: 0.84,
      steps: [{
        id: 'click_action',
        action: 'click',
        target: {
          elementId: target.elementId,
          selector: target.selector,
          text: target.text || targets[0],
          purpose: target.purpose,
          collectionType: 'action_group',
        },
        rationale: `点击当前页面动作按钮：${target.text || targets[0]}`,
        verify: { type: 'page_changed', value: targets[0] },
      }],
      successCriteria: [`已点击 ${targets[0]}`],
    };
  }

  if (phase?.type === 'open_page_or_center') {
    const targets = phase.targets?.length ? phase.targets : ['文件中心'];
    const currentText = [
      context.observation.title,
      context.observation.url,
      context.structuredData?.headings?.join(' '),
    ].join(' ');
    if (includesAnyTarget(currentText, targets)) {
      return makeFinishPlan(`已打开${targets[0] || '目标页面'}`);
    }
    const target = findTextActionCandidate(context, targets, history, phaseMemory);
    if (target) {
      return {
        summary: `打开${targets[0]}`,
        confidence: 0.86,
        steps: [{
          id: 'open_page_or_center',
          action: 'click',
          target: {
            elementId: target.elementId,
            selector: target.selector,
            text: target.text,
            purpose: target.purpose,
            collectionType: 'menu_group',
            parentPath: [],
          },
          rationale: `当前阶段只需要打开：${targets.join('、')}`,
          verify: { type: 'page_changed', value: targets[0] },
        }],
        successCriteria: [`进入 ${targets[0]}`],
      };
    }
    return makeFinishPlan(`未找到入口：${targets.join('、')}。请确认顶部导航或菜单中存在该入口。`);
  }

  if (phase?.type === 'click_latest_download') {
    const filename = baseFileName(runState?.downloadResult?.filename || runState?.downloadResult?.assetTitle);
    const target = findLatestDownloadCandidate(context, runState, phaseMemory);
    if (target) {
      return {
        summary: filename ? `点击刚刚下载的文件：${filename}` : `点击最新可见下载文件：${target.text}`,
        confidence: filename ? 0.86 : 0.7,
        steps: [{
          id: 'click_latest_download',
          action: 'click',
          target: {
            elementId: target.elementId,
            selector: target.selector,
            text: target.text,
            purpose: target.purpose,
            collectionType: 'file_list',
            ordinal: filename ? undefined : 1,
          },
          rationale: filename
            ? `根据下载结果文件名匹配文件中心条目：${filename}`
            : '下载结果没有可靠文件名，尝试点击文件中心里最新可见的文件条目。',
          verify: { type: 'page_changed', value: filename || target.text },
        }],
        successCriteria: ['打开刚刚下载的文件'],
      };
    }
    return makeFinishPlan(filename
      ? `文件中心未找到刚刚下载的文件：${filename}。请确认文件列表已刷新或手动搜索该文件。`
      : '文件中心未找到可点击的下载文件条目。请确认下载已完成并刷新文件中心。');
  }

  const completedDownload = getCompletedDownloadSummary(history);
  if (completedDownload && !phase) {
    return makeFinishPlan(completedDownload);
  }

  const completedExtract = getCompletedExtractTableSummary(history);
  if (completedExtract && !isDownloadTask(intent) && !phase) {
    return makeFinishPlan(completedExtract);
  }

  if (context.observation.pageState?.hasCaptcha) {
    return makeFinishPlan('当前页面出现验证码/安全验证，需要用户先手动处理。');
  }
  if (context.observation.pageState?.kind === 'login_page') {
    return makeFinishPlan('当前页面疑似登录页，需要用户先完成登录。');
  }

  const entities = intent.entities || [];
  const navigationPath = getNavigationPath(intent);
  const currentStageTargets = navigationPath.length ? navigationPath : entities;
  const dataTask = isDataTask(intent) || Boolean(phase?.navigationPath?.length) || phase?.type === 'navigate_to_page';
  const downloadTask = isDownloadTask(intent);
  const targetNavigation = findBestTargetNavigation(context, currentStageTargets, navigationPath, history, phaseMemory);
  const strictPageText = [
    context.observation.title,
    context.observation.url,
    context.structuredData?.headings?.join(' '),
  ].join(' ');
  const loosePageText = [
    strictPageText,
    context.pageTextPreview,
  ].join(' ');
  const primaryTarget = getPrimaryTarget(currentStageTargets);
  const clickedLeafTarget = primaryTarget ? hasClickedTargetWithoutAmbiguity(context, history, primaryTarget, navigationPath) : false;
  const parentTargets = getParentTargets(currentStageTargets);
  const clickedOnlyParentTarget = !clickedLeafTarget && parentTargets.some((target) => hasClickedTargetText(history, target));
  const pathReached = navigationPath.length ? hasReachedNavigationPath(intent, context, history) : false;
  const isOnTarget = !primaryTarget || includesAnyTarget(navigationPath.length ? strictPageText : loosePageText, [primaryTarget]);
  const targetReadyForExport = phase?.type === 'download_file' && !navigationPath.length
    ? true
    : navigationPath.length
      ? pathReached
      : (!primaryTarget || clickedLeafTarget || (isOnTarget && !clickedOnlyParentTarget));

  const nextPathTarget = dataTask ? getNextNavigationPathTarget(intent, context, history, phaseMemory) : null;
  if (nextPathTarget?.missing) {
    return makeFinishPlan(`未找到目标菜单路径节点：${nextPathTarget.target}。请确认菜单已展开、账号有权限，或补充目标页面位置。`);
  }
  if (nextPathTarget?.element && !hasClickedNavigation(history, nextPathTarget.element)) {
    return {
      summary: `点击目标路径节点：${nextPathTarget.target}`,
      confidence: 0.82,
      steps: [{
        id: 'click_navigation_path',
        action: 'click',
        target: {
          elementId: nextPathTarget.element.elementId,
          selector: nextPathTarget.element.selector,
          text: nextPathTarget.element.text,
          purpose: nextPathTarget.element.purpose,
          collectionType: 'menu_group',
          parentPath: getParentPathForTarget(navigationPath, nextPathTarget.target),
        },
        rationale: `按业务菜单路径进入目标页面：${navigationPath.join(' > ')}`,
        verify: { type: 'page_changed', value: nextPathTarget.target },
      }],
      successCriteria: [`已进入或展开 ${nextPathTarget.target}`],
    };
  }

  if (dataTask && targetNavigation && !hasClickedNavigation(history, targetNavigation) && !(downloadTask && targetReadyForExport && findBestDownloadAction(context, phaseMemory))) {
    return {
      summary: `点击匹配的导航项：${targetNavigation.text}`,
      confidence: 0.78,
      steps: [{
        id: 'click_navigation',
        action: 'click',
        target: {
          elementId: targetNavigation.elementId,
          selector: targetNavigation.selector,
          text: targetNavigation.text,
          purpose: targetNavigation.purpose,
          collectionType: 'menu_group',
          parentPath: getParentPathForTarget(navigationPath, targetNavigation.text),
        },
        rationale: `先进入目标导航项，再读取目标页表格：${targetNavigation.text}`,
        verify: { type: 'page_changed', value: targetNavigation.text },
      }],
      successCriteria: [`已点击 ${targetNavigation.text}`],
    };
  }

  if ((downloadTask || phase?.type === 'download_file') && targetReadyForExport) {
    const downloadAction = findTableRowActionCandidate(context, ['下载', '导出'], phase?.ordinal, phaseMemory)
      || findBestDownloadAction(context, phaseMemory);
    if (downloadAction) {
      return {
        summary: phase?.ordinal
          ? `点击第${phase.ordinal}条数据的下载按钮：${downloadAction.text || downloadAction.selector}`
          : `点击真实导出/下载按钮：${downloadAction.text || downloadAction.selector}`,
        confidence: 0.84,
        steps: [{
          id: 'download_file',
          action: 'download_file',
          target: {
            elementId: downloadAction.elementId,
            selector: downloadAction.selector,
            text: downloadAction.text,
            purpose: downloadAction.purpose,
            collectionType: phase?.ordinal ? 'table_row_group' : 'action_group',
            ordinal: phase?.ordinal,
          },
          rationale: phase?.ordinal
            ? `用户明确要求下载第${phase.ordinal}条数据，点击该行的下载动作并等待下载完成：${downloadAction.text || downloadAction.selector}`
            : `用户明确要求导出/下载，点击真实导出按钮并等待下载完成：${downloadAction.text || downloadAction.selector}`,
          verify: { type: 'element_exists', value: downloadAction.text },
          highRisk: false,
        }],
        successCriteria: ['捕获到下载完成事件', '尽可能保存文件到资料中心'],
      };
    }

    const expandable = findExpandableAction(context, history, phaseMemory);
    if (expandable) {
      return {
        summary: `展开可能包含导出的操作入口：${expandable.text}`,
        confidence: 0.68,
        steps: [{
          id: 'expand_actions',
          action: 'click',
          target: {
            elementId: expandable.elementId,
            selector: expandable.selector,
            text: expandable.text,
            purpose: expandable.purpose,
            collectionType: 'action_group',
          },
          rationale: `当前未直接看到导出按钮，先展开操作入口：${expandable.text}`,
          verify: { type: 'text_exists', value: expandable.text },
        }],
        successCriteria: ['展开后能观察到导出/下载入口'],
      };
    }

    return makeFinishPlan('当前页面未找到真实导出/下载按钮。请确认已进入目标列表页，或展开更多操作后重试。');
  }

  if (!downloadTask && dataTask && (isOnTarget || hasClickedNavigation(history, targetNavigation)) && context.tableCandidates.length > 0) {
    return {
      summary: '当前页面已有目标数据迹象，优先提取表格。',
      confidence: 0.82,
      steps: [{
        id: 'extract_table',
        action: 'extract_table',
        rationale: '页面存在表格数据，提取当前可见列表。',
        verify: { type: 'table_exists' },
      }],
      successCriteria: ['提取到至少一个表格'],
    };
  }

  if (targetNavigation && !hasClickedNavigation(history, targetNavigation)) {
    return {
      summary: `点击匹配的导航项：${targetNavigation.text}`,
      confidence: 0.76,
      steps: [{
        id: 'click_navigation',
        action: 'click',
        target: {
          elementId: targetNavigation.elementId,
          selector: targetNavigation.selector,
          text: targetNavigation.text,
          purpose: targetNavigation.purpose,
          collectionType: 'menu_group',
          parentPath: getParentPathForTarget(navigationPath, targetNavigation.text),
        },
        rationale: `当前页面未确认目标内容，先进入相关导航项：${targetNavigation.text}`,
        verify: { type: 'page_changed', value: targetNavigation.text },
      }],
      successCriteria: [`页面出现 ${targetNavigation.text}`],
    };
  }

  if (dataTask) {
    const entityText = currentStageTargets.length ? `目标关键词：${currentStageTargets.join('、')}` : '目标关键词不足';
    return makeFinishPlan(`未找到可点击的目标菜单/导航，且当前页没有可提取表格。${entityText}。请确认菜单已展开或补充目标页面位置。`);
  }

  return makeFinishPlan('当前页面上下文不足，无法安全生成下一步操作。请补充目标元素或页面位置。');
}

export async function createComputerUsePlan(input: {
  intent: ComputerUseIntent;
  context: ComputerUsePageContext;
  history: unknown[];
  callLLM?: PlannerLLM;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  phaseMemory?: ComputerUsePhaseMemory;
}): Promise<ComputerUsePlan> {
  const completedDownload = getCompletedDownloadSummary(input.history);
  if (completedDownload && !input.phase) return makeFinishPlan(completedDownload);

  const completedExtract = getCompletedExtractTableSummary(input.history);
  if (completedExtract && !isDownloadTask(input.intent) && !input.phase) return makeFinishPlan(completedExtract);

  const rulePlan = buildRulePlan(input.intent, input.context, input.history, input.phase, input.runState, input.phaseMemory);
  if (isExecutableRulePlan(rulePlan)) return rulePlan;

  if (!input.callLLM) return rulePlan;

  try {
    const raw = await input.callLLM({
      system: [
        '你是浏览器 Computer Use 动态规划器，只输出 JSON。',
        '生成 1-3 步短计划，不要写死业务系统路径。',
        '如果页面上下文不足，必须用 finish 说明缺少什么，不要输出无意义 press_key。',
        '涉及导出/下载时，优先导航到目标页面，找到 purpose=download_button 的真实按钮后输出 download_file，不要用 extract_table 代替导出。',
        '涉及列表/表格但用户没有要求导出文件时，优先导航到目标页面并 extract_table。',
        '优先使用 page.collections 里的语义集合生成 target：搜索结果用 collectionType=search_results + ordinal，菜单/导航用 collectionType=menu_group + parentPath，导出/下载用 collectionType=action_group + purpose=download_button，文件列表用 collectionType=file_list。',
        '不要直接猜 CSS selector。只有当集合无法表达目标时，才使用 elementId/selector。',
        '同名菜单必须用 parentPath 消歧；第 N 项必须用 ordinal 表达，不要把第一个候选当成默认值。',
        '如果 history 里最近已经成功 download_file，必须输出 finish，总结下载文件和资料 ID。',
        '如果 history 里最近已经成功 extract_table 且包含 tables，且目标不是导出文件，必须输出 finish，总结已提取的数据，不要重复 extract_table。',
      ].join('\n'),
      user: {
        intent: input.intent,
        page: {
          url: input.context.observation.url,
          title: input.context.observation.title,
          pageState: input.context.observation.pageState,
          phase: input.phase,
          runState: input.runState,
          phaseMemory: input.phaseMemory,
          navigationPath: input.intent.navigationPath,
          collections: (input.context.collections || []).map(summarizeCollection).slice(0, 30),
          navigationCandidates: input.context.navigationCandidates.map(summarizeElement).slice(0, 50),
          actionCandidates: input.context.actionCandidates.map(summarizeElement).slice(0, 30),
          elements: input.context.observation.elements.map(summarizeElement).slice(0, 80),
          structuredData: input.context.structuredData,
          tableCandidates: input.context.tableCandidates,
          pageTextPreview: input.context.pageTextPreview,
        },
        history: input.history.slice(-6),
      },
    });
    const normalized = normalizePlan(raw);
    if (normalized && !shouldRejectPlan(normalized, input.intent, input.context, input.history)) {
      return normalized;
    }
    return rulePlan;
  } catch {
    return rulePlan;
  }
}
