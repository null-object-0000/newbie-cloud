export type View =
  | 'overview'
  | 'dns'
  | 'domain-overview'
  | 'registrations'
  | 'records'
  | 'email'
  | 'certificates'
  | 'compute'
  | 'workers'
  | 'projects'
  | 'services'
  | 'storage'
  | 'servers'
  | 'containers'
  | 'accounts'
  | 'plugins'
  | 'extensions'
  | 'plugin-resource'
  | 'history'
  | 'settings'
  | 'deploy';
export type Section = 'overview' | 'domains' | 'compute' | 'storage' | 'settings';
export const sectionLabels: Record<Section, string> = {
  overview: '概览',
  domains: '域名',
  compute: '计算',
  storage: '存储',
  settings: '管理',
};
export function sectionFor(view: View): Section {
  if (
    ['dns', 'domain-overview', 'registrations', 'records', 'email', 'certificates'].includes(view)
  )
    return 'domains';
  if (['compute', 'workers', 'projects', 'services', 'servers', 'containers'].includes(view))
    return 'compute';
  if (view === 'storage') return 'storage';
  if (view === 'overview') return 'overview';
  return 'settings';
}
export const viewLabels: Record<View, string> = {
  overview: '账户概览',
  dns: '所有域名',
  'domain-overview': '域名概述',
  registrations: '注册信息',
  records: 'DNS 记录',
  email: '电子邮件',
  certificates: 'SSL / TLS',
  compute: 'Workers 和 Pages',
  workers: 'Workers',
  projects: 'Pages',
  services: '关联计算资源',
  storage: '对象存储',
  servers: '云服务器',
  containers: '本机容器',
  accounts: '云账号',
  plugins: '插件',
  extensions: '扩展资源',
  'plugin-resource': '扩展资源',
  history: '操作日志',
  settings: '使用说明',
  deploy: 'GitHub 工作流',
};
export const sectionViews: Record<Section, View[]> = {
  overview: ['overview'],
  domains: ['dns', 'registrations', 'records', 'email', 'certificates'],
  compute: ['workers', 'projects', 'servers', 'containers'],
  storage: ['storage'],
  settings: ['accounts', 'plugins', 'extensions', 'deploy', 'history', 'settings'],
};
export function readRoute() {
  try {
    const [route, query] = location.hash.slice(1).split('?'),
      view = route?.split('/').filter(Boolean).pop() as View,
      params = new URLSearchParams(query);
    return {
      view: Object.hasOwn(viewLabels, view) ? view : ('dns' as View),
      domain: params.get('domain') ?? '',
      project: /^[a-f0-9-]{36}$/.test(params.get('project') ?? '') ? params.get('project')! : '',
      zone: params.get('zone') ?? '',
    };
  } catch {
    return { view: 'dns' as View, domain: '', project: '', zone: '' };
  }
}
