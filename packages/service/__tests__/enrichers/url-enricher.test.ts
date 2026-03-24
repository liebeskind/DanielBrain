import { describe, it, expect, vi, beforeEach } from 'vitest';
import { htmlToText, findFetchableUrls, fetchAndConvert, markUrlProcessed, enrichUrlBatch, AuthRequiredError } from '../../src/enrichers/url-enricher.js';

vi.mock('../../src/logger.js', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../src/parsers/pdf.js', () => ({
  parsePdf: vi.fn().mockResolvedValue({ text: 'PDF content extracted', pageCount: 2 }),
}));

const mockPool = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('htmlToText', () => {
  it('strips script and style blocks', () => {
    const html = '<p>Hello</p><script>alert("x")</script><style>.a{}</style><p>World</p>';
    const text = htmlToText(html);
    expect(text).toContain('Hello');
    expect(text).toContain('World');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('.a{}');
  });

  it('converts block elements to newlines', () => {
    const html = '<p>Para 1</p><p>Para 2</p>';
    const text = htmlToText(html);
    expect(text).toContain('Para 1');
    expect(text).toContain('Para 2');
    expect(text.includes('\n')).toBe(true);
  });

  it('converts <br> to newlines', () => {
    const text = htmlToText('Line 1<br>Line 2<br/>Line 3');
    expect(text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('strips remaining HTML tags', () => {
    const text = htmlToText('<b>bold</b> <i>italic</i> <span>span</span>');
    expect(text).toBe('bold italic span');
  });

  it('decodes HTML entities', () => {
    const text = htmlToText('A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s');
    expect(text).toBe("A & B < C > D \"E\" F's");
  });

  it('collapses excessive whitespace', () => {
    const text = htmlToText('<p>  Too   many    spaces  </p>');
    expect(text).toBe('Too many spaces');
  });

  it('handles empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  it('removes nav and footer', () => {
    const html = '<nav>Navigation</nav><main>Content</main><footer>Footer</footer>';
    const text = htmlToText(html);
    expect(text).not.toContain('Navigation');
    expect(text).not.toContain('Footer');
    expect(text).toContain('Content');
  });
});

describe('findFetchableUrls', () => {
  it('finds thoughts with unprocessed fetchable URLs', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'thought-1',
        source_meta: {
          extracted_urls: [
            { url: 'https://example.com/page', type: 'web_page', fetchable: true },
            { url: 'https://notion.so/page', type: 'notion', fetchable: false },
          ],
        },
      }],
    });

    const candidates = await findFetchableUrls(mockPool as any, 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe('https://example.com/page');
    expect(candidates[0].urlIndex).toBe(0);
  });

  it('skips already-processed URLs', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'thought-1',
        source_meta: {
          extracted_urls: [
            { url: 'https://example.com/done', type: 'web_page', fetchable: true, processed: 'success' },
            { url: 'https://example.com/new', type: 'web_page', fetchable: true },
          ],
        },
      }],
    });

    const candidates = await findFetchableUrls(mockPool as any, 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe('https://example.com/new');
    expect(candidates[0].urlIndex).toBe(1);
  });

  it('respects batch size limit', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'thought-1',
        source_meta: {
          extracted_urls: [
            { url: 'https://example.com/1', type: 'web_page', fetchable: true },
            { url: 'https://example.com/2', type: 'web_page', fetchable: true },
            { url: 'https://example.com/3', type: 'web_page', fetchable: true },
          ],
        },
      }],
    });

    const candidates = await findFetchableUrls(mockPool as any, 2);
    expect(candidates).toHaveLength(2);
  });
});

