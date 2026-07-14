import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, List, Space, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import { runPluginHealthCheck, type HealthCheckItem, type HealthCheckStatus } from '../../utils/healthCheck';

const { Text, Title, Paragraph } = Typography;

interface HealthCheckProps {
  onBack: () => void;
}

const statusColor: Record<HealthCheckStatus, string> = {
  pass: 'success',
  warn: 'warning',
  fail: 'error',
};

const statusText: Record<HealthCheckStatus, string> = {
  pass: '正常',
  warn: '注意',
  fail: '异常',
};

function summarize(items: HealthCheckItem[]) {
  const failCount = items.filter((item) => item.status === 'fail').length;
  const warnCount = items.filter((item) => item.status === 'warn').length;
  if (failCount) return { type: 'error' as const, text: `${failCount} 项异常，建议先处理红色项目。` };
  if (warnCount) return { type: 'warning' as const, text: `${warnCount} 项需要注意，但核心能力可能仍可使用。` };
  return { type: 'success' as const, text: '所有检查项正常。' };
}

const HealthCheck: React.FC<HealthCheckProps> = ({ onBack }) => {
  const [items, setItems] = useState<HealthCheckItem[]>([]);
  const [loading, setLoading] = useState(false);

  const summary = useMemo(() => summarize(items), [items]);

  const run = async () => {
    setLoading(true);
    try {
      setItems(await runPluginHealthCheck());
    } catch (error: any) {
      message.error(error?.message || '健康检查失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    run();
  }, []);

  const copyReport = async () => {
    await navigator.clipboard.writeText(JSON.stringify({
      checkedAt: new Date().toISOString(),
      items,
    }, null, 2));
    message.success('已复制健康检查报告');
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      <div style={{ padding: '12px 16px', background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
            <Title level={5} style={{ margin: 0 }}>插件健康检查</Title>
          </Space>
          <Space>
            <Button size="small" icon={<CopyOutlined />} onClick={copyReport} disabled={!items.length}>
              复制报告
            </Button>
            <Button size="small" type="primary" icon={<ReloadOutlined />} onClick={run} loading={loading}>
              重新检查
            </Button>
          </Space>
        </Space>
        <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          用来定位 LLM、登录态、页面注入、下载、PaddleOCR、资料库和任务轨迹是否可用。
        </Paragraph>
      </div>

      <div style={{ padding: 12 }}>
        {items.length > 0 && (
          <Alert
            type={summary.type}
            showIcon
            message={summary.text}
            style={{ marginBottom: 12 }}
          />
        )}
        <List
          loading={loading}
          dataSource={items}
          locale={{ emptyText: <Empty description="点击重新检查获取状态" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(item) => (
            <List.Item>
              <Card size="small" style={{ width: '100%' }}>
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Text strong>{item.title}</Text>
                    <Tag color={statusColor[item.status]}>{statusText[item.status]}</Tag>
                  </Space>
                  <Text>{item.message}</Text>
                  {item.detail && (
                    <Text type="secondary" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                      {item.detail}
                    </Text>
                  )}
                </Space>
              </Card>
            </List.Item>
          )}
        />
      </div>
    </div>
  );
};

export default HealthCheck;
