import { LockOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import { apiRequest } from "../api";
import { useI18n } from "../i18n";

type MasterPasswordValues = {
  current_master_password: string;
  new_master_password: string;
  confirm_master_password: string;
};

export function SettingsPage() {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [form] = Form.useForm<MasterPasswordValues>();
  const [saving, setSaving] = useState(false);

  return (
    <Card title={t("settings.masterPasswordTitle")} bordered>
      <Typography.Paragraph type="secondary">{t("settings.masterPasswordIntro")}</Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 420 }}
        onFinish={async (values) => {
          setSaving(true);
          try {
            await apiRequest("/api/admin/settings/master-password", {
              method: "PATCH",
              body: JSON.stringify({
                current_master_password: values.current_master_password,
                new_master_password: values.new_master_password
              })
            });
            message.success(t("settings.masterPasswordChanged"));
            form.resetFields();
          } catch (error) {
            message.error(error instanceof Error ? error.message : t("settings.masterPasswordChangeFailed"));
          } finally {
            setSaving(false);
          }
        }}
      >
        <Form.Item
          name="current_master_password"
          label={t("settings.currentMasterPassword")}
          rules={[{ required: true, message: t("settings.currentMasterPasswordRequired") }]}
        >
          <Input.Password
            autoComplete="off"
            prefix={<SafetyCertificateOutlined />}
            placeholder={t("settings.currentMasterPasswordPlaceholder")}
          />
        </Form.Item>
        <Form.Item
          name="new_master_password"
          label={t("settings.newMasterPassword")}
          rules={[
            { required: true, message: t("settings.newMasterPasswordRequired") },
            { min: 8, message: t("settings.newMasterPasswordMin") }
          ]}
        >
          <Input.Password autoComplete="new-password" prefix={<LockOutlined />} placeholder={t("settings.newMasterPasswordPlaceholder")} />
        </Form.Item>
        <Form.Item
          name="confirm_master_password"
          label={t("settings.confirmMasterPassword")}
          dependencies={["new_master_password"]}
          rules={[
            { required: true, message: t("settings.confirmMasterPasswordRequired") },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue("new_master_password") === value) {
                  return Promise.resolve();
                }
                return Promise.reject(new Error(t("settings.masterPasswordMismatch")));
              }
            })
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            prefix={<LockOutlined />}
            placeholder={t("settings.confirmMasterPasswordPlaceholder")}
          />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            {t("common.save")}
          </Button>
        </Form.Item>
      </Form>
    </Card>
  );
}
