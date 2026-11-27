import { describe, expect, it } from 'vitest';
import { sanitizeEChartsOption, sanitizeSvgMarkup, sanitizeSvgMarkupTokenizer } from './streamRichSanitize.ts';

describe('sanitizeEChartsOption', () => {
  it('drops HTML formatters and forces tooltip richText at top level', () => {
    const { option } = sanitizeEChartsOption({
      tooltip: { trigger: 'axis', formatter: '<img src=x onerror=alert(1)>', extraCssText: 'x', appendToBody: true },
      series: [{ type: 'bar', data: [1, 2] }],
    });
    const tip = option.tooltip as Record<string, unknown>;
    expect(tip.renderMode).toBe('richText');
    expect(tip.trigger).toBe('axis');
    expect(tip).not.toHaveProperty('formatter');
    expect(tip).not.toHaveProperty('extraCssText');
    expect(tip).not.toHaveProperty('appendToBody');
  });

  it('adds an explicit richText tooltip when the model gave none', () => {
    expect(sanitizeEChartsOption({ series: [] }).option.tooltip).toEqual({ renderMode: 'richText' });
  });

  it('sanitizes nested series[].tooltip and axis-level tooltips', () => {
    const { option } = sanitizeEChartsOption({
      series: [{ type: 'line', data: [1], tooltip: { formatter: '<b>x</b>', valueFormatter: 'v' } }],
      xAxis: { type: 'category', tooltip: { show: true, formatter: 'y' } },
    });
    const s0 = (option.series as Array<Record<string, any>>)[0];
    expect(s0.tooltip.renderMode).toBe('richText');
    expect(s0.tooltip).not.toHaveProperty('formatter');
    expect(s0.tooltip).not.toHaveProperty('valueFormatter');
    const xt = (option.xAxis as Record<string, any>).tooltip;
    expect(xt.renderMode).toBe('richText');
    expect(xt).not.toHaveProperty('formatter');
  });

  it('removes javascript: links, dangerous keys, function values and data:text/html', () => {
    const { option } = sanitizeEChartsOption({
      title: { text: 'T', link: 'javascript:alert(1)', sublink: 'https://x', target: 'blank' },
      toolbox: { feature: { saveAsImage: {} } },
      graphic: [{ type: 'image', style: { image: 'https://evil/x.png' } }],
      legend: { data: ['JavaScript'] },
      series: [{ type: 'pie', name: 'data:text/html,<script>', data: [{ name: 'ok', value: 1, cb: () => 1 }] }],
    });
    const title = option.title as Record<string, unknown>;
    expect(title.text).toBe('T');
    expect(title).not.toHaveProperty('link');
    expect(title).not.toHaveProperty('sublink');
    expect(option).not.toHaveProperty('toolbox');
    expect(option).not.toHaveProperty('graphic');
    expect((option.legend as any).data).toEqual(['JavaScript']);
    const s0 = (option.series as Array<Record<string, any>>)[0];
    expect(s0).not.toHaveProperty('name');
    expect(s0.data[0]).toEqual({ name: 'ok', value: 1 });
  });

  it('forces richText on every item of a tooltip array and drops remote image:// symbols', () => {
    const { option } = sanitizeEChartsOption({
      tooltip: [{ trigger: 'axis', formatter: '<b>x</b>' }, { trigger: 'item' }],
      series: [{ type: 'scatter', symbol: 'image://https://evil.test/p.png', data: [[1, 2]] }],
    });
    const tips = option.tooltip as Array<Record<string, unknown>>;
    expect(tips.map((t) => t.renderMode)).toEqual(['richText', 'richText']);
    expect(tips[0]).not.toHaveProperty('formatter');
    expect((option.series as any[])[0]).not.toHaveProperty('symbol');
    expect(sanitizeEChartsOption({ tooltip: true } as any).option.tooltip).toEqual({ renderMode: 'richText' });
  });

  it('does not loop forever on circular references', () => {
    const raw: Record<string, unknown> = { series: [{ type: 'bar', data: [1] }] };
    raw.self = raw;
    (raw.series as any[])[0].parent = raw;
    const { option } = sanitizeEChartsOption(raw);
    expect(option).not.toHaveProperty('self');
    expect((option.series as any[])[0].data).toEqual([1]);
  });

  it('truncates oversized series data and reports it', () => {
    const data = Array.from({ length: 6000 }, (_, i) => i);
    const res = sanitizeEChartsOption({ series: [{ type: 'line', data }] });
    expect((res.option.series as any[])[0].data).toHaveLength(5000);
    expect(res.truncated).toBe(true);
    expect(sanitizeEChartsOption({ series: [{ type: 'line', data: [1, 2] }] }).truncated).toBe(false);
  });
});

