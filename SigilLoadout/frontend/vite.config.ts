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
        // Wails runtime 在浏览器环境会探测 /wails/custom.js，并往 /wails/runtime 发调用；
        // happy-dom 默认 localhost:3000，测试里没有后端。setup 把 /wails/ 下的 fetch 直接拒绝。
        setupFiles: ["./src/test-setup.ts"],
        fsModuleCache: true,
        /* 默认 5s 对这里的慢用例不够（空载 1~2.5s，机器一忙就成片 `Test timed out in 5000ms`）——
           实测：3 个 vitest 并发时 15 条超时。给足余量，别让假红引着去查不存在的 bug。 */
        testTimeout: 15000,
    },
});
