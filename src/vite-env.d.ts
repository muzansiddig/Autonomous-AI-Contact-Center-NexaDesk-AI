/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE?: "api" | "demo";
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_TENANT_ID?: string;
  readonly VITE_AUTH0_DOMAIN?: string;
  readonly VITE_AUTH0_CLIENT_ID?: string;
  readonly VITE_AUTH0_AUDIENCE?: string;
  readonly VITE_AUTH0_REDIRECT_URI?: string;
  readonly VITE_DEV_API_PROXY_AUTH?: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
