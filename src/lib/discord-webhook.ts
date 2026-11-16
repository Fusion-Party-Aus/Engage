/**
 * Restrict all outbound Discord webhook requests to Discord's expected HTTPS
 * endpoint. Never accept arbitrary destinations, credentials, redirects or URL
 * parameters from application settings.
 */
export function validateDiscordWebhook(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid Discord webhook URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["discord.com", "discordapp.com"].includes(url.hostname) ||
    url.port || url.username || url.password || url.search || url.hash ||
    !/^\/api\/webhooks\/\d{15,25}\/[A-Za-z0-9._-]+$/.test(url.pathname)
  ) {
    throw new Error("Enter a Discord webhook URL from the target channel.");
  }
  url.searchParams.set("wait", "true");
  return url;
}
