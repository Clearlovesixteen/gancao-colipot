import type {
  ActionRiskLevel,
  BrowserObservation,
  ComputerUsePhase,
  ObservedCollection,
  ObservedCollectionItem,
  ObservedCollectionType,
  ObservedElement,
  ObservedActionKind,
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
        : collection.type === 'form_group'
          ? 160
          : collection.type === 'table_row_group'
            ? 160
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
  const multiRowContainer = Number(element.bbox?.height || 0) > 64;
  return containerSelector && (looksLikeContainerText || zeroHeight || multiRowContainer);
}

function isActionableMenuElement(element: ObservedElement): boolean {
  if (['aside', 'nav', 'section'].includes(element.tag) || element.role === 'navigation') return false;
  if (element.clickable || ['button', 'link', 'menuitem', 'tab'].includes(element.role)) return true;
  return /(sidebar-handle|sidebar-text|nav-item\.leaf|nav-item-text)/.test(String(element.selector || ''));
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
    .filter(isActionableMenuElement)
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

function inferActionPurpose(element: ObservedElement): string | undefined {
  if (element.purpose && element.purpose !== 'generic') return element.purpose;
  const text = `${element.text} ${element.context || ''} ${element.name || ''} ${element.placeholder || ''} ${element.ariaLabel || ''} ${element.title || ''}`;
  if (/(导\s*出|下载|export|download|excel|csv)/i.test(text)) return 'download_button';
  if (/(查询|搜索|检索|筛选|search|filter)/i.test(text)) return 'search_button';
  if (/(保存|save)/i.test(text)) return 'save_button';
  if (/(删除|作废|移除|delete|remove)/i.test(text)) return 'delete_button';
  if (/(提交|发送|支付|购买|下单|submit|send|pay|buy)/i.test(text)) return 'submit_button';
  return element.purpose;
}

function inferActionKind(element: ObservedElement): ObservedActionKind {
  const purpose = inferActionPurpose(element);
  const text = `${element.text} ${element.context || ''} ${element.ariaLabel || ''} ${element.title || ''}`;
  if (purpose === 'download_button') return 'download';
  if (purpose === 'search_button') return 'search';
  if (purpose === 'save_button') return 'save';
  if (purpose === 'delete_button' || purpose === 'danger_button') return 'delete';
  if (purpose === 'submit_button') return 'submit';
  if (/(重置|清空|reset|clear)/i.test(text)) return 'reset';
  if (/(更多|操作|批量操作|more|actions?)/i.test(text)) return 'more';
  return 'generic';
}

function actionIconLabel(element: ObservedElement): string | undefined {
  if (compact(element.text)) return undefined;
  return element.ariaLabel || element.title || element.name || element.placeholder || undefined;
}

function inferFieldPurpose(label: string, element: ObservedElement): string {
  const text = compact([
    label,
    element.text,
    element.context,
    element.parentText,
    element.placeholder,
    element.name,
    element.selector,
  ].filter(Boolean).join(' '));
  if (/(子系统|业务系统|所属系统|系统名称|系统)/.test(text)) return 'subsystem';
  if (/(用户花名|花名|用户昵称|用户姓名|操作员|负责人|创建人|申请人)/.test(text)) return 'user_alias';
  if (/(文件名|文件名称|附件名|报表名)/.test(text)) return 'file_name';
  if (/(文件状态|状态|预警状态|审核状态)/.test(text)) return 'status';
  if (/(日期|时间|开始|结束|区间|date|time)/i.test(text)) return 'date_range';
  if (/(仓库|所属仓|仓储|库房)/.test(text)) return 'warehouse';
  if (/(关键词|搜索|查询条件)/.test(text)) return 'keyword';
  return 'field';
}

function inferActionRisk(element: ObservedElement): ActionRiskLevel {
  const purpose = inferActionPurpose(element);
  const text = `${element.text} ${element.context || ''} ${element.name || ''} ${element.ariaLabel || ''} ${element.title || ''}`;
  if (purpose === 'delete_button' || /(删除|作废|支付|购买|下单|delete|pay|buy)/i.test(text)) return 'high';
  if (purpose === 'submit_button' || purpose === 'save_button' || /(提交|保存|发送|同步|禁用|启用|submit|save|send|sync)/i.test(text)) return 'high';
  if (purpose === 'download_button' || /(导\s*出|下载|上传|修改|export|download|upload|edit)/i.test(text)) return 'medium';
  return 'low';
}

function isActionCandidate(element: ObservedElement): boolean {
  if (!element.visible || !element.enabled) return false;
  const inferredPurpose = inferActionPurpose(element);
  if ([
    'download_button',
    'submit_button',
    'search_button',
    'save_button',
    'delete_button',
    'danger_button',
    'login_button',
    'close_modal',
  ].includes(inferredPurpose || '')) return true;
  if (!['button', 'link', 'menuitem', 'option'].includes(element.role)) return false;
  return /(导\s*出|下载|查询|搜索|检索|重置|保存|提交|删除|作废|发送|export|download|excel|csv|search|save|submit|delete|更多|操作|批量操作|more|actions?)/i.test(`${element.text} ${element.context || ''} ${element.name || ''} ${element.placeholder || ''} ${element.ariaLabel || ''} ${element.title || ''}`);
}

function actionConfidence(element: ObservedElement): number {
  const purpose = inferActionPurpose(element);
  if (purpose === 'download_button') return 0.93;
  if (purpose === 'delete_button' || purpose === 'danger_button') return 0.84;
  if (purpose === 'submit_button' || purpose === 'save_button') return 0.78;
  if (purpose === 'search_button') return 0.72;
  if (/(更多|操作|批量操作|more|actions?)/i.test(`${element.text} ${element.context || ''}`)) return 0.64;
  return 0.58;
}

function tableRowIndexForElement(element: ObservedElement, elements: ObservedElement[]): number | undefined {
  if (element.region !== 'table_area' && !/table|tbody|tr|td|ant-table/i.test(`${element.selector || ''} ${element.context || ''}`)) return undefined;
  const rows = Array.from(new Set(elements
    .filter((item) => item.visible && (item.region === 'table_area' || /table|tbody|tr|td|ant-table/i.test(`${item.selector || ''} ${item.context || ''}`)))
    .map((item) => rowBucketKey(item))))
    .sort((a, b) => Number(a) - Number(b));
  const rowIndex = rows.indexOf(rowBucketKey(element));
  return rowIndex >= 0 ? rowIndex + 1 : undefined;
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
    .map((element, index) => {
      const purpose = inferActionPurpose(element);
      const riskLevel = inferActionRisk(element);
      const actionKind = inferActionKind(element);
      const rowIndex = tableRowIndexForElement(element, elements);
      const iconLabel = actionIconLabel(element);
      return {
        ...elementToCollectionItem({ ...element, purpose: purpose as any }, index + 1, actionConfidence(element)),
        purpose,
        riskLevel,
        metadata: {
          ...elementToCollectionItem(element, index + 1).metadata,
          purpose,
          actionKind,
          riskLevel,
          parentRegion: element.region || 'main',
          rowIndex,
          iconLabel,
        },
      };
    });

  return items.length ? {
    id: 'collection_action_group',
    type: 'action_group',
    title: '页面动作',
    items,
    confidence: 0.78,
    metadata: {
      purposes: Array.from(new Set(items.map((item) => item.purpose).filter(Boolean))),
      risks: Array.from(new Set(items.map((item) => item.riskLevel).filter(Boolean))),
    },
  } : null;
}

function inferFormLabel(element: ObservedElement): string {
  const candidates = [
    element.parentText,
    element.name,
    element.ariaLabel,
    element.title,
    element.placeholder,
    element.text,
    element.context,
  ].filter(Boolean).map((item) => String(item).trim());
  const label = candidates.find((item) => item && compact(item).length <= 48) || candidates[0] || '未命名字段';
  return label.replace(/\s+/g, ' ').slice(0, 80);
}

function controlType(element: ObservedElement): 'input' | 'select' | 'checkbox' | 'radio' | 'date' | 'textarea' {
  const descriptor = `${element.role} ${element.tag} ${element.selector || ''} ${element.context || ''}`.toLowerCase();
  if (/select|combobox|dropdown|ant-select|el-select/.test(descriptor)) return 'select';
  if (/checkbox/.test(descriptor)) return 'checkbox';
  if (/radio/.test(descriptor)) return 'radio';
  if (/date|picker|calendar/.test(descriptor)) return 'date';
  if (/textarea/.test(descriptor)) return 'textarea';
  return 'input';
}

function isFormControl(element: ObservedElement): boolean {
  if (!element.visible || !element.enabled) return false;
  if (['search_input'].includes(element.purpose || '')) return true;
  if (['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton'].includes(element.role)) return true;
  if (['input', 'textarea', 'select'].includes(String(element.tag || '').toLowerCase())) return true;
  return /(ant-input|ant-select|ant-picker|el-input|el-select|textarea|form-item)/i.test(`${element.selector || ''} ${element.context || ''}`);
}

function buildFormGroup(elements: ObservedElement[]): ObservedCollection | null {
  const seen = new Set<string>();
  const formControls = elements
    .filter(isFormControl)
    .filter((element) => {
      const key = element.elementId || element.selector || `${inferFormLabel(element)}:${controlType(element)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(a.bbox?.y || 0) - Number(b.bbox?.y || 0) || Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0))
    .map((element, index) => {
      const label = inferFormLabel(element);
      const fieldPurpose = inferFieldPurpose(label, element);
      const type = controlType(element);
      const displayText = [
        label,
        element.placeholder ? `placeholder:${element.placeholder}` : '',
        element.value ? `value:${element.value}` : '',
      ].filter(Boolean).join(' ');
      const item = elementToCollectionItem({
        ...element,
        text: displayText,
        purpose: fieldPurpose as any,
      }, index + 1, element.value ? 0.76 : 0.7);
      return {
        ...item,
        text: label,
        purpose: fieldPurpose,
        metadata: {
          ...(item.metadata || {}),
          label,
          value: element.value,
          placeholder: element.placeholder,
          controlType: type,
          fieldPurpose,
          currentValue: element.value,
          required: element.required === true || /[*＊]\s*$/.test(label),
          selectLike: type === 'select',
          isSelectLike: type === 'select',
          originalText: element.text,
          name: element.name,
          checked: element.checked,
        },
      };
    });

  return formControls.length ? {
    id: 'collection_form_group',
    type: 'form_group',
    title: '页面表单',
    items: formControls,
    confidence: 0.72,
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

function rowBucketKey(element: ObservedElement): string {
  const y = Number(element.bbox?.y || 0);
  return String(Math.round(y / 12) * 12);
}

function tableActionLabel(element: ObservedElement): string {
  return element.text
    || element.ariaLabel
    || element.title
    || element.name
    || element.context
    || element.placeholder
    || inferActionPurpose(element)
    || '行内动作';
}

function stableRowKey(text: string, elementIds: string[]): string {
  const source = `${compact(text)}|${elementIds.join('|')}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `row_${(hash >>> 0).toString(36)}`;
}

function buildTableRowGroup(elements: ObservedElement[]): ObservedCollection | null {
  const tableElements = elements
    .filter((element) => element.visible)
    .filter((element) => element.region === 'table_area' || element.purpose === 'table' || /table|tbody|tr|td|ant-table/i.test(`${element.selector || ''} ${element.context || ''}`))
    .filter((element) => !['table', 'thead', 'tbody', 'tfoot'].includes(String(element.tag || '').toLowerCase()))
    .filter((element) => element.purpose !== 'table')
    .filter((element) => compact(`${element.text} ${element.context || ''}`).length > 0);

  const buckets = new Map<string, ObservedElement[]>();
  for (const element of tableElements) {
    const key = rowBucketKey(element);
    buckets.set(key, [...(buckets.get(key) || []), element]);
  }

  const rows = Array.from(buckets.entries())
    .map(([key, rowElements]) => {
      const sorted = rowElements.sort((a, b) => Number(a.bbox?.x || 0) - Number(b.bbox?.x || 0));
      const text = sorted.map((element) => element.text || element.context || '').filter(Boolean).join(' | ');
      const actions = sorted
        .filter(isActionCandidate)
        .map((element) => ({
          text: tableActionLabel(element),
          purpose: inferActionPurpose(element),
          actionKind: inferActionKind(element),
          riskLevel: inferActionRisk(element),
          elementId: element.elementId,
          selector: element.selector,
          bbox: element.bbox,
          context: element.context,
          iconLabel: actionIconLabel(element),
        }));
      return { key, sorted, text, actions };
    })
    .filter((row) => compact(row.text).length > 1 || row.actions.length > 0)
    .sort((a, b) => Number(a.key) - Number(b.key))
    .slice(0, 120)
    .map((row, index) => {
      const sourceElementIds = row.sorted.map((element) => element.elementId).filter(Boolean);
      return {
      index: index + 1,
      text: row.text.slice(0, 240),
      elementId: row.sorted.find((element) => element.clickable || element.enabled)?.elementId,
      selector: row.sorted.find((element) => element.clickable || element.enabled)?.selector,
      bbox: row.sorted[0]?.bbox,
      sourceElementIds,
      metadata: {
        rowIndex: index + 1,
        rowText: row.text,
        stableRowKey: stableRowKey(row.text, sourceElementIds),
        cells: row.sorted.map((element, cellIndex) => ({
          index: cellIndex + 1,
          text: element.text || element.context || '',
          elementId: element.elementId,
          selector: element.selector,
        })),
        actions: row.actions,
        columnText: row.sorted.map((element) => element.text).filter(Boolean).slice(0, 24),
      },
      confidence: row.actions.length ? 0.74 : 0.62,
    };});

  return rows.length ? {
    id: 'collection_table_rows',
    type: 'table_row_group',
    title: '表格行',
    items: rows,
    confidence: 0.66,
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
  const formGroup = buildFormGroup(elements);
  if (formGroup) pushCollection(collections, formGroup);
  const fileList = buildFileList(elements, input.phase);
  if (fileList) pushCollection(collections, fileList);
  const tables = buildTableCollection(input.tableCandidates || []);
  if (tables) pushCollection(collections, tables);
  const tableRows = buildTableRowGroup(elements);
  if (tableRows) pushCollection(collections, tableRows);
  const actionGroup = buildActionGroup(elements);
  if (actionGroup) pushCollection(collections, actionGroup);
  const cards = buildCards(elements);
  if (cards) pushCollection(collections, cards);
  return collections;
}
