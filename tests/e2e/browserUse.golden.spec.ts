import { expect, test } from '@playwright/test';
import { BROWSER_USE_GOLDEN_TASKS, type BrowserUseGoldenTask } from './browserUseGoldenTasks';
import {
  attachHarnessFailure,
  closeExtensionHarness,
  launchExtension,
  runComputerUse,
  type ExtensionHarness,
} from './extensionHarness';

const enabled = process.env.RUN_BROWSER_USE_GOLDEN === '1';
const repeatCount = Math.max(1, Math.min(10, Number(process.env.BROWSER_USE_GOLDEN_REPEAT || 1)));

function collectQualityReports(trace: any): any[] {
  const reports: any[] = [];
  for (const entry of trace?.entries || []) {
    for (const observation of [entry.observation, entry.beforeObservation, entry.afterObservation]) {
      if (observation?.qualityReport) reports.push(observation.qualityReport);
    }
  }
  return reports;
}

async function applySetup(harness: ExtensionHarness, task: BrowserUseGoldenTask): Promise<void> {
  if (task.setup === 'open_file_center') {
    await harness.fixturePage.locator('#file-center-link').click();
  }
}

async function assertBusinessOutcome(harness: ExtensionHarness, task: BrowserUseGoldenTask, trace: any): Promise<void> {
  if (task.assertion === 'correct_parent_export') {
    await expect(harness.fixturePage.locator('#route-label')).toHaveText('饮片管理 / 库存预警');
    expect(JSON.stringify(trace)).not.toContain('颗粒剂管理-库存预警.xlsx');
    return;
  }
  if (task.assertion === 'first_row_download') {
    await expect(harness.fixturePage.locator('#subsystem')).toHaveValue('智慧药房WMS仓储');
    await expect(harness.fixturePage.locator('#user-alias')).toHaveValue('秋枫');
    const finalRunState = [...(trace.entries || [])].reverse().find((entry: any) => entry.runState)?.runState;
    const downloadUrl = finalRunState?.downloadResult?.finalUrl || finalRunState?.downloadResult?.url || '';
    expect(decodeURIComponent(downloadUrl)).toContain('库存预警-秋枫-001.xlsx');
    expect(decodeURIComponent(downloadUrl)).not.toContain('库存预警-秋枫-002.xlsx');
    return;
  }
  if (task.assertion === 'download_file_center_roundtrip') {
    await expect(harness.fixturePage.locator('#opened-file-name')).toHaveText('饮片管理-库存预警.xlsx');
    const finalRunState = [...(trace.entries || [])].reverse().find((entry: any) => entry.runState)?.runState;
    expect(finalRunState?.downloadResult?.filename).toBe('饮片管理-库存预警.xlsx');
    expect(finalRunState?.completedPhases.map((item: any) => item.phase.type)).toEqual([
      'navigate_to_page',
      'download_file',
      'open_page_or_center',
      'wait',
      'click_latest_download',
    ]);
    return;
  }
  expect(JSON.stringify(trace)).toMatch(/未找到|导出|下载/);
}

test.describe('Browser Use golden task gate', () => {
  test.skip(!enabled, 'Set RUN_BROWSER_USE_GOLDEN=1 to run the repeatability gate.');

  for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
    for (const task of BROWSER_USE_GOLDEN_TASKS) {
      test(`[${repeat}/${repeatCount}] ${task.title}`, async ({}, testInfo) => {
        const harness = await launchExtension(task.fixturePath);
        let trace: any;
        try {
          await applySetup(harness, task);
          trace = await runComputerUse(harness, task.goal, task.maxSteps);
          expect(trace.status).toBe(task.expectedStatus);

          const serialized = JSON.stringify(trace);
          for (const phaseType of task.expectedPhaseTypes) expect(serialized).toContain(phaseType);
          const reports = collectQualityReports(trace);
          expect(reports.length, 'Every golden task must retain at least one Observe quality report.').toBeGreaterThan(0);
          const observedCollectionTypes = new Set(reports.flatMap((report) => (
            (report.collections || []).map((collection: any) => collection.type)
          )));
          for (const collectionType of task.expectedCollectionTypes) {
            expect(observedCollectionTypes.has(collectionType), `Missing semantic collection: ${collectionType}`).toBe(true);
          }
          await assertBusinessOutcome(harness, task, trace);

          await testInfo.attach('browser-use-golden-result.json', {
            body: JSON.stringify({
              taskId: task.id,
              repeat,
              status: trace.status,
              qualityScores: reports.map((report) => report.score),
              issueCodes: Array.from(new Set(reports.flatMap((report) => report.issues?.map((issue: any) => issue.code) || []))),
            }, null, 2),
            contentType: 'application/json',
          });
        } finally {
          await attachHarnessFailure(harness, testInfo);
          await closeExtensionHarness(harness);
        }
      });
    }
  }
});
