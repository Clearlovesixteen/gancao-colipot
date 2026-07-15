import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Collapse,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CopyOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
} from '@ant-design/icons';
import moment from 'moment';
import type {
  AutomationRun,
  AutomationRunKind,
  AutomationRunStatus,
  PageMonitorExtractMode,
  PageMonitorCheckRecord,
} from '../../shared/automationTypes';
import {
  AUTOMATION_TASK_TEMPLATES,
  deleteAutomationRun,
  listAutomationRuns,
  makeAutomationRunFromTemplate,
  patchAutomationRun,
  statusLabel,
  upsertAutomationRun,
} from '../../shared/automationRunStore';
import { createWorkflowDraftFromComputerUseRun } from '../../shared/automationWorkflowDraft';
import { upsertAutomationWorkflow } from '../../sidePanel/utils/automationStorage';
import { listAutomationWorkflows, type StoredAutomationWorkflow } from '../../sidePanel/utils/automationStorage';
import { listDocumentAssets } from '../../shared/documentRepository';
import type { DocumentAsset } from '../../shared/documentTypes';
import { listPageMonitorChecks } from '../../shared/pageMonitorHistory';

const { Text, Title, Paragraph } = Typography;
const { Search } = Input;
const { Option } = Select;

const statusColor: Record<AutomationRunStatus, string> = {
  draft: 'default',
  idle: 'blue',
  scheduled: 'purple',
  running: 'processing',
  success: 'success',
  partial: 'warning',
  failed: 'error',
  stopped: 'default',
};

