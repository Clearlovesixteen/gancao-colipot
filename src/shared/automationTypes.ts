export type BaseStep = {
  id?: string;
};

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObservedElement {
  elementId: string;
  role: string;
  tag: string;
  text: string;
  selector: string;
  selectors: string[];
  selectorCandidates?: string[];
  bbox: ElementBox;
  visible: boolean;
  enabled: boolean;
  value?: string;
  checked?: boolean;
  href?: string;
  placeholder?: string;
  name?: string;
  purpose?: ElementPurpose;
  score?: number;
  region?: BrowserPageRegionType;
  context?: string;
  clickable?: boolean;
  parentText?: string;
  level?: number;
  expanded?: boolean;
  active?: boolean;
  framePath?: string[];
  shadowPath?: string[];
}

export type BrowserPageRegionType =
  | 'top_nav'
  | 'sidebar'
  | 'main'
  | 'search_results'
  | 'table_area'
  | 'modal'
  | 'footer'
  | 'unknown';

export interface BrowserPageRegion {
  type: BrowserPageRegionType;
  selector?: string;
  text?: string;
  bbox?: ElementBox;
}

export type ObservedCollectionType =
  | 'search_results'
  | 'menu_group'
  | 'file_list'
  | 'table'
  | 'action_group'
  | 'cards'
  | 'list';

export interface ObservedCollectionItem {
  index: number;
  text: string;
  elementId?: string;
  selector?: string;
  parentText?: string;
  parentPath?: string[];
  context?: string;
  href?: string;
  bbox?: ElementBox;
  purpose?: string;
  active?: boolean;
  expanded?: boolean;
  clickable?: boolean;
  sourceElementIds?: string[];
  metadata?: Record<string, unknown>;
  confidence: number;
}

export interface ObservedCollection {
  id: string;
  type: ObservedCollectionType;
  title?: string;
  items: ObservedCollectionItem[];
  metadata?: Record<string, unknown>;
  confidence?: number;
}

export type ElementPurpose =
  | 'search_input'
  | 'search_button'
  | 'submit_button'
  | 'login_button'
  | 'close_modal'
  | 'download_button'
  | 'navigation_item'
  | 'menu_item'
  | 'pagination'
  | 'table'
  | 'generic';

export interface BrowserPageState {
  kind: 'search_page' | 'result_page' | 'login_page' | 'form_page' | 'table_page' | 'permission_page' | 'empty_page' | 'unknown';
  hasModal: boolean;
  hasCaptcha: boolean;
  hasLoginSignal: boolean;
  hasPermissionDenied?: boolean;
  hasEmptyState?: boolean;
  mainInputId?: string;
  primaryButtonId?: string;
  searchInputId?: string;
  searchButtonId?: string;
}

export interface BrowserObservation {
  success: true;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  scroll: {
    x: number;
    y: number;
    maxX: number;
    maxY: number;
  };
  elements: ObservedElement[];
  collections?: ObservedCollection[];
  regions?: BrowserPageRegion[];
  pageState?: BrowserPageState;
  screenshot?: string;
  capturedAt: number;
}

