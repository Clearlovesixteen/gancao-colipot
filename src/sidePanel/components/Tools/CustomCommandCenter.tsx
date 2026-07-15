import React, { useEffect, useState } from 'react';
import { Button, Card, Empty, Form, Input, List, Modal, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { ArrowLeftOutlined, CopyOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, PlusOutlined } from '@ant-design/icons';
import {
  deleteCustomCommand,
  exportCustomCommands,
  importCustomCommands,
  listCustomCommands,
  listCustomCommandVersions,
  rollbackCustomCommand,
  upsertCustomCommand,
  type CustomCopilotCommand,
} from '../../../shared/customCommandStore';

const { Text, Title } = Typography;

const CustomCommandCenter: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [commands, setCommands] = useState<CustomCopilotCommand[]>([]);
  const [editing, setEditing] = useState<CustomCopilotCommand | null | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [form] = Form.useForm();
  const [versionsOf, setVersionsOf] = useState<CustomCopilotCommand | null>(null);
  const [versions, setVersions] = useState<any[]>([]);
  const [modelProfiles, setModelProfiles] = useState<Array<{ id: string; name: string; model: string }>>([]);

  const refresh = () => listCustomCommands(true).then(setCommands);
  useEffect(() => {
    refresh().catch(() => {});
    chrome.runtime.sendMessage({ type: 'GET_MODEL_PROFILES' }, (response) => setModelProfiles(response?.profiles || []));
  }, []);

  const openEditor = (command: CustomCopilotCommand | null) => {
    setEditing(command);
    form.setFieldsValue(command || { mode: 'prompt', riskLevel: 'low', enabled: true, taskKind: 'computer_use', metadataJson: '{}', inputSchemaJson: '[]' });
    if (command) form.setFieldValue('metadataJson', JSON.stringify(command.metadata || {}, null, 2));
    if (command) form.setFieldValue('inputSchemaJson', JSON.stringify(command.inputSchema || [], null, 2));
  };

  const save = async () => {
    const values = await form.validateFields();
    let metadata: Record<string, unknown> = {};
    let inputSchema: any[] = [];
    try { metadata = JSON.parse(values.metadataJson || '{}'); } catch { message.error('任务 metadata 必须是 JSON 对象'); return; }
    try { inputSchema = JSON.parse(values.inputSchemaJson || '[]'); if (!Array.isArray(inputSchema)) throw new Error(); } catch { message.error('输入表单必须是 JSON 数组'); return; }
    await upsertCustomCommand({ ...editing, ...values, metadata, inputSchema });
    setEditing(undefined);
    message.success('命令已保存');
    await refresh();
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      <div style={{ padding: 12, background: '#fff', borderBottom: '1px solid #f0f0f0' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space><Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} /><Title level={5} style={{ margin: 0 }}>自定义命令</Title></Space>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openEditor(null)}>新建</Button>
        </Space>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <List
          dataSource={commands}
          locale={{ emptyText: <Empty description="还没有自定义命令" /> }}
          renderItem={(command) => <List.Item>
            <Card size="small" style={{ width: '100%', opacity: command.enabled ? 1 : 0.55 }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space wrap><Text strong>{command.title}</Text><Tag>{command.mode}</Tag><Tag>v{command.version}</Tag><Tag color={command.riskLevel === 'high' ? 'red' : command.riskLevel === 'medium' ? 'orange' : 'green'}>{command.riskLevel}</Tag></Space>
                <Text type="secondary">{command.description || command.promptTemplate}</Text>
                <Space>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEditor(command)}>编辑</Button>
                  <Button size="small" icon={<HistoryOutlined />} onClick={async () => { setVersionsOf(command); setVersions(await listCustomCommandVersions(command.id)); }}>版本</Button>
                  <Switch size="small" checked={command.enabled} onChange={async (enabled) => { await upsertCustomCommand({ ...command, enabled }); await refresh(); }} />
                  <Button size="small" danger icon={<DeleteOutlined />} onClick={() => Modal.confirm({ title: '删除命令', onOk: async () => { await deleteCustomCommand(command.id); await refresh(); } })} />
                </Space>
              </Space>
            </Card>
          </List.Item>}
        />
      </div>
      <div style={{ padding: 12, background: '#fff', borderTop: '1px solid #f0f0f0' }}>
        <Space>
          <Button icon={<CopyOutlined />} onClick={async () => { await navigator.clipboard.writeText(await exportCustomCommands()); message.success('命令 JSON 已复制'); }}>导出</Button>
          <Button onClick={() => setImporting(true)}>导入</Button>
        </Space>
      </div>

      <Modal title={editing ? '编辑命令' : '新建命令'} open={editing !== undefined} onCancel={() => setEditing(undefined)} onOk={save}>
        <Form form={form} layout="vertical">
          <Form.Item name="title" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="说明"><Input /></Form.Item>
          <Form.Item name="mode" label="执行方式"><Select options={[{ value: 'prompt', label: '填入 Chat 提示词' }, { value: 'task', label: '创建自动化任务' }]} /></Form.Item>
          <Form.Item name="promptTemplate" label="提示词 / 任务目标" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
          <Form.Item name="inputSchemaJson" label="输入表单 JSON"><Input.TextArea rows={4} placeholder={'[{"name":"keyword","label":"关键词","type":"text","required":true}]'} /></Form.Item>
          <Form.Item name="modelProfileId" label="指定模型（可选）"><Select allowClear options={modelProfiles.map((profile) => ({ value: profile.id, label: `${profile.name} · ${profile.model}` }))} /></Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.mode !== b.mode}>{({ getFieldValue }) => getFieldValue('mode') === 'task' ? <>
            <Form.Item name="taskKind" label="任务类型"><Select options={['computer_use', 'page_diagnosis', 'document_qa', 'ocr', 'extract', 'workflow'].map((value) => ({ value, label: value }))} /></Form.Item>
            <Form.Item name="metadataJson" label="任务 metadata"><Input.TextArea rows={3} /></Form.Item>
          </> : null}</Form.Item>
          <Form.Item name="riskLevel" label="风险等级"><Select options={['low', 'medium', 'high'].map((value) => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
      <Modal title={`版本历史：${versionsOf?.title || ''}`} open={Boolean(versionsOf)} footer={null} onCancel={() => setVersionsOf(null)}>
        <List dataSource={versions} renderItem={(item: any) => <List.Item actions={[<Button key="rollback" size="small" onClick={async () => { if (!versionsOf) return; await rollbackCustomCommand(versionsOf.id, item.version); message.success(`已回滚到 v${item.version}`); setVersionsOf(null); await refresh(); }}>回滚到此版本</Button>]}><Space><Tag>v{item.version}</Tag><Text>{new Date(item.createdAt).toLocaleString()}</Text></Space></List.Item>} />
      </Modal>
      <Modal title="导入命令 JSON" open={importing} onCancel={() => setImporting(false)} onOk={async () => {
        try { const count = await importCustomCommands(importText); message.success(`已导入 ${count} 条命令`); setImporting(false); setImportText(''); await refresh(); } catch (error: any) { message.error(error?.message || '导入失败'); }
      }}><Input.TextArea rows={10} value={importText} onChange={(e) => setImportText(e.target.value)} /></Modal>
    </div>
  );
};

export default CustomCommandCenter;
