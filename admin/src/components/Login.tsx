import { LockOutlined, SafetyCertificateOutlined, SolutionOutlined, UserOutlined } from "@ant-design/icons";
import { ProForm, ProFormDependency, ProFormSelect, ProFormText } from "@ant-design/pro-components";
import { App as AntApp, Button } from "antd";
import { useState } from "react";
import { apiRequest } from "../api";
import logoUrl from "../assets/logo.webp";
import { useI18n } from "../i18n";
import type { AdminUser } from "../types";
import { ResetPasswordModal } from "./ResetPasswordModal";

type LoginProps = {
  onLogin: (token: string, admin: AdminUser) => void;
};

// The dropdown is a UI hint only: it decides whether the master-password field
// is shown and sent. The server authorises purely on the stored user_role, so
// the selected option itself is never submitted as an auth signal.
type LoginRole = "admin" | "user";

type LoginValues = {
  login_role: LoginRole;
  username: string;
  password: string;
  master_password?: string;
};

export function Login({ onLogin }: LoginProps) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [resetOpen, setResetOpen] = useState(false);

  return (
    <main className="flex min-h-screen items-start justify-center bg-[#f5f7fb] px-4 py-10 pt-[20vh]">
      <section className="w-full max-w-[400px] rounded-lg border border-[#e5e7eb] bg-white px-6 py-8 shadow-[0_18px_45px_rgba(15,23,42,0.08)] sm:px-8">
        <div className="mb-7 text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-lg bg-[#eef4ff]">
            <img alt={t("app.title")} className="size-9 object-contain" src={logoUrl} />
          </div>
          <h1 className="m-0 text-2xl font-semibold leading-8 text-[#111827]">{t("app.title")}</h1>
          <p className="mb-0 mt-2 text-sm text-[#6b7280]">{t("app.subtitle")}</p>
        </div>

        <ProForm<LoginValues>
          isKeyPressSubmit
          submitter={{
            searchConfig: { submitText: t("common.login") },
            submitButtonProps: { size: "large", style: { width: "100%" } },
            render: (_, dom) => dom.pop()
          }}
          onFinish={async (values) => {
            try {
              const body: Record<string, string> = {
                username: values.username,
                password: values.password
              };
              // Only an admin carries the master password; the dropdown role is
              // never sent — the server decides from the stored user_role.
              if (values.login_role === "admin" && values.master_password) {
                body.master_password = values.master_password;
              }
              const data = await apiRequest<{ token: string; admin: AdminUser }>("/api/admin/login", {
                method: "POST",
                body: JSON.stringify(body)
              });
              onLogin(data.token, data.admin);
              return true;
            } catch (error) {
              message.error(error instanceof Error ? error.message : t("auth.loginFailed"));
              return false;
            }
          }}
        >
          <ProFormSelect
            name="login_role"
            initialValue="admin"
            allowClear={false}
            fieldProps={{ size: "large", prefix: <SolutionOutlined /> }}
            placeholder={t("auth.loginAs")}
            options={[
              { value: "admin", label: t("auth.roleAdmin") },
              { value: "user", label: t("auth.roleUser") }
            ]}
          />
          <ProFormText
            name="username"
            fieldProps={{ autoComplete: "username", prefix: <UserOutlined />, size: "large" }}
            placeholder={t("auth.usernamePlaceholder")}
            rules={[{ required: true, message: t("auth.usernameRequired") }]}
          />
          <ProFormText.Password
            name="password"
            fieldProps={{ autoComplete: "current-password", prefix: <LockOutlined />, size: "large" }}
            placeholder={t("auth.passwordPlaceholder")}
            rules={[{ required: true, message: t("auth.passwordRequired") }]}
          />
          <ProFormDependency name={["login_role"]}>
            {({ login_role }) =>
              login_role === "admin" ? (
                <>
                  <ProFormText.Password
                    name="master_password"
                    fieldProps={{ autoComplete: "off", prefix: <SafetyCertificateOutlined />, size: "large" }}
                    placeholder={t("auth.masterPasswordPlaceholder")}
                    rules={[{ required: true, message: t("auth.masterPasswordRequired") }]}
                  />
                  <p className="mb-3 -mt-1 text-xs text-[#6b7280]">{t("auth.adminLoginHint")}</p>
                </>
              ) : null
            }
          </ProFormDependency>
        </ProForm>
        <div className="mt-3 text-right">
          <Button type="link" className="px-0!" onClick={() => setResetOpen(true)}>
            {t("auth.forgotPassword")}
          </Button>
        </div>
      </section>
      <ResetPasswordModal open={resetOpen} onClose={() => setResetOpen(false)} />
    </main>
  );
}
