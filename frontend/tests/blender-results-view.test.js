import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBlenderResults } from '../src/blender-results-view.js';

const job = {
  id: 'replicated:200', itemCount: 12, frames: [0, 2, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  phase: 'Disputing', closed: false, sceneName: '<scene>.blend',
  results: [{ index: 0, frame: 0, filename: '<frame>.png', digest: '0x1234567890abcdef' }],
  review: { compared: false }, resultFilesAvailable: false,
};

test('render review uses independent item indices, escapes metadata and discloses missing file comparison', () => {
  const html = renderBlenderResults(job, { canReview: true });
  assert.match(html, /value="0" aria-label="争议项 0 · 帧 0"/);
  assert.match(html, /value="1" aria-label="争议项 1 · 帧 2"/);
  assert.match(html, /value="2" aria-label="争议项 2 · 帧 2"/);
  assert.match(html, /&lt;scene&gt;\.blend/);
  assert.match(html, /&lt;frame&gt;\.png/);
  assert.doesNotMatch(html, /<scene>|<frame>|href="[^\"]*\.png|像素比较通过/);
  assert.match(html, /尚未取得完整输出文件/);
  assert.match(html, /承诺记录/);
  assert.match(html, /name="disputedIndices"/);
});

test('accept and dispute controls respect participant, closed and deadline states independently', () => {
  assert.doesNotMatch(renderBlenderResults(job), /accept-render|render-dispute-form|name="disputedItems"/);
  assert.doesNotMatch(renderBlenderResults({ ...job, closed: true }, { canReview: true }), /accept-render|render-dispute-form/);
  const expired = renderBlenderResults({ ...job, deadlinePassed: true }, { canReview: true });
  assert.match(expired, /accept-render/);
  assert.doesNotMatch(expired, /name="disputedItems"|提交争议|name="disputedIndices"/);
  assert.match(expired, /争议期已结束/);
  const waiting = renderBlenderResults({ ...job, phase: 'TieBreak', disputedItems: [2] }, { canReview: true });
  assert.doesNotMatch(waiting, /accept-render|render-dispute-form/);
  assert.match(waiting, /等待裁决/);
});

test('result pagination keeps supply context and never invents unloaded commitments or files', () => {
  const html = renderBlenderResults(job, { canReview: true, page: 999, baseHref: '#/jobs/replicated:200/results?view=supply&machine=A' });
  assert.match(html, /2 \/ 2/);
  assert.match(html, /view=supply&amp;machine=A&amp;resultPage=1/);
  assert.match(html, /value="8" aria-label="争议项 8 · 帧 9"/);
  assert.doesNotMatch(html, /value="0"|0x123456/);
  assert.match(html, /未载入/);
});

test('judgement and acceptance labels do not claim a local pixel comparison happened', () => {
  const html = renderBlenderResults({ ...job, closed: true, phase: 'Closed', disputedItems: [0, 2], verdicts: [2, 3] });
  assert.match(html, /裁决否决/);
  assert.match(html, /裁决接受/);
  assert.match(html, /尚未取得完整输出文件/);
  assert.match(renderBlenderResults({ ...job, closed: true, review: { accepted: true } }), /客户已接受/);
});
