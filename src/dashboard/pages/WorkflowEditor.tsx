import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Button, Card, Divider, Input, InputNumber, Select, Space, Tabs, Typography, message, Modal, Breadcrumb, Empty } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, SaveOutlined, PlayCircleOutlined, ArrowLeftOutlined, PlusOutlined, MenuUnfoldOutlined, MenuFoldOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import type { AutomationEvent, AutomationStep, AutomationWorkflow } from '../../shared/automationTypes';
import { getAutomationWorkflow, upsertAutomationWorkflow } from '../../sidePanel/utils/automationStorage';
import WorkflowGraph from '../components/WorkflowGraph';
import { BLOCK_DEFINITIONS, BLOCK_CATEGORIES, BlockDefinition } from '../../shared/blockDefs';
import { getBlockDef, createDefaultStep } from '../../shared/blockHelpers';
import BlockConfigForm from '../components/BlockConfigForm';

const { TextArea } = Input;
const { Title, Text } = Typography;
const { TabPane } = Tabs;

type StepType = AutomationStep['type'];

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

const WorkflowEditor: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [tabKey, setTabKey] = useState<'edit' | 'run'>('edit');
  
  const [draft, setDraft] = useState<AutomationWorkflow | null>(null);
  const [draftName, setDraftName] = useState<string>('');
  const [variablesText, setVariablesText] = useState<string>('{}');
  const [selectedStepIndex, setSelectedStepIndex] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [configCollapsed, setConfigCollapsed] = useState(false);

  // 运行状态
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ ts: number; text: string }>>([]);
  const [result, setResult] = useState<any>(null);
  const logsRef = useRef<HTMLDivElement | null>(null);

  const selectedStep = draft?.steps[selectedStepIndex] as AutomationStep | undefined;

  useEffect(() => {
    if (id) {
      loadWorkflow(id);
    }
  }, [id]);

  const loadWorkflow = async (workflowId: string) => {
    setLoading(true);
    try {
      const stored = await getAutomationWorkflow(workflowId);
      if (stored) {
        setDraft(deepClone(stored.workflow));
        setDraftName(stored.name);
        setVariablesText(safeJsonStringify(stored.workflow.variables || {}));
      } else {
        message.error('工作流不存在');
        navigate('/workflows');
      }
    } catch (e) {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight, behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    const listener = (msg: any) => {
      const event = msg as AutomationEvent;
      if (!event?.type || typeof event.type !== 'string') return;
      
      // 这里的逻辑稍微复杂：
      // 1. 如果 event.runId 不等于当前的 runId (且 runId 已设置)，忽略 -> 是别的任务
      // 2. 如果 runId 还没设置 (null)，但 running 为 true，说明正在启动中，此时应该接收 (这是首条日志的关键)
      // 3. 如果 running 为 false，说明没在跑，忽略
      
      if (!running && event.type !== 'AUTOMATION_FINISHED') return; // 如果已经结束了，还要允许接收 FINISHED
      
      if (runId && event.runId !== runId) return; // ID 不匹配

      // 如果 runId 为 null，我们假设这是我们要的日志 (因为 running=true)
      // 并在收到第一条日志时自动设置 runId (可选优化)
      if (!runId && event.runId) {
         setRunId(event.runId);
      }

      if (event.type === 'AUTOMATION_PROGRESS') {
        let text = `#${event.stepIndex + 1} ${event.state} ${event.step.type}`;
        if (event.state === 'done' && event.result) {
          const res = event.result as any;
          if (event.step.type === 'extract') {
            text += ` 提取: ${res.count}项`;
          } else if (event.step.type === 'screenshot') {
            text += ' 截图成功';
          } else if (event.step.type === 'navigate') {
            text += ` -> ${event.step.url}`;
          }
        }
        setLogs((prev) => [...prev, { ts: Date.now(), text }]);
        return;
      }
      if (event.type === 'AUTOMATION_FINISHED') {
        setRunning(false);
        setResult(event.result);
        setLogs((prev) => [...prev, { ts: Date.now(), text: '完成' }]);
        message.success('自动化执行完成');
        return;
      }
      if (event.type === 'AUTOMATION_ERROR') {
        setRunning(false);
        setLogs((prev) => [...prev, { ts: Date.now(), text: `错误: ${event.error}` }]);
        message.error(event.error || '自动化执行失败');
        return;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [runId]);

  const setStepAt = (index: number, next: AutomationStep) => {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return null;
      const steps = prev.steps.slice();
      steps[index] = next;
      return { ...prev, steps };
    });
  };

  const addStep = (type: StepType) => {
    if (!draft) return;
    const def = getBlockDef(type);
    const step = createDefaultStep(def);
    setDraft((prev) => prev ? ({ ...prev, steps: [...prev.steps, step] }) : null);
    setSelectedStepIndex(draft.steps.length);
  };

  const removeStep = (index: number) => {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return null;
      const steps = prev.steps.slice();
      steps.splice(index, 1);
      return { ...prev, steps: steps.length ? steps : [{ type: 'wait', ms: 300 }] };
    });
    setSelectedStepIndex((prev) => Math.max(0, Math.min(prev, draft.steps.length - 2)));
  };

  const moveStep = (index: number, dir: -1 | 1) => {
    if (!draft) return;
    setDraft((prev) => {
      if (!prev) return null;
      const steps = prev.steps.slice();
      const target = index + dir;
      if (target < 0 || target >= steps.length) return prev;
      const tmp = steps[index];
      steps[index] = steps[target];
      steps[target] = tmp;
      return { ...prev, steps };
    });
    setSelectedStepIndex((prev) => prev + dir);
  };

  const duplicateStep = (index: number) => {
    if (!draft) return;
    const step = deepClone(draft.steps[index]) as AutomationStep;
    setDraft((prev) => {
      if (!prev) return null;
      const steps = prev.steps.slice();
      steps.splice(index + 1, 0, step);
      return { ...prev, steps };
    });
    setSelectedStepIndex(index + 1);
  };

  const applyVariablesText = () => {
    try {
      const v = JSON.parse(variablesText || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        message.error('variables 必须是 JSON 对象');
        return;
      }
      setDraft((prev) => prev ? ({ ...prev, variables: v }) : null);
      message.success('已更新 variables');
    } catch {
      message.error('variables JSON 解析失败');
    }
  };

  const handleSave = async () => {
    if (!draft || !id) return;
    const name = (draftName || '未命名').trim();
    const workflow: AutomationWorkflow = { ...draft, name, variables: draft.variables || {}, steps: draft.steps };
    await upsertAutomationWorkflow({ id, name, workflow });
    message.success('已保存');
  };

  const handleExport = async () => {
    if (!draft) return;
    const payload = safeJsonStringify({ name: draftName, workflow: draft });
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(draftName || 'workflow').replace(/[\\/:*?"<>|]/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startRun = (workflow: AutomationWorkflow) => {
    setLogs([{ ts: Date.now(), text: '启动中...' }]);
    setResult(null);

    chrome.runtime.sendMessage({ type: 'RUN_AUTOMATION', workflow }, (resp) => {
      if (chrome.runtime.lastError) {
        setRunning(false);
        message.error(chrome.runtime.lastError.message || '启动失败');
        return;
      }
      if (!resp?.success) {
        setRunning(false);
        message.error(resp?.error || '启动失败');
        return;
      }
      setRunId(resp.runId);
      setRunning(true);
      setLogs([{ ts: Date.now(), text: `已启动 runId=${resp.runId}` }]);
    });
  };

  const handleRunDraft = () => {
    if (!draft) return;
    const wf: AutomationWorkflow = { ...draft, name: (draftName || draft.name || 'workflow').trim() };
    startRun(wf);
    setTabKey('run');
  };

  const handleStop = () => {
    if (!runId) return;
    chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION', runId }, () => {});
    setRunning(false);
    setLogs((prev) => [...prev, { ts: Date.now(), text: '已请求停止' }]);
  };

  const renderStepConfig = () => {
    if (!selectedStep) return null;
    
    const def = getBlockDef(selectedStep.type);
    
    return (
      <BlockConfigForm
        definition={def}
        step={selectedStep}
        onChange={(updates) => setStepAt(selectedStepIndex, { ...selectedStep, ...updates } as AutomationStep)}
      />
    );
  };

  const categories = useMemo(() => {
    return BLOCK_CATEGORIES.map(cat => ({
      title: cat.title,
      items: BLOCK_DEFINITIONS
        .filter(def => def.category === cat.id)
        .map(def => ({ type: def.id, title: def.name }))
    }));
  }, []);

  if (loading) return <div>Loading...</div>;
  if (!draft) return <div>Error loading workflow</div>;

  const onDragStart = (event: React.DragEvent, nodeType: StepType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#fff', position: 'fixed', top: 0, left: 0, width: '100vw', zIndex: 1000 }}>
      {/* Top Header */}
      <div style={{ height: 56, borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', padding: '0 16px', justifyContent: 'space-between' }}>
        <Space size={16}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/workflows')} />
          <Space direction="vertical" size={0}>
            <Text strong style={{ fontSize: 16 }}>{draftName}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{draft.steps.length} 步骤</Text>
          </Space>
        </Space>
        
        <Space>
          <Tabs activeKey={tabKey} onChange={(k) => setTabKey(k as any)} size="small" type="card" style={{ marginBottom: -1 }}>
            <TabPane tab="编辑器" key="edit" />
            <TabPane tab="日志" key="run" />
          </Tabs>
        </Space>

        <Space>
          <Button icon={<SaveOutlined />} type="primary" onClick={handleSave}>保存</Button>
          <Button icon={<DownloadOutlined />} onClick={handleExport} />
          <Button 
            type={tabKey === 'run' ? 'primary' : 'default'} 
            icon={<PlayCircleOutlined />} 
            onClick={() => {
              if (tabKey !== 'run') setTabKey('run');
            }}
          />
        </Space>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {tabKey === 'edit' ? (
          <>
            {/* Sidebar (Toolbox) */}
            <div style={{ width: 260, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
                <Input prefix={<ArrowLeftOutlined rotate={-45} />} placeholder="搜索..." />
              </div>
              <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
                {categories.map((cat, idx) => (
                  <div key={idx} style={{ marginBottom: 24 }}>
                    <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: 'block', textTransform: 'uppercase', fontWeight: 600 }}>
                      {cat.title}
                    </Text>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      {cat.items.map(meta => (
                        <div 
                          key={meta.type}
                          draggable
                          onDragStart={(event) => onDragStart(event, meta.type)}
                          style={{ 
                            padding: '12px 8px', 
                            background: '#fff', 
                            border: '1px solid #e8e8e8', 
                            borderRadius: 6, 
                            cursor: 'grab',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 12,
                            textAlign: 'center',
                            transition: 'all 0.2s'
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.borderColor = '#1890ff'}
                          onMouseLeave={(e) => e.currentTarget.style.borderColor = '#e8e8e8'}
                        >
                          <div style={{ fontWeight: 500 }}>{meta.title}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, position: 'relative', background: '#f5f5f5' }}>
              <WorkflowGraph 
                steps={draft.steps}
                onStepsChange={(newSteps) => setDraft(prev => prev ? ({ ...prev, steps: newSteps }) : null)}
                onSelectStep={setSelectedStepIndex}
                selectedStepIndex={selectedStepIndex}
              />
              
              {selectedStep && (
                <div style={{ 
                  position: 'absolute', 
                  top: 16, 
                  right: 16, 
                  width: configCollapsed ? 48 : 320, 
                  maxHeight: 'calc(100% - 32px)', 
                  background: '#fff', 
                  borderRadius: 8, 
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  transition: 'width 0.2s ease'
                }}>
                  <div style={{ padding: '12px 16px', borderBottom: configCollapsed ? 'none' : '1px solid #f0f0f0', display: 'flex', justifyContent: configCollapsed ? 'center' : 'space-between', alignItems: 'center' }}>
                    {!configCollapsed && <Text strong>步骤配置</Text>}
                    <Space>
                       {!configCollapsed && (
                         <>
                          <Button size="small" icon={<CopyOutlined />} onClick={() => duplicateStep(selectedStepIndex)} />
                          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeStep(selectedStepIndex)} />
                         </>
                       )}
                       <Button size="small" type="text" icon={configCollapsed ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />} onClick={() => setConfigCollapsed(!configCollapsed)} />
                    </Space>
                  </div>
                  {!configCollapsed && (
                    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
                      {renderStepConfig()}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          /* Run View */
          <div style={{ flex: 1, display: 'flex', padding: 24, gap: 24, background: '#f0f2f5' }}>
             <Card style={{ flex: 1, display: 'flex', flexDirection: 'column' }} bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 0 }}>
                <div style={{ padding: 16, borderBottom: '1px solid #f0f0f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Title level={5} style={{ margin: 0 }}>运行日志</Title>
                  <Space>
                    <Button type="primary" onClick={handleRunDraft} disabled={running} icon={<PlayCircleOutlined />}>开始运行</Button>
                    <Button danger onClick={handleStop} disabled={!running}>停止</Button>
                  </Space>
                </div>
                <div ref={logsRef as any} style={{ flex: 1, overflow: 'auto', padding: 16, fontFamily: 'monospace', fontSize: 13, background: '#fafafa' }}>
                  {logs.length === 0 ? (
                    <div style={{ color: '#999', textAlign: 'center', marginTop: 40 }}>点击上方按钮开始运行</div>
                  ) : (
                    logs.map((l, idx) => (
                      <div key={idx} style={{ marginBottom: 4, paddingBottom: 4, borderBottom: '1px dashed #eee' }}>
                        <span style={{ color: '#999', marginRight: 8 }}>{new Date(l.ts).toLocaleTimeString()}</span>
                        <span>{l.text}</span>
                      </div>
                    ))
                  )}
                </div>
              </Card>

              <Card title="运行结果" style={{ width: 400, display: 'flex', flexDirection: 'column' }} bodyStyle={{ flex: 1, padding: 0 }}>
                <TextArea 
                  value={result ? safeJsonStringify(result) : ''} 
                  placeholder="执行完成后在此显示结果..." 
                  style={{ height: '100%', border: 'none', resize: 'none', padding: 16, background: '#f6f6f6', fontFamily: 'monospace' }} 
                  readOnly 
                />
              </Card>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkflowEditor;
