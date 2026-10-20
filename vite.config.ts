import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const demoMode = env.VITE_APP_MODE === "demo";
  if (mode === "production" && demoMode) {
    throw new Error("VITE_APP_MODE=demo is local-only and cannot be used in a production build.");
  }

  const localDevAuth =
    mode === "development" &&
    env.DEV_AUTH_ENABLED === "true" &&
    Boolean(env.DEV_AUTH_TOKEN);
  const proxy: ProxyOptions = {
    target: "http://127.0.0.1:3000",
    configure(proxyServer) {
      if (localDevAuth) {
        proxyServer.on("proxyReq", (proxyRequest) => {
          proxyRequest.setHeader("Authorization", `Bearer ${env.DEV_AUTH_TOKEN}`);
        });
      }
    },
  };

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_DEV_API_PROXY_AUTH": JSON.stringify(localDevAuth),
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/v1": proxy,
        "/health": "http://127.0.0.1:3000",
      },
    },
  };
});
