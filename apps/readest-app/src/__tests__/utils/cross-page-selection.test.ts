import { describe, it, expect, beforeEach } from 'vitest';
import { getAutoScrollEdge, buildDirectedRange, type Rect } from '@/utils/sel';

describe('getAutoScrollEdge', () => {
  // top=100, bottom=700 (height 600), left=0, right=800 (width 800)
  const rect: Rect = { top: 100, bottom: 700, left: 0, right: 800 };

  describe('horizontal writing', () => {
    it('reports start near the top edge', () => {
      expect(getAutoScrollEdge({ x: 400, y: 120 }, rect)).toBe('start');
    });

    it('reports end near the bottom edge', () => {
      expect(getAutoScrollEdge({ x: 400, y: 690 }, rect)).toBe('end');
    });

    it('reports null in the middle', () => {
      expect(getAutoScrollEdge({ x: 400, y: 400 }, rect)).toBeNull();
    });

    it('reports null when the point is outside the horizontal bounds', () => {
      expect(getAutoScrollEdge({ x: 900, y: 120 }, rect)).toBeNull();
      expect(getAutoScrollEdge({ x: -10, y: 690 }, rect)).toBeNull();
    });

    it('honors a custom edge size', () => {
      expect(getAutoScrollEdge({ x: 400, y: 130 }, rect, { edgeSize: 20 })).toBeNull();
      expect(getAutoScrollEdge({ x: 400, y: 115 }, rect, { edgeSize: 20 })).toBe('start');
    });

    it('never reports both edges in a tiny viewport', () => {
      const tiny: Rect = { top: 0, bottom: 30, left: 0, right: 100 };
      expect(getAutoScrollEdge({ x: 50, y: 15 }, tiny)).toBeNull();
    });
  });

  describe('vertical writing', () => {
    it('vertical-rl maps the right edge to start and left edge to end', () => {
      expect(getAutoScrollEdge({ x: 770, y: 400 }, rect, { vertical: true, rtl: true })).toBe(
        'start',
      );
      expect(getAutoScrollEdge({ x: 20, y: 400 }, rect, { vertical: true, rtl: true })).toBe('end');
    });

    it('vertical-lr maps the left edge to start and right edge to end', () => {
      expect(getAutoScrollEdge({ x: 20, y: 400 }, rect, { vertical: true, rtl: false })).toBe(
        'start',
      );
      expect(getAutoScrollEdge({ x: 770, y: 400 }, rect, { vertical: true, rtl: false })).toBe(
        'end',
      );
    });

    it('reports null when outside the vertical bounds', () => {
      expect(getAutoScrollEdge({ x: 770, y: 800 }, rect, { vertical: true, rtl: true })).toBeNull();
    });
  });
});

describe('buildDirectedRange', () => {
  let first: Text;
  let second: Text;

  beforeEach(() => {
    document.body.innerHTML = '';
    const p = document.createElement('p');
    const a = document.createElement('span');
    const b = document.createElement('span');
    first = document.createTextNode('alpha beta gamma');
    second = document.createTextNode('delta epsilon zeta');
    a.appendChild(first);
    b.appendChild(second);
    p.appendChild(a);
    p.appendChild(b);
    document.body.appendChild(p);
  });

  it('builds a forward range within a single text node', () => {
    const range = buildDirectedRange(
      document,
      { node: first, offset: 0 },
      { node: first, offset: 5 },
    );
    expect(range).not.toBeNull();
    expect(range!.toString()).toBe('alpha');
  });

  it('normalizes order when the focus precedes the anchor', () => {
    const range = buildDirectedRange(
      document,
      { node: first, offset: 5 },
      { node: first, offset: 0 },
    );
    expect(range).not.toBeNull();
    expect(range!.startOffset).toBe(0);
    expect(range!.endOffset).toBe(5);
  });

  it('spans across two nodes (the cross-page case)', () => {
    const range = buildDirectedRange(
      document,
      { node: first, offset: 0 },
      { node: second, offset: 5 },
    );
    expect(range).not.toBeNull();
    expect(range!.startContainer).toBe(first);
    expect(range!.endContainer).toBe(second);
    expect(range!.toString()).toContain('alpha');
    expect(range!.toString()).toContain('delta');
  });

  it('normalizes order across two nodes when anchor is the later node', () => {
    const range = buildDirectedRange(
      document,
      { node: second, offset: 5 },
      { node: first, offset: 0 },
    );
    expect(range).not.toBeNull();
    expect(range!.startContainer).toBe(first);
    expect(range!.endContainer).toBe(second);
  });

  it('returns null for a collapsed range', () => {
    expect(
      buildDirectedRange(document, { node: first, offset: 3 }, { node: first, offset: 3 }),
    ).toBeNull();
  });
});
