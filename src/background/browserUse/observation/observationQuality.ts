import type {
  BrowserObservation,
  BrowserObservationQualityIssue,
  BrowserObservationQualityReport,
  ObservedCollection,
  ObservedCollectionItem,
  ObservedElement,
} from '../../../shared/automation/automationTypes';

const LOW_CONFIDENCE_THRESHOLD = 0.55;

function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compact(value?: string): string {
  return String(value || '').replace(/\s+/g, '').trim().toLowerCase();
}

function isInteractiveElement(element: ObservedElement): boolean {
  if (!element.visible || !element.enabled) return false;
  if (element.clickable) return true;
  if (['button', 'link', 'menuitem', 'tab', 'textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'option'].includes(element.role)) {
    return true;
  }
  return ['input', 'textarea', 'select', 'button', 'a'].includes(String(element.tag || '').toLowerCase());
}

function isActionableItem(item: ObservedCollectionItem): boolean {
  if (item.clickable === false) return false;
  if (item.elementId || item.selector || item.href || item.bbox) return true;
  return Array.isArray(item.metadata?.actions) && item.metadata.actions.some((action) => (
    Boolean(action.elementId || action.selector || action.bbox)
  ));
}

function itemIdentity(collection: ObservedCollection, item: ObservedCollectionItem): string {
  const parentPath = (item.parentPath || []).map(compact).join('>');
  return [
    collection.type,
    parentPath,
    compact(item.text),
    item.elementId || item.selector || item.href || '',
  ].join('|');
}

function coveredElementIds(collections: ObservedCollection[]): Set<string> {
  const ids = new Set<string>();
  for (const collection of collections) {
    for (const item of collection.items) {
      if (item.elementId) ids.add(item.elementId);
      for (const id of item.sourceElementIds || []) ids.add(id);
      for (const action of item.metadata?.actions || []) {
        if (action.elementId) ids.add(action.elementId);
      }
    }
  }
  return ids;
}

function addStructuralIssues(collection: ObservedCollection, issues: BrowserObservationQualityIssue[]): void {
  if (collection.type === 'menu_group') {
    const counts = new Map<string, number>();
    for (const item of collection.items) {
      const key = compact(item.text);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const item of collection.items) {
      if ((counts.get(compact(item.text)) || 0) > 1 && !(item.parentPath?.length || item.parentText)) {
        issues.push({
          code: 'MISSING_PARENT_CONTEXT',
          severity: 'error',
          collectionId: collection.id,
          elementIds: item.elementId ? [item.elementId] : undefined,
          message: `同名菜单“${item.text || '未命名'}”缺少父级路径，无法可靠消歧。`,
        });
      }
    }
  }

  if (collection.type === 'form_group') {
    for (const item of collection.items) {
      if (!item.metadata?.label || !item.metadata?.controlType || !item.metadata?.fieldPurpose) {
        issues.push({
          code: 'INCOMPLETE_FORM_FIELD',
          severity: 'warning',
          collectionId: collection.id,
          elementIds: item.elementId ? [item.elementId] : undefined,
          message: `表单字段“${item.text || '未命名'}”缺少 label、controlType 或 fieldPurpose。`,
        });
      }
    }
  }

  if (collection.type === 'table_row_group') {
    for (const item of collection.items) {
      const hasCells = Array.isArray(item.metadata?.cells) && item.metadata.cells.length > 0;
      if (!Number.isFinite(item.metadata?.rowIndex) || !item.metadata?.stableRowKey || !hasCells) {
        issues.push({
          code: 'INCOMPLETE_TABLE_ROW',
          severity: 'warning',
          collectionId: collection.id,
          elementIds: item.sourceElementIds,
          message: `表格行 ${item.index} 缺少稳定行号、行键或单元格信息。`,
        });
      }
    }
  }

  if (collection.type === 'action_group') {
    for (const item of collection.items) {
      if (!item.purpose || !item.metadata?.actionKind || !item.metadata?.riskLevel) {
        issues.push({
          code: 'INCOMPLETE_ACTION',
          severity: 'warning',
          collectionId: collection.id,
          elementIds: item.elementId ? [item.elementId] : undefined,
          message: `页面动作“${item.text || item.metadata?.iconLabel || '未命名'}”缺少 purpose、actionKind 或 riskLevel。`,
        });
      }
    }
  }
}

export function evaluateObservationQuality(input: {
  observation: BrowserObservation;
  collections?: ObservedCollection[];
}): BrowserObservationQualityReport {
  const elements = input.observation.elements || [];
  const collections = input.collections || input.observation.collections || [];
  const interactiveElements = elements.filter(isInteractiveElement);
  const coveredIds = coveredElementIds(collections);
  const issues: BrowserObservationQualityIssue[] = [];

  const elementIdCounts = new Map<string, number>();
  for (const element of elements) {
    if (!element.elementId) continue;
    elementIdCounts.set(element.elementId, (elementIdCounts.get(element.elementId) || 0) + 1);
  }
  for (const [elementId, count] of elementIdCounts) {
    if (count > 1) {
      issues.push({
        code: 'DUPLICATE_ELEMENT_ID',
        severity: 'error',
        elementIds: [elementId],
        message: `elementId “${elementId}” 在同一次观察中出现 ${count} 次。`,
      });
    }
  }

  const itemIdentities = new Map<string, number>();
  let collectionItemCount = 0;
  let actionableItemCount = 0;
  let lowConfidenceCount = 0;
  for (const collection of collections) {
    addStructuralIssues(collection, issues);
    for (const item of collection.items) {
      collectionItemCount += 1;
      if (isActionableItem(item)) actionableItemCount += 1;
      else if (!['table', 'list'].includes(collection.type)) {
        issues.push({
          code: 'NON_ACTIONABLE_ITEM',
          severity: 'warning',
          collectionId: collection.id,
          message: `${collection.type} 集合项“${item.text || item.index}”没有可执行目标。`,
        });
      }
      if (item.confidence < LOW_CONFIDENCE_THRESHOLD) lowConfidenceCount += 1;
      const identity = itemIdentity(collection, item);
      itemIdentities.set(identity, (itemIdentities.get(identity) || 0) + 1);
    }
  }

  for (const [identity, count] of itemIdentities) {
    if (count > 1) {
      issues.push({
        code: 'DUPLICATE_COLLECTION_ITEM',
        severity: 'warning',
        message: `语义集合中存在 ${count} 个重复候选：${identity.slice(0, 120)}。`,
      });
    }
  }

  if (!interactiveElements.length) {
    issues.push({ code: 'NO_INTERACTIVE_ELEMENTS', severity: 'error', message: '当前观察未识别到任何可交互元素。' });
  }
  if (!collections.length) {
    issues.push({ code: 'NO_SEMANTIC_COLLECTIONS', severity: 'error', message: '当前观察未构建出任何语义集合。' });
  }

  const interactiveIds = new Set(interactiveElements.map((element) => element.elementId).filter(Boolean));
  const coveredInteractiveCount = Array.from(interactiveIds).filter((id) => coveredIds.has(id)).length;
  const coverageRatio = interactiveIds.size ? coveredInteractiveCount / interactiveIds.size : 0;
  if (interactiveIds.size >= 3 && coverageRatio < 0.35) {
    issues.push({
      code: 'LOW_COLLECTION_COVERAGE',
      severity: 'warning',
      message: `语义集合仅覆盖 ${Math.round(coverageRatio * 100)}% 的可交互元素。`,
    });
  }
  if (lowConfidenceCount > 0) {
    issues.push({
      code: 'LOW_CONFIDENCE_ITEM',
      severity: lowConfidenceCount / Math.max(1, collectionItemCount) > 0.3 ? 'warning' : 'info',
      message: `${lowConfidenceCount} 个语义集合项的置信度低于 ${LOW_CONFIDENCE_THRESHOLD}。`,
    });
  }

  const duplicateCount = Array.from(elementIdCounts.values()).reduce((total, count) => total + Math.max(0, count - 1), 0)
    + Array.from(itemIdentities.values()).reduce((total, count) => total + Math.max(0, count - 1), 0);
  const duplicateRatio = duplicateCount / Math.max(1, elements.length + collectionItemCount);
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const coveragePenalty = interactiveIds.size ? (1 - coverageRatio) * 30 : 25;
  const score = Math.max(0, Math.min(100, Math.round(
    100 - coveragePenalty - duplicateRatio * 35 - errorCount * 15 - warningCount * 4 - lowConfidenceCount * 0.5,
  )));

  return {
    score,
    generatedAt: Date.now(),
    interactiveElementCount: interactiveElements.length,
    actionableElementCount: actionableItemCount,
    collectionCount: collections.length,
    collectionItemCount,
    coverageRatio: round(coverageRatio),
    duplicateRatio: round(duplicateRatio),
    lowConfidenceCount,
    collections: collections.map((collection) => ({
      id: collection.id,
      type: collection.type,
      itemCount: collection.items.length,
      actionableCount: collection.items.filter(isActionableItem).length,
      averageConfidence: round(collection.items.reduce((sum, item) => sum + item.confidence, 0) / Math.max(1, collection.items.length)),
    })),
    issues,
  };
}
