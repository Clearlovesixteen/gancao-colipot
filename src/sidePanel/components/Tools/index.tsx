import React, { useState } from 'react';
import { List, Card, Button, Typography, Space } from 'antd';
import { ArrowLeftOutlined, DatabaseOutlined, FileExcelOutlined, FolderOpenOutlined, RightOutlined, ThunderboltOutlined } from '@ant-design/icons';
import ExcelMerge from './ExcelMerge';
import DocumentCenter from './DocumentCenter';
import MemoryCenter from './MemoryCenter';

const { Title, Text } = Typography;

import AutomationList from './AutomationList';

const Tools: React.FC = () => {
  const [currentTool, setCurrentTool] = useState<string | null>(null);

  if (currentTool === 'excel-merge') {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center' }}>
          <Button 
            type="text" 
            icon={<ArrowLeftOutlined />} 
            onClick={() => setCurrentTool(null)}
            style={{ marginRight: 8 }}
          />
          <Title level={5} style={{ margin: 0 }}>Excel 合并工具</Title>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          <ExcelMerge />
        </div>
      </div>
    );
  }

  if (currentTool === 'automation') {
    return <AutomationList onBack={() => setCurrentTool(null)} />;
  }

  if (currentTool === 'documents') {
    return <DocumentCenter onBack={() => setCurrentTool(null)} />;
  }

  if (currentTool === 'memory') {
    return <MemoryCenter onBack={() => setCurrentTool(null)} />;
  }

  const tools = [
    {
      key: 'excel-merge',
      title: 'Excel 合并工具',
      description: '支持多文件Sheet合并或数据追加合并',
      icon: <FileExcelOutlined style={{ fontSize: 24, color: '#52c41a' }} />
    },
    {
      key: 'automation',
      title: '自动化',
      description: '用工作流在当前页面执行点击、输入、提取、截图等',
      icon: <ThunderboltOutlined style={{ fontSize: 24, color: '#722ed1' }} />
    },
    {
      key: 'documents',
      title: '资料中心',
      description: '管理上传文件、OCR、网页结构化数据和任务清单',
      icon: <FolderOpenOutlined style={{ fontSize: 24, color: '#1677ff' }} />
    },
    {
      key: 'memory',
      title: '记忆中心',
      description: '管理聊天历史和长期记忆，控制 AI 可召回的偏好与业务上下文',
      icon: <DatabaseOutlined style={{ fontSize: 24, color: '#13c2c2' }} />
    }
  ];

  return (
    <div style={{ padding: '16px', height: '100%', overflow: 'auto' }}>
      <List
        grid={{ gutter: 16, column: 1 }}
        dataSource={tools}
        renderItem={item => (
          <List.Item>
            <Card 
              hoverable 
              onClick={() => setCurrentTool(item.key)}
              bodyStyle={{ padding: '16px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ marginRight: 16 }}>{item.icon}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: '16px', marginBottom: 4 }}>{item.title}</div>
                  <Text type="secondary" style={{ fontSize: '12px' }}>{item.description}</Text>
                </div>
                <RightOutlined style={{ color: '#ccc' }} />
              </div>
            </Card>
          </List.Item>
        )}
      />
    </div>
  );
};

export default Tools;
