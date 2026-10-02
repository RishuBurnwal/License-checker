import {
  App as AntApp,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useMemo, useState } from "react";
import { ApiCallError, requestReport, requestVerify } from "../lib/api";
import { canonicalize } from "../lib/canonical";
import { verifyLicenseResponse } from "../lib/verify";
import {
  addLicense,
  listLicenses,
  removeLicense,
  suggestInstallationId,
  updateLastSeenServerTime
} from "../store/licenses";
import { REPORT_REASON_CODES } from "../types";
import type { LicensePayload, ReportReasonCode, StoredLicense } from "../types";
import { LicenseDetailView, type DetailState } from "./LicenseDetailView";

type AddFormValues = {
  label: string;
  serverBaseUrl: string;
  licenseKey: string;
  productId: string;
  installationId: string;
  appSecret: string;
};

export function LicenseListPage() {
  const { message } = AntApp.useApp();
  const [licenses, setLicenses] = useState<StoredLicense[]>(() => listLicenses());
  const [detailTarget, setDetailTarget] = useState<StoredLicense | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ kind: "idle" });
  const [reportTarget, setReportTarget] = useState<StoredLicense | null>(null);
  const [reportReason, setReportReason] = useState<ReportReasonCode>("PAYLOAD_TAMPERED");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addForm] = Form.useForm<AddFormValues>();

  function refresh() {
    setLicenses(listLicenses());
  }

  function handleAdd(values: AddFormValues) {
    addLicense({
      label: values.label.trim() || values.licenseKey.trim(),
      serverBaseUrl: values.serverBaseUrl.trim(),
      licenseKey: values.licenseKey.trim(),
      productId: values.productId.trim(),
      installationId: values.installationId.trim(),
      appSecret: values.appSecret
    });
    addForm.resetFields();
    addForm.setFieldValue("installationId", suggestInstallationId());
    refresh();
    message.success("License added");
  }

  async function fetchVerified(license: StoredLicense) {
    return requestVerify({
      serverBaseUrl: license.serverBaseUrl,
      appId: license.productId,
      appSecret: license.appSecret,
      licenseKey: license.licenseKey,
      productId: license.productId,
      installationId: license.installationId
    });
  }

  async function handleCheck(license: StoredLicense) {
    setDetailTarget(license);
    setDetailState({ kind: "loading" });
    setBusyId(license.id);
    try {
      const data = await fetchVerified(license);
      const result = await verifyLicenseResponse(data.payload, data.signature, {
        productId: license.productId,
        installationId: license.installationId,
        lastSeenServerTime: license.lastSeenServerTime,
        verificationIntervalSeconds: data.verification_interval_seconds
      });
      if (!result.ok) {
        setDetailState({ kind: "failed", reason: result.reason, message: result.message });
        return;
      }
      updateLastSeenServerTime(license.id, result.nextLastSeenServerTime);
      refresh();
      setDetailState({
        kind: "ok",
        payload: result.payload,
        verificationIntervalSeconds: data.verification_interval_seconds,
        checkedAt: new Date().toISOString()
      });
    } catch (error) {
      const reason = error instanceof ApiCallError ? error.code : "NETWORK_ERROR";
      const text = error instanceof Error ? error.message : "request failed";
      setDetailState({ kind: "failed", reason, message: text });
    } finally {
      setBusyId(null);
    }
  }

  // Tamper-test: take a GENUINE signed response, mutate one signed field, then
  // re-run the local verifier and show it REJECTING the tampered payload (AC-45).
  async function handleTamper(license: StoredLicense) {
    setDetailTarget(license);
    setDetailState({ kind: "loading" });
    setBusyId(license.id);
    try {
      const data = await fetchVerified(license);
      const tampered: LicensePayload = { ...data.payload, expires_at: "2099-12-31T23:59:59.000Z" };
      // Prove the mutation actually changed the canonical bytes.
      const sameBytes = bytesEqual(canonicalize(data.payload), canonicalize(tampered));
      const result = await verifyLicenseResponse(tampered, data.signature, {
        productId: license.productId,
        installationId: license.installationId,
        lastSeenServerTime: license.lastSeenServerTime,
        verificationIntervalSeconds: data.verification_interval_seconds
      });
      if (result.ok) {
        setDetailState({
          kind: "failed",
          reason: "TAMPER_TEST_UNEXPECTED",
          message: "verifier accepted a tampered payload — this should never happen"
        });
        return;
      }
      setDetailState({
        kind: "failed",
        reason: `TAMPER_REJECTED (${result.reason})`,
        message: `Mutated expires_at on a genuine response${sameBytes ? "" : " (canonical bytes changed)"}; the verifier rejected it: ${result.message}`
      });
      message.success("Tamper test passed: the verifier rejected the mutated payload");
    } catch (error) {
      const text = error instanceof Error ? error.message : "request failed";
      setDetailState({ kind: "failed", reason: "TAMPER_TEST_ERROR", message: text });
    } finally {
      setBusyId(null);
    }
  }

  function openReport(license: StoredLicense) {
    setReportTarget(license);
    setReportReason("PAYLOAD_TAMPERED");
  }

  async function submitReport() {
    if (!reportTarget) {
      return;
    }
    const license = reportTarget;
    setBusyId(license.id);
    try {
      const result = await requestReport({
        serverBaseUrl: license.serverBaseUrl,
        appId: license.productId,
        appSecret: license.appSecret,
        installationId: license.installationId,
        licenseKey: license.licenseKey,
        reasonCode: reportReason
      });
      message.success(`Reported. recorded=${result.recorded}, held=${result.held}`);
      setReportTarget(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "report failed";
      message.error(text);
    } finally {
      setBusyId(null);
    }
  }

  function handleRemove(license: StoredLicense) {
    removeLicense(license.id);
    if (detailTarget?.id === license.id) {
      setDetailTarget(null);
      setDetailState({ kind: "idle" });
    }
    refresh();
  }

  const columns: ColumnsType<StoredLicense> = useMemo(
    () => [
      { title: "Label", dataIndex: "label", key: "label" },
      { title: "Server", dataIndex: "serverBaseUrl", key: "serverBaseUrl", ellipsis: true },
      { title: "Product", dataIndex: "productId", key: "productId" },
      {
        title: "Last seen server time",
        dataIndex: "lastSeenServerTime",
        key: "lastSeenServerTime",
        render: (value: string | null) => value ?? "—"
      },
      {
        title: "Actions",
        key: "actions",
        render: (_, license) => (
          <Space wrap>
            <Button size="small" type="primary" loading={busyId === license.id} onClick={() => handleCheck(license)}>
              Check
            </Button>
            <Button size="small" onClick={() => handleTamper(license)}>
              Tamper test
            </Button>
            <Button size="small" onClick={() => openReport(license)}>
              Report
            </Button>
            <Button size="small" danger onClick={() => handleRemove(license)}>
              Remove
            </Button>
          </Space>
        )
      }
    ],
    [busyId]
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={3}>License Checker</Typography.Title>

      <Card title="Add License">
        <Form<AddFormValues>
          form={addForm}
          layout="vertical"
          initialValues={{ installationId: suggestInstallationId() }}
          onFinish={handleAdd}
        >
          <Form.Item label="Label" name="label">
            <Input placeholder="A name for this license (optional)" />
          </Form.Item>
          <Form.Item label="Server base URL" name="serverBaseUrl" rules={[{ required: true, message: "Server base URL is required" }]}>
            <Input placeholder="https://your-license-server.example" />
          </Form.Item>
          <Form.Item label="License Key" name="licenseKey" rules={[{ required: true, message: "License key is required" }]}>
            <Input placeholder="LM-XXXXX-XXXXX-XXXXX-XXXXX" />
          </Form.Item>
          <Form.Item label="Product ID (app_id)" name="productId" rules={[{ required: true, message: "Product ID is required" }]}>
            <Input placeholder="app_xxx" />
          </Form.Item>
          <Form.Item label="Installation ID" name="installationId" rules={[{ required: true, message: "Installation ID is required" }]}>
            <Input placeholder="stable-installation-id" />
          </Form.Item>
          <Form.Item label="App Secret" name="appSecret" rules={[{ required: true, message: "App secret is required" }]}>
            <Input.Password placeholder="sec_xxx (kept on this machine only)" />
          </Form.Item>
          <Button type="primary" htmlType="submit">
            Add License
          </Button>
        </Form>
      </Card>

      <Card title="Licenses">
        <Table<StoredLicense> rowKey="id" dataSource={licenses} columns={columns} pagination={false} />
      </Card>

      {detailTarget && (
        <Card title={`Details — ${detailTarget.label}`}>
          <LicenseDetailView state={detailState} />
        </Card>
      )}

      <Modal
        title="Report a problem"
        open={reportTarget !== null}
        onCancel={() => setReportTarget(null)}
        onOk={submitReport}
        okText="Send report"
        confirmLoading={busyId !== null && reportTarget !== null}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>Reason code</Typography.Text>
          <Select<ReportReasonCode>
            style={{ width: "100%" }}
            value={reportReason}
            onChange={setReportReason}
            options={REPORT_REASON_CODES.map((code) => ({ label: code, value: code }))}
          />
        </Space>
      </Modal>
    </Space>
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}
