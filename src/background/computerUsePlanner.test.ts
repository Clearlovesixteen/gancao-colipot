import { describe, expect, it } from 'vitest';
import type { BrowserObservation, ComputerUseIntent, ComputerUsePageContext, ObservedElement } from '../shared/automationTypes';
import { createComputerUsePlan } from './computerUsePlanner';

function element(partial: Partial<ObservedElement>): ObservedElement {
  return {
    elementId: partial.elementId || 'el_1',
    role: partial.role || 'button',
    tag: partial.tag || 'div',
    text: partial.text || '',
    selector: partial.selector || '#x',
    selectors: partial.selectors || [partial.selector || '#x'],
    bbox: partial.bbox || { x: 0, y: 0, width: 100, height: 32 },
    visible: partial.visible ?? true,
    enabled: partial.enabled ?? true,
    purpose: partial.purpose || 'generic',
    score: partial.score || 0.5,
    context: partial.context,
    parentText: partial.parentText,
    active: partial.active,
    expanded: partial.expanded,
    level: partial.level,
  };
}

function context(overrides: Partial<ComputerUsePageContext>): ComputerUsePageContext {
  const observation: BrowserObservation = {
    success: true,
    url: 'https://example.test',
    title: '测试页',
    viewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    scroll: { x: 0, y: 0, maxX: 0, maxY: 1000 },
    elements: [],
    capturedAt: Date.now(),
  };
  const { observation: observationOverrides, ...restOverrides } = overrides;
  return {
    pageTextPreview: '',
    navigationCandidates: [],
    tableCandidates: [],
    actionCandidates: [],
    ...restOverrides,
    observation: { ...observation, ...observationOverrides },
  };
}

const intent: ComputerUseIntent = {
  rawGoal: '导出颗粒剂管理中库存预警的列表数据',
  taskType: 'download',
  objective: '导出颗粒剂管理中库存预警的列表数据',
  entities: ['颗粒剂管理', '库存预警'],
  desiredOutput: 'download_file',
  riskLevel: 'high',
};