export interface ComputerUseTaskIntent {
  rawGoal: string;
  startUrl?: string;
  siteName?: string;
  actionType: 'search' | 'fill_form' | 'click' | 'extract' | 'download' | 'generic';
  query?: string;
  postSearchAction?: 'click_first_result';
  targetResultIndex?: number;
  targetText?: string;
  successCriteria?: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ComputerUseIntent {
  rawGoal: string;
  taskType: 'search' | 'navigation' | 'form' | 'data_extraction' | 'download' | 'generic';
  objective: string;
  entities: string[];
  desiredOutput?: 'page_state' | 'table_data' | 'download_file' | 'summary';
  startUrl?: string;
  siteName?: string;
  query?: string;
  postSearchAction?: 'click_first_result';
  targetResultIndex?: number;
  riskLevel: 'low' | 'medium' | 'high';
  ambiguity?: string[];
  navigationPath?: string[];
  taskPlan?: ComputerUseTaskPlan;
}

export interface ComputerUsePageContext {
  observation: BrowserObservation;
  structuredData?: {
    headings: string[];
    fields: unknown[];
    tables: unknown[];
    lists: unknown[];
  };
  pageTextPreview: string;
  navigationCandidates: ObservedElement[];
  tableCandidates: unknown[];
  actionCandidates: ObservedElement[];
  collections?: ObservedCollection[];
}

export interface PlannedStep {
  id: string;
  action: BrowserActionType | 'finish';
  target?: {
    elementId?: string;
    selector?: string;
    text?: string;
    href?: string;
    purpose?: string;
    collectionType?: ObservedCollectionType;
    collectionId?: string;
    ordinal?: number;
    parentPath?: string[];
    x?: number;
    y?: number;
  };
  value?: string;
  rationale: string;
  verify?: {
    type: 'url_contains' | 'text_exists' | 'element_exists' | 'table_exists' | 'value_equals' | 'page_changed' | 'menu_active' | 'candidate_count_increased';
    value?: string;
  };
  highRisk?: boolean;
  summary?: string;
}

export interface ComputerUsePlan {
  summary: string;
  confidence: number;
  steps: PlannedStep[];
  successCriteria: string[];
  needsUserInput?: string;
}

export interface ComputerUsePhaseMemory {
  phaseId: string;
  attempts: number;
  failedCandidates: Array<{
    action?: BrowserActionType | 'finish';
    elementId?: string;
    selector?: string;
    text?: string;
    reason?: string;
    count: number;
  }>;
}

export interface ComputerUseVerificationResult {
  success: boolean;
  reason?: string;
  blocking?: boolean;
  warning?: string;
}

export interface ComputerUseDownloadResult {
  success: boolean;
  status: 'completed' | 'partial' | 'failed' | 'timeout';
  message: string;
  downloadId?: number;
  filename?: string;
  url?: string;
  finalUrl?: string;
  mimeType?: string;
  size?: number;
  state?: string;
  danger?: string;
  error?: string;
  assetId?: string;
  assetTitle?: string;
  localParseStatus?: string;
  parseError?: string;
  savedToDocumentCenter?: boolean;
  needsManualImport?: boolean;
}

export interface ComputerUsePhaseEvidence {
  urlBefore?: string;
  urlAfter?: string;
  titleAfter?: string;
  routeChanged?: boolean;
  activeTexts?: string[];
  matchedTargets?: string[];
  matchedNavigationPath?: string[];
  visibleActionPurposes?: string[];
}

export type ComputerUsePhaseType =
  | 'open_site'
  | 'search'
  | 'select_collection_item'
  | 'extract_data'
  | 'click_action'
  | 'fill_form'
  | 'navigate_to_page'
  | 'download_file'
  | 'open_page_or_center'
  | 'wait'
  | 'click_latest_download'
  | 'generic';

export type ComputerUsePhaseSource = 'llm' | 'fallback' | 'generated' | 'repair';

export interface ComputerUsePhase {
  id: string;
  type: ComputerUsePhaseType;
  goal: string;
  targets?: string[];
  navigationPath?: string[];
  startUrl?: string;
  siteName?: string;
  query?: string;
  ordinal?: number;
  collectionType?: ObservedCollectionType;
  formValues?: Array<{
    label: string;
    value: string;
    control?: 'input' | 'select' | 'checkbox';
  }>;
  waitMs?: number;
  usesDownloadResult?: boolean;
  source?: ComputerUsePhaseSource;
  repairReason?: string;
}

export interface ComputerUseTaskPlan {
  rawGoal: string;
  summary: string;
  phases: ComputerUsePhase[];
  source?: ComputerUsePhaseSource | 'mixed';
  repairReason?: string;
}

export interface ComputerUsePhaseResult {
  phase: ComputerUsePhase;
  success: boolean;
  summary?: string;
  result?: unknown;
  evidence?: ComputerUsePhaseEvidence;
}

export interface ComputerUseRunState {
  currentPhaseIndex: number;
  completedPhases: ComputerUsePhaseResult[];
  downloadResult?: ComputerUseDownloadResult;
  warnings?: string[];
}

export type BrowserActionType =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'type'
  | 'clear_input'
  | 'focus'
  | 'keyboard_shortcut'
  | 'click_by_coordinate'
  | 'press_key'
  | 'select_option'
  | 'check'
  | 'hover'
  | 'drag'
  | 'scroll'
  | 'wait'
  | 'wait_for_element'
  | 'upload_file'
  | 'download_file'
  | 'extract_table';

export type BrowserActionTarget = {
  elementId?: string;
  selector?: string;
  text?: string;
  parentPath?: string[];
  x?: number;
  y?: number;
  timeoutMs?: number;
};

export type AutomationStep =
  | ({ type: 'navigate'; url: string; waitFor?: 'complete' | 'domcontentloaded' | 'none'; timeoutMs?: number; } & BaseStep)
  | ({ type: 'wait'; ms: number; } & BaseStep)
  | ({ type: 'observe'; includeScreenshot?: boolean; limit?: number; into?: string; } & BaseStep)
  | ({ 
      type: 'click'; 
      elementId?: string;
      selector?: string; 
      text?: string; 
      x?: number; 
      y?: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      waitForElement?: boolean;
      timeoutMs?: number;
    } & BaseStep)
  | ({ 
      type: 'type'; 
      elementId?: string;
      selector?: string; 
      text: string; 
      clear?: boolean;
      delay?: number; // 输入延迟
    } & BaseStep)
  | ({
      type: 'pressKey';
      key: string;
      elementId?: string;
      selector?: string;
    } & BaseStep)
  | ({
      type: 'selectOption';
      elementId?: string;
      selector?: string;
      value: string;
      selectBy?: 'value' | 'text' | 'index';
    } & BaseStep)
  | ({
      type: 'hover';
      elementId?: string;
      selector?: string;
      text?: string;
      x?: number;
      y?: number;
    } & BaseStep)
  | ({
      type: 'uploadFile';
      elementId?: string;
      selector?: string;
      fileId?: string;
      fileName?: string;
    } & BaseStep)
  | ({ 
      type: 'waitForElement'; 
      selector: string; 
      timeoutMs?: number; 
    } & BaseStep)
  | ({
      type: 'assert';
      assertion: 'text_exists' | 'url_matches' | 'element_exists' | 'value_equals';
      selector?: string;
      text?: string;
      value?: string;
      timeoutMs?: number;
    } & BaseStep)
  | ({ 
      type: 'scroll'; 
      direction: 'up' | 'down' | 'top' | 'bottom'; 
      pixels?: number;
      behavior?: 'smooth' | 'auto';
    } & BaseStep)
  | ({ 
      type: 'extract'; 
      selector?: string; 
      text?: string; 
      limit?: number; 
      attribute?: string; 
      into: string; 
    } & BaseStep)
  | ({ 
      type: 'screenshot'; 
      format?: 'png' | 'jpeg'; 
      quality?: number;
      fullPage?: boolean;
      into?: string; 
    } & BaseStep)
  | ({
      type: 'forms';
      selector: string;
      value: string;
      formType?: 'text' | 'select' | 'checkbox' | 'radio';
      selectBy?: 'value' | 'text' | 'index'; // For select
      clear?: boolean;
      waitForElement?: boolean;
      timeoutMs?: number;
    } & BaseStep)
  | ({
      type: 'computerTask';
      goal: string;
      maxSteps?: number;
      startUrl?: string;
      allowHighRisk?: boolean;
    } & BaseStep);

export interface AutomationWorkflow {
  name?: string;
  variables?: Record<string, unknown>;
  steps: AutomationStep[];
};

export type AutomationProgressMessage = {
  type: 'AUTOMATION_PROGRESS';
  runId: string;
  stepIndex: number;
  step: AutomationStep;
  state: 'running' | 'done';
  result?: unknown;
};

export type AutomationFinishedMessage = {
  type: 'AUTOMATION_FINISHED';
  runId: string;
  result: {
    vars: Record<string, unknown>;
    last?: unknown;
    steps: Array<{ stepIndex: number; step: AutomationStep; result?: unknown }>;
  };
};

export type AutomationErrorMessage = {
  type: 'AUTOMATION_ERROR';
  runId: string;
  stepIndex?: number;
  error: string;
};

export type AutomationEvent = AutomationProgressMessage | AutomationFinishedMessage | AutomationErrorMessage;

export interface ComputerUseAction {
  action: BrowserActionType | 'finish';
  reason?: string;
  elementId?: string;
  selector?: string;
  text?: string;
  parentPath?: string[];
  x?: number;
  y?: number;
  key?: string;
  keys?: string[];
  value?: string;
  selectBy?: 'value' | 'text' | 'index';
  direction?: 'up' | 'down' | 'top' | 'bottom';
  pixels?: number;
  timeoutMs?: number;
  expect?: string;
  highRisk?: boolean;
  summary?: string;
}

export interface ComputerUseProgressMessage {
  type: 'COMPUTER_USE_PROGRESS';
  runId: string;
  stepIndex: number;
  goal: string;
  observation?: BrowserObservation;
  action?: ComputerUseAction;
  result?: unknown;
  state: 'observing' | 'planning' | 'waiting_confirmation' | 'acting' | 'verifying' | 'recovering' | 'done';
  intent?: ComputerUseIntent;
  plan?: ComputerUsePlan;
  chosenElement?: ObservedElement;
  beforeObservation?: BrowserObservation;
  afterObservation?: BrowserObservation;
  verification?: ComputerUseVerificationResult;
  rejectedPlanReason?: string;
  fallbackUsed?: string;
  phaseIndex?: number;
  phaseType?: ComputerUsePhaseType;
  phaseGoal?: string;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
}

export interface ComputerUseNeedsConfirmationMessage {
  type: 'COMPUTER_USE_NEEDS_CONFIRMATION';
  runId: string;
  stepIndex: number;
  goal: string;
  action: ComputerUseAction;
  reason: string;
}

export interface ComputerUseFinishedMessage {
  type: 'COMPUTER_USE_FINISHED';
  runId: string;
  goal: string;
  summary: string;
  steps: Array<{ action?: ComputerUseAction; result?: unknown }>;
  runState?: ComputerUseRunState;
}

export interface ComputerUseErrorMessage {
  type: 'COMPUTER_USE_ERROR';
  runId: string;
  goal: string;
  error: string;
  steps?: Array<{ action?: ComputerUseAction; result?: unknown; verification?: unknown; plan?: ComputerUsePlan }>;
  lastObservation?: BrowserObservation;
  verification?: ComputerUseVerificationResult;
  intent?: ComputerUseIntent;
  plan?: ComputerUsePlan;
  chosenElement?: ObservedElement;
  beforeObservation?: BrowserObservation;
  afterObservation?: BrowserObservation;
  rejectedPlanReason?: string;
  fallbackUsed?: string;
  phaseIndex?: number;
  phaseType?: ComputerUsePhaseType;
  phaseGoal?: string;
  phase?: ComputerUsePhase;
  runState?: ComputerUseRunState;
  result?: unknown;
}

export interface ComputerUseTraceEntry {
  timestamp: number;
  type: ComputerUseProgressMessage['type'] | ComputerUseNeedsConfirmationMessage['type'] | ComputerUseFinishedMessage['type'] | ComputerUseErrorMessage['type'];
  stepIndex?: number;
  state?: ComputerUseProgressMessage['state'];
  goal: string;
  observation?: BrowserObservation;
  action?: ComputerUseAction;
  result?: unknown;
  error?: string;
  summary?: string;
  intent?: ComputerUseIntent;
  navigationPath?: string[];
  plan?: ComputerUsePlan;
  chosenElement?: ObservedElement;
  beforeObservation?: BrowserObservation;
  afterObservation?: BrowserObservation;
  verification?: ComputerUseVerificationResult;
  rejectedPlanReason?: string;
  fallbackUsed?: string;
  phaseIndex?: number;
  phaseType?: ComputerUsePhaseType;
  phaseGoal?: string;
  phase?: ComputerUsePhase;
  phaseResult?: ComputerUsePhaseResult;
  downloadResult?: ComputerUseDownloadResult;
  runState?: ComputerUseRunState;
}

export interface ComputerUseTrace {
  runId: string;
  goal: string;
  status: 'running' | 'waiting_confirmation' | 'finished' | 'error' | 'stopped';
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  entries: ComputerUseTraceEntry[];
}
