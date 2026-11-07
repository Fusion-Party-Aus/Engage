import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [react({ experimentalReactChildren: true })],
  vite: { plugins: [tailwindcss()] },
  output: "server",
  adapter: node({ mode: "standalone" }),
  session: false,
  security: { checkOrigin: true },
  redirects: {
    "/ballots": "/proposals/?stage=decide",
    "/consultations": "/proposals/?stage=deliberate",
    "/reviews": "/proposals/",
    "/all-policies": "/proposals/",
    "/pending-vote": "/proposals/?stage=decide",
    "/reclaim-our-economy": "/proposals/",
    "/reclaim-our-future": "/proposals/",
    "/governance": "/#how-it-works",
  },
});
