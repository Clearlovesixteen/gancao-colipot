import React from 'react';
import { Button, Collapse, Empty, Space, Tag, Timeline, Typography } from 'antd';
import {
  CopyOutlined,
  ReloadOutlined,
  StopOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { getLatestExtractedTablesFromSteps } from '../../../../shared/automation/computerUseResults';
import type { ComputerUseTaskTraceState } from '../types';
import {
  getBrowserUseActionLabel,
  getBrowserUseStateLabel,
  getBrowserUseStatusMeta,
  getLatestDownloadResult,
  summarizeBrowserUseEntry,
} from './browserUseTrace';
import styles from '../Chat.module.scss';

const { Text } = Typography;
const { Panel } = Collapse;

export interface BrowserUseTaskCardProps {
  trace?: ComputerUseTaskTraceState;
  active: boolean;
  onStop: () => void;
  onCopy: (trace: ComputerUseTaskTraceState) => void;
  onRetry: (trace: ComputerUseTaskTraceState) => void;
}

export const BrowserUseTaskCard: React.FC<BrowserUseTaskCardProps> = ({
  trace,
  active,
  onStop,
  onCopy,
  onRetry,
}) => {
  if (!trace) return null;
  const statusMeta = getBrowserUseStatusMeta(trace.status);
  const tableSummary = getLatestExtractedTablesFromSteps(trace.steps || []);
  const downloadResult = getLatestDownloadResult(trace.steps || []);
  const lastEntry = trace.entries[trace.entries.length - 1];
  const lastObservation = trace.lastObservation || lastEntry?.observation;
  const lastActionEntry = [...trace.entries].reverse().find((entry) => entry.action);
  const lastVerificationEntry = [...trace.entries].reverse().find((entry) => entry.verification);
  const navigationPath = [...trace.entries].reverse().find((entry) => entry.navigationPath?.length)?.navigationPath;
  const lastChosenElement = lastActionEntry?.chosenElement;
  const emptyFinished = trace.status === 'finished' && (!trace.entries.length || !trace.steps?.length) && !tableSummary;

  return (
    <div className={styles.computerUseTask}>
      <div className={styles.computerUseHeader}>
        <Space size={6} wrap>
          <ToolOutlined />
          <Text strong>Browser Use 任务</Text>
          <Tag color={statusMeta.color}>{statusMeta.label}</Tag>
        </Space>
        <Space size={4} wrap>
          {active && (
            <Button size="small" danger icon={<StopOutlined />} onClick={onStop}>
              停止
            </Button>
          )}
          <Button size="small" icon={<CopyOutlined />} onClick={() => onCopy(trace)}>
            复制日志
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => onRetry(trace)}>
            重试
          </Button>
        </Space>
      </div>

      <div className={styles.computerUseGoal}>{trace.goal}</div>

      <div className={styles.computerUseSummary}>
        <Space size={[6, 6]} wrap>
          <Tag>{trace.currentStep || '准备中'}</Tag>
          {trace.summary && <Tag color="blue">{trace.summary}</Tag>}
          {typeof (lastEntry?.result as any)?.navigationCount === 'number' && (
            <Tag>导航 {(lastEntry?.result as any).navigationCount}</Tag>
          )}
          {typeof (lastEntry?.result as any)?.tableCount === 'number' && (
            <Tag>表格 {(lastEntry?.result as any).tableCount}</Tag>
          )}
          {navigationPath?.length && <Tag color="purple">路径 {navigationPath.join(' > ')}</Tag>}
        </Space>
        {trace.error && <div className={styles.computerUseError}>{trace.error}</div>}
        {emptyFinished && (
          <div className={styles.computerUseError}>未拿到实际执行步骤或可交付结果，请补充目标页面位置后重试。</div>
        )}
      </div>

      {lastObservation && (
        <div className={styles.computerUseMeta}>
          {lastObservation.title && <div>页面：{lastObservation.title}</div>}
          {lastObservation.url && <div>URL：{lastObservation.url}</div>}
          {lastActionEntry?.action && <div>最后动作：{getBrowserUseActionLabel(lastActionEntry.action)}</div>}
          {lastChosenElement && (
            <div>目标元素：{lastChosenElement.text || lastChosenElement.selector || lastChosenElement.elementId}</div>
          )}
          {lastVerificationEntry?.verification && (
            <div>
              校验：{lastVerificationEntry.verification.success ? '通过' : '失败'}
              {lastVerificationEntry.verification.reason ? `，${lastVerificationEntry.verification.reason}` : ''}
              {lastVerificationEntry.verification.warning ? `，${lastVerificationEntry.verification.warning}` : ''}
            </div>
          )}
        </div>
      )}

      {tableSummary && (
        <div className={styles.computerUseTablePreview}>
          <Text strong>已提取列表数据：{tableSummary.tableCount} 个表格，共 {tableSummary.rowCount} 行</Text>
          {tableSummary.tables.slice(0, 2).map((table, tableIndex) => (
            <div key={`${table.title || 'table'}_${tableIndex}`} className={styles.computerUseTableBlock}>
              <div className={styles.computerUseTableTitle}>
                {table.title || `表格 ${tableIndex + 1}`}（{table.rowCount || table.rows.length} 行，{table.columnCount || table.headers.length} 列）
              </div>
              {!!table.headers.length && (
                <div className={styles.computerUseTableFields}>字段：{table.headers.slice(0, 8).join('、')}</div>
              )}
              {table.rows.slice(0, 3).map((row, rowIndex) => (
                <div key={rowIndex} className={styles.computerUseTableRow}>
                  {row.slice(0, 6).join(' | ')}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {downloadResult && (
        <div className={styles.computerUseTablePreview}>
          <Text strong>{downloadResult.savedToDocumentCenter ? '已保存导出文件' : '已触发下载'}</Text>
          <div className={styles.computerUseTableBlock}>
            <div className={styles.computerUseTableTitle}>
              文件：{downloadResult.filename || downloadResult.assetTitle || '下载文件'}
            </div>
            <div className={styles.computerUseTableFields}>
              {downloadResult.size ? `大小：${downloadResult.size} bytes` : '大小：未知'}
              {downloadResult.mimeType ? `，类型：${downloadResult.mimeType}` : ''}
            </div>
            {downloadResult.assetId && <div className={styles.computerUseTableRow}>资料 ID：{downloadResult.assetId}</div>}
            {downloadResult.localParseStatus && (
              <div className={styles.computerUseTableRow}>解析状态：{downloadResult.localParseStatus}</div>
            )}
            {downloadResult.needsManualImport && (
              <div className={styles.computerUseError}>已下载，但浏览器限制导致无法自动读取文件内容，请从下载目录手动添加。</div>
            )}
          </div>
        </div>
      )}

      <Collapse ghost className={styles.computerUseCollapse}>
        <Panel header={`执行日志（${trace.entries.length}）`} key="trace">
          {trace.entries.length ? (
            <Timeline className={styles.computerUseTimeline}>
              {trace.entries.map((entry, entryIndex) => (
                <Timeline.Item
                  key={`${entry.timestamp}_${entryIndex}`}
                  color={entry.error ? 'red' : entry.state === 'done' ? 'green' : entry.state === 'waiting_confirmation' ? 'orange' : 'blue'}
                >
                  <div className={styles.traceEntryTitle}>{getBrowserUseStateLabel(entry.state)}</div>
                  <div className={styles.traceEntryText}>{summarizeBrowserUseEntry(entry)}</div>
                  {(entry.observation?.title || entry.observation?.url) && (
                    <div className={styles.traceEntryMeta}>{entry.observation?.title || entry.observation?.url}</div>
                  )}
                </Timeline.Item>
              ))}
            </Timeline>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无执行日志" />
          )}
        </Panel>
      </Collapse>
    </div>
  );
};
