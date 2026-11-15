export type View =
  | 'projects'
  | 'overview'
  | 'accounts'
  | 'dns'
  | 'records'
  | 'services'
  | 'email'
  | 'certificates'
  | 'deploy'
  | 'servers'
  | 'containers'
  | 'plugins'
  | 'extensions'
  | 'plugin-resource'
  | 'history'
  | 'settings';
export type Section = 'projects' | 'resources' | 'activity' | 'settings';
export const sectionLabels: Record<Section, string> = {
  projects: '项目',
  resources: '资源',
  activity: '活动',
  settings: '设置',
};
export function sectionFor(view: View): Section {
  if (['projects', 'deploy'].includes(view)) return 'projects';
  if (['accounts', 'plugins', 'settings'].includes(view)) return 'settings';
  if (view === 'history') return 'activity';
  return 'resources';
}
export const resourceGroups: { id: string; label: string; views: View[] }[] = [
  { id: 'overview', label: '资源总览', views: ['overview'] },
  { id: 'domains', label: '域名', views: ['dns', 'records', 'email', 'certificates'] },
  { id: 'hosting', label: '站点与函数', views: ['services'] },
  { id: 'compute', label: '服务器与容器', views: ['servers', 'containers'] },
  { id: 'extensions', label: '扩展资源', views: ['extensions', 'plugin-resource'] },
];
export function resourceGroup(view: View) {
  return resourceGroups.find((g) => g.views.includes(view));
}
