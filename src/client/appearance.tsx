import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Palette, Sun } from 'lucide-react';

const modes = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
] as const;
const accents = [
  { value: 'neutral', label: '无主色' },
  { value: 'blue', label: '蓝色' },
  { value: 'forest', label: '墨绿' },
  { value: 'violet', label: '紫罗兰' },
] as const;
type Mode = (typeof modes)[number]['value'];
type Accent = (typeof accents)[number]['value'];
const storageKey = 'newbie-cloud-appearance';

export function AppearancePicker() {
  const [mode, setMode] = useState<Mode>(
    () => modes.find((m) => m.value === document.documentElement.dataset.mode)?.value ?? 'system',
  );
  const [accent, setAccent] = useState<Accent>(
    () => accents.find((a) => a.value === document.documentElement.dataset.accent)?.value ?? 'blue',
  );
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const root = document.documentElement;
      root.dataset.mode = mode;
      root.dataset.accent = accent;
      root.dataset.theme = mode === 'system' ? (media.matches ? 'dark' : 'light') : mode;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', getComputedStyle(root).getPropertyValue('--canvas').trim());
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [mode, accent]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector('summary')?.focus();
      }
    };
    const storage = (event: StorageEvent) => {
      if (event.key !== storageKey && event.key !== null) return;
      try {
        const saved = JSON.parse(event.newValue || '{}');
        setMode(modes.find((m) => m.value === saved.mode)?.value ?? 'system');
        setAccent(accents.find((a) => a.value === saved.accent)?.value ?? 'blue');
      } catch {
        /* Ignore malformed preferences from other tabs. */
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('storage', storage);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('storage', storage);
    };
  }, []);

  const choose = (nextMode: Mode, nextAccent: Accent) => {
    setMode(nextMode);
    setAccent(nextAccent);
    try {
      localStorage.setItem(storageKey, JSON.stringify({ mode: nextMode, accent: nextAccent }));
    } catch {
      /* The current session still works without browser storage. */
    }
  };
  return (
    <details className="appearance" ref={menu}>
      <summary aria-label="外观设置" title="外观设置">
        <Palette size={18} />
      </summary>
      <div className="appearance-menu" aria-label="外观设置选项">
        <p className="appearance-label">外观</p>
        <div className="appearance-modes" role="group" aria-label="显示模式">
          {modes.map(({ value, label, icon: Icon }) => (
            <button key={value} aria-pressed={mode === value} onClick={() => choose(value, accent)}>
              <Icon size={17} />
              <span>{label}</span>
              {mode === value && <Check size={15} />}
            </button>
          ))}
        </div>
        <p className="appearance-label">主题色</p>
        <div className="appearance-accents" role="group" aria-label="主题色">
          {accents.map(({ value, label }) => (
            <button
              key={value}
              className={'accent-choice accent-' + value}
              title={label}
              aria-label={label}
              aria-pressed={accent === value}
              onClick={() => choose(mode, value)}
            >
              <span>{accent === value && <Check size={14} />}</span>
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}
