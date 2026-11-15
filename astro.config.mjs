import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import {
  CSP_DIRECTIVES,
  CSP_SCRIPT_RESOURCES,
  CSP_STYLE_ATTRIBUTE_RESOURCES,
} from "./src/lib/security-perimeter.ts";

export default defineConfig({
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
  output: "server",
  adapter: node({ mode: "standalone" }),
  session: false,
  security: {
    checkOrigin: true,
    // The app is served through a TLS-terminating proxy. Without this, Astro
    // builds the request URL from localhost and its origin check compares a
    // legitimate public Origin against the wrong host, refusing same-origin
    // form posts. Only the production host over HTTPS is trusted; other
    // forwarded host/protocol values are ignored by the adapter.
    allowedDomains: [
      { hostname: "engage.fusionparty.org.au", protocol: "https" },
    ],
    // Astro hashes its own inline scripts and styles and renders the policy as
    // a response header for on-demand pages. External hosts are listed, with
    // reasons, in `src/lib/security-perimeter.ts`. Eval is never permitted.
    csp: {
      algorithm: "SHA-256",
      directives: [...CSP_DIRECTIVES],
      scriptDirective: { resources: [...CSP_SCRIPT_RESOURCES] },
      styleDirective: { resources: [...CSP_STYLE_ATTRIBUTE_RESOURCES] },
    },
  },
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
