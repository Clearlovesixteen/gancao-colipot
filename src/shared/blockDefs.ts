import type { AutomationStep } from './automationTypes';

export type BlockCategory = 'browser' | 'interaction' | 'control-flow';

export interface BlockField {
  name: string;
  label: string;
  type: 'input' | 'number' | 'select' | 'checkbox' | 'textarea' | 'list';
  defaultValue?: any;
  placeholder?: string;
  options?: { label: string; value: any }[];
  description?: string;
  required?: boolean;
  min?: number;
  max?: number;
  // For 'list' type
  itemSchema?: BlockField[];
  newItemTemplate?: any;
}

export interface BlockDefinition {
  id: AutomationStep['type'];
  name: string;
  category: BlockCategory;
  description?: string;
  fields: BlockField[];
  summary: (step: AutomationStep) => string;
}

export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  {
    id: 'observe',
    name: '观察页面',
    category: 'browser',
    summary: (s: any) => s.includeScreenshot ? '含截图' : '元素观察',
    fields: [
      { name: 'includeScreenshot', label: '包含截图', type: 'checkbox', defaultValue: false },
      { name: 'limit', label: '元素数量', type: 'number', defaultValue: 80, min: 1, max: 200 },
      { name: 'into', label: '保存到变量', type: 'input', placeholder: 'observation' }
    ]
  },
  {
    id: 'navigate',
    name: '打开链接',
    category: 'browser',
    summary: (s: any) => s.url,
    fields: [
      { name: 'url', label: 'URL', type: 'input', required: true, description: '支持 {{变量}} 插值', defaultValue: 'https://example.com' },
      { 
        name: 'waitFor', 
        label: '等待', 
        type: 'select', 
        defaultValue: 'complete',
        options: [
          { label: 'Complete', value: 'complete' },
          { label: 'DOMContentLoaded', value: 'domcontentloaded' },
          { label: 'None', value: 'none' }
        ]
      },
      { name: 'timeoutMs', label: '超时 (ms)', type: 'number', defaultValue: 30000, min: 0 }
    ]
  },
  {
    id: 'scroll',
    name: '滚动页面',
    category: 'browser',
    summary: (s: any) => `${s.direction} ${s.pixels || ''}`,
    fields: [
      {
        name: 'direction',
        label: '方向',
        type: 'select',
        defaultValue: 'down',
        options: [
          { label: 'Up', value: 'up' },
          { label: 'Down', value: 'down' },
          { label: 'Top', value: 'top' },
          { label: 'Bottom', value: 'bottom' }
        ]
      },
      { name: 'pixels', label: '像素', type: 'number', defaultValue: 500, min: 0 },
      {
        name: 'behavior',
        label: '行为',
        type: 'select',
        defaultValue: 'smooth',
        options: [
          { label: '平滑 (Smooth)', value: 'smooth' },
          { label: '瞬间 (Auto)', value: 'auto' }
        ]
      }
    ]
  },
  {
    id: 'screenshot',
    name: '截图',
    category: 'browser',
    summary: (s: any) => s.format || 'png',
    fields: [
      {
        name: 'format',
        label: '格式',
        type: 'select',
        defaultValue: 'png',
        options: [
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' }
        ]
      },
      { name: 'quality', label: '质量 (JPEG)', type: 'number', defaultValue: 90, min: 1, max: 100 },
      { name: 'fullPage', label: '整页截图', type: 'checkbox', defaultValue: false },
      { name: 'into', label: '保存到变量', type: 'input', placeholder: 'shot' }
    ]
  },

  // Interaction Category
  {
    id: 'click',
    name: '点击元素',
    category: 'interaction',
    summary: (s: any) => s.selector || s.text || 'point',
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input', description: '优先使用选择器' },
      { name: 'elementId', label: '元素 ID', type: 'input', description: 'observe_page 返回的 elementId' },
      { name: 'text', label: '包含文本', type: 'input', description: '如果没有选择器，则查找包含此文本的元素' },
      { 
        name: 'button', 
        label: '按键', 
        type: 'select', 
        defaultValue: 'left',
        options: [
          { label: '左键', value: 'left' },
          { label: '右键', value: 'right' },
          { label: '中键', value: 'middle' }
        ] 
      },
      { name: 'clickCount', label: '点击次数', type: 'number', defaultValue: 1, min: 1 },
      { name: 'waitForElement', label: '等待元素出现', type: 'checkbox', defaultValue: true },
      { name: 'timeoutMs', label: '超时 (ms)', type: 'number', defaultValue: 5000, min: 0 },
      { name: 'x', label: 'X 坐标', type: 'number' },
      { name: 'y', label: 'Y 坐标', type: 'number' }
    ]
  },
  {
    id: 'type',
    name: '输入文本',
    category: 'interaction',
    summary: (s: any) => s.selector || s.elementId,
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'elementId', label: '元素 ID', type: 'input' },
      { name: 'text', label: '文本内容', type: 'input', required: true, description: '支持 {{变量}} 插值' },
      { name: 'clear', label: '先清空', type: 'checkbox', defaultValue: true },
      { name: 'delay', label: '输入延迟 (ms)', type: 'number', defaultValue: 0, min: 0 }
    ]
  },
  {
    id: 'pressKey',
    name: '按键',
    category: 'interaction',
    summary: (s: any) => s.key,
    fields: [
      { name: 'key', label: '按键', type: 'input', required: true, defaultValue: 'Enter' },
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'elementId', label: '元素 ID', type: 'input' }
    ]
  },
  {
    id: 'selectOption',
    name: '选择下拉项',
    category: 'interaction',
    summary: (s: any) => `${s.selector || s.elementId}=${s.value}`,
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'elementId', label: '元素 ID', type: 'input' },
      { name: 'value', label: '值', type: 'input', required: true },
      {
        name: 'selectBy',
        label: '匹配方式',
        type: 'select',
        defaultValue: 'value',
        options: [
          { label: '值', value: 'value' },
          { label: '文本', value: 'text' },
          { label: '序号', value: 'index' }
        ]
      }
    ]
  },
  {
    id: 'hover',
    name: '悬停',
    category: 'interaction',
    summary: (s: any) => s.selector || s.elementId || s.text || 'point',
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'elementId', label: '元素 ID', type: 'input' },
      { name: 'text', label: '包含文本', type: 'input' },
      { name: 'x', label: 'X 坐标', type: 'number' },
      { name: 'y', label: 'Y 坐标', type: 'number' }
    ]
  },
  {
    id: 'uploadFile',
    name: '上传文件',
    category: 'interaction',
    summary: (s: any) => s.selector || s.elementId || s.fileName || 'file',
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'elementId', label: '元素 ID', type: 'input' },
      { name: 'fileId', label: '文件 ID', type: 'input' },
      { name: 'fileName', label: '文件名', type: 'input' }
    ]
  },
  {
    id: 'extract',
    name: '提取数据',
    category: 'interaction',
    summary: (s: any) => `${s.selector} -> ${s.into}`,
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'text', label: '包含文本', type: 'input' },
      { name: 'attribute', label: '属性名', type: 'input', placeholder: '例如 href, src，留空提取文本' },
      { name: 'limit', label: '最大数量', type: 'number', defaultValue: 10, min: 1 },
      { name: 'into', label: '保存到变量', type: 'input', required: true, placeholder: 'data' }
    ]
  },

  {
    id: 'forms',
    name: '表单',
    category: 'interaction',
    summary: (s: any) => s.selector || 'Form',
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input', required: true, description: '表单元素选择器' },
      { 
        name: 'formType', 
        label: '类型', 
        type: 'select', 
        defaultValue: 'text',
        options: [
          { label: '文本域 (Text/Textarea)', value: 'text' },
          { label: '下拉列表 (Select)', value: 'select' },
          { label: '复选框 (Checkbox)', value: 'checkbox' },
          { label: '单选框 (Radio)', value: 'radio' }
        ] 
      },
      { 
        name: 'selectBy', 
        label: 'Select an option by', 
        type: 'select', 
        defaultValue: 'value',
        description: '仅用于下拉列表',
        options: [
          { label: 'The value', value: 'value' },
          { label: 'The text', value: 'text' },
          { label: 'The index', value: 'index' }
        ]
      },
      { name: 'value', label: '值', type: 'input', required: true, description: '支持 {{变量}} 插值' },
      { name: 'clear', label: '清除表单值', type: 'checkbox', defaultValue: false },
      { name: 'waitForElement', label: '等待元素出现', type: 'checkbox', defaultValue: true },
      { name: 'timeoutMs', label: '超时 (ms)', type: 'number', defaultValue: 5000, min: 0 }
    ]
  },

  // Control Flow Category
  {
    id: 'assert',
    name: '断言',
    category: 'control-flow',
    summary: (s: any) => `${s.assertion} ${s.text || s.value || s.selector || ''}`,
    fields: [
      {
        name: 'assertion',
        label: '断言类型',
        type: 'select',
        defaultValue: 'text_exists',
        options: [
          { label: '文本存在', value: 'text_exists' },
          { label: 'URL 匹配', value: 'url_matches' },
          { label: '元素存在', value: 'element_exists' },
          { label: '值相等', value: 'value_equals' }
        ]
      },
      { name: 'selector', label: 'CSS 选择器', type: 'input' },
      { name: 'text', label: '文本', type: 'input' },
      { name: 'value', label: '期望值', type: 'input' },
      { name: 'timeoutMs', label: '超时 (ms)', type: 'number', defaultValue: 5000, min: 0 }
    ]
  },
  {
    id: 'computerTask',
    name: '智能任务',
    category: 'control-flow',
    summary: (s: any) => s.goal,
    fields: [
      { name: 'goal', label: '目标', type: 'textarea', required: true },
      { name: 'startUrl', label: '起始 URL', type: 'input' },
      { name: 'maxSteps', label: '最大步数', type: 'number', defaultValue: 8, min: 1, max: 30 },
      { name: 'allowHighRisk', label: '允许高风险动作', type: 'checkbox', defaultValue: false }
    ]
  },
  {
    id: 'wait',
    name: '等待',
    category: 'control-flow',
    summary: (s: any) => `${s.ms}ms`,
    fields: [
      { name: 'ms', label: '时长 (ms)', type: 'number', required: true, defaultValue: 500, min: 0 }
    ]
  },
  {
    id: 'waitForElement',
    name: '等待元素',
    category: 'control-flow',
    summary: (s: any) => s.selector,
    fields: [
      { name: 'selector', label: 'CSS 选择器', type: 'input', required: true },
      { name: 'timeoutMs', label: '超时 (ms)', type: 'number', defaultValue: 5000, min: 0 }
    ]
  }
];

export const BLOCK_CATEGORIES = [
  { id: 'browser', title: 'Browser' },
  { id: 'interaction', title: 'Interaction' },
  { id: 'control-flow', title: 'Control Flow' }
];
