import type {
  BrowserObservation,
  ComputerUsePhase,
  ObservedCollection,
  ObservedCollectionItem,
  ObservedCollectionType,
  ObservedElement,
} from '../shared/automationTypes';

function compact(text?: string): string {
  return String(text || '').replace(/\s+/g, '').trim();
}

function normalizeTitle(text?: string): string {
  return compact(text).slice(0, 80) || '未命名';
}

function elementToCollectionItem(element: ObservedElement, index: number, confidence = 0.7, parentTextOverride?: string): ObservedCollectionItem {
  const parentText = parentTextOverride || element.parentText;
  const parentPath = parentText ? [parentText] : undefined;
  return {
    index,
    text: element.text,
    elementId: element.elementId,
    selector: element.selector,
    parentText,
    parentPath,
    context: element.context,
    href: element.href,
    bbox: element.bbox,
    purpose: element.purpose,
    active: element.active,
    expanded: element.expanded,
    clickable: element.clickable,
    sourceElementIds: [element.elementId],
    metadata: {
      purpose: element.purpose,
      role: element.role,
      active: element.active,
      expanded: element.expanded,
      level: element.level,
      region: element.region,
    },
    confidence,
  };
}

function pushCollection(collections: ObservedCollection[], collection: ObservedCollection): void {
  if (!collection.items.length) return;
  const limit = collection.type === 'menu_group'
    ? 260
    : collection.type === 'file_list'
      ? 160
      : collection.type === 'action_group'
        ? 120
        : 80;
  collections.push({
    ...collection,
    items: collection.items.slice(0, limit),
  });
}

function buildSearchResults(elements: ObservedElement[]): ObservedCollection | null {
  const items = elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => element.region === 'search_results' || /search_results|result/i.test(String(element.context || '')))
    .filter((element) => element.role === 'link' || Boolean(element.href))
    .filter((element) => element.text && !/^(新闻|网页|图片|视频|地图|文库|更多|设置|\d+|hao123)$/i.test(compact(element.text)))
    .map((element, index) => elementToCollectionItem(element, index + 1, 0.76));
  return items.length ? {
    id: 'collection_search_results',
    type: 'search_results',
    title: '搜索结果',
    items,
    confidence: 0.72,
  } : null;
}

function isAggregateMenuElement(element: ObservedElement): boolean {
  const text = compact(element.text);
  if (!text) return true;
  const selector = String(element.selector || '');
  const containerSelector = /(sidebar-item|sidebar-submenu|nav-level|submenu-wrapper|submenu-inner)/.test(selector);
  const looksLikeContainerText = text.length > 24 && !/^(sidebar-handle|sidebar-text|nav-item-text|nav-item\.leaf)/.test(selector);
  const zeroHeight = Number(element.bbox?.height || 0) <= 4;
  return containerSelector && (looksLikeContainerText || zeroHeight);
}

function inferSidebarParentText(element: ObservedElement, elements: ObservedElement[]): string | undefined {
  if (element.region !== 'sidebar') return element.parentText;
  const selector = String(element.selector || '');
  if (!/(nav-item\.leaf|nav-item-text)/.test(selector)) return element.parentText;
  const elementY = Number(element.bbox?.y || 0);
  const elementX = Number(element.bbox?.x || 0);
  const candidates = elements
    .filter((item) => item.region === 'sidebar' && item.visible)
    .filter((item) => /(sidebar-handle|sidebar-text)/.test(String(item.selector || '')))
    .filter((item) => compact(item.text).length > 0 && compact(item.text).length <= 20)
    .filter((item) => Number(item.bbox?.y || 0) <= elementY)
    .filter((item) => Number(item.bbox?.x || 0) <= elementX)
    .filter((item) => {
      const itemContext = compact([item.text, item.context].filter(Boolean).join(' '));
      return !element.text || itemContext.includes(compact(element.text)) || Number(item.bbox?.y || 0) < elementY;
    })
    .sort((a, b) => Number(b.bbox?.y || 0) - Number(a.bbox?.y || 0));
  return candidates[0]?.text || element.parentText;
}

function buildMenuGroups(elements: ObservedElement[]): ObservedCollection[] {
  const menuElements = elements
    .filter((element) => element.visible)
    .filter((element) => element.purpose === 'menu_item' || element.purpose === 'navigation_item')
    .filter((element) => !isAggregateMenuElement(element));
  const groups = new Map<string, Array<{ element: ObservedElement; parentText?: string }>>();
  for (const element of menuElements) {
    const parentText = inferSidebarParentText(element, elements);
    const key = normalizeTitle(parentText || element.context || element.region || '导航');
    groups.set(key, [...(groups.get(key) || []), { element, parentText }]);
  }
  return Array.from(groups.entries()).map(([title, groupElements], groupIndex) => ({
    id: `collection_menu_group_${groupIndex + 1}`,
    type: 'menu_group' as const,
    title,
    items: groupElements.map(({ element, parentText }, index) => (
      elementToCollectionItem(element, index + 1, element.active ? 0.95 : 0.78, parentText)
    )),
    confidence: 0.8,
    metadata: { title },
  }));
}

function looksLikeFile(text?: string): boolean {
  return /\.(pdf|docx?|xlsx?|csv|txt|md|png|jpe?g|zip|rar)$/i.test(String(text || ''))
    || /(刚刚下载|最近下载|下载文件|文件中心|附件|报表|导出)/i.test(String(text || ''));
}

