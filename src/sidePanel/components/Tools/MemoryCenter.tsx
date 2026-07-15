import React, { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Input, List, Modal, Space, Switch, Tag, Tooltip, Typography, message } from 'antd';
import { ArrowLeftOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, EditOutlined, StopOutlined } from '@ant-design/icons';
import moment from 'moment';
import {
  clearChatHistory,
  clearUserMemories,
  confirmUserMemoryCandidate,
  deleteUserMemory,
  isMemoryEnabled,
  listUserMemories,
  setMemoryEnabled,
  upsertUserMemory,
  type UserMemory,
  type UserMemoryType,
} from '../../../shared/userMemoryStore';

const { Text, Title, Paragraph } = Typography;
const { Search, TextArea } = Input;

interface MemoryCenterProps {
  onBack: () => void;
}

const memoryTypeLabel: Record<UserMemoryType, string> = {
  preference: '偏好',
  workflow: '流程',
  business_term: '术语',
  project_context: '上下文',
  failure_pattern: '失败模式',
};

const MemoryCenter: React.FC<MemoryCenterProps> = ({ onBack }) => {
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [keyword, setKeyword] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [editing, setEditing] = useState<UserMemory | null>(null);
  const [editingContent, setEditingContent] = useState('');

  const refresh = async () => {
    const [nextMemories, nextEnabled] = await Promise.all([
      listUserMemories(true),
      isMemoryEnabled(),
    ]);
    setMemories(nextMemories);
    setEnabled(nextEnabled);
  };

  useEffect(() => {
    refresh().catch((error) => message.error(error?.message || '加载记忆失败'));
  }, []);

  const filteredMemories = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return memories;
    return memories.filter((memory) => (
      `${memory.title} ${memory.content} ${memory.type}`.toLowerCase().includes(text)
    ));
  }, [keyword, memories]);
  const candidates = filteredMemories.filter((memory) => memory.status === 'candidate');
  const confirmedMemories = filteredMemories.filter((memory) => memory.status !== 'candidate');

  const handleToggleEnabled = async (checked: boolean) => {
    await setMemoryEnabled(checked);
    setEnabled(checked);
    message.success(checked ? '已启用长期记忆' : '已关闭长期记忆召回');
  };

  const handleToggleMemory = async (memory: UserMemory) => {
    await upsertUserMemory({ ...memory, enabled: !memory.enabled });
    await refresh();
  };

  const handleDeleteMemory = (memory: UserMemory) => {
    Modal.confirm({
      title: '删除长期记忆',
      content: `确认删除「${memory.title}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await deleteUserMemory(memory.id);
        message.success('已删除');
        await refresh();
      },
    });
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    await upsertUserMemory({ ...editing, content: editingContent });
    setEditing(null);
    setEditingContent('');
    message.success('已更新记忆');
    await refresh();
  };

  const handleClearChatHistory = () => {
    Modal.confirm({
      title: '清空聊天历史',
      content: '只会删除本地会话记录，不会删除长期记忆。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await clearChatHistory();
        message.success('已清空聊天历史');
      },
    });
  };

  const handleClearMemories = () => {
    Modal.confirm({
      title: '清空长期记忆',
      content: '这会删除所有长期记忆，聊天历史不会被删除。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await clearUserMemories();
        message.success('已清空长期记忆');
        await refresh();
      },
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      <div style={{ padding: '12px 16px', background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
            <Title level={5} style={{ margin: 0 }}>记忆中心</Title>
          </Space>
          <Tooltip title="关闭后不会把长期记忆注入 AI 上下文">
            <Switch checked={enabled} onChange={handleToggleEnabled} checkedChildren="启用" unCheckedChildren="关闭" />
          </Tooltip>
        </Space>
        <Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 12 }}>
          这里保存的是你主动记住的偏好、流程、术语和失败模式；聊天历史与长期记忆分开管理。
        </Paragraph>
      </div>

      <div style={{ padding: 12, display: 'flex', gap: 8, borderBottom: '1px solid #f0f0f0', background: '#fff' }}>
        <Search allowClear placeholder="搜索记忆..." onChange={(e) => setKeyword(e.target.value)} />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <List
          header={candidates.length ? <Text strong>待确认记忆（{candidates.length}）</Text> : undefined}
          dataSource={candidates}
          locale={{ emptyText: null }}
          renderItem={(memory) => (
            <List.Item>
              <Card size="small" style={{ width: '100%', borderColor: '#faad14' }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap><Tag color="gold">候选</Tag><Tag>{memoryTypeLabel[memory.type]}</Tag><Text strong>{memory.title}</Text></Space>
                  <Text>{memory.content}</Text>
                  <Space>
                    <Button size="small" type="primary" icon={<CheckOutlined />} onClick={async () => { await confirmUserMemoryCandidate(memory.id); message.success('已保存为长期记忆'); await refresh(); }}>确认记住</Button>
                    <Button size="small" icon={<CloseOutlined />} onClick={async () => { await deleteUserMemory(memory.id); await refresh(); }}>忽略</Button>
                  </Space>
                </Space>
              </Card>
            </List.Item>
          )}
        />
        <List
          header={<Text strong>长期记忆（{confirmedMemories.length}）</Text>}
          dataSource={confirmedMemories}
          locale={{ emptyText: <Empty description="暂无长期记忆，可在聊天消息中点击“记住这条”" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
          renderItem={(memory) => (
            <List.Item>
              <Card size="small" style={{ width: '100%', opacity: memory.enabled ? 1 : 0.58 }}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                    <Space size={6} wrap>
                      <Text strong>{memory.title}</Text>
                      <Tag>{memoryTypeLabel[memory.type]}</Tag>
                      {!memory.enabled && <Tag color="default">已禁用</Tag>}
                    </Space>
                    <Space size={4}>
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => {
                          setEditing(memory);
                          setEditingContent(memory.content);
                        }}
                      />
                      <Button
                        size="small"
                        icon={<StopOutlined />}
                        onClick={() => handleToggleMemory(memory)}
                      >
                        {memory.enabled ? '禁用' : '启用'}
                      </Button>
                      <Button size="small" danger icon={<DeleteOutlined />} onClick={() => handleDeleteMemory(memory)} />
                    </Space>
                  </Space>
                  <Text style={{ whiteSpace: 'pre-wrap' }}>{memory.content}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {moment(memory.updatedAt).fromNow()} 更新 · 置信度 {Math.round(memory.confidence * 100)}%
                  </Text>
                </Space>
              </Card>
            </List.Item>
          )}
        />
      </div>

      <div style={{ padding: 12, borderTop: '1px solid #f0f0f0', background: '#fff' }}>
        <Space wrap>
          <Button danger onClick={handleClearChatHistory}>清空聊天历史</Button>
          <Button danger onClick={handleClearMemories}>清空长期记忆</Button>
        </Space>
      </div>

      <Modal
        title="编辑长期记忆"
        visible={Boolean(editing)}
        onCancel={() => setEditing(null)}
        onOk={handleSaveEdit}
        okText="保存"
        cancelText="取消"
      >
        <TextArea
          value={editingContent}
          onChange={(event) => setEditingContent(event.target.value)}
          autoSize={{ minRows: 5, maxRows: 10 }}
        />
      </Modal>
    </div>
  );
};

export default MemoryCenter;
