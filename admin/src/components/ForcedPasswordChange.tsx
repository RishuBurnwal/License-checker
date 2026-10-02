import { App as AntApp, Button, Form, Input, Typography } from "antd";
import { useState } from "react";
import { apiRequest } from "../api";
import { useI18n } from "../i18n";

const { Paragraph, Title } = Typography;

type ForcedPasswordChangeProps = {
  /** The logged-in account whose password is being changed (shown for clarity). */
  username?: string;
  /** Re-reads /api/admin/me so the gate can lift once the flag clears. */
  onChanged: () => Promise<unknown>;
  onLogout: () => void;
};

/**
 * Blocking screen shown when the account still carries a reset credential.
 * The Worker refuses every other API call in this state, so this screen is the
 * only thing the operator can accomplish until a new password is set.
 */
export function ForcedPasswordChange({ username, onChanged, onLogout }: ForcedPasswordChangeProps) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const who = username ?? "admin";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-4">
      <div className="w-full max-w-md rounded-lg border border-[#e5e7eb] bg-white p-8 shadow-sm">
        <Title level={3} style={{ marginBottom: 4 }}>
          {t("auth.mustChangeTitle", { username: who })}
        </Title>
        <Paragraph type="secondary">{t("auth.mustChangeIntro", { username: who })}</Paragraph>
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={async (values) => {
            setLoading(true);
            try {
              await apiRequest("/api/admin/password", {
                method: "PATCH",
                body: JSON.stringify({
                  current_password: values.current_password,
                  new_password: values.new_password
                })
              });
              message.success(t("auth.passwordChanged"));
              form.resetFields();
              await onChanged();
            } catch (error) {
              message.error(error instanceof Error ? error.message : t("auth.changeFailed"));
            } finally {
              setLoading(false);
            }
          }}
        >
          <Form.Item
            name="current_password"
            label={`${t("auth.currentPassword")} (${who})`}
            extra={t("auth.changePasswordAccountNote", { username: who })}
            rules={[{ required: true, message: t("auth.currentPasswordRequired") }]}
          >
            <Input.Password autoComplete="current-password" autoFocus />
          </Form.Item>
          <Form.Item
            name="new_password"
            label={t("auth.newPassword")}
            rules={[
              { required: true, message: t("auth.newPasswordRequired") },
              { min: 8, message: t("auth.newPasswordMin") }
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm_password"
            label={t("auth.confirmPassword")}
            dependencies={["new_password"]}
            rules={[
              { required: true, message: t("auth.confirmPasswordRequired") },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("new_password") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error(t("auth.passwordMismatch")));
                }
              })
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t("auth.setNewPassword")}
          </Button>
          <Button type="link" block onClick={onLogout} style={{ marginTop: 8 }}>
            {t("auth.signOutInstead")}
          </Button>
        </Form>
      </div>
    </div>
  );
}
