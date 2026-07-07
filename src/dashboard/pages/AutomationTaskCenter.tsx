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

const AutomationTaskCenter: React.FC = () => {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [runningTask, setRunningTask] = useState<{ taskId: string; computerUseRunId: string } | null>(null);
  const [detailRun, setDetailRun] = useState<AutomationRun | null>(null);
  const [statusFilter, setStatusFilter] = useState<AutomationRunStatus | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<AutomationRunKind | 'all'>('all');
  const [monitorTemplateId, setMonitorTemplateId] = useState<string | null>(null);
  const [monitorForm] = Form.useForm();

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
  }, []);

  useEffect(() => {
    const listener = async (msg: any) => {
      if (!runningTask) return;
      if (msg.type === 'COMPUTER_USE_FINISHED' && msg.runId === runningTask.computerUseRunId) {
        setRunningTask(null);
        message.success('任务已完成');
        setTimeout(refresh, 300);
      }
      if (msg.type === 'COMPUTER_USE_ERROR' && msg.runId === runningTask.computerUseRunId) {
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
      });
      return;
    }
    const run = await upsertAutomationRun(makeAutomationRunFromTemplate(template));
    message.success('已加入任务中心');
    await refresh();
    return run;
  };

  const handleRun = async (run: AutomationRun) => {
    if (runningTask) {
      message.warning('已有任务运行中，请先停止或等待完成');
      return;
    }
    if (run.kind !== 'computer_use' && run.kind !== 'page_monitor') {
      message.info('该任务已记录为模板任务，调度执行将在后续批次接入');
      return;
    }
    if (!run.goal?.trim()) {
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
        if (run.kind === 'computer_use') setRunningTask({ taskId: run.id, computerUseRunId: resp.runId });
        message.success('任务已启动');
        refresh();
      },
    );
  };

  const handleStop = async (run: AutomationRun) => {
    const computerUseRunId = String(
      run.metadata?.computerUseRunId || (runningTask?.taskId === run.id ? runningTask.computerUseRunId : '') || '',
    );
    if (computerUseRunId) {
      chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION_TASK', taskId: run.id });
    }
    await patchAutomationRun(run.id, { status: 'stopped', endedAt: Date.now() });
    if (runningTask?.taskId === run.id) setRunningTask(null);
    message.info('已请求停止');
    refresh();
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
            <Tooltip title={run.kind === 'computer_use' ? '在当前活动标签页运行' : run.kind === 'page_monitor' ? '立即检查一次' : '后续接入调度执行'}>
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
            统一管理 Computer Use、页面监控、页面诊断和资料任务的模板与运行记录。当前已支持 Computer Use 手动运行、trace 详情、保存工作流草稿和页面监控 MVP。
          </Paragraph>
        </div>

        <Card title="任务模板" extra={<Text type="secondary">HARPA-style 常用命令模板</Text>}>
          <List
            grid={{ gutter: 16, column: 5 }}
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
                  <Descriptions.Item label="最后检查">
                    {(detailRun.metadata as any).monitor.lastCheckedAt ? moment((detailRun.metadata as any).monitor.lastCheckedAt).format('YYYY-MM-DD HH:mm:ss') : '-'}
                  </Descriptions.Item>
                </Descriptions>
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
        </Form>
      </Modal>
    </div>
  );
};

export default AutomationTaskCenter;