const TaskOutputCard: React.FC<{ run: AutomationRun }> = ({ run }) => {
  const output = run.metadata?.taskOutput as any;
  if (output === undefined || output === null) return null;

  if (run.kind === 'document_qa') {
    return (
      <Card size="small" title="资料回答">
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{String(output.answer || output.summary || '已完成资料问答')}</Paragraph>
        {Array.isArray(output.sources) && output.sources.length > 0 && (
          <List
            size="small"
            header={<Text strong>引用来源</Text>}
            dataSource={output.sources}
            renderItem={(source: any) => (
              <List.Item actions={[source.documentId ? <Button key="copy-ref" type="link" size="small" onClick={() => navigator.clipboard.writeText(JSON.stringify(source))}>复制定位</Button> : null]}>
                <Space direction="vertical" size={0}>
                  <Text>{source.documentTitle || source.fileName || source.documentId || '资料来源'}</Text>
                  <Text type="secondary">
                    {[source.pageNumber ? `第 ${source.pageNumber} 页` : '', source.sectionTitle, source.chunkId].filter(Boolean).join(' · ') || '未标注页码/章节'}
                  </Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
    );
  }

  if (run.kind === 'ocr') {
    return (
      <Card size="small" title="OCR 结果">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="资料">{output.assetTitle || output.fileName || output.assetId || '-'}</Descriptions.Item>
          <Descriptions.Item label="页数">{output.pageCount ?? output.pages?.length ?? '-'}</Descriptions.Item>
          <Descriptions.Item label="状态">{output.status || run.status}</Descriptions.Item>
          <Descriptions.Item label="识别文本">{String(output.text || output.preview || '').slice(0, 600) || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>
    );
  }

  if (run.kind === 'page_diagnosis') {
    return (
      <Card size="small" title="页面诊断">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="摘要">{output.summary || output.answer || run.resultSummary || '-'}</Descriptions.Item>
          <Descriptions.Item label="风险等级">{output.riskLevel || output.risk || '-'}</Descriptions.Item>
          <Descriptions.Item label="当前页面">{output.url || run.traceSummary?.lastPageUrl || '-'}</Descriptions.Item>
        </Descriptions>
      </Card>
    );
  }

  if (run.kind === 'extract') {
    const tableCount = Array.isArray(output.tables) ? output.tables.length : 0;
    const fieldCount = Array.isArray(output.fields) ? output.fields.length : 0;
    const listCount = Array.isArray(output.lists) ? output.lists.length : 0;
    return (
      <Card size="small" title="提取结果">
        <Space wrap>
          <Tag>表格 {tableCount}</Tag>
          <Tag>字段 {fieldCount}</Tag>
          <Tag>列表 {listCount}</Tag>
        </Space>
      </Card>
    );
  }

  if (run.kind === 'computer_use') {
    const download = output.downloadResult || output.result?.downloadResult;
    if (download) {
      return (
        <Card size="small" title="业务交付结果">
          <Descriptions column={1} size="small">
            <Descriptions.Item label="文件名">{download.filename || download.assetTitle || '-'}</Descriptions.Item>
            <Descriptions.Item label="下载状态">{download.status || (download.success ? 'completed' : 'failed')}</Descriptions.Item>
            <Descriptions.Item label="资料 ID">{download.assetId || '-'}</Descriptions.Item>
            <Descriptions.Item label="资料入库">{download.savedToDocumentCenter ? '已入库' : '未自动入库'}</Descriptions.Item>
          </Descriptions>
        </Card>
      );
    }
  }

  return (
    <Collapse>
      <Collapse.Panel header="结构化任务结果" key="task-output">
        <pre style={{ maxHeight: 280, overflow: 'auto', background: '#f7f8fa', padding: 12, borderRadius: 6 }}>
          {JSON.stringify(output, null, 2)}
        </pre>
      </Collapse.Panel>
    </Collapse>
  );
};

const AutomationTaskCenter: React.FC = () => {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [runningTask, setRunningTask] = useState<{ taskId: string } | null>(null);
  const [detailRun, setDetailRun] = useState<AutomationRun | null>(null);
  const [statusFilter, setStatusFilter] = useState<AutomationRunStatus | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<AutomationRunKind | 'all'>('all');
  const [monitorTemplateId, setMonitorTemplateId] = useState<string | null>(null);
  const [monitorForm] = Form.useForm();
  const [configTemplateId, setConfigTemplateId] = useState<string | null>(null);
  const [taskForm] = Form.useForm();
  const [documents, setDocuments] = useState<DocumentAsset[]>([]);
  const [workflows, setWorkflows] = useState<StoredAutomationWorkflow[]>([]);
  const [monitorChecks, setMonitorChecks] = useState<PageMonitorCheckRecord[]>([]);

  const refresh = async () => {
    setLoading(true);
    try {
      setRuns(await listAutomationRuns());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    listDocumentAssets().then(setDocuments).catch(() => setDocuments([]));
    listAutomationWorkflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, []);

  useEffect(() => {
    if (detailRun?.kind !== 'page_monitor') {
      setMonitorChecks([]);
      return;
    }
    listPageMonitorChecks(detailRun.id).then(setMonitorChecks).catch(() => setMonitorChecks([]));
  }, [detailRun]);

  useEffect(() => {
    const listener = async (msg: any) => {
      if (!runningTask) return;
      if (msg.type === 'AUTOMATION_TASK_FINISHED' && msg.taskId === runningTask.taskId) {
        setRunningTask(null);
        message.success('任务已完成');
        setTimeout(refresh, 300);
      }
      if (msg.type === 'AUTOMATION_TASK_ERROR' && msg.taskId === runningTask.taskId) {
        setRunningTask(null);
        message.error('任务失败，已记录日志摘要');
        setTimeout(refresh, 300);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [runningTask]);

  const filteredRuns = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    return runs.filter((run) => {
      if (statusFilter !== 'all' && run.status !== statusFilter) return false;
      if (kindFilter !== 'all' && run.kind !== kindFilter) return false;
      if (!text) return true;
      return [run.title, run.goal, run.resultSummary, run.error, run.tags?.join(' ')]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(text));
    });
  }, [runs, keyword, statusFilter, kindFilter]);

  const handleCreateFromTemplate = async (templateId: string) => {
    const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === templateId);
    if (!template) return;
    if (template.kind === 'page_monitor') {
      setMonitorTemplateId(template.id);
      monitorForm.setFieldsValue({
        title: template.title,
        url: '',
        intervalMinutes: 15,
        extractMode: 'page_text',
        ruleType: 'changed',
        maxConsecutiveFailures: 3,
        extensionNotification: true,
      });
      return;
    }
    setConfigTemplateId(template.id);
    taskForm.setFieldsValue({
      title: template.title,
      goal: template.defaultGoal,
      startUrl: '',
      maxSteps: 12,
      documentIds: [],
      maxPages: 20,
      extractMode: 'structured',
      workflowVariablesJson: '{}',
      variablesJson: '{}',
    });
  };

  const handleRun = async (run: AutomationRun) => {
    if (runningTask) {
      message.warning('已有任务运行中，请先停止或等待完成');
      return;
    }
    if (run.kind !== 'ocr' && run.kind !== 'workflow' && !run.goal?.trim()) {
      message.error('任务缺少目标描述');
      return;
    }
    chrome.runtime.sendMessage(
      {
        type: 'RUN_AUTOMATION_TASK',
        taskId: run.id,
      },
      async (resp) => {
        const runtimeError = chrome.runtime.lastError?.message;
        if (runtimeError || !resp?.success) {
          message.error(resp?.error || runtimeError || '启动失败');
          refresh();
          return;
        }
        setRunningTask({ taskId: run.id });
        message.success('任务已启动');
        refresh();
      },
    );
  };

  const handleStop = async (run: AutomationRun) => {
    chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION_TASK', taskId: run.id });
    if (runningTask?.taskId === run.id) setRunningTask(null);
    message.info('已请求停止');
    refresh();
  };

  const handleSubmitTask = async () => {
    const values = await taskForm.validateFields();
    const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === configTemplateId);
    if (!template) return;
    const base = makeAutomationRunFromTemplate(template);
    const documentIds = Array.isArray(values.documentIds) ? values.documentIds : [];
    const parseJsonObject = (value: string | undefined, label: string) => {
      if (!value?.trim()) return {};
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        return parsed as Record<string, unknown>;
      } catch {
        throw new Error(`${label}必须是 JSON 对象`);
      }
    };
    let workflowVariables: Record<string, unknown>;
    let variables: Record<string, unknown>;
    try {
      workflowVariables = parseJsonObject(values.workflowVariablesJson, '工作流参数');
      variables = parseJsonObject(values.variablesJson, '运行参数');
    } catch (error: any) {
      message.error(error?.message || '参数格式不正确');
      return;
    }
    const run = await upsertAutomationRun({
      ...base,
      title: values.title || template.title,
      goal: values.goal || template.defaultGoal,
      workflowId: values.workflowId,
      metadata: {
        ...(base.metadata || {}),
        startUrl: values.startUrl,
        maxSteps: values.maxSteps,
        question: values.goal,
        documentIds,
        assetId: values.assetId,
        maxPages: values.maxPages,
        extractMode: values.extractMode,
        workflowId: values.workflowId,
        useDebugger: values.useDebugger === true,
        workflowVariables,
        variables,
      },
    });
    message.success('任务已加入任务中心');
    setConfigTemplateId(null);
    taskForm.resetFields();
    await refresh();
    return run;
  };

  const handleDisableMonitor = async (run: AutomationRun) => {
    await patchAutomationRun(run.id, {
      status: 'stopped',
      schedule: {
        ...(run.schedule || { enabled: false }),
        enabled: false,
      },
    });
    chrome.runtime.sendMessage({ type: 'UPSERT_PAGE_MONITOR_ALARM', runId: run.id });
    message.info('已停用页面监控');
    refresh();
  };

  const handleDelete = (run: AutomationRun) => {
    Modal.confirm({
      title: '删除任务记录',
      content: `确认删除「${run.title}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteAutomationRun(run.id);
        message.success('已删除');
        refresh();
      },
    });
  };

  const handleCopy = async (run: AutomationRun) => {
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          title: run.title,
          kind: run.kind,
          status: run.status,
          goal: run.goal,
          resultSummary: run.resultSummary,
          error: run.error,
          traceSummary: run.traceSummary,
        },
        null,
        2,
      ),
    );
    message.success('已复制任务摘要');
  };

  const handleCopyFullLog = async (run: AutomationRun) => {
    await navigator.clipboard.writeText(JSON.stringify(run, null, 2));
    message.success('已复制完整任务记录');
  };

  const handleSaveWorkflowDraft = async (run: AutomationRun) => {
    const id = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const { name, workflow } = createWorkflowDraftFromComputerUseRun(run);
    await upsertAutomationWorkflow({ id, name, workflow });
    message.success('已保存到自动化工作流');
  };

  const handleSubmitMonitor = async () => {
    const values = await monitorForm.validateFields();
    const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === monitorTemplateId);
    if (!template) return;
    const now = Date.now();
    const run = await upsertAutomationRun({
      id: `${now.toString(16)}-${Math.random().toString(16).slice(2)}`,
      title: values.title || template.title,
      kind: 'page_monitor',
      status: 'scheduled',
      goal: `监控页面：${values.url}`,
      source: 'dashboard',
      templateId: template.id,
      tags: template.tags,
      schedule: {
        enabled: true,
        intervalMinutes: Number(values.intervalMinutes || 15),
        nextRunAt: now + Number(values.intervalMinutes || 15) * 60 * 1000,
      },
      metadata: {
        category: template.category,
        riskLevel: template.riskLevel,
        requiredContext: template.requiredContext || [],
        monitor: {
          url: values.url,
          intervalMinutes: Number(values.intervalMinutes || 15),
          extractMode: values.extractMode as PageMonitorExtractMode,
          rule: {
            type: values.ruleType || 'changed',
            value: values.ruleValue,
            from: values.ruleFrom,
            to: values.ruleTo,
            operator: values.ruleOperator,
          },
          maxConsecutiveFailures: Number(values.maxConsecutiveFailures || 3),
          notifications: {
            extension: values.extensionNotification !== false,
            feishuWebhook: values.feishuWebhook?.trim() || undefined,
            dingtalkWebhook: values.dingtalkWebhook?.trim() || undefined,
            webhook: values.webhook?.trim() || undefined,
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    chrome.runtime.sendMessage({ type: 'UPSERT_PAGE_MONITOR_ALARM', runId: run.id });
    message.success('页面监控已创建');
    setMonitorTemplateId(null);
    monitorForm.resetFields();
    refresh();
  };

  const columns: ColumnsType<AutomationRun> = [
    {
      title: '任务',
      dataIndex: 'title',
      render: (_, run) => (
        <Space direction="vertical" size={2}>
          <Text strong>{run.title}</Text>
          <Text type="secondary" style={{ maxWidth: 420 }} ellipsis>
            {run.goal || run.resultSummary || '暂无目标'}
          </Text>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 130,
      render: (kind: AutomationRun['kind']) => <Tag>{kind}</Tag>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: AutomationRunStatus) => <Tag color={statusColor[status]}>{statusLabel(status)}</Tag>,
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 160,
      render: (updatedAt: number) => <Text type="secondary">{moment(updatedAt).fromNow()}</Text>,
    },
    {
      title: '结果/错误',
      width: 260,
      render: (_, run) => (
        <Text type={run.error ? 'danger' : 'secondary'} ellipsis style={{ maxWidth: 240 }}>
          {run.error || run.resultSummary || run.traceSummary?.lastError || '-'}
        </Text>
      ),
    },
    {
      title: '操作',
      width: 300,
      render: (_, run) => (
        <Space>
          {run.status === 'running' ? (
            <Button size="small" danger icon={<StopOutlined />} onClick={() => handleStop(run)}>
              停止
            </Button>
          ) : run.kind === 'page_monitor' && run.schedule?.enabled ? (
            <>
              <Button size="small" icon={<PlayCircleOutlined />} onClick={() => handleRun(run)}>
                检查
              </Button>
              <Button size="small" danger icon={<StopOutlined />} onClick={() => handleDisableMonitor(run)}>
                停用
              </Button>
            </>
          ) : (
            <Tooltip title={run.kind === 'page_monitor' ? '立即检查一次' : '运行任务'}>
              <Button size="small" icon={<PlayCircleOutlined />} onClick={() => handleRun(run)}>
                {run.kind === 'page_monitor' ? '检查' : '运行'}
              </Button>
            </Tooltip>
          )}
          <Button size="small" icon={<EyeOutlined />} onClick={() => setDetailRun(run)}>
            详情
          </Button>
          {run.kind === 'computer_use' && (run.status === 'success' || run.status === 'partial') && (
            <Button size="small" icon={<SaveOutlined />} onClick={() => handleSaveWorkflowDraft(run)}>
              存草稿
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={() => handleCopy(run)} />
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDelete(run)} />
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1280, margin: '0 auto' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>自动化任务中心</Title>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            统一运行与追踪 Computer Use、页面监控、页面诊断、资料问答、OCR、数据提取和固定工作流。
          </Paragraph>
        </div>

        <Card title="任务模板" extra={<Text type="secondary">HARPA-style 常用命令模板</Text>}>
          <List
            grid={{ gutter: 16, column: 4 }}
            dataSource={AUTOMATION_TASK_TEMPLATES}
            renderItem={(template) => (
              <List.Item>
                <Card size="small" hoverable style={{ minHeight: 168 }}>
                  <Space direction="vertical" size={8} style={{ width: '100%' }}>
                    <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                      <Text strong>{template.title}</Text>
                      <Tag color={template.riskLevel === 'medium' ? 'orange' : 'blue'}>{template.riskLevel}</Tag>
                    </Space>
                    <Text type="secondary" style={{ minHeight: 44 }}>{template.description}</Text>
                    <Space wrap>
                      {template.tags?.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                    </Space>
                    <Button block icon={<PlusOutlined />} onClick={() => handleCreateFromTemplate(template.id)}>
                      加入任务中心
                    </Button>
                  </Space>
                </Card>
              </List.Item>
            )}
          />
        </Card>

        <Card
          title="运行记录"
          extra={
            <Space>
              <Select value={kindFilter} onChange={setKindFilter} style={{ width: 150 }}>
                <Option value="all">全部类型</Option>
                <Option value="computer_use">Computer Use</Option>
                <Option value="page_monitor">页面监控</Option>
                <Option value="page_diagnosis">页面诊断</Option>
                <Option value="document_qa">资料问答</Option>
                <Option value="ocr">OCR</Option>
                <Option value="extract">数据提取</Option>
                <Option value="workflow">工作流</Option>
              </Select>
              <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 130 }}>
                <Option value="all">全部状态</Option>
                <Option value="draft">草稿</Option>
                <Option value="scheduled">已计划</Option>
                <Option value="running">运行中</Option>
                <Option value="success">成功</Option>
                <Option value="partial">部分成功</Option>
                <Option value="failed">失败</Option>
                <Option value="idle">待运行</Option>
              </Select>
              <Search allowClear placeholder="搜索任务..." style={{ width: 260 }} onChange={(e) => setKeyword(e.target.value)} />
              <Button icon={<ReloadOutlined />} onClick={refresh}>刷新</Button>
            </Space>
          }
        >
          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={filteredRuns}
            pagination={{ pageSize: 8 }}
            locale={{ emptyText: <Empty description="暂无任务记录，可先从模板加入任务" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          />
        </Card>
      </Space>

      <Drawer
        title={detailRun?.title || '任务详情'}
        width={720}
        open={Boolean(detailRun)}
        onClose={() => setDetailRun(null)}
        extra={detailRun ? (
          <Space>
            <Button icon={<CopyOutlined />} onClick={() => handleCopyFullLog(detailRun)}>复制日志</Button>
            {detailRun.kind === 'computer_use' && (detailRun.status === 'success' || detailRun.status === 'partial') && (
              <Button icon={<SaveOutlined />} onClick={() => handleSaveWorkflowDraft(detailRun)}>保存为工作流</Button>
            )}
          </Space>
        ) : null}
      >
        {detailRun && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="类型">{detailRun.kind}</Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={statusColor[detailRun.status]}>{statusLabel(detailRun.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="目标">{detailRun.goal || '-'}</Descriptions.Item>
              <Descriptions.Item label="创建时间">{moment(detailRun.createdAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
              <Descriptions.Item label="更新时间">{moment(detailRun.updatedAt).format('YYYY-MM-DD HH:mm:ss')}</Descriptions.Item>
              <Descriptions.Item label="开始/结束">
                {[detailRun.startedAt ? moment(detailRun.startedAt).format('HH:mm:ss') : '-', detailRun.endedAt ? moment(detailRun.endedAt).format('HH:mm:ss') : '-'].join(' / ')}
              </Descriptions.Item>
              <Descriptions.Item label="结果">{detailRun.resultSummary || '-'}</Descriptions.Item>
              <Descriptions.Item label="错误">{detailRun.error || '-'}</Descriptions.Item>
            </Descriptions>

            <TaskOutputCard run={detailRun} />

            {detailRun.traceSummary && (
              <Card size="small" title="Trace 摘要">
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="Trace Run ID">{detailRun.traceSummary.traceRunId || String(detailRun.metadata?.computerUseRunId || '-')}</Descriptions.Item>
                  <Descriptions.Item label="阶段数">{detailRun.traceSummary.phaseCount ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="事件数">{detailRun.traceSummary.entryCount ?? '-'}</Descriptions.Item>
                  <Descriptions.Item label="当前阶段">{detailRun.traceSummary.currentPhase || '-'}</Descriptions.Item>
                  <Descriptions.Item label="最后动作">{detailRun.traceSummary.lastAction || '-'}</Descriptions.Item>
                  <Descriptions.Item label="最后页面">{detailRun.traceSummary.lastPageTitle || '-'}</Descriptions.Item>
                  <Descriptions.Item label="URL">{detailRun.traceSummary.lastPageUrl || '-'}</Descriptions.Item>
                  <Descriptions.Item label="快照 Hash">{detailRun.traceSummary.snapshotHash || '-'}</Descriptions.Item>
                </Descriptions>
              </Card>
            )}

            {(detailRun.metadata as any)?.monitor && (
              <Card size="small" title="监控配置">
                <Descriptions column={1} size="small">
                  <Descriptions.Item label="URL">{(detailRun.metadata as any).monitor.url}</Descriptions.Item>
                  <Descriptions.Item label="间隔">{(detailRun.metadata as any).monitor.intervalMinutes} 分钟</Descriptions.Item>
                  <Descriptions.Item label="采集模式">{(detailRun.metadata as any).monitor.extractMode}</Descriptions.Item>
                  <Descriptions.Item label="触发规则">{(detailRun.metadata as any).monitor.rule?.type || 'changed'}</Descriptions.Item>
                  <Descriptions.Item label="连续失败">
                    {(detailRun.metadata as any).monitor.consecutiveFailures || 0} / {(detailRun.metadata as any).monitor.maxConsecutiveFailures || 3}
                  </Descriptions.Item>
                  <Descriptions.Item label="暂停原因">{(detailRun.metadata as any).monitor.pausedReason || '-'}</Descriptions.Item>
                  <Descriptions.Item label="最后检查">
                    {(detailRun.metadata as any).monitor.lastCheckedAt ? moment((detailRun.metadata as any).monitor.lastCheckedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            )}

            {detailRun.kind === 'page_monitor' && (
              <Card size="small" title="检查历史">
                <List
                  size="small"
                  dataSource={monitorChecks}
                  locale={{ emptyText: '暂无检查记录' }}
                  renderItem={(record) => (
                    <List.Item>
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space>
                          <Tag color={record.status === 'changed' ? 'green' : record.status === 'failed' ? 'red' : 'default'}>{record.status}</Tag>
                          <Text type="secondary">{moment(record.checkedAt).format('YYYY-MM-DD HH:mm:ss')}</Text>
                        </Space>
                        <Text>{record.summary}</Text>
                        {record.diffPreview && <Text code ellipsis>{record.diffPreview}</Text>}
                        {record.error && <Text type="danger">{record.error}</Text>}
                      </Space>
                    </List.Item>
                  )}
                />
              </Card>
            )}

            <Collapse>
              <Collapse.Panel header="完整 Trace / 任务 JSON" key="trace">
                <pre style={{ maxHeight: 360, overflow: 'auto', background: '#f7f8fa', padding: 12, borderRadius: 6 }}>
                  {JSON.stringify(detailRun.metadata?.traceSnapshot || detailRun, null, 2)}
                </pre>
              </Collapse.Panel>
            </Collapse>
          </Space>
        )}
      </Drawer>

      <Modal
        title="配置页面监控"
        open={Boolean(monitorTemplateId)}
        onCancel={() => setMonitorTemplateId(null)}
        onOk={handleSubmitMonitor}
        okText="创建并启用"
        cancelText="取消"
      >
        <Form form={monitorForm} layout="vertical">
          <Form.Item name="title" label="任务名称" rules={[{ required: true, message: '请输入任务名称' }]}>
            <Input placeholder="页面变化监控" />
          </Form.Item>
          <Form.Item name="url" label="监控 URL" rules={[{ required: true, message: '请输入监控 URL' }, { type: 'url', message: '请输入合法 URL' }]}>
            <Input placeholder="https://example.com/page" />
          </Form.Item>
          <Form.Item name="intervalMinutes" label="检查间隔（分钟）" rules={[{ required: true, message: '请输入检查间隔' }]}>
            <InputNumber min={1} max={1440} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="extractMode" label="采集模式" rules={[{ required: true, message: '请选择采集模式' }]}>
            <Select>
              <Option value="page_text">页面文本</Option>
              <Option value="table_summary">表格摘要</Option>
              <Option value="context_summary">页面上下文摘要</Option>
            </Select>
          </Form.Item>
          <Form.Item name="ruleType" label="触发规则" rules={[{ required: true }]}>
            <Select options={[
              { value: 'changed', label: '内容发生变化' },
              { value: 'contains', label: '包含指定内容' },
              { value: 'number_threshold', label: '数值达到阈值' },
              { value: 'new_records', label: '出现新增记录' },
              { value: 'status_transition', label: '状态发生转换' },
            ]} />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.ruleType !== next.ruleType}>
            {({ getFieldValue }) => {
              const type = getFieldValue('ruleType');
              if (type === 'contains') return <Form.Item name="ruleValue" label="目标内容" rules={[{ required: true }]}><Input /></Form.Item>;
              if (type === 'number_threshold') return <Space align="start" style={{ width: '100%' }}>
                <Form.Item name="ruleOperator" label="比较" initialValue="gt"><Select style={{ width: 120 }} options={['gt', 'gte', 'lt', 'lte', 'eq'].map((value) => ({ value, label: value }))} /></Form.Item>
                <Form.Item name="ruleValue" label="阈值" rules={[{ required: true }]}><InputNumber /></Form.Item>
              </Space>;
              if (type === 'status_transition') return <Space align="start" style={{ width: '100%' }}>
                <Form.Item name="ruleFrom" label="原状态" rules={[{ required: true }]}><Input /></Form.Item>
                <Form.Item name="ruleTo" label="目标状态" rules={[{ required: true }]}><Input /></Form.Item>
              </Space>;
              return null;
            }}
          </Form.Item>
          <Form.Item name="maxConsecutiveFailures" label="连续失败后自动暂停"><InputNumber min={1} max={10} style={{ width: '100%' }} /></Form.Item>
          <Collapse ghost>
            <Collapse.Panel header="变化通知" key="notifications">
              <Form.Item name="extensionNotification" label="插件通知" valuePropName="checked"><Switch /></Form.Item>
              <Form.Item name="feishuWebhook" label="飞书机器人 Webhook"><Input.Password placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." /></Form.Item>
              <Form.Item name="dingtalkWebhook" label="钉钉机器人 Webhook"><Input.Password placeholder="https://oapi.dingtalk.com/robot/send?..." /></Form.Item>
              <Form.Item name="webhook" label="通用 Webhook"><Input.Password placeholder="https://example.com/hooks/monitor" /></Form.Item>
            </Collapse.Panel>
          </Collapse>
        </Form>
      </Modal>

      <Modal
        title={`配置${AUTOMATION_TASK_TEMPLATES.find((item) => item.id === configTemplateId)?.title || '任务'}`}
        open={Boolean(configTemplateId)}
        onCancel={() => setConfigTemplateId(null)}
        onOk={handleSubmitTask}
        okText="加入任务中心"
        cancelText="取消"
      >
        {(() => {
          const template = AUTOMATION_TASK_TEMPLATES.find((item) => item.id === configTemplateId);
          if (!template) return null;
          return (
            <Form form={taskForm} layout="vertical">
              <Form.Item name="title" label="任务名称" rules={[{ required: true }]}><Input /></Form.Item>
              {template.kind !== 'ocr' && template.kind !== 'workflow' && (
                <Form.Item name="goal" label={template.kind === 'document_qa' ? '资料问题' : '任务目标'} rules={[{ required: true }]}>
                  <Input.TextArea rows={3} />
                </Form.Item>
              )}
              {template.kind === 'computer_use' && <>
                <Form.Item name="startUrl" label="起始 URL（可选）"><Input /></Form.Item>
                <Form.Item name="maxSteps" label="最大步骤"><InputNumber min={1} max={30} style={{ width: '100%' }} /></Form.Item>
                <Form.Item name="workflowVariablesJson" label="保存为工作流时的参数默认值">
                  <Input.TextArea rows={3} placeholder={'例如：{\n  "warehouse": "杭州仓",\n  "operator": "秋枫"\n}'} />
                </Form.Item>
              </>}
              {template.kind === 'page_diagnosis' && (
                <Form.Item name="useDebugger" label="增强网络采集"><Select options={[{ value: false, label: '默认采集' }, { value: true, label: '使用 Debugger（需要授权）' }]} /></Form.Item>
              )}
              {template.kind === 'document_qa' && (
                <Form.Item name="documentIds" label="资料范围"><Select mode="multiple" allowClear options={documents.map((item) => ({ value: item.id, label: item.title }))} /></Form.Item>
              )}
              {template.kind === 'ocr' && <>
                <Form.Item name="assetId" label="选择资料" rules={[{ required: true, message: '请选择资料' }]}>
                  <Select showSearch optionFilterProp="label" options={documents.map((item) => ({ value: item.id, label: item.title }))} />
                </Form.Item>
                <Form.Item name="maxPages" label="最大页数"><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item>
              </>}
              {template.kind === 'extract' && (
                <Form.Item name="extractMode" label="提取模式"><Select options={[{ value: 'structured', label: '字段、列表与表格' }, { value: 'tables', label: '仅表格' }]} /></Form.Item>
              )}
              {template.kind === 'workflow' && (
                <>
                  <Form.Item name="workflowId" label="选择工作流" rules={[{ required: true, message: '请选择工作流' }]}>
                    <Select options={workflows.map((item) => ({ value: item.id, label: item.name }))} />
                  </Form.Item>
                  <Form.Item name="variablesJson" label="本次运行参数">
                    <Input.TextArea rows={4} placeholder={'例如：{ "warehouse": "杭州仓" }'} />
                  </Form.Item>
                </>
              )}
            </Form>
          );
        })()}
      </Modal>
    </div>
  );
};

export default AutomationTaskCenter;
