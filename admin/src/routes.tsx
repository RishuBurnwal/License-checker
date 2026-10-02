import {
  AppstoreOutlined,
  AuditOutlined,
  CodeOutlined,
  DashboardOutlined,
  FileTextOutlined,
  KeyOutlined,
  PlayCircleOutlined,
  SettingOutlined,
  SignatureOutlined,
  TeamOutlined,
  UsergroupAddOutlined
} from "@ant-design/icons";
import type { MenuDataItem } from "@ant-design/pro-components";
import { lazy, type ReactNode } from "react";

const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const AppsPage = lazy(() => import("./pages/AppsPage").then((module) => ({ default: module.AppsPage })));
const CodesPage = lazy(() => import("./pages/CodesPage").then((module) => ({ default: module.CodesPage })));
const GeneratePage = lazy(() => import("./pages/GeneratePage").then((module) => ({ default: module.GeneratePage })));
const LogsPage = lazy(() => import("./pages/LogsPage").then((module) => ({ default: module.LogsPage })));
const SessionsPage = lazy(() => import("./pages/SessionsPage").then((module) => ({ default: module.SessionsPage })));
const DocsPage = lazy(() => import("./pages/DocsPage").then((module) => ({ default: module.DocsPage })));
const SdkPage = lazy(() => import("./pages/SdkPage").then((module) => ({ default: module.SdkPage })));
const PlaygroundPage = lazy(() => import("./pages/PlaygroundPage").then((module) => ({ default: module.PlaygroundPage })));
const UsersPage = lazy(() => import("./pages/UsersPage").then((module) => ({ default: module.UsersPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

export type PageKey =
  | "dashboard"
  | "users"
  | "settings"
  | "apps"
  | "codes"
  | "generate"
  | "logs"
  | "sessions"
  | "docs"
  | "sdk"
  | "playground";

type AdminRoute = MenuDataItem & {
  key: PageKey;
  path: string;
  name: string;
  element: ReactNode;
};

type Translate = (key: string) => string;

export const defaultPage: PageKey = "dashboard";

export function getAdminPageRoutes(t: Translate): AdminRoute[] {
  return [
  {
    key: "dashboard",
    path: "/dashboard",
    name: t("nav.dashboard"),
    icon: <DashboardOutlined />,
    element: <DashboardPage />,
  },
  {
    key: "users",
    path: "/users",
    name: t("nav.users"),
    icon: <UsergroupAddOutlined />,
    element: <UsersPage />
  },
  {
    key: "settings",
    path: "/settings",
    name: t("nav.settings"),
    icon: <SettingOutlined />,
    element: <SettingsPage />
  },
  {
    key: "apps",
    path: "/apps",
    name: t("nav.apps"),
    icon: <AppstoreOutlined />,
    element: <AppsPage />
  },
  {
    key: "codes",
    path: "/codes",
    name: t("nav.codes"),
    icon: <KeyOutlined />,
    element: <CodesPage />
  },
  {
    key: "generate",
    path: "/generate",
    name: t("nav.generate"),
    icon: <SignatureOutlined />,
    element: <GeneratePage />
  },
  {
    key: "logs",
    path: "/logs",
    name: t("nav.logs"),
    icon: <AuditOutlined />,
    element: <LogsPage />
  },
  {
    key: "sessions",
    path: "/sessions",
    name: t("nav.sessions"),
    icon: <TeamOutlined />,
    element: <SessionsPage />
  },
  {
    key: "docs",
    path: "/docs",
    name: t("nav.docs"),
    icon: <FileTextOutlined />,
    element: <DocsPage />
  },
  {
    key: "sdk",
    path: "/sdk",
    name: t("nav.sdk"),
    icon: <CodeOutlined />,
    element: <SdkPage />
  },
  {
    key: "playground",
    path: "/playground",
    name: "Playground",
    icon: <PlayCircleOutlined />,
    element: <PlaygroundPage />
  }
  ];
}

const routePaths: Array<[string, PageKey]> = [
  ["/dashboard", "dashboard"],
  ["/users", "users"],
  ["/settings", "settings"],
  ["/apps", "apps"],
  ["/codes", "codes"],
  ["/generate", "generate"],
  ["/logs", "logs"],
  ["/sessions", "sessions"],
  ["/docs", "docs"],
  ["/sdk", "sdk"],
  ["/playground", "playground"]
];

export const pathToPage = new Map<string, PageKey>(routePaths);

export function getRouteMap(routes: AdminRoute[]) {
  return Object.fromEntries(routes.map((route) => [route.key, route])) as Record<PageKey, AdminRoute>;
}

export function getMenuRoutes(
  routes: AdminRoute[],
  t: Translate,
  isUserManager: boolean
): MenuDataItem[] {
  const menuRouteMap = Object.fromEntries(routes.map(({ element: _element, ...route }) => [route.key, route])) as Record<
    PageKey,
    MenuDataItem
  >;

  // The System group holds user management (admin via isUserManager; staff
  // never see it, and the server denies them regardless). Render the group only
  // if it has at least one visible child.
  const systemChildren: MenuDataItem[] = [
    ...(isUserManager ? [menuRouteMap.users, menuRouteMap.settings] : [])
  ];

  return [
    menuRouteMap.dashboard,
    {
      key: "license",
      path: "/license",
      name: t("nav.license"),
      children: [menuRouteMap.apps, menuRouteMap.codes, menuRouteMap.generate]
    },
    {
      key: "audit",
      path: "/audit",
      name: t("nav.audit"),
      children: [menuRouteMap.logs, menuRouteMap.sessions]
    },
    {
      key: "support",
      path: "/support",
      name: t("nav.support"),
      children: [menuRouteMap.docs, menuRouteMap.sdk, menuRouteMap.playground]
    },
    ...(systemChildren.length > 0 ? [{
      key: "system",
      path: "/system",
      name: t("nav.system"),
      children: systemChildren
    }] : [])
  ];
}
