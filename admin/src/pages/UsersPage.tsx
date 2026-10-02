import { CopyOutlined, KeyOutlined, LogoutOutlined, PlusOutlined, ProfileOutlined, SwapOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { ProTable } from "@ant-design/pro-components";
import { App as AntApp, Button, Checkbox, Drawer, Input, Modal, Select, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useRef, useState } from "react";
import { apiRequest } from "../api";
import { useI18n } from "../i18n";
import { USER_ROLE, getUserRoleValueEnum, type UserRole } from "../shared/constants";
import { formatDate } from "../shared/format";
import type { GeneratedPassword, UserItem, UserSessionList } from "../types";

export function UsersPage() {
  const { message, modal } = AntApp.useApp();
  const { t } = useI18n();
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<UserItem | null>(null);
  const [roleTarget, setRoleTarget] = useState<UserItem | null>(null);
  const [sessionsTarget, setSessionsTarget] = useState<UserItem | null>(null);

  const reload = () => actionRef.current?.reload();

  const columns: ProColumns<UserItem>[] = [
    { title: t("common.index"), valueType: "index", width: 72, search: false },
    { title: t("users.username"), dataIndex: "username", search: false },
    {
      title: t("users.role"),
      dataIndex: "role",
      width: 120,
      valueType: "select",
      valueEnum: getUserRoleValueEnum(t),
      render: (_, row) => (
        <Tag color={row.role === USER_ROLE.ADMIN ? "blue" : "default"}>
          {row.role === USER_ROLE.ADMIN ? t("users.roleAdmin") : t("users.roleStaff")}
        </Tag>
      )
    },
    {
      title: t("users.mustChangePassword"),
      dataIndex: "must_change_password",
      width: 150,
      search: false,
      render: (_, row) =>
        row.must_change_password ? (
          <Tag color="orange">{t("users.forcedPending")}</Tag>
        ) : (
          <Tag color="green">{t("users.forcedDone")}</Tag>
        )
    },
    { title: t("users.createdAt"), dataIndex: "created_at", width: 180, search: false, renderText: formatDate },
    {
      title: t("common.action"),
      valueType: "option",
      width: 320,
      fixed: "right",
      render: (_, row) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<ProfileOutlined />} onClick={() => setSessionsTarget(row)}>
            {t("users.sessions")}
          </Button>
          <Button size="small" type="link" icon={<KeyOutlined />} onClick={() => setResetTarget(row)}>
            {t("users.resetPassword")}
          </Button>
          <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => setRoleTarget(row)}>
            {t("users.changeRole")}
          </Button>
          <Button
            danger
            size="small"
            type="link"
            icon={<LogoutOutlined />}
            onClick={() => {
              modal.confirm({
                title: t("users.kickTitle"),
                content: t("users.kickConfirm", { username: row.username }),
                okText: t("users.kick"),
                okButtonProps: { danger: true },
                cancelText: t("common.cancel"),
                onOk: async () => {
                  await apiRequest(`/api/admin/users/${row.id}/kick`, { method: "POST", body: "{}" });
                  message.success(t("users.kickSucceeded"));
                  reload();
                }
              });
            }}
          >
            {t("users.kick")}
          </Button>
        </Space>
      )
    }
  ];

  return (
    <>
      <ProTable<UserItem>
        rowKey="id"
        actionRef={actionRef}
        columns={columns}
        cardBordered
        bordered
        search={false}
        scroll={{ x: 980 }}
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={false}
        toolBarRender={() => [
          <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
            {t("users.create")}
          </Button>
        ]}
        request={async () => {
          try {
            const data = await apiRequest<{ items: UserItem[] }>("/api/admin/users");
            return { data: data.items, total: data.items.length, success: true };
          } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.loadingFailed"));
            return { data: [], total: 0, success: false };
          }
        }}
      />
      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => {
          setCreateOpen(false);
          reload();
        }}
      />
      <ResetPasswordModal
        user={resetTarget}
        onClose={() => setResetTarget(null)}
        onSaved={() => {
          setResetTarget(null);
          reload();
        }}
      />
      <ChangeRoleModal
        user={roleTarget}
        onClose={() => setRoleTarget(null)}
        onSaved={() => {
          setRoleTarget(null);
          reload();
        }}
      />
      <SessionsDrawer user={sessionsTarget} onClose={() => setSessionsTarget(null)} />
    </>
  );
}

function CreateUserModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>(USER_ROLE.STAFF);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!username.trim()) {
      message.warning(t("users.usernameRequired"));
      return;
    }
    if (!password) {
      message.warning(t("users.passwordRequired"));
      return;
    }
    setSaving(true);
    try {
      await apiRequest("/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password, role })
      });
      message.success(t("users.createSucceeded"));
      onSaved();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("users.create")}
      okText={t("common.create")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      afterOpenChange={(visible) => {
        if (visible) {
          setUsername("");
          setPassword("");
          setRole(USER_ROLE.STAFF);
        }
      }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }} size={12}>
        <div>
          <Typography.Text>{t("users.username")}</Typography.Text>
          <input
            className="ant-input"
            style={{ width: "100%", marginTop: 4 }}
            value={username}
            placeholder={t("users.usernamePlaceholder")}
            onChange={(event) => setUsername(event.target.value)}
          />
        </div>
        <div>
          <Typography.Text>{t("users.password")}</Typography.Text>
          <input
            className="ant-input"
            type="password"
            style={{ width: "100%", marginTop: 4 }}
            value={password}
            placeholder={t("users.passwordPlaceholder")}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div>
          <Typography.Text>{t("users.role")}</Typography.Text>
          <Select
            style={{ width: "100%", marginTop: 4 }}
            value={role}
            onChange={(value) => setRole(value)}
            options={[
              { value: USER_ROLE.ADMIN, label: t("users.roleAdmin") },
              { value: USER_ROLE.STAFF, label: t("users.roleStaff") }
            ]}
          />
          <Typography.Text type="secondary">{t("users.roleHelp")}</Typography.Text>
        </div>
      </Space>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onSaved }: { user: UserItem | null; onClose: () => void; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [forceChange, setForceChange] = useState(true);
  const [generated, setGenerated] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const open = user !== null;

  async function submit() {
    if (!user) {
      return;
    }
    if (!password) {
      message.warning(t("users.resetPasswordPlaceholder"));
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/admin/users/${user.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ new_password: password, force_change: forceChange })
      });
      message.success(t("users.resetSucceeded"));
      onSaved();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.requestFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function generate() {
    if (!user) {
      return;
    }
    setGenerating(true);
    try {
      const result = await apiRequest<GeneratedPassword>(`/api/admin/users/${user.id}/password/generate`, {
        method: "POST",
        body: JSON.stringify({ force_change: forceChange })
      });
      setGenerated(result.password);
      message.success(t("users.resetSucceeded"));
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("users.resetGenerateFailed"));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("users.resetPasswordTitle")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      afterOpenChange={(visible) => {
        if (visible) {
          setPassword("");
          setForceChange(true);
          setGenerated(null);
        }
      }}
      onOk={() => void submit()}
      onCancel={() => (generated !== null ? onSaved() : onClose())}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{t("users.resetPasswordLabel")}</Typography.Text>
        <input
          className="ant-input"
          type="password"
          style={{ width: "100%" }}
          value={password}
          placeholder={t("users.resetPasswordPlaceholder")}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Checkbox checked={forceChange} onChange={(event) => setForceChange(event.target.checked)}>
          {t("users.resetForceChange")}
        </Checkbox>
        <Typography.Text type="secondary">{t("users.resetForceChangeHelp")}</Typography.Text>
        <Button icon={<ThunderboltOutlined />} loading={generating} onClick={() => void generate()}>
          {t("users.resetGenerate")}
        </Button>
        {generated !== null && (
          <>
            <Typography.Text>{t("users.resetGeneratedLabel")}</Typography.Text>
            <Space.Compact style={{ width: "100%" }}>
              <Input readOnly value={generated} />
              <Button
                icon={<CopyOutlined />}
                title={t("common.copy")}
                onClick={async () => {
                  await navigator.clipboard.writeText(generated);
                  message.success(t("common.copiedLabel", { label: t("users.resetGeneratedLabel") }));
                }}
              />
            </Space.Compact>
            <Typography.Text type="warning">{t("users.resetGeneratedHelp")}</Typography.Text>
          </>
        )}
        <Typography.Text type="secondary">{t("users.resetPasswordHelp")}</Typography.Text>
      </Space>
    </Modal>
  );
}

