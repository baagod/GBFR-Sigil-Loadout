import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
    server: {
        host: "127.0.0.1",
        port: Number(process.env.WAILS_VITE_PORT) || 9245,
        strictPort: true,
    },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    plugins: [react(), tailwindcss(), wails("./bindings")],
    // 测试的 transform 结果跨运行复用：vitest 默认每次都重做（实测 3.1s，它自己在输出里提示了这个
    // 选项）。只影响测试，与产物无关。defineConfig 因此从 vitest/config 引（它是 vite 那个的超集）。
    test: {
        fsModuleCache: true,
    },
});
