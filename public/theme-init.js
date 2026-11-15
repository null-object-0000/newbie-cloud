// Loaded before rendering so a saved dark preference never flashes light.
(() => {
  let mode = 'system';
  let accent = 'blue';
  try {
    const saved = JSON.parse(localStorage.getItem('newbie-cloud-appearance') || '{}');
    if (['light', 'dark', 'system'].includes(saved.mode)) mode = saved.mode;
    if (['neutral', 'blue', 'forest', 'violet'].includes(saved.accent)) accent = saved.accent;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.dataset.accent = accent;
  root.dataset.theme =
    mode === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : mode;
})();
