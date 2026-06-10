import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  chunkArray,
  csvCell,
  filterSignature,
  isPathExcluded,
  mapUpnToDomain,
  nextChunkRange,
  parseMappingCsv,
  timingSafeEqual,
  toCsv,
  UPLOAD_CHUNK_SIZE,
} from '../src/util';

describe('mapUpnToDomain', () => {
  it('swaps the domain suffix', () => {
    expect(mapUpnToDomain('ada@contoso.com', 'fabrikam.com')).toBe('ada@fabrikam.com');
    expect(mapUpnToDomain('ada@contoso.com', '@fabrikam.com')).toBe('ada@fabrikam.com');
  });
});

describe('parseMappingCsv', () => {
  it('parses rows, skips header, lowercases, reports bad lines', () => {
    const { rows, errors } = parseMappingCsv(
      'SourceUPN,DestUPN\r\nAda@Contoso.com, ada@fabrikam.com\n\nnot-an-upn,also-bad\n"bob@contoso.com","bob@fabrikam.com"'
    );
    expect(rows).toEqual([
      { sourceUpn: 'ada@contoso.com', destUpn: 'ada@fabrikam.com' },
      { sourceUpn: 'bob@contoso.com', destUpn: 'bob@fabrikam.com' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('line 4');
  });
});

describe('csv output', () => {
  it('escapes cells containing quotes, commas and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    const csv = toCsv(['a', 'b'], [[1, 'x,y']]);
    expect(csv).toBe('a,b\r\n1,"x,y"\r\n');
  });
});

describe('nextChunkRange', () => {
  it('is aligned to a 320 KiB multiple', () => {
    expect(UPLOAD_CHUNK_SIZE % (320 * 1024)).toBe(0);
  });
  it('walks a file in order and terminates', () => {
    const total = UPLOAD_CHUNK_SIZE * 2 + 5;
    const first = nextChunkRange(0, total)!;
    expect(first).toEqual({ start: 0, end: UPLOAD_CHUNK_SIZE - 1, length: UPLOAD_CHUNK_SIZE });
    const last = nextChunkRange(UPLOAD_CHUNK_SIZE * 2, total)!;
    expect(last).toEqual({ start: UPLOAD_CHUNK_SIZE * 2, end: total - 1, length: 5 });
    expect(nextChunkRange(total, total)).toBeNull();
  });
});

describe('filterSignature', () => {
  it('distinguishes filtered passes so delta cursors do not collide', () => {
    expect(filterSignature({})).toBe('all');
    expect(filterSignature({ mailReceivedBefore: '2024-01-01T00:00:00Z' })).not.toBe('all');
    expect(filterSignature({ mailReceivedBefore: '2024-01-01T00:00:00Z' })).toBe(
      filterSignature({ mailReceivedBefore: '2024-01-01T00:00:00Z' })
    );
  });
});

describe('isPathExcluded', () => {
  it('matches exact paths and subtrees case-insensitively', () => {
    expect(isPathExcluded('Inbox/Newsletters', ['inbox/newsletters'])).toBe(true);
    expect(isPathExcluded('Inbox/Newsletters/2023', ['Inbox/Newsletters'])).toBe(true);
    expect(isPathExcluded('Inbox/News', ['Inbox/Newsletters'])).toBe(false);
    expect(isPathExcluded('Inbox', undefined)).toBe(false);
  });
});

describe('chunkArray', () => {
  it('splits into fixed-size chunks', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 2)).toEqual([]);
  });
});

describe('timingSafeEqual', () => {
  it('compares strings correctly', () => {
    expect(timingSafeEqual('secret', 'secret')).toBe(true);
    expect(timingSafeEqual('secret', 'secreT')).toBe(false);
    expect(timingSafeEqual('secret', 'longer-secret')).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows with attempts and stays within the cap', () => {
    for (let i = 0; i < 12; i++) {
      const v = backoffMs(i, 1000, 60_000);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(60_000);
    }
  });
});
