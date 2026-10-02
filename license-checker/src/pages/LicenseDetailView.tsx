import { Alert, Descriptions, Tag } from "antd";
import type { LicensePayload } from "../types";
import type { VerifyFailureReason } from "../lib/verify";

const STATUS_COLORS: Record<string, string> = {
  active: "green",
  expired: "orange",
  revoked: "red",
  suspended: "volcano",
  hold: "gold"
};

function remainingSeconds(expiresAt: string | null): number | null {
  if (!expiresAt) {
    return null;
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) {
    return null;
  }
  return Math.max(0, Math.round((ms - Date.now()) / 1000));
}

export type DetailState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; payload: LicensePayload; verificationIntervalSeconds: number; checkedAt: string }
  | { kind: "failed"; reason: VerifyFailureReason | string; message: string };

export function LicenseDetailView({ state }: { state: DetailState }) {
  if (state.kind === "idle") {
    return <Alert type="info" message="Run Check to verify this license and load its details." showIcon />;
  }
  if (state.kind === "loading") {
    return <Alert type="info" message="Checking license..." showIcon />;
  }
  if (state.kind === "failed") {
    // Clear, specific "license failed to load" state on any verification,
    // field, or freshness failure (AC-24/25/44).
    return (
      <Alert
        type="error"
        showIcon
        message="License failed to load"
        description={`${state.reason}: ${state.message}`}
      />
    );
  }

  const { payload, verificationIntervalSeconds, checkedAt } = state;
  const remaining = remainingSeconds(payload.expires_at);
  return (
    <Descriptions bordered column={1} size="small">
      <Descriptions.Item label="Status">
        <Tag color={STATUS_COLORS[payload.status] ?? "default"}>{payload.status}</Tag>
      </Descriptions.Item>
      <Descriptions.Item label="Activation allowed">
        <Tag color={payload.activation_allowed ? "green" : "red"}>
          {payload.activation_allowed ? "yes" : "no"}
        </Tag>
      </Descriptions.Item>
      <Descriptions.Item label="Plan">{payload.plan}</Descriptions.Item>
      <Descriptions.Item label="Expires at">{payload.expires_at ?? "—"}</Descriptions.Item>
      <Descriptions.Item label="Remaining (s)">{remaining ?? "—"}</Descriptions.Item>
      <Descriptions.Item label="Grace period (s)">{payload.grace_period_seconds}</Descriptions.Item>
      <Descriptions.Item label="Last verification">{checkedAt}</Descriptions.Item>
      <Descriptions.Item label="Server time">{payload.server_time}</Descriptions.Item>
      <Descriptions.Item label="Verification interval (s)">{verificationIntervalSeconds}</Descriptions.Item>
      <Descriptions.Item label="Key id">{payload.key_id}</Descriptions.Item>
      <Descriptions.Item label="License id">{payload.license_id}</Descriptions.Item>
      <Descriptions.Item label="Product id">{payload.product_id}</Descriptions.Item>
      <Descriptions.Item label="Protocol version">{payload.protocol_version}</Descriptions.Item>
    </Descriptions>
  );
}
