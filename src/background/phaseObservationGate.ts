import type {
  ComputerUsePageContext,
  ComputerUsePhase,
  ObservedCollection,
  ObservedCollectionType,
} from '../shared/automationTypes';

export interface PhaseObservationGateResult {
  ok: boolean;
  retryable: boolean;
  reason?: string;
  requiredCollections: ObservedCollectionType[];
  presentCollections: ObservedCollectionType[];
  qualityScore?: number;
  blockingIssues: string[];
}

function isActionableCollection(collection: ObservedCollection): boolean {
  return collection.items.some((item) => (
    item.clickable !== false
    && Boolean(
      item.elementId
      || item.selector
      || item.href
      || item.bbox
      || item.metadata?.actions?.some((action) => action.elementId || action.selector || action.bbox)
    )
  ));
}

function requiredCollectionsForPhase(phase: ComputerUsePhase): ObservedCollectionType[] {
  switch (phase.type) {
    case 'select_collection_item':
      return [phase.collectionType || 'search_results'];
    case 'navigate_to_page':
    case 'open_page_or_center':
      return ['menu_group'];
    case 'download_file':
      return phase.collectionType === 'table_row_group'
        ? ['table_row_group']
        : ['action_group'];
    case 'fill_form':
      return ['form_group'];
    case 'click_latest_download':
      return ['file_list'];
    case 'extract_data':
      return ['table'];
    case 'click_action':
      return phase.ordinal ? ['table_row_group'] : ['action_group'];
    default:
      return [];
  }
}

function hasTargetPageEvidence(phase: ComputerUsePhase, context: ComputerUsePageContext): boolean {
  const targets = (phase.navigationPath?.length ? phase.navigationPath : phase.targets || [])
    .map((value) => String(value || '').replace(/\s+/g, '').toLowerCase())
    .filter(Boolean);
  if (!targets.length) return false;
  const pageText = [
    context.observation.title,
    context.observation.url,
    context.pageTextPreview,
    ...(context.structuredData?.headings || []).map(String),
  ].join(' ').replace(/\s+/g, '').toLowerCase();
  return targets.every((target) => pageText.includes(target));
}

export function evaluatePhaseObservationGate(input: {
  phase: ComputerUsePhase;
  context: ComputerUsePageContext;
}): PhaseObservationGateResult {
  const requiredCollections = requiredCollectionsForPhase(input.phase);
  const collections = input.context.collections || [];
  const presentCollections = Array.from(new Set(collections.map((collection) => collection.type)));
  const quality = input.context.observationQuality || input.context.observation.qualityReport;
  const blockingIssues = (quality?.issues || [])
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.message);

  // Duplicate element identities make every downstream target reference unsafe.
  if ((quality?.issues || []).some((issue) => issue.code === 'DUPLICATE_ELEMENT_ID')) {
    return {
      ok: false,
      retryable: true,
      reason: '页面观察包含重复 elementId，无法可靠定位唯一目标。',
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  if (!requiredCollections.length) {
    return {
      ok: true,
      retryable: false,
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  const missing = requiredCollections.filter((type) => !collections.some((collection) => (
    collection.type === type && isActionableCollection(collection)
  )));

  if (input.phase.type === 'extract_data' && input.context.tableCandidates.length > 0) {
    return {
      ok: true,
      retryable: false,
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  if (missing.length && ['navigate_to_page', 'open_page_or_center'].includes(input.phase.type)
    && hasTargetPageEvidence(input.phase, input.context)) {
    return {
      ok: true,
      retryable: false,
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  if (missing.length) {
    return {
      ok: false,
      retryable: true,
      reason: `当前观察缺少可执行的 ${missing.join(' / ')} 语义集合。`,
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  const weakRequiredCollection = requiredCollections.some((type) => {
    // Content scripts and persisted traces can briefly expose an older/partial
    // quality report while a navigation is settling. The semantic collections
    // above are still authoritative, so a missing summary must not crash an
    // otherwise successful action during post-navigation verification.
    const summaries = (quality?.collections || []).filter((collection) => collection.type === type);
    return summaries.length > 0 && summaries.every((summary) => (
      summary.actionableCount === 0 || summary.averageConfidence < 0.45
    ));
  });
  if (weakRequiredCollection) {
    return {
      ok: false,
      retryable: true,
      reason: '目标语义集合置信度过低或没有可执行项，拒绝基于当前观察执行。',
      requiredCollections,
      presentCollections,
      qualityScore: quality?.score,
      blockingIssues,
    };
  }

  return {
    ok: true,
    retryable: false,
    requiredCollections,
    presentCollections,
    qualityScore: quality?.score,
    blockingIssues,
  };
}
