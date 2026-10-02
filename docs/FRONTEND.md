# Frontend Specification

The admin console lives in `admin/` and uses React, Vite, Tailwind CSS, Ant Design, and Ant Design Pro Components. When adding a page or adjusting an interaction, follow the existing patterns first and do not introduce a new UI framework.

## Directory Responsibilities

- `admin/src/App.tsx`: top-level `ConfigProvider`, Ant Design `App` container, login state, current administrator loading, and lazy loading of the login/admin entry points.
- `admin/src/components/Shell.tsx`: the main admin layout based on `ProLayout` mix layout, the top brand bar, side menu, top user menu, and page switching.
- `admin/src/routes.tsx`: admin menu, page paths, and page component configuration; business page components are lazy-loaded with `React.lazy`.
- `admin/src/components/Login.tsx`: login page.
- `admin/src/components/ChangePasswordModal.tsx`: change-password modal.
- `admin/src/components/ForcedPasswordChange.tsx`: blocking screen shown while the account still carries a reset credential; it is not dismissible because the Worker refuses every other business route in that state.
- `admin/src/components/ResetPasswordModal.tsx`: password reset modal on the login page.
- `admin/src/pages/`: business pages, one file per page.
- `admin/src/hooks/`: frontend data-loading logic reused across pages.
- `admin/src/shared/`: frontend display helpers, parameter handling, and shared types.
- `admin/src/shared/CodeBlock.tsx`: code display component with copy support, handling highlighting consistently.
- `admin/src/shared/logMessage.ts`: renders stored log messages for display; must stay in sync with the messages the Worker writes.
- `admin/src/shared/constants.ts`: frontend enum constants for statuses, actions, platform options, and ProTable `valueEnum`s.
- `admin/src/api.ts`: API request wrapper, token read/write, and query parameter handling.
- `admin/src/types.ts`: admin console API types.
- `admin/src/styles.css`: Tailwind CSS entry point and a small global base layer.

Page split rules:

- The dashboard home page lives in `admin/src/pages/DashboardPage.tsx`.
- The activation code page lives in `admin/src/pages/CodesPage.tsx`.
- The bulk generation page lives in `admin/src/pages/GeneratePage.tsx`.
- The app management page lives in `admin/src/pages/AppsPage.tsx`.
- The operation log page lives in `admin/src/pages/LogsPage.tsx`.
- The integration docs page lives in `admin/src/pages/DocsPage.tsx`.
- The SDK page lives in `admin/src/pages/SdkPage.tsx`.
- The online Playground page lives in `admin/src/pages/PlaygroundPage.tsx`.
- The settings page lives in `admin/src/pages/SettingsPage.tsx` and hosts the change-master-password form.

## Page Conventions

