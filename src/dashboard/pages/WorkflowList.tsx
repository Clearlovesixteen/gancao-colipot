import React, { useEffect, useState, useMemo } from 'react';
import { Card, List, Button, Typography, Space, Modal, message, Empty, Tooltip, Input, Select, Tag, Dropdown, Menu } from 'antd';
import { 
  PlusOutlined, 
  ImportOutlined, 
  DeleteOutlined, 
  RobotOutlined, 
  CopyOutlined, 
  PlayCircleOutlined, 
  EditOutlined,
  SearchOutlined,
  MoreOutlined,
  ClockCircleOutlined,
  StopOutlined
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { listAutomationWorkflows, deleteAutomationWorkflow, upsertAutomationWorkflow, type StoredAutomationWorkflow } from '../../sidePanel/utils/automationStorage';
import type { AutomationWorkflow } from '../../shared/automationTypes';
import moment from 'moment';

const { Text, Title } = Typography;
const { Search } = Input;
const { Option } = Select;

function makeId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

function exampleWorkflow(): AutomationWorkflow {
  return {
    name: '示例：简单自动化',
    variables: { keyword: 'Automa' },
    steps: [
      { type: 'wait', ms: 300 },
      { type: 'extract', selector: 'h1,h2', limit: 5, into: 'headers' },
      { type: 'screenshot', format: 'png', into: 'shot' },
    ],
  };
}

const WorkflowList: React.FC = () => {
  const navigate = useNavigate();
  const [items, setItems] = useState<StoredAutomationWorkflow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [sortType, setSortType] = useState<'updated' | 'name'>('updated');
  const [runningId, setRunningId] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await listAutomationWorkflows();
      setItems(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    
    // 监听运行状态消息
    const listener = (msg: any) => {
      if (msg.type === 'AUTOMATION_FINISHED' || msg.type === 'AUTOMATION_ERROR') {
        if (msg.runId === runningId) {
          setRunningId(null);
          if (msg.type === 'AUTOMATION_FINISHED') message.success('执行完成');
          else message.error(`执行出错: ${msg.error}`);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [runningId]);

  const filteredItems = useMemo(() => {
    let result = items.filter(item => 
      item.name.toLowerCase().includes(searchText.toLowerCase())
    );
    
    if (sortType === 'name') {
      result.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      result.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    
    return result;
  }, [items, searchText, sortType]);

  const handleCreate = async () => {
    const id = makeId();
    const name = '新工作流';
    const workflow = exampleWorkflow();
    workflow.name = name;
    await upsertAutomationWorkflow({ id, name, workflow });
    message.success('已创建');
    refresh();
    navigate(`/workflow/${id}`);
  };

  const handleDelete = async (id: string, name: string) => {
    Modal.confirm({
      title: '删除工作流',
      content: `确认删除「${name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteAutomationWorkflow(id);
        message.success('已删除');
        refresh();
      },
    });
  };

  const handleCopy = async (item: StoredAutomationWorkflow) => {
    const id = makeId();
    const name = `${item.name} - 副本`;
    await upsertAutomationWorkflow({ id, name, workflow: { ...item.workflow, name } });
    message.success('已复制');
    refresh();
  };

  const handleRun = (item: StoredAutomationWorkflow, e: React.MouseEvent) => {
    e.stopPropagation();
    if (runningId) return;

    message.loading({ content: '启动中...', key: 'run_start' });
    
    chrome.runtime.sendMessage({ 
      type: 'RUN_AUTOMATION', 
      workflow: item.workflow 
    }, (resp) => {
      message.destroy('run_start');
      if (chrome.runtime.lastError || !resp?.success) {
        message.error(chrome.runtime.lastError?.message || resp?.error || '启动失败');
        return;
      }
      setRunningId(resp.runId);
      message.success('已开始运行');
    });
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!runningId) return;
    chrome.runtime.sendMessage({ type: 'STOP_AUTOMATION', runId: runningId });
    setRunningId(null);
    message.info('已请求停止');
  };

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={4} style={{ margin: 0 }}>我的工作流</Title>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate} size="large">
            新建工作流
          </Button>
        </div>
        
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', background: '#fff', padding: 16, borderRadius: 8 }}>
          <Search 
            placeholder="搜索工作流..." 
            allowClear 
            style={{ width: 300 }} 
            onChange={e => setSearchText(e.target.value)}
          />
          <Select value={sortType} onChange={setSortType} style={{ width: 140 }}>
            <Option value="updated">按时间排序</Option>
            <Option value="name">按名称排序</Option>
          </Select>
          <div style={{ flex: 1 }} />
          <Text type="secondary">共 {filteredItems.length} 个工作流</Text>
        </div>
      </div>

      <List
        grid={{ gutter: 24, column: 4 }}
        dataSource={filteredItems}
        loading={loading}
        locale={{ 
          emptyText: (
            <Empty 
              description="暂无工作流" 
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" onClick={handleCreate}>立即创建</Button>
            </Empty>
          ) 
        }}
        renderItem={(item) => (
          <List.Item>
            <Card
              hoverable
              style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid #f0f0f0' }}
              bodyStyle={{ padding: 0 }}
              onClick={() => navigate(`/workflow/${item.id}`)}
            >
              {/* Card Header */}
              <div style={{ padding: '16px 20px', borderBottom: '1px solid #f9f9f9', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ 
                    width: 36, 
                    height: 36, 
                    borderRadius: 8, 
                    background: 'linear-gradient(135deg, #e6f7ff 0%, #bae7ff 100%)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    color: '#1890ff'
                  }}>
                    <RobotOutlined style={{ fontSize: 20 }} />
                  </div>
                  <Text ellipsis strong style={{ fontSize: 16, maxWidth: 140 }}>{item.name}</Text>
                </div>
                
                <Dropdown 
                  overlay={
                    <Menu>
                      <Menu.Item key="edit" icon={<EditOutlined />} onClick={() => navigate(`/workflow/${item.id}`)}>
                        编辑
                      </Menu.Item>
                      <Menu.Item key="copy" icon={<CopyOutlined />} onClick={(e) => { e.domEvent.stopPropagation(); handleCopy(item); }}>
                        复制副本
                      </Menu.Item>
                      <Menu.Divider />
                      <Menu.Item key="delete" icon={<DeleteOutlined />} danger onClick={(e) => { e.domEvent.stopPropagation(); handleDelete(item.id, item.name); }}>
                        删除
                      </Menu.Item>
                    </Menu>
                  }
                  trigger={['click']}
                >
                  <Button type="text" icon={<MoreOutlined />} onClick={e => e.stopPropagation()} />
                </Dropdown>
              </div>

              {/* Card Body */}
              <div style={{ padding: '20px 20px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Tag color="blue" style={{ margin: 0 }}>{item.workflow.steps.length} 步骤</Tag>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{moment(item.updatedAt).fromNow()}</Text>
                </div>
                
                <Button 
                  type={runningId === item.id ? 'primary' : 'default'}
                  danger={runningId === item.id}
                  block 
                  size="middle"
                  icon={runningId === item.id ? <StopOutlined /> : <PlayCircleOutlined />}
                  onClick={(e) => {
                    if (runningId === item.id) handleStop(e);
                    else handleRun(item, e);
                  }}
                  style={{ 
                    borderRadius: 6,
                    borderColor: runningId === item.id ? undefined : '#d9d9d9',
                    color: runningId === item.id ? undefined : '#666'
                  }}
                >
                  {runningId === item.id ? '停止运行' : '运行'}
                </Button>
              </div>
            </Card>
          </List.Item>
        )}
      />
    </div>
  );
};

export default WorkflowList;
