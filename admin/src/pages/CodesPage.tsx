import {
  CheckCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  FieldTimeOutlined,
  NumberOutlined,
  PauseCircleOutlined,
  ProfileOutlined,
  StopOutlined
} from "@ant-design/icons";
import type { ActionType, ProColumns } from "@ant-design/pro-components";
import { ProTable } from "@ant-design/pro-components";
import { App as AntApp, Button, DatePicker, Descriptions, Drawer, InputNumber, Modal, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { useRef, useState } from "react";
import { apiRequest, toQuery } from "../api";
import { useCatalogs } from "../hooks/useCatalogs";
import { formatAppOptionLabel, formatAppPlatform } from "../shared/appPlatform";
import { useI18n } from "../i18n";
import {
  CODE_BULK_ACTION,
  CODE_STATUS,
  CODE_TOGGLE_STATUS,
  getCodeListStatusValueEnum,
  getSecurityEventTypeLabel,
  getSecurityReasonCodeLabel,
  type CodeBulkAction
} from "../shared/constants";
import { formatDate, isExpired, statusTag } from "../shared/format";
import { formatPlanLabel } from "../shared/plan";
import type { ListResponse } from "../shared/types";
import type { CodeActivationList, CodeItem, SecurityEventItem } from "../types";

const DISABLE_BUTTON_STYLE = { color: "#d48806" };
const DISABLE_CONFIRM_BUTTON_STYLE = { backgroundColor: "#d48806", borderColor: "#d48806" };
const ENABLE_BUTTON_STYLE = { color: "#389e0d" };
const ENABLE_CONFIRM_BUTTON_STYLE = { backgroundColor: "#389e0d", borderColor: "#389e0d" };
const HOLD_BUTTON_STYLE = { color: "#d4380d" };
const HOLD_CONFIRM_BUTTON_STYLE = { backgroundColor: "#d4380d", borderColor: "#d4380d" };

export function CodesPage() {
  const { message, modal } = AntApp.useApp();
  const { t } = useI18n();
  const { apps, plans } = useCatalogs();
  const actionRef = useRef<ActionType | undefined>(undefined);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [validityTarget, setValidityTarget] = useState<CodeItem | null>(null);
  const [maxActivationsTarget, setMaxActivationsTarget] = useState<CodeItem | null>(null);
  const [detailTarget, setDetailTarget] = useState<CodeItem | null>(null);
  const selectedCount = selectedRowKeys.length;

  const reload = () => actionRef.current?.reload();

  const columns: ProColumns<CodeItem>[] = [
    {
      title: t("common.index"),
      valueType: "index",
      width: 72,
      search: false
    },
    {
      title: t("common.keyword"),
      dataIndex: "query",
      hideInTable: true,
      fieldProps: { placeholder: t("codes.searchPlaceholder") }
    },
    {
      title: t("common.app"),
      dataIndex: "app_id",
      hideInTable: true,
      valueType: "select",
      fieldProps: {
        options: apps.map((app) => ({ value: app.app_id, label: formatAppOptionLabel(app, t) }))
      }
    },
    {
      title: t("common.plan"),
      dataIndex: "plan_code",
      hideInTable: true,
      valueType: "select",
      fieldProps: {
        options: plans.map((plan) => ({ value: plan.code, label: plan.name }))
      }
    },
    {
      title: t("codes.suffix"),
      dataIndex: "code_suffix",
      width: 96,
      search: false,
      render: (_, row) => <Typography.Text code>{row.code_suffix}</Typography.Text>
    },
    {
      title: t("common.status"),
      dataIndex: "status",
      width: 96,
      valueType: "select",
      valueEnum: getCodeListStatusValueEnum(t),
      render: (_, row) => statusTag(row, t)
    },
    {
      title: t("codes.bindingStatus"),
      dataIndex: "device_hash",
      width: 104,
      search: false,
      render: (_, row) => (row.device_hash ? <Tag color="green">{t("status.bound")}</Tag> : <Tag color="default">{t("status.unbound")}</Tag>)
    },
    {
      title: t("common.app"),
      dataIndex: "app_name",
      width: 240,
      search: false,
      render: (_, row) => `${row.app_name} / ${formatAppPlatform(row.app_platform, t)}`
    },
    {
      title: t("common.plan"),
      dataIndex: "plan_name",
      width: 180,
      search: false,
      render: (_, row) => formatPlanLabel(row, t)
    },
    { title: t("codes.activatedAt"), dataIndex: "activated_at", width: 170, search: false, renderText: formatDate },
    { title: t("codes.expiresAt"), dataIndex: "expires_at", width: 170, search: false, renderText: formatDate },
    { title: t("codes.disabledAt"), dataIndex: "disabled_at", width: 170, search: false, renderText: formatDate },
    { title: t("codes.rebindCount"), dataIndex: "rebind_count", width: 72, search: false },
    {
      title: t("common.action"),
      valueType: "option",
      width: 420,
      fixed: "right",
      render: (_, row) => (
        <Space size={4} wrap>
          <Button
            size="small"
            type="link"
            icon={<ProfileOutlined />}
            aria-label={t("codes.detail")}
            onClick={() => setDetailTarget(row)}
          >
            {t("codes.detail")}
          </Button>
          <Button
            size="small"
            type="link"
            icon={<DisconnectOutlined />}
            aria-label={t("codes.unbindDevice")}
            disabled={!canManuallyUnbind(row)}
            onClick={() => {
              modal.confirm({
                title: t("codes.unbindDevice"),
                content: t("codes.unbindConfirm", { suffix: row.code_suffix }),
                okText: t("common.unbind"),
                cancelText: t("common.cancel"),
                onOk: async () => {
                  await apiRequest(`/api/admin/codes/${row.id}/unbind-device`, { method: "PATCH" });
                  message.success(t("common.unbind"));
                  reload();
                }
              });
            }}
          >
            {t("common.unbind")}
          </Button>
          <Button
            size="small"
            style={row.hold_at ? ENABLE_BUTTON_STYLE : HOLD_BUTTON_STYLE}
            type="link"
            icon={row.hold_at ? <CheckCircleOutlined /> : <PauseCircleOutlined />}
            aria-label={row.hold_at ? t("codes.approve") : t("codes.hold")}
            disabled={row.status === CODE_STATUS.DELETED}
            onClick={() => {
              const toApprove = Boolean(row.hold_at);
              modal.confirm({
                title: toApprove ? t("codes.approveTitle") : t("codes.holdTitle"),
                content: toApprove
                  ? t("codes.approveConfirm", { suffix: row.code_suffix })
                  : t("codes.holdConfirm", { suffix: row.code_suffix }),
                okText: toApprove ? t("codes.approve") : t("codes.hold"),
                okButtonProps: { style: toApprove ? ENABLE_CONFIRM_BUTTON_STYLE : HOLD_CONFIRM_BUTTON_STYLE },
                cancelText: t("common.cancel"),
                onOk: async () => {
                  await apiRequest(`/api/admin/codes/${row.id}/${toApprove ? "approve" : "hold"}`, {
                    method: "PATCH",
                    body: "{}"
                  });
                  message.success(toApprove ? t("codes.approveSucceeded") : t("codes.holdSucceeded"));
                  reload();
                }
              });
            }}
          >
            {row.hold_at ? t("codes.approve") : t("codes.hold")}
          </Button>
          <Button
            size="small"
            type="link"
            icon={<FieldTimeOutlined />}
            aria-label={t("codes.validity")}
            disabled={row.status !== CODE_STATUS.ACTIVE}
            onClick={() => setValidityTarget(row)}
          >
            {t("codes.validity")}
          </Button>
          <Button
            size="small"
            type="link"
            icon={<NumberOutlined />}
            aria-label={t("codes.maxActivations")}
            disabled={row.status === CODE_STATUS.DELETED}
            onClick={() => setMaxActivationsTarget(row)}
          >
            {t("codes.maxActivations")}
          </Button>
          <Button
            size="small"
            style={row.disabled_at ? ENABLE_BUTTON_STYLE : DISABLE_BUTTON_STYLE}
            type="link"
            icon={row.disabled_at ? <CheckCircleOutlined /> : <StopOutlined />}
            aria-label={row.disabled_at ? t("codes.enableCode") : t("codes.disableCode")}
            disabled={row.status === CODE_STATUS.DELETED}
            onClick={() => {
              const disabled = !row.disabled_at;
              modal.confirm({
                title: disabled ? t("codes.disableCode") : t("codes.enableCode"),
                content: disabled
                  ? t("codes.disableConfirm", { suffix: row.code_suffix })
                  : t("codes.enableConfirm", { suffix: row.code_suffix }),
                okText: disabled ? t("common.disable") : t("common.enable"),
                okButtonProps: {
                  style: disabled ? DISABLE_CONFIRM_BUTTON_STYLE : ENABLE_CONFIRM_BUTTON_STYLE
                },
                cancelText: t("common.cancel"),
                onOk: async () => {
                  await apiRequest(`/api/admin/codes/${row.id}/status`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      status: disabled ? CODE_TOGGLE_STATUS.DISABLED : CODE_TOGGLE_STATUS.ENABLED
                    })
                  });
                  message.success(disabled ? t("common.disabled") : t("common.enabled"));
                  reload();
                }
              });
            }}
          >
            {row.disabled_at ? t("common.enable") : t("common.disable")}
          </Button>
          <Button
            danger
            size="small"
            type="link"
            icon={<DeleteOutlined />}
            aria-label={t("codes.deleteCode")}
            disabled={row.status === CODE_STATUS.DELETED}
            onClick={() => {
              modal.confirm({
                title: t("codes.deleteCode"),
                content: t("codes.deleteConfirm", { suffix: row.code_suffix }),
                okText: t("common.delete"),
                okButtonProps: { danger: true },
                cancelText: t("common.cancel"),
                onOk: async () => {
                  await apiRequest(`/api/admin/codes/${row.id}`, { method: "DELETE" });
                  message.success(t("common.deleted"));
                  reload();
                }
              });
            }}
          >
            {t("common.delete")}
          </Button>
        </Space>
      )
    }
  ];

  return (
    <>
      <ProTable<CodeItem>
        rowKey="id"
        actionRef={actionRef}
        columns={columns}
        cardBordered
        bordered
        scroll={{ x: 1810 }}
        rowSelection={{
          selectedRowKeys,
          getCheckboxProps: (row) => ({ disabled: row.status === CODE_STATUS.DELETED }),
          onChange: (keys) => setSelectedRowKeys(keys)
        }}
        search={{ labelWidth: 72, defaultCollapsed: false }}
        options={{ density: true, fullScreen: true, reload: true, setting: true }}
        pagination={{ defaultPageSize: 20, showSizeChanger: true }}
        tableAlertRender={false}
        tableAlertOptionRender={false}
        toolBarRender={() => [
          <Space key="selected-actions" size={8} wrap>
            <Typography.Text type={selectedCount > 0 ? undefined : "secondary"}>{t("codes.selected", { count: selectedCount })}</Typography.Text>
            <Button
              size="small"
              icon={<CheckCircleOutlined />}
              disabled={selectedCount === 0}
              onClick={() => bulkUpdateCodes(CODE_BULK_ACTION.ENABLE, selectedRowKeys)}
            >
              {t("codes.bulkEnable")}
            </Button>
            <Button
              size="small"
              icon={<StopOutlined />}
              style={DISABLE_BUTTON_STYLE}
              disabled={selectedCount === 0}
              onClick={() => bulkUpdateCodes(CODE_BULK_ACTION.DISABLE, selectedRowKeys)}
            >
              {t("codes.bulkDisable")}
            </Button>
            <Button
              danger
              size="small"
              icon={<DeleteOutlined />}
              disabled={selectedCount === 0}
              onClick={() => bulkUpdateCodes(CODE_BULK_ACTION.DELETE, selectedRowKeys)}
            >
              {t("codes.bulkDelete")}
            </Button>
            <Button size="small" icon={<CloseOutlined />} disabled={selectedCount === 0} onClick={() => setSelectedRowKeys([])}>
              {t("codes.clearSelection")}
            </Button>
          </Space>
        ]}
        request={async (params) => {
          try {
            const data = await apiRequest<ListResponse<CodeItem>>(
              `/api/admin/codes${toQuery({
                query: params.query as string | undefined,
                app_id: params.app_id as string | undefined,
                plan_code: params.plan_code as string | undefined,
                status: params.status as string | undefined,
                page: params.current,
                page_size: params.pageSize
              })}`
            );
            return { data: data.items, total: data.total, success: true };
          } catch (error) {
            message.error(error instanceof Error ? error.message : t("common.loadingFailed"));
            return { data: [], total: 0, success: false };
          }
        }}
      />
      <ValidityModal
        code={validityTarget}
        onClose={() => setValidityTarget(null)}
        onSaved={() => {
          setValidityTarget(null);
          reload();
        }}
      />
      <MaxActivationsModal
        code={maxActivationsTarget}
        onClose={() => setMaxActivationsTarget(null)}
        onSaved={() => {
          setMaxActivationsTarget(null);
          reload();
        }}
      />
      <CodeDetailDrawer code={detailTarget} onClose={() => setDetailTarget(null)} />
    </>
  );

  function bulkUpdateCodes(action: CodeBulkAction, keys: React.Key[]) {
    if (keys.length === 0) {
      message.warning(t("codes.selectFirst"));
      return;
    }
    const actionText =
      action === CODE_BULK_ACTION.DELETE ? t("common.delete") : action === CODE_BULK_ACTION.DISABLE ? t("common.disable") : t("common.enable");
    modal.confirm({
      title: t("codes.bulkTitle", { action: actionText }),
      content: t("codes.bulkConfirm", { action: actionText, count: keys.length }),
      okText: actionText,
      okButtonProps:
        action === CODE_BULK_ACTION.DELETE
          ? { danger: true }
          : action === CODE_BULK_ACTION.DISABLE
            ? { style: DISABLE_CONFIRM_BUTTON_STYLE }
            : undefined,
      cancelText: t("common.cancel"),
      onOk: async () => {
        const result = await apiRequest<{ action: string; requested: number; updated: number }>("/api/admin/codes/bulk", {
          method: "POST",
          body: JSON.stringify({
            action,
            ids: keys.map((key) => Number(key))
          })
        });
        message.success(t("codes.bulkSucceeded", { action: actionText, count: result.updated }));
        setSelectedRowKeys([]);
        reload();
      }
    });
  }
}

