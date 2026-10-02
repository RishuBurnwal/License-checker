import { Tag } from "antd";
import dayjs from "dayjs";
import type { CodeItem } from "../types";
import { CODE_DERIVED_STATUS, CODE_STATUS, deriveCodeDisplayStatus } from "./constants";

export function formatDate(value: string | null): string {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm:ss") : "-";
}

export function isExpired(value: string | null): boolean {
  return value !== null && dayjs(value).isBefore(dayjs());
}

type Translate = (key: string) => string;

const STATUS_TAG_META = {
  [CODE_STATUS.DELETED]: { color: "default", key: "status.deleted", fallback: "Deleted" },
  [CODE_DERIVED_STATUS.HOLD]: { color: "volcano", key: "status.hold", fallback: "On hold" },
  [CODE_DERIVED_STATUS.DISABLED]: { color: "orange", key: "status.codeDisabled", fallback: "Disabled" },
  [CODE_STATUS.UNUSED]: { color: "blue", key: "status.unused", fallback: "Unused" },
  [CODE_DERIVED_STATUS.EXPIRED]: { color: "red", key: "status.expired", fallback: "Expired" },
  [CODE_STATUS.ACTIVE]: { color: "green", key: "status.active", fallback: "Active" }
} as const;

export function statusTag(code: CodeItem, t?: Translate) {
  const meta = STATUS_TAG_META[deriveCodeDisplayStatus(code)];
  return <Tag color={meta.color}>{t ? t(meta.key) : meta.fallback}</Tag>;
}
