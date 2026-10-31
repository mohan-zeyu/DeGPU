export function taskRuntimeLabel(task) {
  if (task?.id !== 'blender-render-v1') return task?.runs_here ? '本机可运行' : '本机缺少运行环境';
  const runtime = task.runtime || {};
  const required = runtime.required_version || '5.2';
  if (task.runs_here) return `Blender ${runtime.detected_version || required}.x · 可提供渲染`;
  if (runtime.code === 'version_mismatch') return `Blender 版本不符：检测到 ${runtime.detected_version}，需 ${required}.x；其他服务不受影响`;
  if (runtime.code === 'unreadable') return `无法读取 Blender 版本，需 ${required}.x；其他服务不受影响`;
  return `Blender 可选：未安装，提供渲染服务需 ${required}.x；其他服务不受影响`;
}
