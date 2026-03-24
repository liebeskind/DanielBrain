import { describe, it, expect } from 'vitest';
import { extractUrls } from '../../src/hubspot/format.js';

describe('extractUrls', () => {
  it('extracts URLs from <a href> tags', () => {
    const html = '<p>Check <a href="https://example.com/page">this page</a></p>';
    const urls = extractUrls(html);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe('https://example.com/page');
    expect(urls[0].anchor_text).toBe('this page');
    expect(urls[0].type).toBe('web_page');
    expect(urls[0].fetchable).toBe(true);
  });

  it('extracts bare URLs from text', () => {
    const html = '<p>Visit https://example.com/report for details.</p>';
    const urls = extractUrls(html);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe('https://example.com/report');
  });

  it('deduplicates URLs from href and bare text', () => {
    const html = '<a href="https://example.com">link</a> also see https://example.com';
    const urls = extractUrls(html);
    expect(urls).toHaveLength(1);
  });

  it('classifies Google Docs as fetchable', () => {
    const html = '<a href="https://docs.google.com/document/d/abc123/edit">doc</a>';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('google_doc');
    expect(urls[0].fetchable).toBe(true);
  });

  it('classifies Google Drive as non-fetchable', () => {
    const html = 'https://drive.google.com/file/d/abc/view';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('google_doc');
    expect(urls[0].fetchable).toBe(false);
  });

  it('classifies Notion as non-fetchable', () => {
    const html = 'https://notion.so/workspace/page-abc123';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('notion');
    expect(urls[0].fetchable).toBe(false);
  });

  it('classifies Otter.ai as fetchable', () => {
    const html = 'https://otter.ai/note/ABC123XYZ';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('otter');
    expect(urls[0].fetchable).toBe(true);
  });

  it('classifies Fathom as non-fetchable', () => {
    const html = 'https://fathom.video/calls/12345';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('fathom');
    expect(urls[0].fetchable).toBe(false);
  });

  it('classifies YouTube as non-fetchable', () => {
    const html = 'https://youtube.com/watch?v=abc123';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('video');
    expect(urls[0].fetchable).toBe(false);
  });

  it('classifies Loom as non-fetchable', () => {
    const html = 'https://loom.com/share/abc123def';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('loom');
    expect(urls[0].fetchable).toBe(false);
  });

  it('classifies meeting links as non-fetchable', () => {
    const html = 'https://meet.google.com/abc-defg-hij https://zoom.us/j/123456';
    const urls = extractUrls(html);
    expect(urls).toHaveLength(2);
    expect(urls[0].type).toBe('calendar');
    expect(urls[1].type).toBe('calendar');
  });

  it('classifies PDF links as fetchable', () => {
    const html = 'https://example.com/report.pdf';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('pdf');
    expect(urls[0].fetchable).toBe(true);
  });

  it('classifies PDF with query params', () => {
    const html = 'https://example.com/doc.pdf?token=abc';
    const urls = extractUrls(html);
    expect(urls[0].type).toBe('pdf');
  });

  it('filters HubSpot internal URLs', () => {
    const html = `
      <a href="https://app.hubspot.com/contacts/123">view</a>
      <a href="https://track.hubspot.com/click/123">track</a>
      <a href="https://example.com/real">real link</a>
    `;
    const urls = extractUrls(html);
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toContain('example.com');
  });

  it('filters unsubscribe/mailing list URLs', () => {
    const html = 'https://list-manage.com/unsubscribe https://mailchimp.com/track';
    const urls = extractUrls(html);
    expect(urls).toHaveLength(0);
  });

  it('strips trailing punctuation from bare URLs', () => {
    const html = 'Visit https://example.com/page, for more.';
    const urls = extractUrls(html);
    expect(urls[0].url).toBe('https://example.com/page');
  });

  it('handles multiple URLs in one note', () => {
    const html = `
      <p>See <a href="https://docs.google.com/document/d/abc/edit">the doc</a></p>
      <p>Recording: https://otter.ai/note/XYZ123</p>
      <p>Also https://example.com/meeting-notes</p>
    `;
    const urls = extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls.map((u) => u.type)).toEqual(['google_doc', 'otter', 'web_page']);
  });

  it('returns empty array for notes without URLs', () => {
    const html = '<p>Just a regular note with no links.</p>';
    expect(extractUrls(html)).toEqual([]);
  });

  it('handles empty/malformed HTML', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls('<broken')).toEqual([]);
  });

  it('ignores non-http URLs', () => {
    const html = '<a href="mailto:user@example.com">email</a> <a href="tel:+1234">call</a>';
    expect(extractUrls(html)).toEqual([]);
  });
});