describe('sanitizeSvgMarkup (tokenizer path in Node)', () => {
  it('strips script, event handlers, javascript: href and external @import', () => {
    const raw = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <style>@import url('https://fonts.googleapis.com/css2?family=Inter'); text { font-family: Inter; fill: url(https://evil/x); }</style>
      <script>alert(1)</script>
      <foreignObject><iframe src="x"></iframe></foreignObject>
      <a href="javascript:alert(1)"><text onclick="x()">hi</text></a>
      <a xlink:href="https://evil.test/"><text>ext</text></a>
      <animate attributeName="x"/>
      <rect width="1" height="1"/>
    </svg>`;
    const out = sanitizeSvgMarkup(raw, 'p1');
    expect(out).toContain('<svg');
    expect(out).toContain('<rect');
    expect(out).toContain('hi');
    expect(out).not.toMatch(/script|foreignObject|iframe|animate|onload|onclick|javascript:|evil|@import|googleapis/i);
    expect(out).toContain('font-family: Inter');
  });

  it('decodes entity-obfuscated javascript: before rejecting', () => {
    const out = sanitizeSvgMarkup('<svg><a href="jav&#x61;script:alert(1)"><text>x</text></a></svg>', 'p');
    expect(out).not.toMatch(/javascript|href/i);
  });

  it('drops unknown elements with their subtree and keeps allowed siblings', () => {
    const out = sanitizeSvgMarkup('<svg><div><g><rect id="r"/></g></div><circle r="2"/></svg>', 'p');
    expect(out).not.toContain('<div');
    expect(out).not.toContain('<rect');
    expect(out).toContain('<circle');
  });

  it('prefixes ids and rewrites url(#), href, aria refs and style selectors consistently', () => {
    const raw = `<svg id="mermaid-1" aria-labelledby="t1">
      <style>#mermaid-1 .node { fill: url(#grad); } .a{stroke:#fff}</style>
      <title id="t1">t</title>
      <defs><marker id="arrowhead"><path d="M0 0"/></marker><linearGradient id="grad"/></defs>
      <path d="M0 0L1 1" marker-end="url(#arrowhead)"/>
      <use href="#arrowhead"/><use xlink:href="#grad"/>
    </svg>`;
    const a = sanitizeSvgMarkup(raw, 'card');
    const b = sanitizeSvgMarkup(raw, 'box');
    expect(a).toContain('id="card-arrowhead"');
    expect(a).toContain('marker-end="url(#card-arrowhead)"');
    expect(a).toContain('href="#card-arrowhead"');
    expect(a).toContain('xlink:href="#card-grad"');
    expect(a).toContain('aria-labelledby="card-t1"');
    expect(a).toContain('#card-mermaid-1 .node');
    expect(a).toContain('url(#card-grad)');
    expect(a).toContain('stroke:#fff');
    expect(a).not.toMatch(/id="arrowhead"/);
    expect(b).toContain('id="box-arrowhead"');
    expect(b).toContain('marker-end="url(#box-arrowhead)"');
    // The two instances share no ids, so they cannot clash on one page.
    const idsOf = (s: string) => new Set([...s.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const ia = idsOf(a);
    for (const id of idsOf(b)) expect(ia.has(id)).toBe(false);
  });

  it('exposes the DOM-free path explicitly and returns empty for non-svg input', () => {
    expect(sanitizeSvgMarkupTokenizer('<svg><rect/></svg>', 'x')).toContain('<rect/>');
    expect(sanitizeSvgMarkup('<div>nope</div>', 'x')).toBe('');
    expect(sanitizeSvgMarkup('', 'x')).toBe('');
  });
});
