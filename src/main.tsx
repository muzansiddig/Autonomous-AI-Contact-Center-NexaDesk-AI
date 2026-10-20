import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./app.css";

const App = lazy(() => import("./App"));
const Auth0App = lazy(() => import("./Auth0App"));

const appMode = import.meta.env.VITE_APP_MODE ?? "api";
const useLocalProxyAuth = import.meta.env.VITE_DEV_API_PROXY_AUTH === true;
const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim() ?? "";
const auth0ClientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ?? "";
const auth0Audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim() ?? "";
const auth0AudienceIsManagementApi = auth0Audience.endsWith("/api/v2/");

function MessageScreen({ title, description }: { title: string; description: string }) {
  return (
    <main className="auth-screen" dir="rtl">
      <section className="auth-screen__card">
        <h1>{title}</h1>
        <p>{description}</p>
      </section>
    </main>
  );
}

function Root() {
  if (appMode === "demo" || useLocalProxyAuth) return <App />;

  if (!auth0Domain || !auth0ClientId || !auth0Audience || auth0AudienceIsManagementApi) {
    const description = auth0AudienceIsManagementApi
      ? "قيمة audience الحالية تخص Auth0 Management API. أنشئ API مخصصًا للتطبيق واضبط audience الخاص به في الواجهة والخادم."
      : "أكمل إعداد VITE_AUTH0_DOMAIN وVITE_AUTH0_CLIENT_ID وVITE_AUTH0_AUDIENCE باستخدام إعدادات SPA وAPI المخصصة.";
    return <MessageScreen title="إعداد تسجيل الدخول غير مكتمل" description={description} />;
  }

  return <Auth0App />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense
      fallback={
        <MessageScreen
          title="جارٍ تحميل مساحة العمل"
          description="يرجى الانتظار..."
        />
      }
    >
      <Root />
    </Suspense>
  </React.StrictMode>,
);
