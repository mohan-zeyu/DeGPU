import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderResultTable } from '../src/result-details.js';

test('classification renders the verified taxonomy name and preserves class zero', () => {
  const html = renderResultTable({ mode: 'replicated', closed: true }, [{ index: 0, value: 0 }, { index: 1, classId: 999 }]);
  assert.match(html, /tench（0）/);
  assert.match(html, /toilet tissue（999）/);
});

test('only missing checked outputs claim a refund after closing', () => {
  const row = [{ index: 0, value: null, found: false }];
  assert.match(renderResultTable({ mode: 'checked', closed: true }, row), /未找到 · 已退款/);
  assert.match(renderResultTable({ mode: 'checked', closed: false }, row), /未找到 · 待结算/);
  const image = renderResultTable({ mode: 'replicated', closed: true }, row);
  assert.match(image, /结果缺失或无法解码/);
  assert.doesNotMatch(image, /退款/);
});

test('disputed output clearly reflects each final verdict without replacing provider values', () => {
  const statuses = { MainOutvoted: '原始结果错误 · 提供方被否决', VerifierOutvoted: '结果有效 · 复核方被否决', BothOutvoted: '双方被否决 · 结果存疑', NoMajority: '未形成多数 · 结果存疑' };
  for (const [outcome, text] of Object.entries(statuses)) {
    const html = renderResultTable({ mode: 'replicated', closed: true, outcome }, [{ value: 0, mismatched: true }]);
    assert.ok(html.includes(text));
    assert.match(html, /tench（0）/);
  }
  assert.match(renderResultTable({ chainOutcome: 'main_outvoted', closed: true }, [{ value: 1, disputed: true }]), /原始结果错误/);
});

test('rendered files link real previews and downloads while escaping names and refusing active URLs', () => {
  const html = renderResultTable({ compare: 'similar', closed: true }, [
    { frame: 12, filename: 'frame-12.png', previewUrl: '/api/jobs/replicated:1/results/0', downloadUrl: '/api/jobs/replicated:1/results/0' },
    { index: 1, filename: '<script>.png', previewUrl: 'javascript:alert(1)', downloadUrl: 'data:text/html,test' },
  ]);
  assert.match(html, /href="\/api\/jobs\/replicated:1\/results\/0" target="_blank" rel="noopener noreferrer">预览/);
  assert.match(html, /download="frame-12\.png"/);
  assert.match(html, /&lt;script&gt;\.png/);
  assert.doesNotMatch(html, /javascript:|data:text|<script>/);
});
