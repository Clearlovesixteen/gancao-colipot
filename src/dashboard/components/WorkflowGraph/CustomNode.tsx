import React, { memo } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { 
  GlobalOutlined, 
  ClockCircleOutlined, 
  AimOutlined, 
  FontSizeOutlined, 
  SearchOutlined, 
  PicCenterOutlined, 
  MoreOutlined, 
  CameraOutlined,
  ThunderboltOutlined,
  FormOutlined
} from '@ant-design/icons';
import type { AutomationStep } from '../../../shared/automationTypes';
import { BLOCK_DEFINITIONS } from '../../../shared/blockDefs';

const ICONS: Record<string, React.ReactNode> = {
  navigate: <GlobalOutlined />,
  wait: <ClockCircleOutlined />,
  click: <AimOutlined />,
  type: <FontSizeOutlined />,
  waitForElement: <SearchOutlined />,
  scroll: <PicCenterOutlined />,
  extract: <MoreOutlined />,
  screenshot: <CameraOutlined />,
  forms: <FormOutlined />,
};

const COLORS: Record<string, string> = {
  navigate: '#faad14', // Orange
  wait: '#8c8c8c',     // Gray
  click: '#52c41a',    // Green
  type: '#52c41a',     // Green
  waitForElement: '#1890ff', // Blue
  scroll: '#1890ff',   // Blue
  extract: '#722ed1',  // Purple
  screenshot: '#eb2f96', // Pink
  forms: '#722ed1',    // Purple
};

const CustomNode = memo(({ data, selected }: NodeProps<{ step: AutomationStep; index: number }>) => {
  const step = data.step;
  const def = BLOCK_DEFINITIONS.find(d => d.id === step.type);
  
  const icon = ICONS[step.type] || <MoreOutlined />;
  const title = def?.name || step.type;
  const color = COLORS[step.type] || '#1890ff';
  
  // 使用 definition 中的 summary 函数
  const desc = def?.summary ? def.summary(step) : '';

  return (
    <div style={{ position: 'relative' }}>
      <Handle 
        type="target" 
        position={Position.Left} 
        style={{ 
          background: '#fff', 
          border: '2px solid #b1b1b7', 
          width: 10, 
          height: 10,
          left: -6
        }} 
      />
      
      <div 
        style={{ 
          width: 220, 
          background: '#fff',
          borderRadius: 8,
          boxShadow: selected ? '0 0 0 2px #2684FF, 0 4px 12px rgba(0,0,0,0.1)' : '0 2px 5px rgba(0,0,0,0.1)',
          display: 'flex',
          overflow: 'hidden',
          transition: 'all 0.2s ease'
        }}
      >
        <div style={{ 
          width: 40, 
          background: color, 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'center',
          color: '#fff',
          fontSize: 18
        }}>
          {icon}
        </div>

        {/* Right Content */}
        <div style={{ flex: 1, padding: '10px 12px', minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: '#333', marginBottom: 4 }}>{title}</div>
          <div style={{ 
            fontSize: 12, 
            color: '#666', 
            whiteSpace: 'nowrap', 
            overflow: 'hidden', 
            textOverflow: 'ellipsis',
            background: '#f5f5f5',
            padding: '2px 6px',
            borderRadius: 4,
            display: desc ? 'block' : 'none'
          }}>
            {desc}
          </div>
        </div>
      </div>

      <Handle 
        type="source" 
        position={Position.Right} 
        style={{ 
          background: '#fff', 
          border: '2px solid #b1b1b7', 
          width: 10, 
          height: 10,
          right: -6
        }} 
      />
    </div>
  );
});

export default CustomNode;
