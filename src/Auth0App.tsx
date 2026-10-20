import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import { lazy, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { configureAccessTokenProvider } from "./auth";

const App = lazy(() => import("./App"));
const audience = import.meta.env.VITE_AUTH0_AUDIENCE?.trim() ?? "";
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() ?? "";
const domain = import.meta.env.VITE_AUTH0_DOMAIN?.trim() ?? "";
const redirectUri =
  import.meta.env.VITE_AUTH0_REDIRECT_URI?.trim() || window.location.origin;
const scope = "openid profile email";

function MessageScreen({
  title,
  description,
  action,
  actionLabel,
}: {
  title: string;
  description: string;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <main className="auth-screen" dir="rtl">
      <section className="auth-screen__card">
        <h1>{title}</h1>
        <p>{description}</p>
        {action && actionLabel && (
          <button className="auth-screen__button" onClick={action} type="button">
            {actionLabel}
          </button>
        )}
      </section>
    </main>
  );
}

function AuthenticatedInbox() {
  const {
    error,
    getAccessTokenSilently,
    isAuthenticated,
    isLoading,
    loginWithRedirect,
    logout,
    user,
  } = useAuth0();
  const [tokenProviderReady, setTokenProviderReady] = useState(false);
  const [authActionError, setAuthActionError] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);

  useEffect(() => {
    const onExpired = () => setAuthExpired(true);
    window.addEventListener("nexadesk:auth-expired", onExpired);
    return () => window.removeEventListener("nexadesk:auth-expired", onExpired);
  }, []);

  const startLogin = async () => {
    setAuthActionError(false);
    try {
      await loginWithRedirect();
    } catch {
      setAuthActionError(true);
    }
  };

  const startLogout = async () => {
    setAuthActionError(false);
    try {
      await logout({ logoutParams: { returnTo: redirectUri } });
    } catch {
      setAuthActionError(true);
    }
  };

  useEffect(() => {
    configureAccessTokenProvider(async () =>
      (await getAccessTokenSilently({
        authorizationParams: { audience, scope },
      })) ?? null,
    );
    setTokenProviderReady(true);
  }, [getAccessTokenSilently]);

  if (isLoading || (isAuthenticated && !tokenProviderReady)) {
    return <MessageScreen title="جارٍ التحقق من تسجيل الدخول" description="يرجى الانتظار..." />;
  }

  if (error) {
    return (
      <MessageScreen
        title="تعذر التحقق من تسجيل الدخول"
        description={
          authActionError
            ? "تعذر بدء تسجيل الدخول. تحقق من الاتصال وحاول مجددًا."
            : "تحقق من إعدادات Auth0 أو حاول تسجيل الدخول مجددًا."
        }
        action={() => void startLogin()}
        actionLabel="إعادة المحاولة"
      />
    );
  }

  if (authExpired) {
    return (
      <MessageScreen
        title="انتهت جلسة الدخول"
        description="سجّل الدخول مجددًا للمتابعة. لم تُرسل أي طلبات تلقائيًا بعد انتهاء الجلسة."
        action={() => void startLogin()}
        actionLabel="تسجيل الدخول مجددًا"
      />
    );
  }

  if (!isAuthenticated) {
    return (
      <MessageScreen
        title="تسجيل الدخول مطلوب"
        description={
          authActionError
            ? "تعذر بدء تسجيل الدخول. تحقق من الاتصال وحاول مجددًا."
            : "سجّل الدخول للوصول إلى صندوق الوارد."
        }
        action={() => void startLogin()}
        actionLabel="تسجيل الدخول"
      />
    );
  }

  return (
    <>
      <div className="auth-session-bar" dir="rtl">
        <span>{user?.name ?? user?.email ?? "المستخدم"}</span>
        {authActionError && <span role="alert">تعذر تسجيل الخروج. حاول مجددًا.</span>}
        <button onClick={() => void startLogout()} type="button">
          تسجيل الخروج
        </button>
      </div>
      <App />
    </>
  );
}

export default function Auth0App(): ReactNode {
  return (
    <Auth0Provider
      authorizationParams={{ audience, redirect_uri: redirectUri, scope }}
      cacheLocation="memory"
      clientId={clientId}
      domain={domain}
    >
      <AuthenticatedInbox />
    </Auth0Provider>
  );
}
