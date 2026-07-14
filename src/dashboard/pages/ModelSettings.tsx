import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  List,
  Modal,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
} from 'antd';
import { CheckCircleOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ApiOutlined } from '@ant-design/icons';
import {
  MODEL_PROFILE_PRESETS,
  type ModelCapabilities,
  type ModelProfile,
  type ModelProvider,
  type PublicModelProfile,
} from '../../shared/modelProfiles';
import { runtimeMessage } from '../utils/runtimeMessage';

const { Title, Text, Paragraph } = Typography;

type ModelFormValue = Pick<ModelProfile, 'id' | 'name' | 'provider' | 'baseUrl' | 'model' | 'apiKey'> & {
  capabilities: ModelCapabilities;
};

const defaultCapabilities: ModelCapabilities = { streaming: true, tools: true, json: true, files: false };

const ModelSettings: React.FC = () => {
  const [profiles, setProfiles] = useState<PublicModelProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<ModelFormValue>();
  const provider = Form.useWatch('provider', form);
  const activeProfile = useMemo(() => profiles.find((profile) => profile.active), [profiles]);

  const load = async () => {
    setLoading(true);
    try {
      const response = await runtimeMessage<{ success: boolean; profiles?: PublicModelProfile[]; error?: string }>({ type: 'GET_MODEL_PROFILES' });
      if (!response?.success) throw new Error(response?.error || '读取模型配置失败');
      setProfiles(response.profiles || []);
    } catch (error: any) {
      message.error(error?.message || '读取模型配置失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const openCreate = () => {
    const preset = MODEL_PROFILE_PRESETS[0];
    form.setFieldsValue({ ...preset, apiKey: '', capabilities: { ...preset.capabilities } });
    setOpen(true);
  };

  const openEdit = (profile: PublicModelProfile) => {
    form.setFieldsValue({ ...profile, apiKey: '', capabilities: { ...profile.capabilities } });
    setOpen(true);
  };

  const applyProviderPreset = (value: ModelProvider) => {
    const preset = MODEL_PROFILE_PRESETS.find((item) => item.provider === value);
    if (!preset) return;
    form.setFieldsValue({
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
      capabilities: { ...preset.capabilities },
    });
  };

  const submit = async () => {
    const value = await form.validateFields();
    setSaving(true);
    try {
      const response = await runtimeMessage<{ success: boolean; error?: string }>({ type: 'UPSERT_MODEL_PROFILE', profile: value });
      if (!response?.success) throw new Error(response?.error || '保存失败');
      message.success('模型配置已保存');
      setOpen(false);
      form.resetFields();
      await load();
    } catch (error: any) {
      message.error(error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    const value = await form.validateFields();
    setTesting(true);
    try {
      const response = await runtimeMessage<{ success: boolean; error?: string }>({ type: 'TEST_MODEL_PROFILE', profile: value });
      if (!response?.success) throw new Error(response?.error || '连接失败');
      message.success('模型连接正常');
    } catch (error: any) {
      message.error(error?.message || '连接失败');
    } finally {
      setTesting(false);
    }
  };

  const activate = async (id: string) => {
    const response = await runtimeMessage<{ success: boolean; error?: string }>({ type: 'SET_ACTIVE_MODEL_PROFILE', id });
    if (!response?.success) return message.error(response?.error || '切换失败');
    message.success('已切换活动模型');
    await load();
  };

  const remove = (profile: PublicModelProfile) => {
    Modal.confirm({
      title: `删除“${profile.name}”？`,
      content: '删除后无法恢复，本地 API Key 也会一并移除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const response = await runtimeMessage<{ success: boolean; error?: string }>({ type: 'DELETE_MODEL_PROFILE', id: profile.id });
        if (!response?.success) throw new Error(response?.error || '删除失败');
        await load();
      },
    });
  };

  return (
    <div style={{ padding: 24, maxWidth: 1040 }}>
      <Space direction="vertical" size={18} style={{ width: '100%' }}>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>模型设置</Title>
          <Paragraph type="secondary" style={{ marginBottom: 0 }}>
            API Key 仅保存在本机扩展存储中。SidePanel 不直接访问模型接口，所有请求由后台 ModelGateway 统一处理。
          </Paragraph>
        </div>

        {!activeProfile && (
          <Alert type="warning" showIcon message="尚未配置活动模型" description="AI 对话、资料问答、页面诊断和智能规划暂不可用。" />
        )}

        <Card size="small" title="模型配置" extra={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>添加模型</Button>}>
          <List
            loading={loading}
            dataSource={profiles}
            locale={{ emptyText: '暂无模型配置' }}
            renderItem={(profile) => (
              <List.Item
                actions={[
                  <Button key="edit" type="text" icon={<EditOutlined />} onClick={() => openEdit(profile)}>编辑</Button>,
                  profile.active
                    ? <Tag key="active" color="success" icon={<CheckCircleOutlined />}>当前使用</Tag>
                    : <Button key="activate" type="link" onClick={() => void activate(profile.id)}>设为当前</Button>,
                  <Button key="delete" danger type="text" icon={<DeleteOutlined />} onClick={() => remove(profile)}>删除</Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={<ApiOutlined style={{ fontSize: 24, color: profile.active ? '#1677ff' : '#8c8c8c' }} />}
                  title={<Space><Text strong>{profile.name}</Text><Tag>{profile.provider}</Tag></Space>}
                  description={<Space direction="vertical" size={0}><Text>{profile.model}</Text><Text type="secondary">{profile.baseUrl} · Key {profile.apiKey || '未配置'}</Text></Space>}
                />
              </List.Item>
            )}
          />
        </Card>
      </Space>

      <Modal
        title={form.getFieldValue('id') ? '编辑模型配置' : '添加模型配置'}
        open={open}
        onCancel={() => { setOpen(false); form.resetFields(); }}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        footer={[
          <Button key="test" loading={testing} onClick={() => void test()}>测试连接</Button>,
          <Button key="cancel" onClick={() => { setOpen(false); form.resetFields(); }}>取消</Button>,
          <Button key="save" type="primary" loading={saving} onClick={() => void submit()}>保存</Button>,
        ]}
      >
        <Form form={form} layout="vertical" initialValues={{ capabilities: defaultCapabilities }}>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item label="服务类型" name="provider" rules={[{ required: true }]}>
            <Select onChange={applyProviderPreset} options={MODEL_PROFILE_PRESETS.map((item) => ({ value: item.provider, label: item.name }))} />
          </Form.Item>
          <Form.Item label="配置名称" name="name" rules={[{ required: true, message: '请输入配置名称' }]}><Input /></Form.Item>
          <Form.Item label="Base URL" name="baseUrl" rules={[{ required: true, type: 'url', message: '请输入有效 URL' }]}><Input placeholder="https://api.example.com/v1" /></Form.Item>
          <Form.Item label="模型名称" name="model" rules={[{ required: true, message: '请输入模型名称' }]}><Input /></Form.Item>
          <Form.Item label="API Key" name="apiKey" tooltip={form.getFieldValue('id') ? '留空表示保留原 Key' : undefined} rules={form.getFieldValue('id') ? [] : [{ required: true, message: '请输入 API Key' }]}>
            <Input.Password autoComplete="new-password" placeholder={form.getFieldValue('id') ? '留空保留原 Key' : '输入 API Key'} />
          </Form.Item>
          <Form.Item label="能力">
            <Space wrap>
              {(['streaming', 'tools', 'json', 'files'] as const).map((capability) => (
                <Form.Item key={capability} name={['capabilities', capability]} valuePropName="checked" noStyle>
                  <Switch checkedChildren={capability} unCheckedChildren={capability} />
                </Form.Item>
              ))}
            </Space>
          </Form.Item>
          {provider === 'gancao' && <Alert type="info" showIcon message="业务模型的原生文件能力取决于服务端接口；资料中心本地解析仍是默认路径。" />}
        </Form>
      </Modal>
    </div>
  );
};

export default ModelSettings;
