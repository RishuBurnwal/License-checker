import { App as AntApp, ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import { lazy, Suspense, useEffect, useState } from "react";
import { clearToken, getToken, setToken, apiRequest } from "./api";
import { LanguageProvider } from "./i18n";
import type { AdminUser } from "./types";

const Login = lazy(() => import("./components/Login").then((module) => ({ default: module.Login })));
const Shell = lazy(() => import("./components/Shell").then((module) => ({ default: module.Shell })));
const ForcedPasswordChange = lazy(() =>
  import("./components/ForcedPasswordChange").then((module) => ({ default: module.ForcedPasswordChange }))
);

function AppLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb]">
      <div className="size-8 animate-spin rounded-full border-2 border-[#d9d9d9] border-t-[#1677ff]" />
    </div>
  );
}

export function App() {
  return (
    <LanguageProvider>
      <LocalizedApp />
    </LanguageProvider>
  );
}

function LocalizedApp() {
  const [token, updateToken] = useState<string | null>(() => getToken());
  const [admin, setAdmin] = useState<AdminUser | null>(null);

  function reloadAdmin() {
    return apiRequest<{ admin: AdminUser }>("/api/admin/me").then((data) => {
      setAdmin(data.admin);
      return data.admin;
    });
  }

  useEffect(() => {
    if (!token) {
      return;
    }
    apiRequest<{ admin: AdminUser }>("/api/admin/me")
      .then((data) => {
        setAdmin(data.admin);
      })
      .catch(() => {
        clearToken();
        updateToken(null);
      });
  }, [token]);

  function logout() {
    clearToken();
    updateToken(null);
    setAdmin(null);
  }

  // A reset credential must be replaced before the console becomes usable.
  // The server enforces this on every API call; this gate keeps the UI honest
  // instead of letting the operator meet a wall of failed requests.
  const mustChangePassword = token !== null && admin?.must_change_password === true;

  return (
    <ConfigProvider locale={enUS}>
      <AntApp>
        {mustChangePassword ? (
          <Suspense fallback={<AppLoading />}>
            <ForcedPasswordChange username={admin?.username} onChanged={reloadAdmin} onLogout={logout} />
          </Suspense>
        ) : token ? (
          <Suspense fallback={<AppLoading />}>
            <Shell admin={admin} onLogout={logout} />
          </Suspense>
        ) : (
          <Suspense fallback={<AppLoading />}>
            <Login
              onLogin={(nextToken, nextAdmin) => {
                setToken(nextToken);
                updateToken(nextToken);
                setAdmin(nextAdmin);
              }}
            />
          </Suspense>
        )}
      </AntApp>
    </ConfigProvider>
  );
}