describe('computerUsePlanner', () => {
  it('plans download_file when target page already has a download button', async () => {
    const exportButton = element({ elementId: 'export_1', text: '导出', purpose: 'download_button' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        pageTextPreview: '库存预警',
        actionCandidates: [exportButton],
        observation: { elements: [exportButton] } as any,
        tableCandidates: [{ headers: ['商品'], rows: [['A']] }],
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'download_file',
      target: expect.objectContaining({ elementId: 'export_1' }),
    }));
  });

  it('finishes when history already has a successful download result', async () => {
    const plan = await createComputerUsePlan({
      intent,
      history: [{
        action: { action: 'download_file' },
        verification: { success: true },
        result: { success: true, status: 'completed', filename: '库存预警.xlsx', assetId: 'download_1', savedToDocumentCenter: true },
      }],
      context: context({
        pageTextPreview: '库存预警',
        tableCandidates: [{ headers: ['商品'], rows: [['A']] }],
      }),
    });

    expect(plan.steps[0].action).toBe('finish');
    expect(plan.summary).toContain('已导出文件');
  });

  it('plans navigation click when matching menu is visible', async () => {
    const menu = element({ elementId: 'menu_1', text: '库存预警', purpose: 'menu_item' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        navigationCandidates: [menu],
        observation: { elements: [menu] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_1' }),
    }));
  });

  it('clicks target navigation before extracting tables from a possibly wrong current page', async () => {
    const menu = element({ elementId: 'menu_warning', text: '库存预警', purpose: 'menu_item' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        pageTextPreview: '数据权限管理 操作员ID 花名 手机号',
        navigationCandidates: [menu],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['310']] }],
        observation: { elements: [menu] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_warning' }),
    }));
  });

  it('clicks the parent module when only the parent navigation is visible on a wrong current page', async () => {
    const parent = element({ elementId: 'menu_module', text: '颗粒剂管理', purpose: 'menu_item' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        pageTextPreview: '数据权限管理 操作员ID 花名 手机号',
        navigationCandidates: [parent],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['310']] }],
        observation: { elements: [parent] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_module' }),
    }));
  });

  it('does not look for export after only the parent module was clicked and the leaf target is still missing', async () => {
    const parent = element({ elementId: 'menu_module', text: '颗粒剂管理', purpose: 'menu_item' });
    const plan = await createComputerUsePlan({
      intent,
      history: [{
        action: { action: 'click', elementId: 'menu_module', text: '颗粒剂管理' },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '数据权限管理 操作员ID 花名 手机号',
        navigationCandidates: [parent],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['310']] }],
        observation: { elements: [parent] } as any,
      }),
    });

    expect(plan.steps[0].action).toBe('finish');
    expect(plan.summary).toContain('库存预警');
  });

  it('prefers the leaf target navigation over the parent module', async () => {
    const parent = element({ elementId: 'menu_module', text: '颗粒剂管理', purpose: 'menu_item' });
    const child = element({
      elementId: 'menu_warning',
      text: '库存预警',
      purpose: 'menu_item',
      context: 'sidebar | 颗粒剂管理 库存列表 库存预警',
      parentText: '颗粒剂管理 库存列表 库存预警',
    });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        navigationCandidates: [parent, child],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['310']] }],
        observation: { elements: [parent, child] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_warning' }),
    }));
  });

  it('does not treat the same leaf menu under another module as the target path', async () => {
    const drinkIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '导出饮片管理中库存预警的列表',
      objective: '导出饮片管理中库存预警的列表',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const wrongActiveLeaf = element({
      elementId: 'menu_granule_warning',
      text: '库存预警',
      purpose: 'menu_item',
      active: true,
      context: 'sidebar | 颗粒剂管理 颗粒剂收货 库存列表 库存预警 库存结存',
      parentText: '颗粒剂管理 颗粒剂收货 库存列表 库存预警 库存结存',
    });
    const drinkParent = element({
      elementId: 'menu_drink',
      text: '饮片管理',
      purpose: 'menu_item',
      context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
    });
    const exportButton = element({ elementId: 'export_1', text: '导出', purpose: 'download_button' });
    const plan = await createComputerUsePlan({
      intent: drinkIntent,
      history: [],
      context: context({
        pageTextPreview: '库存预警 所属仓 预警状态',
        navigationCandidates: [wrongActiveLeaf, drinkParent],
        actionCandidates: [exportButton],
        tableCandidates: [{ headers: ['商品'], rows: [['A']] }],
        observation: { elements: [wrongActiveLeaf, drinkParent, exportButton] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_drink' }),
    }));
  });

  it('clicks the child tab after the parent module was clicked even if the reason contains the full path', async () => {
    const drinkIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '请自动操作：导出饮片管理中库存预警的列表',
      objective: '导出饮片管理中库存预警的列表',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const granuleWarning = element({
      elementId: 'el_granule_warning_111',
      text: '库存预警',
      purpose: 'menu_item',
      context: 'sidebar | 颗粒剂收货 颗粒剂收货单 库存列表 药斗库存列表 库存预警 库存结存',
      parentText: '颗粒剂收货 颗粒剂收货单 库存列表 药斗库存列表 库存预警 库存结存',
    });
    const drinkWarning = element({
      elementId: 'el_drink_warning_164',
      text: '库存预警',
      purpose: 'menu_item',
      context: 'sidebar | 待入库列表 入库记录 库存列表 药斗库存列表 货架库存列表 库存预警 库存结存',
      parentText: '待入库列表 入库记录 库存列表 药斗库存列表 货架库存列表 库存预警 库存结存',
    });
    const searchButton = element({
      elementId: 'search_button',
      text: '查 询',
      purpose: 'search_button',
      role: 'button',
      selector: '.base-btn-search',
      score: 0.78,
    });
    const plan = await createComputerUsePlan({
      intent: drinkIntent,
      history: [{
        action: {
          action: 'click',
          elementId: 'el_drink_parent_141',
          text: '饮片管理',
          reason: '按业务菜单路径进入目标页面：饮片管理 > 库存预警',
        },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '花名 手机号 状态 操作员ID',
        navigationCandidates: [granuleWarning, drinkWarning],
        actionCandidates: [searchButton],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['282']] }],
        observation: { elements: [granuleWarning, drinkWarning, searchButton] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'el_drink_warning_164' }),
    }));
  });

  it('does not click an aggregate submenu wrapper as the leaf target', async () => {
    const drinkIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '请自动操作：打开饮片管理中库存预警的列表，点击导出',
      objective: '打开饮片管理中库存预警的列表，点击导出',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const aggregateWrapper = element({
      elementId: 'aggregate_wrapper',
      text: '待入库列表入库记录收货单记录库存列表药斗库存列表货架库存列表库存预警库存结存盘点管理退货列表货架挪动清斗管理',
      purpose: 'menu_item',
      role: 'div',
      clickable: false,
      context: 'sidebar | 饮片管理 待入库列表 入库记录 收货单记录 库存列表 药斗库存列表 货架库存列表 库存预警 库存结存',
      parentText: '饮片管理 待入库列表 入库记录 收货单记录 库存列表 药斗库存列表 货架库存列表 库存预警 库存结存',
      bbox: { x: 12, y: 300, width: 180, height: 0 },
    });
    const plan = await createComputerUsePlan({
      intent: drinkIntent,
      history: [{
        action: {
          action: 'click',
          elementId: 'drink_parent',
          text: '饮片管理',
          reason: '按业务菜单路径进入目标页面：饮片管理 > 库存预警',
        },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '欢迎使用智慧药房WMS',
        navigationCandidates: [aggregateWrapper],
        observation: { elements: [aggregateWrapper] } as any,
      }),
    });

    expect(plan.steps[0].action).toBe('finish');
    expect(plan.summary).toContain('库存预警');
  });

  it('does not use a search button as the real download action', async () => {
    const drinkIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '请自动操作：导出饮片管理中库存预警的列表',
      objective: '导出饮片管理中库存预警的列表',
      entities: ['饮片管理', '库存预警'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const warningMenu = element({
      elementId: 'menu_drink_warning',
      text: '库存预警',
      purpose: 'menu_item',
      active: true,
      context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
      parentText: '饮片管理 待入库列表 库存列表 库存预警 库存结存',
    });
    const searchButton = element({
      elementId: 'search_button',
      text: '查 询',
      purpose: 'search_button',
      role: 'button',
      selector: '.base-btn-search',
      score: 0.78,
    });
    const plan = await createComputerUsePlan({
      intent: drinkIntent,
      history: [{
        action: { action: 'click', elementId: 'menu_drink', text: '饮片管理' },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '库存预警 所属仓 药材名称 预警状态',
        navigationCandidates: [warningMenu],
        actionCandidates: [searchButton],
        tableCandidates: [{ headers: ['所属仓', '药材名称'], rows: [['test仓1', 'A']] }],
        observation: { elements: [warningMenu, searchButton] } as any,
      }),
    });

    expect(plan.steps[0].action).not.toBe('download_file');
    expect(plan.summary).not.toContain('查 询');
  });

  it('ignores post-download entities while planning the current export stage', async () => {
    const complexIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '请自动操作：打开饮片管理中库存预警的列表，点击导出，然后打开文件中心，等待5S,然后点击刚刚下载的文件',
      objective: '打开饮片管理中的库存预警列表，执行导出操作；随后打开文件中心，等待5秒，并打开刚刚下载的文件。',
      entities: ['饮片管理', '库存预警', '文件中心', '刚刚下载的文件'],
      navigationPath: ['饮片管理', '库存预警'],
    };
    const warningMenu = element({
      elementId: 'menu_drink_warning',
      text: '库存预警',
      purpose: 'menu_item',
      active: true,
      context: 'sidebar | 饮片管理 待入库列表 库存列表 库存预警 库存结存',
      parentText: '饮片管理 待入库列表 库存列表 库存预警 库存结存',
    });
    const exportButton = element({
      elementId: 'export_drink_warning',
      text: '导 出',
      purpose: 'download_button',
      role: 'button',
      selector: '.base-btn-export',
      score: 0.9,
    });
    const plan = await createComputerUsePlan({
      intent: complexIntent,
      history: [{
        action: { action: 'click', elementId: 'el_drink_parent_141', text: '饮片管理' },
        verification: { success: true },
        result: { success: true },
      }, {
        action: { action: 'click', elementId: 'menu_drink_warning', text: '库存预警' },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '库存预警 所属仓 药材名称 预警状态',
        navigationCandidates: [warningMenu],
        actionCandidates: [exportButton],
        tableCandidates: [{ headers: ['所属仓', '药材名称'], rows: [['test仓1', 'A']] }],
        observation: { elements: [warningMenu, exportButton] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'download_file',
      target: expect.objectContaining({ elementId: 'export_drink_warning' }),
    }));
  });

  it('opens file center in a phase without looking for previous inventory targets', async () => {
    const fileCenter = element({ elementId: 'file_center', text: '文件中心', purpose: 'navigation_item', role: 'link' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      phase: { id: 'open_file_center', type: 'open_page_or_center', goal: '打开文件中心', targets: ['文件中心'] },
      context: context({
        pageTextPreview: '库存预警 所属仓 药材名称 导出',
        navigationCandidates: [fileCenter],
        observation: { elements: [fileCenter] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'file_center' }),
    }));
  });

  it('clicks the downloaded filename in file center phase', async () => {
    const downloadedFile = element({
      elementId: 'downloaded_file',
      text: '库存预警_20260630.xlsx',
      purpose: 'generic',
      role: 'link',
      selector: '.file-row',
    });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      phase: { id: 'click_latest_download', type: 'click_latest_download', goal: '点击刚刚下载的文件', usesDownloadResult: true },
      runState: {
        currentPhaseIndex: 4,
        completedPhases: [],
        downloadResult: {
          success: true,
          status: 'completed',
          message: '已下载',
          filename: '库存预警_20260630.xlsx',
          downloadId: 9,
        },
      },
      context: context({
        pageTextPreview: '文件中心 库存预警_20260630.xlsx',
        observation: { elements: [downloadedFile] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'downloaded_file' }),
    }));
  });

  it('clicks a real download button after matching navigation was clicked', async () => {
    const menu = element({ elementId: 'menu_warning_new', text: '库存预警', purpose: 'menu_item' });
    const exportButton = element({ elementId: 'export_after_nav', text: '导出', purpose: 'download_button' });
    const plan = await createComputerUsePlan({
      intent,
      history: [{
        action: { action: 'click', elementId: 'old_menu_id', text: '库存预警' },
        verification: { success: true },
        result: { success: true },
      }],
      context: context({
        pageTextPreview: '库存预警 商品编码 当前库存',
        navigationCandidates: [menu],
        actionCandidates: [exportButton],
        tableCandidates: [{ headers: ['商品编码', '当前库存'], rows: [['A', '10']] }],
        observation: { elements: [menu, exportButton] } as any,
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'download_file',
      target: expect.objectContaining({ elementId: 'export_after_nav' }),
    }));
  });

  it('extracts tables for non-download data extraction tasks', async () => {
    const dataIntent: ComputerUseIntent = {
      ...intent,
      rawGoal: '读取库存预警的列表数据',
      taskType: 'data_extraction',
      desiredOutput: 'table_data',
    };
    const plan = await createComputerUsePlan({
      intent: dataIntent,
      history: [],
      context: context({
        pageTextPreview: '库存预警 商品编码 当前库存',
        tableCandidates: [{ headers: ['商品编码', '当前库存'], rows: [['A', '10']] }],
      }),
    });

    expect(plan.steps[0].action).toBe('extract_table');
  });

  it('rejects premature LLM finish when actionable navigation exists', async () => {
    const menu = element({ elementId: 'menu_warning', text: '库存预警', purpose: 'menu_item' });
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({
        navigationCandidates: [menu],
        tableCandidates: [{ headers: ['操作员ID'], rows: [['310']] }],
        observation: { elements: [menu] } as any,
      }),
      callLLM: async () => ({
        summary: 'finish',
        confidence: 0.9,
        steps: [{
          id: 'finish',
          action: 'finish',
          rationale: 'finish',
          summary: 'finish',
        }],
        successCriteria: [],
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'click',
      target: expect.objectContaining({ elementId: 'menu_warning' }),
    }));
  });

  it('finishes with explanation when target is unavailable', async () => {
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({}),
    });

    expect(plan.steps[0].action).toBe('finish');
    expect(plan.steps[0].summary || plan.summary).toContain('未找到');
  });

  it('normalizes LLM action aliases such as fill to supported actions', async () => {
    const plan = await createComputerUsePlan({
      intent,
      history: [],
      context: context({}),
      callLLM: async () => ({
        summary: '填写输入框',
        confidence: 0.8,
        steps: [{
          id: 'fill_keyword',
          action: 'fill',
          target: { elementId: 'input_1' },
          value: '库存预警',
          rationale: '填写关键词',
        }],
        successCriteria: [],
      }),
    });

    expect(plan.steps[0]).toEqual(expect.objectContaining({
      action: 'type',
      value: '库存预警',
    }));
  });
});
