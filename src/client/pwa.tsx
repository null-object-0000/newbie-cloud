import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, RefreshCw, WifiOff, X } from 'lucide-react';
import './pwa.css';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
type PwaState = { prompt: InstallPrompt | null; installed: boolean; install: () => Promise<void> };
const Context = createContext<PwaState>({
  prompt: null,
  installed: false,
  install: async () => {},
});

export function PwaProvider({ children }: { children: ReactNode }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [reconnected, setReconnected] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [updating, setUpdating] = useState(false);
  const requestedUpdate = useRef(false);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const offlineRef = useRef(!navigator.onLine);
  useEffect(() => {
    const standalone = matchMedia('(display-mode: standalone)');
    const syncInstalled = () =>
      setInstalled(
        standalone.matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
      );
    const available = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const added = () => {
      setPrompt(null);
      setInstalled(true);
    };
    const online = () => {
      setOffline(false);
      if (offlineRef.current) setReconnected(true);
      offlineRef.current = false;
    };
    const disconnected = () => {
      setOffline(true);
      setReconnected(false);
      offlineRef.current = true;
    };
    const network = (event: Event) => {
      if ((event as CustomEvent<{ offline: boolean }>).detail.offline) disconnected();
      else online();
    };
    syncInstalled();
    window.addEventListener('beforeinstallprompt', available);
    window.addEventListener('appinstalled', added);
    window.addEventListener('online', online);
    window.addEventListener('offline', disconnected);
    window.addEventListener('newbie-cloud-network', network);
    standalone.addEventListener('change', syncInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', available);
      window.removeEventListener('appinstalled', added);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', disconnected);
      window.removeEventListener('newbie-cloud-network', network);
      standalone.removeEventListener('change', syncInstalled);
    };
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    let active = true,
      lastCheck = 0;
    const changed = () => {
      if (requestedUpdate.current) {
        requestedUpdate.current = false;
        window.location.reload();
      }
    };
    const check = () => {
      if (
        document.visibilityState === 'visible' &&
        navigator.onLine &&
        Date.now() - lastCheck > 60000
      ) {
        lastCheck = Date.now();
        void registration.current?.update().catch(() => {});
      }
    };
    const register = async () => {
      try {
        const r = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });
        if (!active) return;
        registration.current = r;
        if (r.waiting) setWaiting(r.waiting);
        const installing = () => {
          const worker = r.installing;
          worker?.addEventListener('statechange', () => {
            if (
              active &&
              worker.state === 'installed' &&
              navigator.serviceWorker.controller &&
              r.waiting
            )
              setWaiting(r.waiting);
          });
        };
        r.addEventListener('updatefound', installing);
        installing();
      } catch {
        /* Installation is optional; the online application continues to work. */
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', changed);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    if (document.readyState === 'complete') void register();
    else window.addEventListener('load', register, { once: true });
    return () => {
      active = false;
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', changed);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, []);
  const install = async () => {
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } finally {
      setPrompt(null);
    }
  };
  const update = () => {
    if (!waiting || offline) return;
    if (waiting.state === 'activated' || waiting.state === 'redundant') {
      window.location.reload();
      return;
    }
    setUpdating(true);
    requestedUpdate.current = true;
    waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  };
  return (
    <Context.Provider value={{ prompt, installed, install }}>
      {children}
      {(offline || waiting || reconnected) && (
        <aside className="pwa-notice" role="status" aria-live="polite">
          {offline ? (
            <>
              <WifiOff size={19} />
              <div>
                <strong>当前处于离线状态</strong>
                <p>可打开已缓存的界面；云资源查询和修改需要联网，操作不会排队重试。</p>
              </div>
            </>
          ) : waiting ? (
            <>
              <RefreshCw size={19} />
              <div>
                <strong>新版本已准备好</strong>
                <p>完成当前操作后，可以更新应用。</p>
              </div>
              <button className="primary compact" disabled={updating} onClick={update}>
                {updating ? '更新中…' : '更新并刷新'}
              </button>
            </>
          ) : (
            <>
              <div>
                <strong>网络已恢复</strong>
                <p>重新加载以连接云管理台。</p>
              </div>
              <button className="secondary compact" onClick={() => window.location.reload()}>
                重新加载
              </button>
              <button
                className="icon-button"
                aria-label="关闭网络提示"
                onClick={() => setReconnected(false)}
              >
                <X size={17} />
              </button>
            </>
          )}
        </aside>
      )}
    </Context.Provider>
  );
}

export function PwaInstall() {
  const { prompt, installed, install } = useContext(Context);
  const [help, setHelp] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!help) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelp(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [help]);
  if (installed) return null;
  return (
    <>
      <button
        className="pwa-install"
        title="安装应用"
        aria-label="安装应用"
        onClick={() => {
          if (prompt)
            void install().catch(() => {
              setError('安装未完成，可以使用浏览器菜单重试。');
              setHelp(true);
            });
          else {
            setError('');
            setHelp(true);
          }
        }}
      >
        <Download size={18} />
      </button>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="安装 Newbie Cloud"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <h2>安装 Newbie Cloud</h2>
              <button
                className="icon-button"
                aria-label="关闭安装说明"
                onClick={() => setHelp(false)}
                autoFocus
              >
                <X size={20} />
              </button>
            </header>
            <div className="modal-body pwa-help">
              <p>安装后可从桌面或主屏幕打开，在独立窗口中管理自己的云资源。</p>
              {error && <p className="danger-text">{error}</p>}
              <p>
                <strong>Chrome / Edge</strong>
                <br />
                点击地址栏的安装图标，或在浏览器菜单中选择“安装应用”。
              </p>
              <p>
                <strong>iPhone / iPad</strong>
                <br />
                使用 Safari 打开，点击“分享”→“添加到主屏幕”，并开启“作为 Web App 打开”（如有）。
              </p>
              <p>
                <strong>Mac Safari</strong>
                <br />
                在“文件”菜单中选择“添加到程序坞”。
              </p>
              <small>
                具体名称因浏览器版本而异。离线仅保留应用界面，不保存云资源或离线执行修改。
              </small>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
