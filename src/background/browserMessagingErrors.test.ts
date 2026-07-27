import { describe, expect, it } from 'vitest';
import { isTransientNavigationMessagingError, isTransientObservationMessagingError } from './browserMessagingErrors';

describe('isTransientNavigationMessagingError', () => {
  it('recognizes Chrome navigation and BFCache messaging teardown errors', () => {
    expect(isTransientNavigationMessagingError(new Error(
      'The page keeping the extension port is moved into back/forward cache, so the message channel is closed.'
    ))).toBe(true);
    expect(isTransientNavigationMessagingError(
      'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received'
    )).toBe(true);
  });

  it('does not hide ordinary content-script or action errors', () => {
    expect(isTransientNavigationMessagingError(new Error('Could not establish connection. Receiving end does not exist.'))).toBe(false);
    expect(isTransientNavigationMessagingError(new Error('目标元素不可见'))).toBe(false);
  });

  it('allows observation retries while a new document content script is attaching', () => {
    expect(isTransientObservationMessagingError(
      new Error('Could not establish connection. Receiving end does not exist.')
    )).toBe(true);
    expect(isTransientObservationMessagingError(new Error('目标元素不可见'))).toBe(false);
  });
});
