import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      // 默认指向本机 dev 引擎；另起一套引擎（例如带认证闸做验证）时用 VITE_ENGINE_ORIGIN 换目标，
      // 不必改文件、也不用停手上那个引擎。
      "/api": process.env.VITE_ENGINE_ORIGIN ?? "http://127.0.0.1:3001"
    }
  }
});