function ChangeRoleModal({ user, onClose, onSaved }: { user: UserItem | null; onClose: () => void; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [role, setRole] = useState<UserRole>(USER_ROLE.STAFF);
  const [saving, setSaving] = useState(false);
  const open = user !== null;

  async function submit() {
    if (!user) {
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/admin/users/${user.id}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role })
      });
      message.success(t("users.changeRoleSucceeded"));
      onSaved();
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.requestFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("users.changeRoleTitle")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      afterOpenChange={(visible) => {
        if (visible) {
          setRole(user?.role ?? USER_ROLE.STAFF);
        }
      }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{t("users.role")}</Typography.Text>
        <Select
          style={{ width: "100%" }}
          value={role}
          onChange={(value) => setRole(value)}
          options={[
            { value: USER_ROLE.ADMIN, label: t("users.roleAdmin") },
            { value: USER_ROLE.STAFF, label: t("users.roleStaff") }
          ]}
        />
        <Typography.Text type="secondary">{t("users.roleHelp")}</Typography.Text>
      </Space>
    </Modal>
  );
}

function SessionsDrawer({ user, onClose }: { user: UserItem | null; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [data, setData] = useState<UserSessionList | null>(null);
  const [loading, setLoading] = useState(false);
  const open = user !== null;

  async function load(target: UserItem) {
    setLoading(true);
    try {
      const result = await apiRequest<UserSessionList>(`/api/admin/users/${target.id}/sessions`);
      setData(result);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.loadingFailed"));
    } finally {
      setLoading(false);
    }
  }

  const columns: ColumnsType<UserSessionList["items"][number]> = [
    { title: t("common.index"), render: (_, __, index) => index + 1, width: 64 },
    {
      title: t("users.sessionState"),
      dataIndex: "active",
      width: 110,
      render: (_, row) => (
        <Tag color={row.active ? "green" : "default"}>{row.active ? t("users.sessionActive") : t("users.sessionRevoked")}</Tag>
      )
    },
    { title: t("users.sessionIssuedAt"), dataIndex: "issued_at", render: (value: string) => formatDate(value) },
    { title: t("users.sessionExpiresAt"), dataIndex: "expires_at", render: (value: string) => formatDate(value) },
    { title: t("users.sessionLastSeen"), dataIndex: "last_seen_at", render: (value: string | null) => formatDate(value) },
    { title: t("users.sessionUserAgent"), dataIndex: "user_agent", render: (value: string | null) => value ?? "-" }
  ];

  return (
    <Drawer
      width={760}
      open={open}
      title={user ? t("users.sessionsTitle", { username: user.username }) : undefined}
      onClose={onClose}
      afterOpenChange={(visible) => {
        if (visible && user) {
          void load(user);
        } else if (!visible) {
          setData(null);
        }
      }}
      destroyOnClose
    >
      <Table<UserSessionList["items"][number]>
        rowKey="id"
        size="small"
        bordered
        loading={loading}
        columns={columns}
        dataSource={data?.items ?? []}
        pagination={{ pageSize: 10, showSizeChanger: false }}
        scroll={{ x: 760 }}
      />
    </Drawer>
  );
}
