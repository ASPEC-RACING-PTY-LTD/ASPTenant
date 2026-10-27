// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { dateGroup, htmlToText, initials, sanitiseHtml, splitAddresses } from './format.js';

describe('mail formatting', () => {
  it('keeps simple formatting and strips anything that could run in the page', () => {
    const clean = sanitiseHtml(
      [
        '<p onclick="steal()">Hi <b>there</b></p>',
        '<script>alert(1)</script>',
        '<img src="x" onerror="alert(1)">',
        '<a href="javascript:alert(1)">bad</a>',
        '<a href="https://example.com">good</a>',
        '<iframe src="https://example.com"></iframe>',
        '<span style="color:red;background:url(https://x.test/a.png)">styled</span>',
        '<custom-tag>kept text</custom-tag>',
      ].join(''),
    );
    expect(clean).toContain('<p>Hi <b>there</b></p>');
    expect(clean).not.toMatch(/script|onerror|onclick|<img|<iframe|javascript:|url\(/i);
    expect(clean).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">good</a>',
    );
    expect(clean).toContain('<a target="_blank" rel="noopener noreferrer">bad</a>');
    expect(clean).toContain('<span>styled</span>');
    expect(clean).toContain('kept text');
  });

  it('turns composed HTML into the plain text part', () => {
    expect(htmlToText('<p>One</p><p>Two<br>Three</p><a href="https://a.test">link</a>')).toBe(
      'One\nTwo\nThree\nlink (https://a.test)',
    );
  });

  it('groups the list like Outlook', () => {
    const now = new Date(2026, 9, 28, 15, 0); // Wednesday
    expect(dateGroup(new Date(2026, 9, 28, 9, 0).getTime(), now)).toBe('Today');
    expect(dateGroup(new Date(2026, 9, 27, 23, 0).getTime(), now)).toBe('Yesterday');
    expect(dateGroup(new Date(2026, 9, 26, 8, 0).getTime(), now)).toBe('This week');
    expect(dateGroup(new Date(2026, 9, 20, 8, 0).getTime(), now)).toBe('Last week');
  });

  it('reads recipients and initials', () => {
    expect(splitAddresses('Ann <ann@a.test>; bob@b.test, ')).toEqual(['ann@a.test', 'bob@b.test']);
    expect(initials({ name: 'Priya Shah', address: 'priya@a.test' })).toBe('PS');
    expect(initials({ name: null, address: 'ops@a.test' })).toBe('OA');
  });
});
