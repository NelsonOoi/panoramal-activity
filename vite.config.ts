import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
    plugins: [react(), tailwindcss()],
    server: {
        allowedHosts: true,
        proxy: {
            "/api": "http://127.0.0.1:3000",
            "/frames": "http://127.0.0.1:3000"
        }
    }
})
