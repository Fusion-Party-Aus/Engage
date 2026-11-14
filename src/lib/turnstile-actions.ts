/**
 * Cloudflare Turnstile action names shared by the widget and the server.
 *
 * Keep this module free of Node and MongoDB imports so it can be bundled into
 * the browser.
 */
export const TURNSTILE_ACTIONS = {
  signIn: "signin",
  signUp: "signup",
  senseBox: "sense-box",
} as const;
