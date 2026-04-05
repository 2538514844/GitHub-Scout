import React, { useState, useEffect, useCallback } from 'react';

function Auth({ onAuthChange }) {
  const [user, setUser] = useState(null);
  const [patInput, setPatInput] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [showPatInput, setShowPatInput] = useState(false);

  const checkAuth = useCallback(async () => {
    const status = await window.electronAPI.getAuthStatus();
    if (status.loggedIn) {
      setUser(status.user);
      onAuthChange?.(status.user);
    } else {
      setUser(null);
      onAuthChange?.(null);
    }
  }, [onAuthChange]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLoginWithPat = async () => {
    if (!patInput.trim()) {
      setLoginError('请输入 Token');
      return;
    }
    setLoggingIn(true);
    setLoginError('');
    try {
      const result = await window.electronAPI.loginWithGitHubPat(patInput.trim());
      if (result.ok) {
        setUser(result.auth);
        onAuthChange?.(result.auth);
        setPatInput('');
        setShowPatInput(false);
      } else {
        setLoginError(result.message);
      }
    } catch (e) {
      setLoginError(e.message);
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogin = () => {
    window.electronAPI.openUrl('https://github.com/settings/tokens/new?scopes=repo&description=GitHub+Scout');
    setShowPatInput(true);
    setLoginError('');
  };

  const handleLogout = async () => {
    await window.electronAPI.logout();
    setUser(null);
    onAuthChange?.(null);
  };

  if (user) {
    return (
      <div className="auth-section">
        <img src={user.avatar} alt="" className="auth-avatar" />
        <span className="auth-name">{user.login}</span>
        <button className="auth-logout" onClick={handleLogout} title="登出">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <div className="auth-section">
      <button className="auth-login-btn" onClick={handleLogin} disabled={loggingIn}>
        {loggingIn ? (
          <><span className="spinner" /> 登录中</>
        ) : (
          <><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
          </svg> 登录</>
        )}
      </button>
      {showPatInput && (
        <div className="auth-pat-inline">
          <input
            type="password"
            value={patInput}
            onChange={e => setPatInput(e.target.value)}
            placeholder="ghp_xxx"
            onKeyDown={e => e.key === 'Enter' && handleLoginWithPat()}
          />
          <button className="auth-pat-btn" onClick={handleLoginWithPat} disabled={loggingIn}>
            {loggingIn ? <span className="spinner" /> : '确认'}
          </button>
        </div>
      )}
      {loginError && <span className="auth-error-text">{loginError}</span>}
    </div>
  );
}

export default Auth;
