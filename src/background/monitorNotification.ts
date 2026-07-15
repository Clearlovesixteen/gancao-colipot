import type { AutomationRun, PageMonitorMetadata, PageMonitorSnapshot } from '../shared/automationTypes';

const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z3XkAAAAASUVORK5CYII=';

export interface MonitorNotificationInput {
  run: AutomationRun;
  monitor: PageMonitorMetadata;
  snapshot: PageMonitorSnapshot;
  summary: string;
  diffPreview?: string;
}

function validateWebhookUrl(value?: string): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('通知 Webhook 仅支持 HTTP/HTTPS 地址');
  return url.toString();
}

async function postJson(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Webhook 请求失败（HTTP ${response.status}）`);
}

export function buildMonitorNotificationText(input: MonitorNotificationInput): string {
  return [
    `监控任务：${input.run.title}`,
    input.summary,
    input.diffPreview ? `变化摘要：${input.diffPreview.slice(0, 500)}` : '',
    `页面：${input.snapshot.title || input.snapshot.url}`,
    input.snapshot.url,
  ].filter(Boolean).join('\n');
}

export async function sendMonitorNotifications(input: MonitorNotificationInput): Promise<string[]> {
  const config = input.monitor.notifications || { extension: true };
  const text = buildMonitorNotificationText(input);
  const results: string[] = [];

  if (config.extension !== false && chrome.notifications?.create) {
    await chrome.notifications.create(`page-monitor:${input.run.id}:${input.snapshot.hash}`, {
      type: 'basic',
      iconUrl: ICON_DATA_URL,
      title: `页面监控：${input.run.title}`,
      message: input.summary.slice(0, 220),
      contextMessage: input.snapshot.title || input.snapshot.url,
    });
    results.push('extension');
  }

  const feishu = validateWebhookUrl(config.feishuWebhook);
  if (feishu) {
    await postJson(feishu, { msg_type: 'text', content: { text } });
    results.push('feishu');
  }
  const dingtalk = validateWebhookUrl(config.dingtalkWebhook);
  if (dingtalk) {
    await postJson(dingtalk, { msgtype: 'text', text: { content: text } });
    results.push('dingtalk');
  }
  const webhook = validateWebhookUrl(config.webhook);
  if (webhook) {
    await postJson(webhook, {
      event: 'page_monitor.changed',
      runId: input.run.id,
      title: input.run.title,
      summary: input.summary,
      diffPreview: input.diffPreview,
      snapshot: input.snapshot,
    });
    results.push('webhook');
  }
  return results;
}
