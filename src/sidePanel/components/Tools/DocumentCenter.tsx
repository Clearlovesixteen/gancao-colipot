import React, { useEffect, useState } from 'react';
import { Button, Card, Empty, Input, List, Modal, Progress, Select, Space, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import { CopyOutlined, DeleteOutlined, DownloadOutlined, EyeOutlined, FileSearchOutlined, ReloadOutlined, ScanOutlined } from '@ant-design/icons';
import type { DocumentAsset, DocumentContent, DocumentResult, DocumentSpace, PageStructuredData, RequirementTaskResult, StructuredOcrResult } from '../../../shared/documentTypes';
import {
  deleteDocumentAsset,
  getDocumentContent,
  getRawFile,
  listDocumentAssets,
  listDocumentResults,
  migrateLegacyUploadedFiles,
  rebuildDocumentChunks,
  saveDocumentContent,
  upsertDocumentAsset,
} from '../../utils/documentStore';
import {
  downloadTextFile,
  downloadWorkbook,
  pageStructuredDataToRows,
  requirementTasksToMarkdown,
  requirementTasksToRows,
  tableToRows,
  toCsv,
} from '../../../shared/exporters';
import { parseUploadedFile, type ParsedUploadedFile } from '../../../shared/fileParser';
import { getOcrErrorMessage, runOcr } from '../../utils/ocrEngine';
import { structureOcrText, structuredOcrToMarkdown } from '../../../shared/ocrStructurer';
import { listDocumentSpaces, upsertDocumentSpace } from '../../../shared/documentSpaces';

const { Text, Title } = Typography;
const { TabPane } = Tabs;

function statusColor(status: string) {
  if (['parsed', 'uploaded', 'done', 'not_needed'].includes(status)) return 'green';
  if (['pending', 'running', 'partial'].includes(status)) return 'gold';
  if (['error', 'unsupported'].includes(status)) return 'red';
  return 'default';
}

const DocumentCenter: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const [assets, setAssets] = useState<DocumentAsset[]>([]);
  const [results, setResults] = useState<DocumentResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<Record<string, number>>({});
  const [detail, setDetail] = useState<{ asset: DocumentAsset; content: DocumentContent | null } | null>(null);
  const [spaces, setSpaces] = useState<DocumentSpace[]>([]);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string>('all');

  const refresh = async () => {
    setLoading(true);
    try {
      await migrateLegacyUploadedFiles();
      const [nextAssets, nextResults, nextSpaces] = await Promise.all([
        listDocumentAssets(),
        listDocumentResults(),
        listDocumentSpaces(),
      ]);
      setAssets(nextAssets);
      setResults(nextResults);
      setSpaces(nextSpaces);
    } finally {
      setLoading(false);
    }
  };

  const visibleAssets = selectedSpaceId === 'all'
    ? assets
    : selectedSpaceId === 'unassigned'
      ? assets.filter((asset) => !asset.spaceId)
      : assets.filter((asset) => asset.spaceId === selectedSpaceId);

  const handleCreateSpace = () => {
    let name = '';
    Modal.confirm({
      title: '新建资料空间',
      content: <Input placeholder="例如：智慧药房项目" onChange={(event) => { name = event.target.value; }} />,
      onOk: async () => {
        if (!name.trim()) throw new Error('请输入空间名称');
        await upsertDocumentSpace({ name });
        await refresh();
      },
    });
  };

  const handleMoveAsset = async (asset: DocumentAsset, spaceId?: string) => {
    await upsertDocumentAsset({ ...asset, spaceId: spaceId || undefined, updatedAt: Date.now() });
    message.success('资料空间已更新');
    await refresh();
  };

  useEffect(() => {
    refresh();
    const listener = (event: any) => {
      if (event?.type === 'DOCUMENT_CENTER_UPDATED') {
        refresh();
      }
    };
    chrome.runtime?.onMessage?.addListener(listener);
    return () => chrome.runtime?.onMessage?.removeListener(listener);
  }, []);

  const handleDelete = async (asset: DocumentAsset) => {
    await deleteDocumentAsset(asset.id);
    message.success('已删除资料');
    refresh();
  };

  const handleOpenDetail = async (asset: DocumentAsset) => {
    const content = await getDocumentContent(asset.id);
    setDetail({ asset, content });
  };

  const renderTextBlock = (text?: string) => (
    text?.trim()
      ? <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 12 }}>{text}</pre>
      : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无内容" />
  );

  const renderStructuredOcr = (structuredOcr?: StructuredOcrResult) => {
    if (!structuredOcr) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无结构化 OCR 结果" />;
    }

    return (
      <Tabs defaultActiveKey="overview" size="small">
        <TabPane tab="概览" key="overview">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Card size="small">
              <Space wrap>
                <Tag color="blue">{structuredOcr.documentType}</Tag>
                <Tag>页数 {structuredOcr.pageCount}</Tag>
                <Tag>字段 {structuredOcr.fields.length}</Tag>
                <Tag>表格 {structuredOcr.tables.length}</Tag>
              </Space>
              <div style={{ marginTop: 10 }}>{structuredOcr.summary}</div>
            </Card>
            {structuredOcr.warnings.length > 0 && (
              <Card size="small" title="识别提示">
                <Space direction="vertical" size={4}>
                  {structuredOcr.warnings.map((warning, index) => (
                    <Text key={`${warning}_${index}`} type="secondary">{warning}</Text>
                  ))}
                </Space>
              </Card>
            )}
          </Space>
        </TabPane>
        <TabPane tab={`字段 ${structuredOcr.fields.length}`} key="fields">
          {structuredOcr.fields.length ? (
            <Table
              size="small"
              pagination={{ pageSize: 8 }}
              rowKey={(record, index) => `${record.key}_${index}`}
              dataSource={structuredOcr.fields}
              columns={[
                { title: '字段', dataIndex: 'key', width: 160 },
                { title: '内容', dataIndex: 'value' },
                { title: '页码', dataIndex: 'pageNumber', width: 72 },
              ]}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未识别出字段" />
          )}
        </TabPane>
        <TabPane tab={`表格 ${structuredOcr.tables.length}`} key="tables">
          {structuredOcr.tables.length ? (
            structuredOcr.tables.map((table, index) => (
              <Card key={`${table.title || 'ocr_table'}_${index}`} size="small" title={table.title || `表格 ${index + 1}`} style={{ marginBottom: 12 }}>
                <Table
                  size="small"
                  pagination={{ pageSize: 5 }}
                  columns={(table.headers || []).map((header, colIndex) => ({
                    title: header || `列 ${colIndex + 1}`,
                    dataIndex: String(colIndex),
                  }))}
                  dataSource={(table.rows || []).map((row, rowIndex) => ({
                    key: rowIndex,
                    ...row.reduce((acc, cell, colIndex) => ({ ...acc, [String(colIndex)]: cell }), {}),
                  }))}
                />
              </Card>
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="未识别出表格" />
          )}
        </TabPane>
        <TabPane tab={`正文 ${structuredOcr.sections.length}`} key="sections">
          {structuredOcr.sections.length ? (
            <Space direction="vertical" size={8} style={{ width: '100%', maxHeight: 420, overflow: 'auto' }}>
              {structuredOcr.sections.slice(0, 80).map((section, index) => (
                <Card
                  key={`${section.type}_${section.pageNumber || 0}_${index}`}
                  size="small"
                  title={section.title || `${section.type}${section.pageNumber ? ` · 第 ${section.pageNumber} 页` : ''}`}
                >
                  <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 }}>{section.text}</pre>
                </Card>
              ))}
            </Space>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无正文区块" />
          )}
        </TabPane>
      </Tabs>
    );
  };

  const parsedSheetsToTables = (parsed: ParsedUploadedFile) => parsed.sheets?.map((sheet) => ({
    title: sheet.name,
    headers: sheet.headers || [],
    rows: sheet.rows.map((row) => row.map((cell) => String(cell ?? ''))),
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
  }));

  const getRawFileAsFile = async (asset: DocumentAsset): Promise<File> => {
    const raw = await getRawFile(asset.id);
    if (!raw) throw new Error('未找到原始文件，无法执行该操作。');
    return raw instanceof File
      ? raw
      : new File([raw], asset.title, { type: asset.mimeType || raw.type || 'application/octet-stream' });
  };

  const handleReparse = async (asset: DocumentAsset) => {
    try {
      message.loading({ content: '正在重新解析资料...', key: `reparse_${asset.id}` });
      const file = await getRawFileAsFile(asset);
      const parsed = await parseUploadedFile(file);
      const existing = await getDocumentContent(asset.id);
      const nextAsset: DocumentAsset = {
        ...asset,
        localParseStatus: parsed.status,
        ocrStatus: asset.ocrStatus,
        error: parsed.error,
        updatedAt: Date.now(),
      };
      const nextContent = {
        assetId: asset.id,
        text: [parsed.text, existing?.structuredOcr ? structuredOcrToMarkdown(existing.structuredOcr) : existing?.ocrText].filter(Boolean).join('\n\n'),
        localText: parsed.text || '',
        ocrText: existing?.ocrText,
        structuredOcr: existing?.structuredOcr,
        tables: [
          ...(parsedSheetsToTables(parsed) || []),
          ...(existing?.structuredOcr?.tables || []),
        ],
        metadata: parsed.metadata,
        updatedAt: Date.now(),
      };
      await upsertDocumentAsset(nextAsset);
      await saveDocumentContent(nextContent);
      await rebuildDocumentChunks(nextAsset, nextContent);
      message.success({ content: '重新解析完成', key: `reparse_${asset.id}` });
      refresh();
    } catch (error: any) {
      message.error({ content: error?.message || '重新解析失败', key: `reparse_${asset.id}` });
    }
  };

  const handleRunOcr = async (asset: DocumentAsset) => {
    try {
      message.loading({ content: 'OCR 正在识别...', key: `ocr_${asset.id}` });
      setOcrProgress((prev) => ({ ...prev, [asset.id]: 0 }));
      const file = await getRawFileAsFile(asset);
      await upsertDocumentAsset({ ...asset, ocrStatus: 'running', updatedAt: Date.now() });
      const result = await runOcr(file, asset.mimeType || file.type, {
        maxPages: 20,
        onProgress: (progress) => {
          setOcrProgress((prev) => ({
            ...prev,
            [asset.id]: Math.round((progress.progress || 0) * 100),
          }));
        },
      });
      const existing = await getDocumentContent(asset.id);
      const structuredOcr = structureOcrText({
        text: result.text,
        pages: result.pages,
        warnings: result.warnings,
      });
      const structuredOcrMarkdown = structuredOcrToMarkdown(structuredOcr);
      const text = [existing?.localText, structuredOcrMarkdown].filter(Boolean).join('\n\n');
      const hasOcrText = Boolean(result.text.trim());
      const ocrIsReliable = hasOcrText && !result.quality.lowConfidence && !result.quality.likelyGarbled;
      const ocrWarning = result.warnings.join(' ');
      const nextAsset: DocumentAsset = {
        ...asset,
        ocrStatus: ocrIsReliable ? 'done' : 'partial',
        error: ocrIsReliable ? undefined : (ocrWarning || 'OCR 结果置信度较低'),
        updatedAt: Date.now(),
      };
      const nextContent = {
        assetId: asset.id,
        text,
        localText: existing?.localText,
        ocrText: result.text,
        structuredOcr,
        tables: [
          ...(existing?.tables || []).filter((table) => !table.title?.startsWith('OCR 表格')),
          ...structuredOcr.tables,
        ],
        metadata: {
          ...(existing?.metadata || {}),
          ocrPages: result.pages,
          ocrQuality: result.quality,
          ocrWarnings: result.warnings,
        },
        updatedAt: Date.now(),
      };
      await saveDocumentContent(nextContent);
      await upsertDocumentAsset(nextAsset);
      await rebuildDocumentChunks(nextAsset, nextContent);
      if (hasOcrText) {
        if (ocrIsReliable) {
          message.success({ content: 'OCR 完成', key: `ocr_${asset.id}` });
        } else {
          message.warning({ content: 'OCR 已完成，但置信度较低', key: `ocr_${asset.id}` });
        }
      } else {
        message.warning({ content: 'OCR 已完成，但未识别到文字', key: `ocr_${asset.id}` });
      }
      setOcrProgress((prev) => {
        const next = { ...prev };
        delete next[asset.id];
        return next;
      });
      refresh();
    } catch (error: any) {
      const errorMessage = getOcrErrorMessage(error);
      await upsertDocumentAsset({ ...asset, ocrStatus: 'error', error: errorMessage, updatedAt: Date.now() });
      message.error({ content: errorMessage, key: `ocr_${asset.id}` });
      setOcrProgress((prev) => {
        const next = { ...prev };
        delete next[asset.id];
        return next;
      });
      refresh();
    }
  };

  const executeTool = async (toolName: string, args: Record<string, any>) => {
    const response = await chrome.runtime.sendMessage({ type: 'EXECUTE_TOOL', toolName, arguments: args });
    if (response?.code === 'UNAUTHENTICATED') {
      await chrome.storage.local.set({ user_auth: false });
      throw new Error(response.error || '未登录');
    }
    if (!response?.success) throw new Error(response?.error || '工具执行失败');
    return response;
  };

  const handleGenerateTasks = async (asset: DocumentAsset) => {
    try {
      message.loading({ content: '正在生成任务清单...', key: `tasks_${asset.id}` });
      await executeTool('generate_requirement_tasks', { documentIds: [asset.id] });
      message.success({ content: '任务清单已生成', key: `tasks_${asset.id}` });
      refresh();
    } catch (error: any) {
      message.error({ content: error?.message || '生成任务失败', key: `tasks_${asset.id}` });
    }
  };

  const exportResult = (result: DocumentResult) => {
    if (result.kind === 'requirement_tasks') {
      const data = result.data as RequirementTaskResult;
      downloadTextFile('需求任务清单.md', requirementTasksToMarkdown(data), 'text/markdown;charset=utf-8');
      downloadTextFile('需求任务清单.csv', toCsv(requirementTasksToRows(data)), 'text/csv;charset=utf-8');
      downloadWorkbook('需求任务清单.xlsx', [{ name: '任务清单', rows: requirementTasksToRows(data) }]);
      return;
    }

    if (result.kind === 'page_structured_data') {
      const data = result.data as PageStructuredData;
      downloadTextFile('网页结构化数据.json', JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
      downloadTextFile('网页字段.csv', toCsv(pageStructuredDataToRows(data)), 'text/csv;charset=utf-8');
      downloadWorkbook('网页结构化数据.xlsx', [
        { name: '字段', rows: pageStructuredDataToRows(data) },
        ...data.tables.map((table, index) => ({ name: table.title || `表格${index + 1}`, rows: tableToRows(table) })),
      ]);
      return;
    }

    downloadTextFile(`${result.title || 'result'}.json`, JSON.stringify(result.data, null, 2), 'application/json;charset=utf-8');
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0', display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button type="text" onClick={onBack}>返回</Button>
        <Title level={5} style={{ margin: 0, flex: 1 }}>资料中心</Title>
        <Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>
      </div>
      <Tabs defaultActiveKey="assets" style={{ flex: 1, minHeight: 0 }} tabBarStyle={{ padding: '0 16px' }}>
        <TabPane tab={`资料 ${assets.length}`} key="assets">
          <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            <Space style={{ width: '100%', marginBottom: 12 }}>
              <Select
                value={selectedSpaceId}
                onChange={setSelectedSpaceId}
                style={{ minWidth: 180 }}
                options={[
                  { value: 'all', label: `全部资料 (${assets.length})` },
                  { value: 'unassigned', label: '未分类' },
                  ...spaces.map((space) => ({ value: space.id, label: space.name })),
                ]}
              />
              <Button size="small" onClick={handleCreateSpace}>新建空间</Button>
            </Space>
            {visibleAssets.length === 0 ? (
              <Empty description="暂无资料" />
            ) : (
              <List
                dataSource={visibleAssets}
                renderItem={(asset) => (
                  <List.Item>
                    <Card size="small" style={{ width: '100%' }}>
                      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Text strong ellipsis style={{ maxWidth: 260 }}>{asset.title}</Text>
                          <div style={{ marginTop: 8 }}>
                            <Space size={4} wrap>
                              <Tag>{asset.sourceType}</Tag>
                              <Tag color={statusColor(asset.localParseStatus)}>解析 {asset.localParseStatus}</Tag>
                              <Tag color={statusColor(asset.nativeUploadStatus)}>模型 {asset.nativeUploadStatus}</Tag>
                              <Tag color={statusColor(asset.ocrStatus)}>OCR {asset.ocrStatus}</Tag>
                              {asset.spaceId && <Tag color="blue">{spaces.find((space) => space.id === asset.spaceId)?.name || '未知空间'}</Tag>}
                            </Space>
                          </div>
                          {asset.error && <Text type="secondary" style={{ fontSize: 12 }}>{asset.error}</Text>}
                          {typeof ocrProgress[asset.id] === 'number' && (
                            <Progress percent={ocrProgress[asset.id]} size="small" style={{ marginTop: 8 }} />
                          )}
                        </div>
                        <Space size={4}>
                          <Select
                            size="small"
                            value={asset.spaceId || 'unassigned'}
                            style={{ width: 108 }}
                            onChange={(value) => handleMoveAsset(asset, value === 'unassigned' ? undefined : value)}
                            options={[{ value: 'unassigned', label: '未分类' }, ...spaces.map((space) => ({ value: space.id, label: space.name }))]}
                          />
                          <Tooltip title="查看详情">
                            <Button type="text" icon={<EyeOutlined />} onClick={() => handleOpenDetail(asset)} />
                          </Tooltip>
                          <Tooltip title="OCR 识别">
                            <Button
                              type="text"
                              icon={<ScanOutlined />}
                              disabled={!['pending', 'partial', 'error'].includes(asset.ocrStatus)}
                              onClick={() => handleRunOcr(asset)}
                            />
                          </Tooltip>
                          <Tooltip title="重新解析">
                            <Button type="text" icon={<ReloadOutlined />} onClick={() => handleReparse(asset)} />
                          </Tooltip>
                          <Tooltip title="生成任务清单">
                            <Button type="text" icon={<FileSearchOutlined />} onClick={() => handleGenerateTasks(asset)} />
                          </Tooltip>
                          <Button danger type="text" icon={<DeleteOutlined />} onClick={() => handleDelete(asset)} />
                        </Space>
                      </div>
                    </Card>
                  </List.Item>
                )}
              />
            )}
          </div>
        </TabPane>
        <TabPane tab={`结果 ${results.length}`} key="results">
          <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
            {results.length === 0 ? (
              <Empty description="暂无分析结果" />
            ) : (
              <List
                dataSource={results}
                renderItem={(result) => (
                  <List.Item>
                    <Card
                      size="small"
                      title={result.title}
                      extra={<Button size="small" icon={<DownloadOutlined />} onClick={() => exportResult(result)}>导出</Button>}
                      style={{ width: '100%' }}
                    >
                      {result.kind === 'requirement_tasks' ? (
                        <Table
                          size="small"
                          pagination={{ pageSize: 5 }}
                          dataSource={(result.data as RequirementTaskResult).tasks}
                          rowKey="id"
                          columns={[
                            { title: '模块', dataIndex: 'module', width: 70 },
                            { title: '任务', dataIndex: 'title' },
                            { title: '优先级', dataIndex: 'priority', width: 70 },
                          ]}
                        />
                      ) : (
                        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', fontSize: 12 }}>
                          {JSON.stringify(result.data, null, 2)}
                        </pre>
                      )}
                    </Card>
                  </List.Item>
                )}
              />
            )}
          </div>
        </TabPane>
      </Tabs>
      <Modal
        title={detail?.asset.title || '资料详情'}
        visible={Boolean(detail)}
        onCancel={() => setDetail(null)}
        width={760}
        footer={[
          <Button
            key="copy-ocr"
            icon={<CopyOutlined />}
            disabled={!detail?.content?.ocrText?.trim()}
            onClick={() => {
              if (!detail?.content?.ocrText) return;
              navigator.clipboard?.writeText(detail.content.ocrText);
              message.success('OCR 文本已复制');
            }}
          >
            复制 OCR
          </Button>,
          <Button key="close" type="primary" onClick={() => setDetail(null)}>关闭</Button>,
        ]}
      >
        {detail && (
          <Tabs defaultActiveKey={detail.content?.structuredOcr ? 'structuredOcr' : 'ocr'}>
            <TabPane tab="OCR 结构化" key="structuredOcr">
              {renderStructuredOcr(detail.content?.structuredOcr)}
            </TabPane>
            <TabPane tab="OCR 原文" key="ocr">
              {renderTextBlock(detail.content?.ocrText)}
            </TabPane>
            <TabPane tab="本地解析" key="local">
              {renderTextBlock(detail.content?.localText)}
            </TabPane>
            <TabPane tab="全文索引" key="text">
              {renderTextBlock(detail.content?.text)}
            </TabPane>
            <TabPane tab={`表格 ${detail.content?.tables?.length || 0}`} key="tables">
              {detail.content?.tables?.length ? (
                detail.content.tables.map((table, index) => (
                  <Card key={`${table.title || 'table'}_${index}`} size="small" title={table.title || `表格 ${index + 1}`} style={{ marginBottom: 12 }}>
                    <Table
                      size="small"
                      pagination={{ pageSize: 5 }}
                      columns={(table.headers || []).map((header, colIndex) => ({
                        title: header || `列 ${colIndex + 1}`,
                        dataIndex: String(colIndex),
                      }))}
                      dataSource={(table.rows || []).map((row, rowIndex) => ({
                        key: rowIndex,
                        ...row.reduce((acc, cell, colIndex) => ({ ...acc, [String(colIndex)]: cell }), {}),
                      }))}
                    />
                  </Card>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无表格" />
              )}
            </TabPane>
            <TabPane tab="元数据" key="metadata">
              <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', fontSize: 12 }}>
                {JSON.stringify({
                  asset: detail.asset,
                  metadata: detail.content?.metadata,
                }, null, 2)}
              </pre>
            </TabPane>
          </Tabs>
        )}
      </Modal>
    </div>
  );
};

export default DocumentCenter;
