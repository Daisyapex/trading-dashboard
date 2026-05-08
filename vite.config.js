import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: change "trading-dashboard" below to whatever you name your GitHub repo.
// GitHub Pages serves your site at https://USERNAME.github.io/REPO_NAME/
// so Vite needs to know that subdirectory.
export default defineConfig({
  plugins: [react()],
  base: "/trading-dashboard/",
});
