import { describe, expect, it } from 'vitest';
import { evaluateOcrQuality, getOcrErrorMessage, getPaddleOcrRuntimeOptions, paddleResultToPage } from './ocrEngine';

describe('ocrEngine', () => {
  it('uses extension-local PaddleOCR models and ORT assets', () => {
    const options = getPaddleOcrRuntimeOptions();

    expect(options.worker).toBe(false);
    expect(options.sandboxUrl).toContain('paddleocrSandbox.html');
    expect(options.textDetectionModelAsset.url).toContain('paddleocr/models/PP-OCRv5_mobile_det.tar');
    expect(options.textRecognitionModelAsset.url).toContain('paddleocr/models/PP-OCRv5_mobile_rec.tar');
    expect(options.ortOptions.wasmPaths).toContain('paddleocr/ort/');
  });

  it('normalizes non-Error OCR failures', () => {
    expect(getOcrErrorMessage({ type: 'securitypolicyviolation' })).toContain('securitypolicyviolation');
    expect(getOcrErrorMessage(null)).toContain('PaddleOCR 初始化或识别失败');
  });

  it('explains PaddleOCR sandbox CSP failures', () => {
    const message = getOcrErrorMessage(new Error("Evaluating a string as JavaScript violates Content Security Policy directive because 'unsafe-eval' is not allowed"));

    expect(message).toContain('sandbox');
    expect(message).toContain('paddleocrSandbox.html');
  });

  it('sorts PaddleOCR lines by coordinates and averages confidence', () => {
    const page = paddleResultToPage({
      items: [
        { text: '第二行', score: 0.8, poly: [[10, 80], [80, 80], [80, 100], [10, 100]] },
        { text: '第一行右侧', score: 0.9, poly: [[120, 20], [220, 20], [220, 40], [120, 40]] },
        { text: '第一行左侧', score: 0.7, poly: [[10, 22], [100, 22], [100, 42], [10, 42]] },
      ],
    }, 1);

    expect(page.text).toBe('第一行左侧\n第一行右侧\n第二行');
    expect(page.confidence).toBeCloseTo(80);
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