describe('fetchAndConvert', () => {
  it('fetches and converts HTML to text', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/page',
      headers: new Map([['content-type', 'text/html']]),
      text: () => Promise.resolve('<html><body><p>Hello World</p></body></html>'),
    });

    const result = await fetchAndConvert('https://example.com/page', 'web_page');
    expect(result.text).toContain('Hello World');
    expect(result.contentType).toBe('text/html');
  });

  it('handles plain text responses', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://docs.google.com/document/d/abc/export',
      headers: new Map([['content-type', 'text/plain']]),
      text: () => Promise.resolve('Plain text document content'),
    });

    const result = await fetchAndConvert('https://docs.google.com/document/d/abc/edit', 'google_doc');
    expect(result.text).toBe('Plain text document content');

    // Verify Google Doc URL was rewritten
    const fetchCall = (global.fetch as any).mock.calls[0];
    expect(fetchCall[0]).toContain('/export?format=txt');
  });

  it('detects auth-walled responses (401/403)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      url: 'https://example.com/private',
      headers: new Map([['content-type', 'text/html']]),
    });

    await expect(fetchAndConvert('https://example.com/private', 'web_page'))
      .rejects.toThrow(AuthRequiredError);
  });

  it('throws on non-OK responses', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      url: 'https://example.com/broken',
      headers: new Map([['content-type', 'text/html']]),
    });

    await expect(fetchAndConvert('https://example.com/broken', 'web_page'))
      .rejects.toThrow('HTTP 500');
  });
});

describe('markUrlProcessed', () => {
  it('updates source_meta with processed status', async () => {
    mockPool.query.mockResolvedValueOnce({});

    await markUrlProcessed(mockPool as any, 'thought-1', 0, 'success');

    const call = mockPool.query.mock.calls[0];
    expect(call[0]).toContain('UPDATE thoughts');
    expect(call[0]).toContain('extracted_urls');
    expect(call[1]).toContain('thought-1');
    expect(call[1]).toContain('success');
  });

  it('includes details for auth_required status', async () => {
    mockPool.query.mockResolvedValueOnce({});

    await markUrlProcessed(mockPool as any, 'thought-1', 2, 'auth_required', 'HTTP 403');

    const call = mockPool.query.mock.calls[0];
    expect(call[1]).toContain('auth_required');
    expect(call[1]).toContain('HTTP 403');
  });
});

describe('enrichUrlBatch', () => {
  it('processes fetchable URLs end-to-end', async () => {
    // findFetchableUrls
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'thought-1',
        source_meta: {
          extracted_urls: [{ url: 'https://example.com/article', type: 'web_page', fetchable: true }],
          hubspotAssociations: { people: ['Alice'], companies: ['Acme'] },
        },
      }],
    });

    // Mock fetch
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://example.com/article',
      headers: new Map([['content-type', 'text/html']]),
      text: () => Promise.resolve('<html><body><p>Great article about partnerships with detailed insights about the deal.</p></body></html>'),
    });

    // enqueueUrlContent INSERT
    mockPool.query.mockResolvedValueOnce({ rowCount: 1 });
    // markUrlProcessed UPDATE
    mockPool.query.mockResolvedValueOnce({});

    const count = await enrichUrlBatch(mockPool as any);
    expect(count).toBe(1);

    // Verify enqueue call
    const insertCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('INSERT INTO queue'),
    );
    expect(insertCall).toBeDefined();
    const sourceMeta = JSON.parse(insertCall![1][3]);
    expect(sourceMeta.fetched_url).toBe('https://example.com/article');
    expect(sourceMeta.parent_thought_id).toBe('thought-1');
    expect(sourceMeta.hubspotAssociations.people).toEqual(['Alice']);
  });

  it('handles auth-required URLs gracefully', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{
        id: 'thought-1',
        source_meta: {
          extracted_urls: [{ url: 'https://docs.google.com/document/d/abc/edit', type: 'google_doc', fetchable: true }],
        },
      }],
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      url: 'https://docs.google.com/document/d/abc/export',
      headers: new Map([['content-type', 'text/html']]),
    });

    // markUrlProcessed UPDATE
    mockPool.query.mockResolvedValueOnce({});

    const count = await enrichUrlBatch(mockPool as any);
    expect(count).toBe(1);

    // Verify marked as auth_required
    const updateCall = mockPool.query.mock.calls.find(
      (c: any) => typeof c[0] === 'string' && c[0].includes('UPDATE thoughts'),
    );
    expect(updateCall![1]).toContain('auth_required');
  });

  it('returns 0 when no candidates', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });
    const count = await enrichUrlBatch(mockPool as any);
    expect(count).toBe(0);
  });
});
