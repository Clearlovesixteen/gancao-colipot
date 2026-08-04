import type { PageAuthSnapshot } from '../../shared/auth/authBridge';

export interface StoredPageAuthContext {
  userAuth: boolean;
  authSource?: 'page' | 'plugin' | string;
  pageAuthHost?: string;
  pageAuthTabId?: number;
}

export type PageAuthDecision =
  | { kind: 'login'; sessionOnly: boolean; reason: string }
  | { kind: 'logout'; reason: string }
  | { kind: 'preserve'; reason: string };

export function decidePageAuthTransition(
  current: StoredPageAuthContext,
  snapshot: PageAuthSnapshot,
  senderTabId?: number,
): PageAuthDecision {
  if (current.userAuth && current.authSource === 'plugin') {
    return { kind: 'preserve', reason: 'plugin_login_is_authoritative' };
  }

  if (snapshot.pageLooksLoggedOut === true) {
    const sameTab = current.pageAuthTabId != null
      ? current.pageAuthTabId === senderTabId
      : current.pageAuthHost === snapshot.host;
    if (current.userAuth && current.authSource === 'page' && sameTab) {
      return { kind: 'logout', reason: 'explicit_page_logout' };
    }
    return { kind: 'preserve', reason: 'logout_signal_from_unrelated_tab' };
  }

  if (snapshot.token) {
    return { kind: 'login', sessionOnly: false, reason: 'page_token_detected' };
  }

  if (snapshot.pageLooksLoggedIn === true) {
    return { kind: 'login', sessionOnly: true, reason: 'trusted_page_session_detected' };
  }

  if (current.userAuth && current.authSource === 'page') {
    return { kind: 'preserve', reason: 'page_auth_temporarily_unknown' };
  }

  return { kind: 'preserve', reason: 'page_auth_not_changed' };
}
