import { describe, expect, it } from 'vitest';
import { evaluateOcrQuality, getOcrErrorMessage, getOcrWorkerOptions } from './ocrEngine';

describe('ocrEngine', () => {
  it('uses extension-local worker instead of blob worker', () => {
    const options = getOcrWorkerOptions();

    expect(options.workerBlobURL).toBe(false);
    expect(options.workerPath).toContain('tesseract/worker.min.js');
    expect(options.corePath).toContain('tesseract/core');
    expect(options.langPath).toContain('tesseract/lang-data');
  });

  it('normalizes non-Error OCR failures', () => {
    expect(getOcrErrorMessage({ type: 'securitypolicyviolation' })).toContain('securitypolicyviolation');
    expect(getOcrErrorMessage(null)).toContain('OCR 初始化或识别失败');
  });

  it('marks low-confidence OCR as unreliable', () => {
    const quality = evaluateOcrQuality('机 杰 名 称 E 主区 E', 32);

    expect(quality.lowConfidence).toBe(true);
    expect(quality.likelyGarbled).toBe(true);
  });

  it('keeps high-confidence mixed Chinese text reliable', () => {
    const quality = evaluateOcrQuality('机构名称：甘草医生\n联系电话：13516099499', 88);

    expect(quality.lowConfidence).toBe(false);
    expect(quality.likelyGarbled).toBe(false);
  });
});
