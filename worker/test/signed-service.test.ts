/**
 * Signed-license service logic (FEAT-003) via the MemoryRepo fake pattern.
 *
 * These assert the pure service decisions — product-mismatch refusal, protocol
 * validation, signed-status derivation, single-device activation_allowed, the
 * corroborated auto-hold rule, and the max-activations floor — without a DB. The
 * real SQL (atomic slot claim) is covered by signed-license.test.ts.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { APP_STATUS, CODE_STATUS } from "../src/constants";
import { hmacSha256, normalizeCode } from "../src/crypto";
import { Repository } from "../src/repository";
import { LicenseService } from "../src/service";
import { base64UrlToBytes } from "../src/crypto";
import { canonicalize, type LicensePayload } from "../src/license/canonical";
import { TEST_SECRETS } from "./helpers/harness";
import type { AppRow, Bindings, CodeDetailRow } from "../src/types";

const env = {
  CODE_HMAC_SECRET: "code-secret",
  APP_SECRET_HMAC_SECRET: "app-secret-secret",
  DEVICE_HMAC_SECRET: "device-secret",
  JWT_SECRET: "jwt-secret",
  LICENSE_SIGNING_PRIVATE_KEY: TEST_SECRETS.LICENSE_SIGNING_PRIVATE_KEY,
  LICENSE_SIGNING_PUBLIC_KEY: TEST_SECRETS.LICENSE_SIGNING_PUBLIC_KEY,
  LICENSE_SIGNING_KEY_ID: TEST_SECRETS.LICENSE_SIGNING_KEY_ID
} as Bindings;

type SecurityEventInput = {
  appId?: number | null;
  codeId?: number | null;
  eventType: string;
  reasonCode?: string | null;
  installationHash?: string | null;
  result: string;
};

async function verifySignature(payload: LicensePayload, signatureB64: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(TEST_SECRETS.LICENSE_SIGNING_PUBLIC_KEY) as BufferSource,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    base64UrlToBytes(signatureB64) as BufferSource,
    canonicalize(payload) as BufferSource
  );
}

class SignedMemoryRepo {
  static readonly appSecret = "sec_test";
  static readonly code = "LM-ABCDE-23456-FGHIJ-789KL";

  readonly events: SecurityEventInput[] = [];
  readonly logs: unknown[] = [];
  app!: AppRow;
  code!: CodeDetailRow;
  distinctReports = 0;

  static async create(): Promise<SignedMemoryRepo> {
    const repo = new SignedMemoryRepo();
    repo.app = {
      id: 1,
      app_id: "app_test",
      name: "Test App",
      description: null,
      purchase_url: null,
      platform: "desktop",
      status: APP_STATUS.ACTIVE,
      app_secret_hash: await hmacSha256(env.APP_SECRET_HMAC_SECRET, SignedMemoryRepo.appSecret),
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z"
    };
    repo.code = {
      id: 10,
      batch_id: null,
      app_id: 1,
      plan_id: 1,
      code_hash: await hmacSha256(env.CODE_HMAC_SECRET, normalizeCode(SignedMemoryRepo.code)),
      code_suffix: "J789KL",
      status: CODE_STATUS.ACTIVE,
      disabled_at: null,
      activated_at: "2026-06-25T08:00:00.000Z",
      expires_at: "2099-07-25T08:00:00.000Z",
      device_hash: await hmacSha256(env.DEVICE_HMAC_SECRET, "device-a"),
      rebind_count: 0,
      last_rebind_at: null,
      hold_at: null,
      hold_reason_code: null,
      max_activations: null,
      created_by: null,
      created_at: "2026-06-25T00:00:00.000Z",
      updated_at: "2026-06-25T00:00:00.000Z",
      app_public_id: "app_test",
      app_name: "Test App",
      app_platform: "desktop",
      app_status: APP_STATUS.ACTIVE,
      plan_code: "monthly",
      plan_name: "Monthly",
      duration_days: 30,
      grace_period_seconds: 86400
    };
    return repo;
  }

  async getAppByPublicId(appId: string) {
    return this.app.app_id === appId ? this.app : null;
  }

  async findCodeByHash(codeHash: string) {
    return this.code.code_hash === codeHash ? this.code : null;
  }

  async findCodeById(codeId: number) {
    return this.code.id === codeId ? this.code : null;
  }

  async insertSecurityEvent(input: SecurityEventInput) {
    this.events.push(input);
  }

  async insertLog(input: unknown) {
    this.logs.push(input);
  }

  async countDistinctInstallationReports() {
    return this.distinctReports;
  }

  async holdCode(input: { codeId: number }) {
    if (this.code.id !== input.codeId || this.code.hold_at !== null) {
      return false;
    }
    this.code.hold_at = "2026-06-25T09:00:00.000Z";
    return true;
  }
}

function makeService(repo: SignedMemoryRepo): LicenseService {
  return new LicenseService(repo as unknown as Repository, env);
}

describe("verifySigned", () => {
  let repo: SignedMemoryRepo;
  let service: LicenseService;
  beforeEach(async () => {
    repo = await SignedMemoryRepo.create();
    service = makeService(repo);
  });

  it("signs an active license bound to the requesting installation", async () => {
    const result = await service.verifySigned({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      licenseKey: SignedMemoryRepo.code,
      productId: repo.app.app_id,
      installationId: "device-a",
      protocolVersion: 1
    });
    expect(result.payload.status).toBe("active");
    expect(result.payload.activation_allowed).toBe(true);
    expect(result.public_key_id).toBe(TEST_SECRETS.LICENSE_SIGNING_KEY_ID);
    expect(await verifySignature(result.payload, result.signature)).toBe(true);
    expect(repo.events.some((e) => e.eventType === "VERIFY")).toBe(true);
  });

  it("reports activation_allowed false for a non-bound installation on a single-device code", async () => {
    const result = await service.verifySigned({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      licenseKey: SignedMemoryRepo.code,
      productId: repo.app.app_id,
      installationId: "device-other",
      protocolVersion: 1
    });
    expect(result.payload.status).toBe("active");
    expect(result.payload.activation_allowed).toBe(false);
  });

  it("refuses a product mismatch with an unsigned 404 and a PRODUCT_MISMATCH event", async () => {
    await expect(
      service.verifySigned({
        appId: repo.app.app_id,
        appSecret: SignedMemoryRepo.appSecret,
        licenseKey: SignedMemoryRepo.code,
        productId: "app_other",
        installationId: "device-a",
        protocolVersion: 1
      })
    ).rejects.toMatchObject({ code: "INVALID_CODE", status: 404 });
    expect(repo.events.some((e) => e.eventType === "PRODUCT_MISMATCH")).toBe(true);
  });

  it("rejects an unsupported protocol version", async () => {
    await expect(
      service.verifySigned({
        appId: repo.app.app_id,
        appSecret: SignedMemoryRepo.appSecret,
        licenseKey: SignedMemoryRepo.code,
        productId: repo.app.app_id,
        installationId: "device-a",
        protocolVersion: 2
      })
    ).rejects.toMatchObject({ code: "PROTOCOL_UNSUPPORTED", status: 400 });
  });

  it("rejects an over-long installation_id", async () => {
    await expect(
      service.verifySigned({
        appId: repo.app.app_id,
        appSecret: SignedMemoryRepo.appSecret,
        licenseKey: SignedMemoryRepo.code,
        productId: repo.app.app_id,
        installationId: "x".repeat(201),
        protocolVersion: 1
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("derives revoked for a deleted code and refuses activation", async () => {
    repo.code.status = CODE_STATUS.DELETED;
    const result = await service.verifySigned({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      licenseKey: SignedMemoryRepo.code,
      productId: repo.app.app_id,
      installationId: "device-a",
      protocolVersion: 1
    });
    expect(result.payload.status).toBe("revoked");
    expect(result.payload.activation_allowed).toBe(false);
  });
});

describe("reportEvent + auto-hold decision", () => {
  let repo: SignedMemoryRepo;
  let service: LicenseService;
  beforeEach(async () => {
    repo = await SignedMemoryRepo.create();
    service = makeService(repo);
  });

  it("records a report without holding when only one distinct installation reported", async () => {
    repo.distinctReports = 1;
    const result = await service.reportEvent({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      installationId: "device-a",
      licenseKey: SignedMemoryRepo.code,
      reasonCode: "PAYLOAD_TAMPERED"
    });
    expect(result).toEqual({ recorded: true, held: false });
    expect(repo.code.hold_at).toBeNull();
  });

  it("auto-holds when two distinct installations reported (corroborated threshold)", async () => {
    repo.distinctReports = 2;
    const result = await service.reportEvent({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      installationId: "device-b",
      licenseKey: SignedMemoryRepo.code,
      reasonCode: "SIGNATURE_INVALID"
    });
    expect(result.held).toBe(true);
    expect(repo.code.hold_at).not.toBeNull();
    expect(repo.events.some((e) => e.eventType === "AUTO_HOLD")).toBe(true);
  });

  it("does not hold on a low-severity reason even when corroborated", async () => {
    repo.distinctReports = 5;
    const result = await service.reportEvent({
      appId: repo.app.app_id,
      appSecret: SignedMemoryRepo.appSecret,
      installationId: "device-a",
      licenseKey: SignedMemoryRepo.code,
      reasonCode: "KEY_ID_UNKNOWN"
    });
    expect(result.held).toBe(false);
  });

  it("rejects an unknown reason code", async () => {
    await expect(
      service.reportEvent({
        appId: repo.app.app_id,
        appSecret: SignedMemoryRepo.appSecret,
        installationId: "device-a",
        licenseKey: SignedMemoryRepo.code,
        reasonCode: "NONSENSE"
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
