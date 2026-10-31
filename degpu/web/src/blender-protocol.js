// Mirrors the installed Blender task's inputs and pinned runner, not a new wire schema.
export const BLENDER_RUNNER = Object.freeze({
  taskType: 'blender-render-v1', mode: 'replicated', compare: 'similar',
  blenderVersion: '5.2', engine: 'CYCLES', format: 'PNG', secondsPerItem: 30,
  grid: 8, maxTileMseX1000: 65025, maxItems: 1000,
});

// Python parse_frames preserves requested order and duplicate frames.
export function parseBlenderFrames(spec) {
  if (typeof spec !== 'string' || !spec.trim() || spec.length > 16000) {
    throw new Error('请输入帧号，如 1-12 或 1,5,9。');
  }
  const frames = [];
  for (const part of spec.split(',')) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());
    if (!match) throw new Error('帧号格式不正确，请使用 1-12 或 1,5,9。');
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
      throw new Error('帧范围须递增，帧号须为有效整数。');
    }
    if (end - start + 1 > BLENDER_RUNNER.maxItems - frames.length) {
      throw new Error('每个任务最多渲染 1000 帧。');
    }
    for (let frame = start; frame <= end; frame += 1) frames.push(frame);
  }
  return Object.freeze(frames);
}

export function validateBlenderSceneName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 255
    || /[\x00-\x1f/\\]/.test(name) || !/\.blend$/i.test(name)) {
    throw new Error('请选择已打包资源的 .blend 场景文件。');
  }
  return name;
}
