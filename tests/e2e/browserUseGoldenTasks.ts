export type BrowserUseGoldenTask = {
  id: string;
  title: string;
  fixturePath: string;
  goal: string;
  maxSteps: number;
  expectedStatus: 'finished' | 'error';
  expectedPhaseTypes: string[];
  expectedCollectionTypes: string[];
  setup?: 'open_file_center';
  assertion: 'correct_parent_export' | 'first_row_download' | 'download_file_center_roundtrip' | 'missing_export_error';
};

export const BROWSER_USE_GOLDEN_TASKS: BrowserUseGoldenTask[] = [
  {
    id: 'duplicate-menu-real-export',
    title: '同名菜单按父路径导航并真实导出',
    fixturePath: '/business.html',
    goal: '打开饮片管理中的库存预警列表，点击导出',
    maxSteps: 16,
    expectedStatus: 'finished',
    expectedPhaseTypes: ['navigate_to_page', 'download_file'],
    expectedCollectionTypes: ['menu_group', 'action_group'],
    assertion: 'correct_parent_export',
  },
  {
    id: 'form-query-first-row-download',
    title: '填写筛选条件并下载第一条表格数据',
    fixturePath: '/business.html',
    goal: '子系统选择智慧药房WMS仓储，再输入用户花名：秋枫，再点击查询，下载第一条数据',
    maxSteps: 20,
    expectedStatus: 'finished',
    expectedPhaseTypes: ['fill_form', 'click_action', 'download_file'],
    expectedCollectionTypes: ['form_group', 'table_row_group', 'action_group'],
    setup: 'open_file_center',
    assertion: 'first_row_download',
  },
  {
    id: 'download-file-center-roundtrip',
    title: '导出后进入文件中心并打开同一文件',
    fixturePath: '/business.html',
    goal: '打开饮片管理中的库存预警列表，点击导出，然后打开文件中心，等待1秒，然后点击刚刚下载的文件',
    maxSteps: 24,
    expectedStatus: 'finished',
    expectedPhaseTypes: ['navigate_to_page', 'download_file', 'open_page_or_center', 'wait', 'click_latest_download'],
    expectedCollectionTypes: ['menu_group', 'action_group', 'file_list'],
    assertion: 'download_file_center_roundtrip',
  },
  {
    id: 'missing-export-must-fail',
    title: '目标页没有导出按钮时必须明确失败',
    fixturePath: '/business.html?noExport=1',
    goal: '打开饮片管理中的库存预警列表，点击导出',
    maxSteps: 16,
    expectedStatus: 'error',
    expectedPhaseTypes: ['navigate_to_page', 'download_file'],
    expectedCollectionTypes: ['menu_group'],
    assertion: 'missing_export_error',
  },
];
