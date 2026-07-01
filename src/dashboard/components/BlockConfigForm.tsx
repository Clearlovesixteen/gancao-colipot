import React from 'react';
import { Form, Input, InputNumber, Select, Checkbox, Typography, Space, Divider, Button, Card } from 'antd';
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import type { AutomationStep } from '../../shared/automationTypes';
import { BlockDefinition, BlockField } from '../../shared/blockDefs';

const { Text } = Typography;
const { TextArea } = Input;

interface BlockConfigFormProps {
  definition: BlockDefinition;
  step: AutomationStep;
  onChange: (updates: Partial<AutomationStep>) => void;
}

const BlockConfigForm: React.FC<BlockConfigFormProps> = ({ definition, step, onChange }) => {
  const renderField = (field: BlockField, value: any, onFieldChange: (val: any) => void) => {
    switch (field.type) {
      case 'input':
        return (
          <Input 
            value={value} 
            placeholder={field.placeholder}
            onChange={(e) => onFieldChange(e.target.value)} 
          />
        );
      case 'number':
        return (
          <InputNumber 
            value={value} 
            min={field.min} 
            max={field.max}
            placeholder={field.placeholder}
            style={{ width: '100%' }}
            onChange={(v) => onFieldChange(v)} 
          />
        );
      case 'select':
        return (
          <Select
            value={value}
            style={{ width: '100%' }}
            options={field.options}
            onChange={(v) => onFieldChange(v)}
          />
        );
      case 'textarea':
        return (
          <TextArea
            value={value}
            placeholder={field.placeholder}
            rows={4}
            onChange={(e) => onFieldChange(e.target.value)}
          />
        );
      case 'checkbox':
        return (
          <Checkbox 
            checked={value}
            onChange={(e) => onFieldChange(e.target.checked)}
          />
        );
      case 'list':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(value || []).map((item: any, index: number) => (
              <Card key={index} size="small" bodyStyle={{ padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 12 }}>项目 {index + 1}</Text>
                  <Button 
                    type="text" 
                    danger 
                    size="small" 
                    icon={<DeleteOutlined />} 
                    onClick={() => {
                      const newList = [...(value || [])];
                      newList.splice(index, 1);
                      onFieldChange(newList);
                    }}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {field.itemSchema?.map(subField => (
                    <div key={subField.name}>
                      <div style={{ marginBottom: 4 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>{subField.label}</Text>
                      </div>
                      {renderField(subField, item[subField.name], (val) => {
                        const newList = [...(value || [])];
                        newList[index] = { ...newList[index], [subField.name]: val };
                        onFieldChange(newList);
                      })}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
            <Button 
              type="dashed" 
              icon={<PlusOutlined />} 
              onClick={() => {
                const newList = [...(value || []), { ...field.newItemTemplate }];
                onFieldChange(newList);
              }}
            >
              添加项目
            </Button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={16}>
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        <Text strong style={{ fontSize: 16 }}>{definition.name}</Text>
        {definition.description && <Text type="secondary">{definition.description}</Text>}
      </Space>
      
      <Divider style={{ margin: '0' }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {definition.fields.map(field => (
          <div key={field.name}>
            <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
              <Text type="secondary">{field.label}</Text>
              {field.required && <Text type="danger">*</Text>}
            </div>
            {renderField(field, (step as any)[field.name], (val) => onChange({ [field.name]: val }))}
            {field.description && (
              <div style={{ marginTop: 4 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{field.description}</Text>
              </div>
            )}
          </div>
        ))}
      </div>
    </Space>
  );
};

export default BlockConfigForm;
