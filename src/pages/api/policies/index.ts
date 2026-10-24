import { loadPolicyCatalogue } from "../../../lib/platform/catalogue.ts";
import { json, platformEnv } from "../../../lib/platform/http.ts";
import type { RuntimeLocals } from "../../../lib/platform/types.ts";

export const prerender = false;

export async function GET({ request, locals }: { request: Request; locals: RuntimeLocals }): Promise<Response> {
  try {
    const url = new URL(request.url);
    const domainSlug = url.searchParams.get("domainSlug");
    const policyId = url.searchParams.get("policyId");
    const roundId = url.searchParams.get("roundId");
    const catalogue = await loadPolicyCatalogue(platformEnv(locals));
    const filtered = catalogue.filter((policy) => {
      if (domainSlug && policy.domainSlug !== domainSlug) return false;
      if (policyId && policy.policyId !== policyId) return false;
      if (roundId && !policy.consultationRounds.some((r) => r.roundId === roundId)) return false;
      return true;
    });
    return json({ policies: filtered });
  } catch {
    return json({ error: "Policy catalogue is temporarily unavailable." }, 503);
  }
}
