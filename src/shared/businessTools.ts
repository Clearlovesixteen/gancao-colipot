export interface BusinessToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export const BUSINESS_TOOLS: BusinessToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'observe_page',
      description: '观察当前页面的可交互元素、视口、滚动位置和可选截图。Computer Use 自动操作前应优先调用。',
      parameters: {
        type: 'object',
        properties: {
          includeScreenshot: {
            type: 'boolean',
            description: '是否返回当前可视区域截图 dataUrl。默认 false。',
          },
          limit: {
            type: 'number',
            description: '最多返回多少个可交互元素，默认 80。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_page_info',
      description: '获取当前活动网页的标题、URL 和页面正文摘要。适合用户说“这个页面”“当前页面”“帮我看看网页”时使用。',
      parameters: {
        type: 'object',
        properties: {
          include_html: {
            type: 'boolean',
            description: '是否包含页面 HTML 片段。默认 false，只有需要分析结构或选择器时才开启。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_page_elements',
      description: '在当前网页中按 CSS 选择器或文本查询元素，用于分析页面结构、定位业务字段或准备自动化操作。',
      parameters: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description: 'CSS 选择器。selector 和 text 至少提供一个。',
          },
          text: {
            type: 'string',
            description: '元素包含的文本。selector 和 text 至少提供一个。',
          },
          limit: {
            type: 'number',
            description: '最多返回多少个元素，默认 10。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser_action',
      description: '执行浏览器动作。支持点击、输入、按键、选择、勾选、悬停、拖拽、滚动、等待、文件输入定位和真实导出/下载。用户明确要求导出/下载时使用 download_file；涉及提交、删除、购买、付款等高风险动作前必须先向用户确认。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['click', 'double_click', 'right_click', 'click_by_coordinate', 'type', 'clear_input', 'focus', 'keyboard_shortcut', 'press_key', 'select_option', 'check', 'hover', 'drag', 'scroll', 'wait', 'wait_for_element', 'upload_file', 'download_file'],
            description: '要执行的动作。',
          },
          elementId: {
            type: 'string',
            description: 'observe_page 返回的元素 ID，优先使用。',
          },
          selector: {
            type: 'string',
            description: 'CSS 选择器。',
          },
          text: {
            type: 'string',
            description: '点击时可作为包含文本；输入时是输入内容。',
          },
          direction: {
            type: 'string',
            enum: ['up', 'down', 'top', 'bottom'],
            description: '滚动方向。',
          },
          pixels: {
            type: 'number',
            description: '滚动像素。',
          },
          key: {
            type: 'string',
            description: 'press_key 或 keyboard_shortcut 使用的键名，例如 Enter、Escape、Meta+K。',
          },
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'keyboard_shortcut 使用的组合键，例如 ["Meta","K"]。',
          },
          value: {
            type: 'string',
            description: 'select_option/check 等动作使用的值。',
          },
          selectBy: {
            type: 'string',
            enum: ['value', 'text', 'index'],
            description: '选择下拉选项的方式。',
          },
          x: {
            type: 'number',
            description: '坐标点击或拖拽起点 X。',
          },
          y: {
            type: 'number',
            description: '坐标点击或拖拽起点 Y。',
          },
          toX: {
            type: 'number',
            description: '拖拽终点 X。',
          },
          toY: {
            type: 'number',
            description: '拖拽终点 Y。',
          },
          expect: {
            type: 'string',
            description: '执行后期望看到的结果描述，供调用方校验。',
          },
          timeoutMs: {
            type: 'number',
            description: '等待超时毫秒。',
          },
          role: {
            type: 'string',
            description: 'wait_for_element 可按 role 定位。',
          },
          purpose: {
            type: 'string',
            description: 'wait_for_element 可按 observe_page 的 purpose 定位，例如 download_button。',
          },
          clear: {
            type: 'boolean',
            description: 'type 动作是否先清空输入框。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_uploaded_files',
      description: '列出用户在聊天中上传或粘贴过的文件，并返回文件类型、解析状态、解析警告。适合用户提到“刚才的文件”“需求文档”“这个 Excel”等场景。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_uploaded_file',
      description: '读取用户上传文件的解析结果。支持文本、Markdown、JSON、CSV、Excel、HTML/XML、DOCX、PPTX、PDF 和图片元信息，用于总结、提取字段、分析需求文档。',
      parameters: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '文件唯一 ID。优先使用 id 读取，避免同名文件混淆。',
          },
          name: {
            type: 'string',
            description: '文件名。可以先调用 list_uploaded_files 获取。',
          },
          index: {
            type: 'number',
            description: '文件下标，从 0 开始。name 和 index 至少提供一个。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_documents',
      description: '列出资料中心中的文件、网页资料和 OCR 资料，返回解析、模型上传、OCR 状态。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_document',
      description: '读取资料中心中的某个资料全文、表格和分块摘要。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资料 ID。' },
          maxLength: { type: 'number', description: '最多返回多少字符，默认 20000。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description: '按问题检索资料中心相关片段，用于多文件问答和引用来源。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '用户问题或检索关键词。' },
          documentIds: {
            type: 'array',
            description: '可选，限制检索范围。',
            items: { type: 'string' },
          },
          limit: { type: 'number', description: '最多返回片段数，默认 8。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_document',
      description: '读取资料并返回可用于总结的正文片段和引用来源。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资料 ID。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_documents',
      description: '读取多个资料的核心片段，适合对比差异、合并信息。',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: '要对比的资料 ID 列表。',
          },
        },
        required: ['ids'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_document_tables',
      description: '读取资料中的表格数据，适合 Excel、CSV、网页表格和文档表格提取。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '资料 ID。' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_requirement_tasks',
      description: '把一个或多个需求文档拆成结构化任务清单、验收标准和待确认问题。',
      parameters: {
        type: 'object',
        properties: {
          documentIds: {
            type: 'array',
            items: { type: 'string' },
            description: '需求文档资料 ID。为空时默认使用最近资料。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract_page_structured_data',
      description: '提取当前网页的标题、字段、表格和列表，并保存为资料中心结果。',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_console_errors',
      description: '读取当前页面在插件注入后捕获到的控制台错误、Promise 未处理异常和资源加载失败，用于诊断页面报错。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '最多返回多少条错误，默认 30。',
          },
          since: {
            type: 'number',
            description: '可选，仅返回该时间戳之后的错误。',
          },
          useDebugger: {
            type: 'boolean',
            description: '是否使用 chrome.debugger 采集当前页面错误。默认 false；需要更完整诊断时设为 true。',
          },
          durationMs: {
            type: 'number',
            description: 'debugger 采集持续时间，默认 3500 毫秒。',
          },
          reload: {
            type: 'boolean',
            description: 'debugger 采集时是否刷新页面以捕获启动阶段错误。默认 false。',
          },
          includeContentFallback: {
            type: 'boolean',
            description: '使用 debugger 时是否合并 content script 已捕获错误。默认 true。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_search_results',
      description: '读取当前搜索结果页中的真实结果链接，排除顶部导航、登录、设置和 hao123 等非结果链接。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '最多返回多少条搜索结果，默认 10。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_search_result',
      description: '点击当前搜索结果页第 N 条真实搜索结果。默认点击第 1 条。',
      parameters: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: '要点击的搜索结果序号，从 1 开始。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_trace',
      description: '读取最近自动操作任务的完整执行日志，包含观察、计划、动作、结果、校验和错误。',
      parameters: {
        type: 'object',
        properties: {
          runId: {
            type: 'string',
            description: '可选，指定自动操作 runId；不传则返回最近任务列表。',
          },
          limit: {
            type: 'number',
            description: '不传 runId 时返回最近多少条任务，默认 10。',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_business_workflow_draft',
      description: '根据用户业务目标生成可保存的流程草稿，不直接执行。适合把重复业务沉淀为流程模板。',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '流程名称。',
          },
          goal: {
            type: 'string',
            description: '业务目标。',
          },
          steps: {
            type: 'array',
            description: '自然语言步骤列表。',
            items: { type: 'string' },
          },
        },
        required: ['name', 'goal', 'steps'],
        additionalProperties: false,
      },
    },
  },
];

export const BUSINESS_TOOL_NAMES = new Set(BUSINESS_TOOLS.map((tool) => tool.function.name));
