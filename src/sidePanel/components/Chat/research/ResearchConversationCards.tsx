import React from 'react';
import { Button, Collapse, List, Space, Tag, Tooltip, Typography } from 'antd';
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  LoadingOutlined,
} from '@ant-design/icons';
import type { ChatSession } from '../../../../shared/memory/userMemoryStore';
import type { ChatMessage } from '../types';
import type { TopicSourceItem } from '../hooks/useResearchConversation';
import styles from '../Chat.module.scss';

const { Text } = Typography;
const { Panel } = Collapse;

function sourceSite(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '未知站点';
  }
}

export function ResearchUpgradeCard(props: {
  message: ChatMessage;
  loading?: boolean;
  onConfirm: (message: ChatMessage) => void;
}) {
  const upgrade = props.message.researchUpgrade;
  if (!upgrade) return null;
  return (
    <div className={styles.researchUpgradeCard}>
      <div className={styles.researchUpgradeTitle}>
        <ExperimentOutlined />
        <span>升级为专题研究</span>
      </div>
      <div className={styles.researchUpgradeSection}>
        <Text type="secondary">专题名称</Text>
        <Text strong>{upgrade.title}</Text>
        <Text type="secondary">核心问题</Text>
        <Text>{upgrade.coreQuestion}</Text>
      </div>
      <Text className={styles.researchUpgradeReason}>{upgrade.reason}</Text>
      {upgrade.missingInformation.length > 0 && (
        <div className={styles.researchUpgradeSection}>
          <Text type="secondary">当前页面还缺：</Text>
          <div className={styles.researchTagList}>
            {upgrade.missingInformation.slice(0, 3).map((item) => (
              <Tag key={item}>{item}</Tag>
            ))}
          </div>
        </div>
      )}
      {upgrade.suggestedDirections.length > 0 && (
        <div className={styles.researchUpgradeSection}>
          <Text type="secondary">建议补充：</Text>
          <ul>
            {upgrade.suggestedDirections.slice(0, 3).map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      <Button
        type="primary"
        size="small"
        icon={props.loading ? <LoadingOutlined /> : <ExperimentOutlined />}
        loading={props.loading}
        onClick={() => props.onConfirm(props.message)}
      >
        确认升级并加入当前页
      </Button>
    </div>
  );
}

export function TopicSessionHeader(props: {
  session: ChatSession;
  sources: TopicSourceItem[];
  loading?: boolean;
  onExit: () => void;
  onLocate: (source: TopicSourceItem) => void;
  onRemove: (documentId: string) => void;
}) {
  const status = props.session.researchStatus === 'ready'
    ? { color: 'green', text: '可追问' }
    : props.session.researchStatus === 'partial'
      ? { color: 'orange', text: '来源不足' }
      : { color: 'blue', text: '收集中' };
  return (
    <div className={styles.topicSessionHeader}>
      <div className={styles.topicHeaderMain}>
        <div className={styles.topicHeaderText}>
          <div className={styles.topicHeaderTitle}>
            <ExperimentOutlined />
            <span>{props.session.title || '专题研究'}</span>
          </div>
          <Text type="secondary" ellipsis={{ tooltip: props.session.coreQuestion }}>
            {props.session.coreQuestion || '围绕已加入来源继续追问'}
          </Text>
        </div>
        <Space size={4}>
          <Tag color={status.color}>{status.text}</Tag>
          <Tooltip title="退出专题模式，资料原件会保留">
            <Button
              type="text"
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={props.onExit}
            />
          </Tooltip>
        </Space>
      </div>
      <Collapse
        ghost
        className={styles.topicSourcesCollapse}
      >
        <Panel header={`来源 ${props.sources.length}`} key="sources">
          {props.sources.length ? (
            <List
              size="small"
              dataSource={props.sources}
              renderItem={(source) => (
                <List.Item
                  className={styles.topicSourceItem}
                  actions={[
                    <Tooltip title="定位来源" key="locate">
                      <Button
                        type="text"
                        size="small"
                        icon={<EnvironmentOutlined />}
                        disabled={!source.url}
                        onClick={() => props.onLocate(source)}
                      />
                    </Tooltip>,
                    <Tooltip title="移出本专题，不删除资料原件" key="remove">
                      <Button
                        type="text"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => props.onRemove(source.documentId)}
                      />
                    </Tooltip>,
                  ]}
                >
                  <List.Item.Meta
                    title={<Text ellipsis={{ tooltip: source.title }}>{source.title}</Text>}
                    description={[
                      sourceSite(source.url),
                      source.selection ? '网页选区' : '当前网页',
                      new Date(source.addedAt).toLocaleString(),
                    ].join(' · ')}
                  />
                </List.Item>
              )}
            />
          ) : (
            <Text type="secondary">
              {props.loading ? '正在加入当前页面...' : '暂无来源，请在网页中选中文字后点击“加入专题”。'}
            </Text>
          )}
        </Panel>
      </Collapse>
    </div>
  );
}

export function TopicSourceAddedMessage(props: {
  message: ChatMessage;
  onLocate: (source: TopicSourceItem) => void;
}) {
  const source = props.message.topicSource;
  if (!source) return null;
  return (
    <div className={styles.topicSourceAdded}>
      <ExperimentOutlined />
      <div>
        <Text strong>已加入专题来源</Text>
        <Text type="secondary" ellipsis={{ tooltip: source.title }}>{source.title}</Text>
      </div>
      <Button
        type="link"
        size="small"
        disabled={!source.url}
        onClick={() => props.onLocate({
          documentId: source.documentId,
          title: source.title,
          url: source.url,
          addedAt: props.message.timestamp,
          selection: Boolean(props.message.pageContext),
        })}
      >
        查看
      </Button>
    </div>
  );
}