function fileNameFromText(text?: string): string | undefined {
  const match = String(text || '').match(/[^\\/\s"'<>]+?\.(?:pdf|docx?|xlsx?|csv|txt|md|png|jpe?g|zip|rar)\b/i);
  return match?.[0];
}

function fileItemText(element: ObservedElement): string {
  return fileNameFromText(`${element.text} ${element.context || ''} ${element.href || ''}`)
    || element.text
    || element.context
    || element.href
    || '文件';
}

function buildFileList(elements: ObservedElement[], phase?: ComputerUsePhase): ObservedCollection | null {
  const phaseTargets = [...(phase?.targets || []), phase?.goal || ''].join(' ');
  const items = elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => looksLikeFile(`${element.text} ${element.context || ''} ${element.href || ''} ${phaseTargets}`))
    .filter((element) => {
      const text = compact(element.text);
      if (!text) return Boolean(fileNameFromText(`${element.context || ''} ${element.href || ''}`));
      if (['文件中心', '导出'].includes(text)) return false;
      if (text === '下载') return Boolean(fileNameFromText(`${element.context || ''} ${element.href || ''}`));
      return true;
    })
    .map((element, index) => {
      const filename = fileNameFromText(`${element.text} ${element.context || ''} ${element.href || ''}`);
      return {
        ...elementToCollectionItem({ ...element, text: fileItemText(element) }, index + 1, filename ? 0.9 : 0.62),
        metadata: {
          ...(elementToCollectionItem(element, index + 1).metadata || {}),
          filename,
          originalText: element.text,
        },
      };
    });
  return items.length ? {
    id: 'collection_file_list',
    type: 'file_list',
    title: '文件列表',
    items,
    confidence: 0.7,
  } : null;
}

function isActionCandidate(element: ObservedElement): boolean {
  if (!element.visible || !element.enabled) return false;
  if (['download_button', 'submit_button', 'search_button', 'login_button', 'close_modal'].includes(element.purpose || '')) return true;
  if (!['button', 'link', 'menuitem', 'option'].includes(element.role)) return false;
  return /(导\s*出|下载|export|download|excel|csv|更多|操作|批量操作|more|actions?)/i.test(`${element.text} ${element.context || ''} ${element.name || ''} ${element.placeholder || ''}`);
}

function actionConfidence(element: ObservedElement): number {
  if (element.purpose === 'download_button') return 0.93;
  if (element.purpose === 'submit_button') return 0.78;
  if (element.purpose === 'search_button') return 0.72;
  if (/(更多|操作|批量操作|more|actions?)/i.test(`${element.text} ${element.context || ''}`)) return 0.64;
  return 0.58;
}

function buildActionGroup(elements: ObservedElement[]): ObservedCollection | null {
  const seen = new Set<string>();
  const items = elements
    .filter(isActionCandidate)
    .filter((element) => {
      const key = element.elementId || element.selector || compact(element.text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const aScore = actionConfidence(a) * 100 + (a.score || 0);
      const bScore = actionConfidence(b) * 100 + (b.score || 0);
      return bScore - aScore
        || Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0)
        || Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0);
    })
    .map((element, index) => elementToCollectionItem(element, index + 1, actionConfidence(element)));

  return items.length ? {
    id: 'collection_action_group',
    type: 'action_group',
    title: '页面动作',
    items,
    confidence: 0.78,
    metadata: {
      purposes: Array.from(new Set(items.map((item) => item.purpose).filter(Boolean))),
    },
  } : null;
}

function buildTableCollection(tableCandidates: unknown[]): ObservedCollection | null {
  const tables = Array.isArray(tableCandidates) ? tableCandidates : [];
  const items = tables.map((table: any, index) => ({
    index: index + 1,
    text: String(table?.title || table?.caption || table?.headers?.join?.(' ') || `表格 ${index + 1}`),
    metadata: {
      headers: Array.isArray(table?.headers) ? table.headers.slice(0, 20) : [],
      rowCount: Number(table?.rowCount || table?.rows?.length || 0),
      columnCount: Number(table?.columnCount || table?.headers?.length || 0),
    },
    confidence: 0.8,
  }));
  return items.length ? {
    id: 'collection_tables',
    type: 'table',
    title: '页面表格',
    items,
    confidence: 0.8,
  } : null;
}

function buildCards(elements: ObservedElement[]): ObservedCollection | null {
  const items = elements
    .filter((element) => element.visible && element.enabled)
    .filter((element) => element.region === 'main' && element.purpose === 'generic' && compact(element.text).length > 2)
    .filter((element) => Number(element.bbox?.width || 0) >= 80 && Number(element.bbox?.height || 0) >= 24)
    .slice(0, 30)
    .map((element, index) => elementToCollectionItem(element, index + 1, 0.45));
  return items.length ? {
    id: 'collection_cards',
    type: 'cards',
    title: '主区域卡片/列表项',
    items,
    confidence: 0.45,
  } : null;
}

export function buildObservedCollections(input: {
  observation: BrowserObservation;
  tableCandidates?: unknown[];
  phase?: ComputerUsePhase;
}): ObservedCollection[] {
  const collections: ObservedCollection[] = [];
  const elements = input.observation.elements || [];
  const searchResults = buildSearchResults(elements);
  if (searchResults) pushCollection(collections, searchResults);
  for (const menuGroup of buildMenuGroups(elements)) pushCollection(collections, menuGroup);
  const fileList = buildFileList(elements, input.phase);
  if (fileList) pushCollection(collections, fileList);
  const tables = buildTableCollection(input.tableCandidates || []);
  if (tables) pushCollection(collections, tables);
  const actionGroup = buildActionGroup(elements);
  if (actionGroup) pushCollection(collections, actionGroup);
  const cards = buildCards(elements);
  if (cards) pushCollection(collections, cards);
  return collections;
}
