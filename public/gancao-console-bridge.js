(() => {
  if (window.__gancaoPageConsoleBridgeInstalled) return;
  window.__gancaoPageConsoleBridgeInstalled = true;

  const originalError = console.error;

  const serialize = (value) => {
    if (value instanceof Error) {
      return { message: value.message, stack: value.stack };
    }
    if (typeof value === 'string') {
      return { message: value };
    }
    try {
      return { message: JSON.stringify(value) };
    } catch (_) {
      return { message: String(value) };
    }
  };

  console.error = function patchedConsoleError(...args) {
    try {
      const serialized = args.map(serialize);
      window.postMessage({
        source: 'gancao-console-bridge',
        type: 'console-error',
        message: serialized.map((item) => item.message).join(' '),
        stack: serialized.map((item) => item.stack).filter(Boolean).join('\n'),
        timestamp: Date.now(),
      }, '*');
    } catch (_) {}

    return originalError.apply(this, args);
  };
})();
