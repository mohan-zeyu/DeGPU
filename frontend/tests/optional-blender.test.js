import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProviderSettings } from '../src/provider-settings.js';
import { taskRuntimeLabel } from '../src/task-runtime.js';
const task = (code, version = null) => ({ id: 'blender-render-v1', name: 'Blender 渲染', runs_here: code === 'ready', runtime: {code, detected_version: version, required_version: '5.2'} });
test('missing Blender disables only new render offers and explains optional installation', () => {
  const html = renderProviderSettings({taskTypes: [task('not_installed'), {id:'key-search-v1', name:'密钥搜索', runs_here:true}]}, null);
  assert.match(html, /Blender 可选：未安装/);
  assert.match(html, /name="enabled.blender-render-v1" type="checkbox" disabled/);
  assert.doesNotMatch(html, /name="enabled.key-search-v1" type="checkbox"[^>]*disabled/);
});
test('wrong version and unreadable version give distinct actionable messages', () => {
  assert.match(taskRuntimeLabel(task('version_mismatch','5.1')), /检测到 5.1，需 5.2.x/);
  assert.match(taskRuntimeLabel(task('unreadable')), /无法读取 Blender 版本/);
});
test('supported Blender enables rendering and old unavailable offer can be removed', () => {
  assert.match(taskRuntimeLabel(task('ready','5.2')), /可提供渲染/);
  const html = renderProviderSettings({taskTypes:[task('not_installed')]}, {offers:{'blender-render-v1':'0.001'}});
  assert.match(html, /name="enabled.blender-render-v1" type="checkbox" checked>/);
});
