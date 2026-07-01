import React, { useState } from 'react';
import { Upload, Button,  message, Card, Radio, Space, Typography, Spin } from 'antd';
import { InboxOutlined,  DownloadOutlined } from '@ant-design/icons';
import * as XLSX from 'xlsx';
import type { UploadFile } from 'antd/es/upload/interface';

const { Dragger } = Upload;
const { Title, Text } = Typography;

const ExcelMerge: React.FC = () => {
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [merging, setMerging] = useState(false);
  const [mergeType, setMergeType] = useState<'sheet' | 'append'>('sheet');

  const handleUploadChange = (info: any) => {
    let newFileList = [...info.fileList];
    setFileList(newFileList);
  };

  const handleRemove = (file: UploadFile) => {
    const index = fileList.indexOf(file);
    const newFileList = fileList.slice();
    newFileList.splice(index, 1);
    setFileList(newFileList);
  };

  const mergeExcelFiles = async () => {
    if (fileList.length < 2) {
      message.warning('请至少上传两个Excel文件');
      return;
    }

    setMerging(true);
    try {
      const newWorkbook = XLSX.utils.book_new();
      
      for (const file of fileList) {
        if (!file.originFileObj) continue;
        
        const data = await file.originFileObj.arrayBuffer();
        const workbook = XLSX.read(data);
        
        if (mergeType === 'sheet') {
          // 模式1：保留所有Sheet，重命名避免冲突
          workbook.SheetNames.forEach(sheetName => {
            let newSheetName = `${file.name.replace(/\.[^/.]+$/, "")}-${sheetName}`;
            // 截断过长的Sheet名（Excel限制31字符）
            if (newSheetName.length > 31) {
              newSheetName = newSheetName.substring(0, 31);
            }
            
            // 确保名字唯一
            let counter = 1;
            let finalName = newSheetName;
            while (newWorkbook.SheetNames.includes(finalName)) {
              finalName = `${newSheetName.substring(0, 28)}(${counter})`;
              counter++;
            }
            
            XLSX.utils.book_append_sheet(newWorkbook, workbook.Sheets[sheetName], finalName);
          });
        } else {
          
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          
          if (newWorkbook.SheetNames.length === 0) {
            // 第一个文件，直接创建新Sheet
            const newSheet = XLSX.utils.aoa_to_sheet(jsonData as any[][]);
            XLSX.utils.book_append_sheet(newWorkbook, newSheet, 'MergedData');
          } else {
           
            const currentSheet = newWorkbook.Sheets['MergedData'];
           
            const existingData = XLSX.utils.sheet_to_json(currentSheet, { header: 1 }) as any[][];
            const newData = (jsonData as any[][]).slice(1); // 假设第一行是表头，跳过
            const combinedData = existingData.concat(newData);
            
            const newSheet = XLSX.utils.aoa_to_sheet(combinedData);
            newWorkbook.Sheets['MergedData'] = newSheet;
            
            // 更新范围
            const range = XLSX.utils.decode_range(newSheet['!ref'] || 'A1');
            newSheet['!ref'] = XLSX.utils.encode_range(range);
          }
        }
      }

      // 导出文件
      XLSX.writeFile(newWorkbook, `合并结果_${Date.now()}.xlsx`);
      message.success('合并成功并已开始下载');
    } catch (error) {
      console.error('合并失败:', error);
      message.error('合并过程中发生错误');
    } finally {
      setMerging(false);
    }
  };

  return (
    <div style={{ padding: '16px' }}>
      
      <Card style={{ marginBottom: 16 }}>
        <Dragger
          multiple
          fileList={fileList}
          onChange={handleUploadChange}
          onRemove={handleRemove}
          beforeUpload={() => false} // 阻止自动上传
          accept=".xlsx,.xls,.csv"
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到此区域</p>
          <p className="ant-upload-hint">支持 .xlsx, .xls, .csv 格式</p>
        </Dragger>
      </Card>

      <Space direction="vertical" style={{ width: '100%' }}>
        <Card size="small" title="合并选项">
          <Radio.Group value={mergeType} onChange={e => setMergeType(e.target.value)}>
            <Space direction="vertical">
              <Radio value="sheet">
                合并为多Sheet
                <Text type="secondary" style={{ display: 'block', fontSize: '12px', marginLeft: 24 }}>
                  保留所有源文件的Sheet，以文件名作为前缀
                </Text>
              </Radio>
              <Radio value="append">
                追加合并数据
                <Text type="secondary" style={{ display: 'block', fontSize: '12px', marginLeft: 24 }}>
                  将所有文件的第一个Sheet数据追加到一张表中（表头必须一致）
                </Text>
              </Radio>
            </Space>
          </Radio.Group>
        </Card>

        <Button 
          type="primary" 
          block 
          icon={merging ? <Spin size="small" /> : <DownloadOutlined />}
          onClick={mergeExcelFiles}
          disabled={fileList.length < 2 || merging}
          size="large"
        >
          {merging ? '正在处理...' : '开始合并并下载'}
        </Button>
      </Space>
    </div>
  );
};

export default ExcelMerge;
