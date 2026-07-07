import React from 'react';
import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { Layout, Menu, Typography } from 'antd';
import { RobotOutlined, DashboardOutlined } from '@ant-design/icons';
import WorkflowList from './pages/WorkflowList';
import WorkflowEditor from './pages/WorkflowEditor';
import AutomationTaskCenter from './pages/AutomationTaskCenter';

const { Header, Sider, Content } = Layout;
const { Title } = Typography;

const AppLayout: React.FC = () => {
  const location = useLocation();
  const selectedKey = location.pathname.startsWith('/tasks')
    ? 'tasks'
    : location.pathname.startsWith('/workflow')
      ? 'workflows'
      : 'tasks';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="light" width={240} style={{ borderRight: '1px solid #f0f0f0' }}>
        <div style={{ padding: '16px 24px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <img src="/icons/icon128.png" alt="logo" style={{ width: 32, height: 32 }} onError={(e) => (e.currentTarget.style.display = 'none')} />
          <Title level={4} style={{ margin: 0 }}>甘草 Copilot</Title>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          style={{ borderRight: 0 }}
        >
          <Menu.Item key="tasks" icon={<DashboardOutlined />}>
            <Link to="/tasks">自动化任务中心</Link>
          </Menu.Item>
          <Menu.Item key="workflows" icon={<RobotOutlined />}>
            <Link to="/workflows">自动化工作流</Link>
          </Menu.Item>
          {/* <Menu.Item key="settings" icon={<SettingOutlined />}>
            <Link to="/settings">设置</Link>
          </Menu.Item> */}
        </Menu>
      </Sider>
      <Layout>
        <Header style={{ background: '#fff', padding: '0 24px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center' }}>
          <Title level={4} style={{ margin: 0 }}>工作台</Title>
        </Header>
        <Content style={{ margin: '24px', background: '#fff', borderRadius: 8, overflow: 'hidden' }}>
          <Routes>
            <Route path="/" element={<AutomationTaskCenter />} />
            <Route path="/tasks" element={<AutomationTaskCenter />} />
            <Route path="/workflows" element={<WorkflowList />} />
            <Route path="/workflow/:id" element={<WorkflowEditor />} />
            <Route path="/settings" element={<div style={{ padding: 24 }}>设置功能开发中...</div>} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <HashRouter>
      <AppLayout />
    </HashRouter>
  );
};

export default App;
