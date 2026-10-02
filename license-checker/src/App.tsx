import { App as AntApp, ConfigProvider } from "antd";
import enUS from "antd/locale/en_US";
import { LicenseListPage } from "./pages/LicenseListPage";

export function App() {
  return (
    <ConfigProvider locale={enUS}>
      <AntApp>
        <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
          <LicenseListPage />
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
