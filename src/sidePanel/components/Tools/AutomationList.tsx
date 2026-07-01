import React, { useEffect, useState, useMemo } from 'react';
import { List, Card, Button, Typography, Space, Input, Dropdown, Menu, message, Empty, Tooltip } from 'antd';
import { 
  SearchOutlined, 
  SortAscendingOutlined, 
  PlayCircleOutlined, 
  MoreOutlined, 
  ThunderboltOutlined,
  StopOutlined,
  ArrowLeftOutlined,
  PlusOutlined
} from '@ant-design/icons';
import { listAutomationWorkflows, type StoredAutomationWorkflow } from '../../utils/automationStorage';
import moment from 'moment';

const { Text, Title } = Typography;

interface AutomationListProps {
  onBack: () => void;
}

const AutomationList: React.FC<AutomationListProps> = ({ onBack }) => {
  const [items, setItems] = useState<StoredAutomationWorkflow[]>([]);
  const [searchText, setSearchText] = useState('');
  const [sortType, setSortType] = useState<'updated' | 'name'>('updated');
  const [runningId, setRunningId] = useState<string | null>(null);

  const refresh = async () => {
    const list = await listAutomationWorkflows();
    setItems(list);
  };

  useEffect(() => {
    refresh();
    
    // 监听 storage 变化，以便 Dashboard 修改后这里能同步
    const handleStorageChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.automationWorkflows) {
        refresh();
      }
    };
    chrome.storage.onChanged.addListener(handleStorageChange);
    return () => chrome.storage.onChanged.removeListener(handleStorageChange);
  }, []);

  // 监听运行状态消息
  useEffect(() => {
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

  const openDashboard = (path: string = '/workflows') => {
    chrome.tabs.create({ url: `dashboard.html#${path}` });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      {/* Header */}
      <div style={{ padding: '12px 16px', background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} style={{ marginRight: 8 }} />
          <Title level={5} style={{ margin: 0, flex: 1 }}>自动化工作流</Title>
          <Tooltip title="打开完整控制台">
            <Button icon={<ThunderboltOutlined />} onClick={() => openDashboard()} />
          </Tooltip>
        </div>
        
        <Input 
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />} 
          placeholder="搜索..." 
          value={searchText}
          onChange={e => setSearchText(e.target.value)}
          allowClear
          style={{ marginBottom: 8 }}
        />
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Dropdown 
            overlay={
              <Menu onClick={({ key }) => setSortType(key as any)}>
                <Menu.Item key="updated">按时间排序</Menu.Item>
                <Menu.Item key="name">按名称排序</Menu.Item>
              </Menu>
            }
          >
            <Button size="small" type="text" icon={<SortAscendingOutlined />}>
              {sortType === 'updated' ? '最近更新' : '名称排序'}
            </Button>
          </Dropdown>
          
          <Button 
            type="primary" 
            size="small" 
            icon={<PlusOutlined />} 
            onClick={() => openDashboard('/workflows')}
          >
            新建
          </Button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <List
          dataSource={filteredItems}
          locale={{ emptyText: <Empty description="暂无工作流" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={item => (
            <Card
              hoverable
              style={{ marginBottom: 8, borderRadius: 8, border: 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }}
              bodyStyle={{ padding: '12px 16px' }}
              onClick={() => openDashboard(`/workflow/${item.id}`)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0, marginRight: 12 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#999' }}>
                    {moment(item.updatedAt).fromNow()} · {item.workflow.steps.length} 步
                  </div>
                </div>
                
                <div style={{ display: 'flex', gap: 8 }}>
                  {runningId ? (
                     <Button 
                       type="primary" 
                       danger 
                       shape="circle" 
                       icon={<StopOutlined />} 
                       onClick={handleStop}
                       title="停止运行"
                     />
                  ) : (
                    <Button 
                      type="text" 
                      shape="circle" 
                      icon={<PlayCircleOutlined style={{ fontSize: 20, color: '#52c41a' }} />} 
                      onClick={(e) => handleRun(item, e)}
                      title="运行"
                    />
                  )}
                  
                  <Dropdown 
                    overlay={
                      <Menu>
                        <Menu.Item key="edit" onClick={() => openDashboard(`/workflow/${item.id}`)}>编辑</Menu.Item>
                        {/* 更多功能留给 Dashboard */}
                      </Menu>
                    }
                    trigger={['click']}
                  >
                    <Button 
                      type="text" 
                      shape="circle" 
                      icon={<MoreOutlined style={{ fontSize: 16, color: '#999' }} />} 
                      onClick={e => e.stopPropagation()}
                    />
                  </Dropdown>
                </div>
              </div>
            </Card>
          )}
        />
      </div>
    </div>
  );
};

export default AutomationList;
