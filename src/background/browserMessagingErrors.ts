const NAVIGATION_CHANNEL_ERROR_PATTERNS = [
  /back\/forward cache/i,
  /message channel is closed/i,
  /message port closed before a response was received/i,
  /asynchronous response.*message channel closed/i,
];

export function isTransientNavigationMessagingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return NAVIGATION_CHANNEL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

const OBSERVATION_CHANNEL_ERROR_PATTERNS = [
  ...NAVIGATION_CHANNEL_ERROR_PATTERNS,
  /could not establish connection.*receiving end does not exist/i,
  /the message port closed/i,
  /PAGE_OBSERVATION_NOT_READY/i,
  /当前标签页没有可访问的 URL/i,
];

export function isTransientObservationMessagingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return OBSERVATION_CHANNEL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
