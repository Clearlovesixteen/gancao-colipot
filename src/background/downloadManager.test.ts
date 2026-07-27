import { describe, expect, it } from 'vitest';
import { resolveDownloadFilename } from './downloadManager';

describe('resolveDownloadFilename', () => {
  it('uses the browser filename when it contains a meaningful extension', () => {
    expect(resolveDownloadFilename({
      filename: '/Downloads/report.xlsx',
      url: 'https://example.test/download/other.xlsx',
      finalUrl: 'https://example.test/download/other.xlsx',
    })).toBe('report.xlsx');
  });

  it('recovers the real filename from the final URL when Chrome exposes a temporary UUID', () => {
    expect(resolveDownloadFilename({
      filename: '/tmp/d8fec5bd-38d8-4461-a0dd-a29db2b0a11f',
      url: 'https://example.test/download/%E9%A5%AE%E7%89%87%E7%AE%A1%E7%90%86-%E5%BA%93%E5%AD%98%E9%A2%84%E8%AD%A6.xlsx',
      finalUrl: 'https://example.test/download/%E9%A5%AE%E7%89%87%E7%AE%A1%E7%90%86-%E5%BA%93%E5%AD%98%E9%A2%84%E8%AD%A6.xlsx',
    })).toBe('饮片管理-库存预警.xlsx');
  });

  it('falls back to the browser value when no source has a file extension', () => {
    expect(resolveDownloadFilename({
      filename: '/tmp/download-token',
      url: 'https://example.test/download?id=1',
      finalUrl: '',
    })).toBe('download-token');
  });
});
