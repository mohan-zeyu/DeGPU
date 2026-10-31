// Service names identify plugins; numeric task IDs are local to each market.
export const services = [
  {
    id: 'image-classify-v1', name: '图像分类', mode: 'replicated', compare: 'exact', available: true,
    unit: '张', runner: 'ONNX · CPU', defaultCount: 200, maxItems: 1000, liveMaxItems: 200, countLabel: '图片数量',
    workload: count => `${count} 张图片`,
    validate: input => {
      if (!Number.isInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > 1000) {
        return '图片数量须为 1–1000 的整数。';
      }
      return null;
    },
    resultColumns: [['index', '图片序号'], ['labelId', '类别编号'], ['label', '类别名称']],
  },
  {
    id: 'blender-render-v1', name: 'Blender 渲染', mode: 'replicated', compare: 'similar', available: true,
    unit: '帧', runner: 'Blender 5.2 · Cycles', defaultCount: 12, maxItems: 1000, countLabel: '渲染帧数',
    workload: count => `${count} 帧渲染`,
    validate: input => Number.isInteger(input.itemCount) && input.itemCount >= 1 && input.itemCount <= 1000
      ? null : '渲染帧数须为 1–1000 的整数。',
    resultColumns: [['frame', '帧号'], ['filename', '输出文件'], ['digest', '承诺记录']],
  },
  {
    id: 'key-search-v1', name: '密钥搜索', mode: 'checked', available: true,
    unit: '项', runner: 'Keccak-256', defaultCount: 8, maxItems: 1000, liveMaxItems: 256, countLabel: '挑战数量',
    workload: count => `${count} 项密钥挑战`,
    validate: input => Number.isInteger(input.itemCount) && input.itemCount >= 1 && input.itemCount <= 1000
      ? null : '挑战数量须为 1–1000 的整数。',
    resultColumns: [['index', '挑战序号'], ['key', '数值密钥']],
  },
];

export const getService = id => services.find(service => service.id === id);
export const servicesForState = state => state?.network?.mode === 'live'
  ? (state.taskTypes || []).map(task => ({ unit: '项', ...getService(task.id), ...task }))
  : services.filter(service => service.available);
// Live execution uses the bridge's upload and default 12-bit search limits.
export const getServiceItemLimit = (service, { live = false } = {}) =>
  (live ? service?.liveMaxItems : undefined) ?? service?.maxItems ?? 1000;
export function validateServiceInput(service, input, options) {
  const limit = getServiceItemLimit(service, options);
  if (!Number.isInteger(input.itemCount) || input.itemCount < 1 || input.itemCount > limit) {
    return `${service?.countLabel || '任务数量'}须为 1–${limit} 的整数。`;
  }
  return service?.validate?.(input) ?? null;
}
export const getProviderOffer = (provider, taskType) => provider?.offers?.[taskType] ?? null;
export const modeLabel = (mode, compare) => mode === 'checked' ? '合约直接检验' : compare === 'similar' ? '相似度复核' : '精确结果复核';

export const scenarios = [
  { id: 'verified', name: '正常复核', verify: true, provider: 'A', description: '两组独立复核，结果一致后结算。' },
  { id: 'unverified', name: '不复核交付', verify: false, provider: 'A', description: '公开不复核决定，交付后退回未使用的复核预存。' },
  { id: 'main-cheat', name: '提供方造假', verify: true, provider: 'E', description: '提供方伪造部分结果，裁决后罚没错误方质押。' },
  { id: 'verifier-cheat', name: '复核方造假', verify: true, provider: 'A', description: '两组复核给出错误结果，由独立复核方裁决。' },
  { id: 'main-offline', name: '提供方离线', verify: true, provider: 'F', description: '接单后停止响应，截止后调用 expire 才会处罚与退款。' },
];

export const getScenario = id => scenarios.find(scenario => scenario.id === id);
