import { ReloadOutlined, StopOutlined } from "@ant-design/icons";
import { App as AntApp, Button, Popconfirm, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../api";
import { useI18n } from "../i18n";
import { formatDate } from "../shared/format";

export type AdminSessionItem = {
  id: number;
  code_id: number;
  code_suffix: string;
  app_public_id: string;
  app_name: string;
  status: "active" | "kicked" | "expired";
  started_at: string;
  last_seen_at: string;
  lease_expires_at: string;
  kicked_at: string | null;
  device_bound: boolean;
};

type SessionList = { items: AdminSessionItem[] };

export function SessionsPage() {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [items, setItems] = useState<AdminSessionItem[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<SessionList>("/api/admin/sessions");
      setItems(data.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.loadingFailed"));
    } finally {
      setLoading(false);
    }
  }, [message, t]);

  useEffect(() => { void load(); }, [load]);

  async function kick(sessionId: number) {
    try {
      await apiRequest<{ kicked: boolean }>(`/api/admin/sessions/${sessionId}/kick`, { method: "POST", body: "{}" });
      message.success(t("sessions.kicked"));
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.requestFailed"));
    }
  }

  const columns: ColumnsType<AdminSessionItem> = [
    { title: t("common.index"), render: (_, __, index) => index + 1, width: 72 },
    { title: t("sessions.app"), dataIndex: "app_name", render: (value, row) => <Space direction="vertical" size={0}><Typography.Text strong>{value}</Typography.Text><Typography.Text type="secondary">{row.app_public_id}</Typography.Text></Space> },
    { title: t("sessions.code"), dataIndex: "code_suffix", width: 130 },
    { title: t("sessions.status"), dataIndex: "status", width: 110, render: (value) => <Tag color={value === "active" ? "green" : "red"}>{value}</Tag> },
    { title: t("sessions.started"), dataIndex: "started_at", render: (value) => formatDate(value) },
    { title: t("sessions.lastSeen"), dataIndex: "last_seen_at", render: (value) => formatDate(value) },
    { title: t("sessions.leaseExpires"), dataIndex: "lease_expires_at", render: (value) => formatDate(value) },
    { title: t("common.action"), key: "action", width: 120, render: (_, row) => <Popconfirm title={t("sessions.kickConfirm")} onConfirm={() => kick(row.id)} okText={t("sessions.kick")}><Button danger icon={<StopOutlined />} size="small">{t("sessions.kick")}</Button></Popconfirm> }
  ];

  return <div className="space-y-4">
    <div className="flex items-center justify-between"><div><Typography.Title level={3} style={{ margin: 0 }}>{t("sessions.title")}</Typography.Title><Typography.Text type="secondary">{t("sessions.subtitle")}</Typography.Text></div><Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>{t("common.reload")}</Button></div>
    <Table<AdminSessionItem> rowKey="id" columns={columns} dataSource={items} loading={loading} bordered pagination={{ pageSize: 20, showSizeChanger: true }} scroll={{ x: 1080 }} />
  </div>;
}
