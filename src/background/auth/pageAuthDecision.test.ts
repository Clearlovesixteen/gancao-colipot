import { describe, expect, it } from 'vitest';
import type { PageAuthSnapshot } from '../../shared/auth/authBridge';
import { decidePageAuthTransition } from './pageAuthDecision';

function snapshot(overrides: Partial<PageAuthSnapshot> = {}): PageAuthSnapshot {
  return {
    token: null,
    url: 'https://adminweb-erp-warehousing.gancao.com/#/dashboard',
    host: 'adminweb-erp-warehousing.gancao.com',
    detectedAt: 1,
    ...overrides,
  };
}

describe('decidePageAuthTransition', () => {
  it('does not log out a page session merely because a refresh temporarily has no token', () => {
    expect(decidePageAuthTransition({
      userAuth: true,
      authSource: 'page',
      pageAuthHost: 'adminweb-erp-warehousing.gancao.com',
      pageAuthTabId: 12,
    }, snapshot(), 12)).toEqual({
      kind: 'preserve',
      reason: 'page_auth_temporarily_unknown',
    });
  });

  it('does not let a separate DingTalk authorization tab clear a completed plugin login', () => {
    expect(decidePageAuthTransition({
      userAuth: true,
      authSource: 'plugin',
    }, snapshot({
      url: 'https://sso-server-dev.igancao.cn/auth/oauth2/authorize',
      host: 'sso-server-dev.igancao.cn',
      pageLooksLoggedOut: true,
      logoutSignals: ['钉钉扫码登录'],
    }), 99)).toEqual({
      kind: 'preserve',
      reason: 'plugin_login_is_authoritative',
    });
  });

  it('does not let an unrelated page token replace a completed plugin login', () => {
    expect(decidePageAuthTransition({
      userAuth: true,
      authSource: 'plugin',
    }, snapshot({ token: 'stale-page-token' }), 99)).toEqual({
      kind: 'preserve',
      reason: 'plugin_login_is_authoritative',
    });
  });

  it('accepts an authenticated WMS application shell when the session is cookie based', () => {
    expect(decidePageAuthTransition({ userAuth: false }, snapshot({
      pageLooksLoggedIn: true,
      loginSignals: ['authenticated-app-shell'],
    }), 12)).toEqual({
      kind: 'login',
      sessionOnly: true,
      reason: 'trusted_page_session_detected',
    });
  });

  it('logs out only on explicit evidence from the tab that established the page session', () => {
    expect(decidePageAuthTransition({
      userAuth: true,
      authSource: 'page',
      pageAuthHost: 'adminweb-erp-warehousing.gancao.com',
      pageAuthTabId: 12,
    }, snapshot({
      pageLooksLoggedOut: true,
      logoutSignals: ['请登录'],
    }), 12)).toEqual({
      kind: 'logout',
      reason: 'explicit_page_logout',
    });
  });

  it('treats a login route as logout even when stale page storage still contains a token', () => {
    expect(decidePageAuthTransition({
      userAuth: true,
      authSource: 'page',
      pageAuthHost: 'adminweb-erp-warehousing.gancao.com',
      pageAuthTabId: 12,
    }, snapshot({
      token: 'stale-token',
      pageLooksLoggedOut: true,
      logoutSignals: ['请登录'],
    }), 12)).toEqual({
      kind: 'logout',
      reason: 'explicit_page_logout',
    });
  });
});