function ValidityModal({ code, onClose, onSaved }: { code: CodeItem | null; onClose: () => void; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [value, setValue] = useState<Dayjs | null>(null);
  const [saving, setSaving] = useState(false);
  const open = code !== null;

  async function submit() {
    if (!code) {
      return;
    }
    if (!value) {
      message.warning(t("codes.validityRequired"));
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/admin/codes/${code.id}/validity`, {
        method: "PATCH",
        body: JSON.stringify({ expires_at: value.toISOString() })
      });
      message.success(t("codes.validitySucceeded"));
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
      title={t("codes.validityTitle")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      afterOpenChange={(visible) => {
        if (visible) {
          setValue(code?.expires_at ? dayjs(code.expires_at) : null);
        }
      }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{t("codes.validityLabel")}</Typography.Text>
        <DatePicker
          showTime
          style={{ width: "100%" }}
          value={value}
          placeholder={t("codes.validityPlaceholder")}
          onChange={(next) => setValue(next)}
        />
      </Space>
    </Modal>
  );
}

function MaxActivationsModal({ code, onClose, onSaved }: { code: CodeItem | null; onClose: () => void; onSaved: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [value, setValue] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const open = code !== null;

  async function submit() {
    if (!code) {
      return;
    }
    setSaving(true);
    try {
      await apiRequest(`/api/admin/codes/${code.id}/max-activations`, {
        method: "PATCH",
        body: JSON.stringify({ max_activations: value })
      });
      message.success(t("codes.maxActivationsSucceeded"));
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
      title={t("codes.maxActivationsTitle")}
      okText={t("common.save")}
      cancelText={t("common.cancel")}
      confirmLoading={saving}
      afterOpenChange={(visible) => {
        if (visible) {
          setValue(code?.max_activations ?? null);
        }
      }}
      onOk={() => void submit()}
      onCancel={onClose}
      destroyOnClose
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        <Typography.Text>{t("codes.maxActivationsLabel")}</Typography.Text>
        <InputNumber
          min={1}
          precision={0}
          style={{ width: "100%" }}
          value={value}
          placeholder={t("codes.maxActivationsPlaceholder")}
          onChange={(next) => setValue(typeof next === "number" ? next : null)}
        />
        <Typography.Text type="secondary">{t("codes.maxActivationsHelp")}</Typography.Text>
      </Space>
    </Modal>
  );
}

function CodeDetailDrawer({ code, onClose }: { code: CodeItem | null; onClose: () => void }) {
  const { message } = AntApp.useApp();
  const { t } = useI18n();
  const [activations, setActivations] = useState<CodeActivationList | null>(null);
  const [events, setEvents] = useState<SecurityEventItem[]>([]);
  const [loading, setLoading] = useState(false);
  const open = code !== null;

  async function load(target: CodeItem) {
    setLoading(true);
    try {
      const [activationData, eventData] = await Promise.all([
        apiRequest<CodeActivationList>(`/api/admin/codes/${target.id}/activations`),
        apiRequest<ListResponse<SecurityEventItem>>(`/api/admin/codes/${target.id}/security-events`)
      ]);
      setActivations(activationData);
      setEvents(eventData.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : t("common.loadingFailed"));
    } finally {
      setLoading(false);
    }
  }

  const limitText = (max: number | null) => (max === null ? t("codes.detailSingleDevice") : String(max));

  const activationColumns: ColumnsType<CodeActivationList["items"][number]> = [
    { title: t("common.index"), render: (_, __, index) => index + 1, width: 64 },
    {
      title: t("codes.activationSlotStatus"),
      dataIndex: "status",
      width: 110,
      render: (value: string) => (
        <Tag color={value === "active" ? "green" : "default"}>{value === "active" ? t("codes.slotActive") : t("codes.slotReleased")}</Tag>
      )
    },
    { title: t("codes.activationActivatedAt"), dataIndex: "activated_at", render: (value: string) => formatDate(value) },
    { title: t("codes.activationLastSeen"), dataIndex: "last_seen_at", render: (value: string) => formatDate(value) },
    { title: t("codes.activationReleasedAt"), dataIndex: "released_at", render: (value: string | null) => formatDate(value) }
  ];

  const eventColumns: ColumnsType<SecurityEventItem> = [
    { title: t("security.eventType"), dataIndex: "event_type", width: 130, render: (value: string) => getSecurityEventTypeLabel(value, t) },
    {
      title: t("security.reasonCode"),
      dataIndex: "reason_code",
      width: 150,
      render: (value: string | null) => (value ? getSecurityReasonCodeLabel(value, t) : "-")
    },
    { title: t("common.result"), dataIndex: "result", width: 90, render: (value: string) => <Tag color={value === "success" ? "green" : "red"}>{value === "success" ? t("common.success") : t("common.failure")}</Tag> },
    { title: t("security.protocolVersion"), dataIndex: "protocol_version", width: 90, render: (value: number | null) => (value ?? "-") },
    { title: t("security.keyId"), dataIndex: "key_id", width: 150, render: (value: string | null) => value ?? "-" },
    {
      title: t("security.hasInstallation"),
      dataIndex: "has_installation",
      width: 110,
      render: (value: boolean) => (value ? <Tag color="blue">{t("security.installationPresent")}</Tag> : <Tag color="default">{t("security.installationAbsent")}</Tag>)
    },
    { title: t("common.message"), dataIndex: "message", render: (value: string | null) => value ?? "-" },
    { title: t("common.time"), dataIndex: "created_at", width: 170, render: (value: string) => formatDate(value) }
  ];

  return (
    <Drawer
      width={760}
      open={open}
      title={code ? t("codes.detailTitle") : undefined}
      onClose={onClose}
      afterOpenChange={(visible) => {
        if (visible && code) {
          void load(code);
        } else if (!visible) {
          setActivations(null);
          setEvents([]);
        }
      }}
      destroyOnClose
    >
      {code && (
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Descriptions title={t("codes.detailSummary")} bordered size="small" column={1}>
            <Descriptions.Item label={t("codes.suffix")}>
              <Typography.Text code>{code.code_suffix}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label={t("codes.detailStatus")}>{statusTag(code, t)}</Descriptions.Item>
            <Descriptions.Item label={t("codes.detailHoldState")}>
              {code.hold_at ? <Tag color="volcano">{t("status.hold")}</Tag> : <Tag color="default">{t("status.active")}</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label={t("codes.detailHoldReason")}>
              {code.hold_reason_code ? getSecurityReasonCodeLabel(code.hold_reason_code, t) : "-"}
            </Descriptions.Item>
            <Descriptions.Item label={t("codes.detailExpiresAt")}>{formatDate(code.expires_at)}</Descriptions.Item>
            <Descriptions.Item label={t("codes.detailMaxActivations")}>{limitText(code.max_activations)}</Descriptions.Item>
            <Descriptions.Item label={t("codes.detailActiveSlots")}>
              {activations ? t("codes.slotUsage", { active: activations.active_count, limit: limitText(activations.max_activations) }) : "-"}
            </Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Title level={5}>{t("codes.activationsTitle")}</Typography.Title>
            <Table
              rowKey="id"
              size="small"
              bordered
              loading={loading}
              columns={activationColumns}
              dataSource={activations?.items ?? []}
              pagination={false}
            />
          </div>
          <div>
            <Typography.Title level={5}>{t("security.history")}</Typography.Title>
            <Table<SecurityEventItem>
              rowKey="id"
              size="small"
              bordered
              loading={loading}
              columns={eventColumns}
              dataSource={events}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              scroll={{ x: 980 }}
            />
          </div>
        </Space>
      )}
    </Drawer>
  );
}

function canManuallyUnbind(row: CodeItem) {
  return row.status === CODE_STATUS.ACTIVE && !row.disabled_at && !isExpired(row.expires_at) && Boolean(row.device_hash);
}