- A page-level file contains only that page's tables, forms, modal state, and request logic.
- Prefer putting cross-page reusable logic in `hooks/` or `shared/`; do not copy it into several pages.
- When adding an admin page, add the `PageKey`, route configuration, and page component in `routes.tsx`.
- Admin routing is managed centrally by `Shell` from `routes.tsx`. Page paths must be reflected in the `ProLayout` menu configuration, and switching menus synchronizes the browser address; `Shell` hosts the loading state with `Suspense`.
- The dashboard home page is the default entry point at `/dashboard`.
- The admin menu uses the Ant Design Pro mix layout with a grouped side menu. The workspace is a top-level entry, "Apps" and "Activation Codes"/"Generate Codes" belong to "License Management", "Operation Logs" belongs to "Audit Management", and "Integration Docs", "SDK", and "Playground" belong to "Developer Support".
- An administrator whose `user_role` is `admin` additionally sees the "System" group with "Users" and "Settings"; a `staff` account sees neither entry and is bounced from `/settings`, and the server denies the API regardless.
- The Settings page offers a change-master-password form (current, new, and confirm fields) that posts to `PATCH /api/admin/settings/master-password` through `api.ts`. On the Users page, the reset-password modal has a "require password change on next login" checkbox (default on) sent as `force_change`, plus a "Generate password" action that posts to the generate endpoint and shows the returned password exactly once with a copy affordance.
- The page-level `PageContainer` is hosted centrally by `Shell` and includes the page title and breadcrumb except on the dashboard; business pages render only their content and must not wrap another `PageContainer`.
- When a page needs to show a local control after the title, register the title extra content through `components/PageTitleExtraContext.tsx` and clear it on unmount instead of creating another `PageContainer` in the business page.
- All visible admin console copy goes through `admin/src/i18n/`, which is English-only. Do not hardcode user-visible text in components.
- The login page offers a forgot-password entry that calls `/api/recovery/admin-password` through the reset-password modal, submitting the username, recovery password, and new password in the body.
- When `admin.must_change_password` is `true` from the login response or from `GET /api/admin/me`, `App.tsx` replaces the shell with `ForcedPasswordChange` instead of rendering business pages. Submitting the new password re-reads `/api/admin/me` so the gate lifts only after the server confirms the flag is cleared; the screen also offers a sign-out path.
- The login page requires the username and password, both mandatory. A "Log in as" dropdown (Admin / User) controls the field count: Admin also shows a master-password field whose value is submitted as `master_password`, while User hides it. The dropdown choice is a UI hint only and is never sent as an auth signal; the server authorizes on the stored `user_role`.
- Date display keeps the `YYYY-MM-DD HH:mm:ss` style and should reuse `shared/format.tsx`.
- The app management page shows only the app list by default. Create and edit use modals for the form; the app description and license purchase link are optional, and the purchase link accepts only `http` or `https` addresses with an external link entry in the list. A created or rotated `app_secret` is shown in a one-time modal. App usage instructions are shown in a modal with copyable code that must not echo `app_secret`. Deleting an app and rotating a secret require a second confirmation.
- The integration docs page provides client endpoint descriptions, an endpoint flow diagram, copyable call samples, and ready-made demos covering the TypeScript SDK, JavaScript SDK, cURL, and HTML. The Playground page provides online calls to the real endpoints, never stores or echoes `app_secret`, and must warn that calling real client endpoints writes logs or changes activation state.
- The SDK page provides copyable and downloadable React, Vue, React Native, Angular, Svelte, Electron, Flutter/Dart, and TypeScript Core component code, automatically filling the API base URL and `app_id` from the current admin address and the selected app. It must never request, store, or echo a real `app_secret`.
- Admin lists show an index column by default.
- The activation code page supports single and bulk disable, enable, and delete, plus manual unbind for a valid bound activation code. The disabled state takes display priority over unused, active, and expired.
- The activation code page shows only the device binding state, never a device hash or plaintext device fingerprint.
- The operation log page's action filter must cover every action type the backend records, and log messages are rendered through `admin/src/shared/logMessage.ts`.

## UI Conventions

- Prefer `ProTable` for tables.
- Prefer `ProForm`, `ProFormText`, `ProFormSelect`, `ProFormDigit`, and `ProFormTextArea` for forms.
- Prefer Ant Design `Modal` for dialogs.
- Prefer `Tag` or a ProTable `valueEnum` for status display.
- Use Ant Design `message` for action feedback.
- Use `modal.confirm` for destructive confirmations, and the `danger` style for delete actions.
- Prefer Ant Design icons for action buttons, keeping the existing button copy and density.
- When showing code, JSON, command lines, or HTML samples on a page, always use `shared/CodeBlock.tsx` with the matching language type so highlighting stays consistent.
- Use Tailwind CSS utility classes for custom layout, spacing, sizing, colors, and overrides; do not add plain CSS selectors.
- Do not add marketing-style pages, explanatory cards, or repeated page title descriptions.

## API Conventions

- Route all endpoint calls through `apiRequest` in `admin/src/api.ts`.
- Build query strings with `toQuery`.
- Keep API return types in `admin/src/types.ts`.
- Keep API enum values and table display enums in `admin/src/shared/constants.ts`, deriving types from the constants.
- Pages with list pagination use the backend's `items` and `total`.
- On a 401 or an expired session, clear the token and return to the login state through the existing token helper.

## Security Conventions

- The frontend must not display app secret hashes, plaintext device fingerprints, or full activation code history.
- `app_secret` and bulk-generated plaintext activation codes are shown exactly once in the create, rotate, or generation result.
- The bulk generation result must keep the "plaintext activation codes are shown only here" warning.
- Do not write tokens, secrets, or activation codes into logs, URLs, or commit-able files.

## Verification

Run at least the following for a frontend change:

```bash
pnpm --filter @license-manager/admin type-check
pnpm --filter @license-manager/admin test
```

When the build, static asset hosting, or deployment path is involved, additionally run:

```bash
pnpm --filter @license-manager/admin build
```
