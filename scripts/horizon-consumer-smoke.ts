import { horizonFeedErrors } from "../src/lib/collaboration-horizon-consumer.ts";

/**
 * A simulated Horizon consumer. Polls the feed the way a CMS job would, checks
 * the contract, downloads one image, revalidates with an entity tag and asks for
 * changes since the last publication.
 *
 * This observes the feed, not a real Horizon deployment. Run it in staging or
 * production before Horizon goes live, and on a schedule if Horizon is not yet
 * polling for itself.
 */
async function main() {
  const base = (
    process.env.HORIZON_BASE_URL ||
    process.env.PUBLIC_ORIGIN ||
    "http://localhost:4321"
  ).replace(/\/$/, "");
  const token = String(process.env.HORIZON_FEED_TOKEN ?? "").trim();
  const allowEmpty = process.argv.includes("--allow-empty");
  if (!token) throw new Error("Set HORIZON_FEED_TOKEN to the credential Horizon uses.");
  const url = `${base}/api/v1/horizon/stories`;
  const authorise = { authorization: `Bearer ${token}` };

  const unauthorised = await fetch(url);
  if (unauthorised.status !== 401) {
    throw new Error(`The feed answered ${unauthorised.status} without a token; it must be 401.`);
  }

  const response = await fetch(url, { headers: authorise });
  if (response.status !== 200) throw new Error(`The authorised feed answered ${response.status}.`);
  const payload = await response.json();
  const errors = horizonFeedErrors(payload);
  if (errors.length) throw new Error(`Contract violations:\n- ${errors.join("\n- ")}`);
  const stories = Array.isArray(payload.stories) ? payload.stories : [];
  if (!stories.length && !allowEmpty) {
    throw new Error("No published stories. Publish one, or pass --allow-empty to check the envelope only.");
  }

  let mediaStatus: number | null = null;
  let mediaBytes = 0;
  const firstMedia = stories[0]?.media?.[0]?.url;
  if (firstMedia) {
    const media = await fetch(firstMedia);
    mediaStatus = media.status;
    const bytes = new Uint8Array(await media.arrayBuffer());
    mediaBytes = bytes.byteLength;
    if (media.status !== 200 || !String(media.headers.get("content-type") ?? "").startsWith("image/")) {
      throw new Error(`The first photograph did not download as an image (${media.status}).`);
    }
  }

  const etag = response.headers.get("etag");
  let notModified: number | null = null;
  if (etag) {
    const revalidated = await fetch(url, { headers: { ...authorise, "if-none-match": etag } });
    notModified = revalidated.status;
    if (revalidated.status !== 304) {
      throw new Error(`Revalidating with the entity tag answered ${revalidated.status}; expected 304.`);
    }
  }

  let incrementalStories: number | null = null;
  if (payload.nextSince) {
    const incremental = await fetch(`${url}?since=${encodeURIComponent(payload.nextSince)}`, {
      headers: authorise,
    });
    if (incremental.status !== 200) throw new Error(`The incremental poll answered ${incremental.status}.`);
    const next = await incremental.json();
    const incrementalErrors = horizonFeedErrors(next);
    if (incrementalErrors.length) {
      throw new Error(`Incremental contract violations:\n- ${incrementalErrors.join("\n- ")}`);
    }
    incrementalStories = Array.isArray(next.stories) ? next.stories.length : 0;
  }

  console.log(
    JSON.stringify(
      {
        base,
        authorised: response.status,
        unauthorised: unauthorised.status,
        stories: stories.length,
        firstStoryId: stories[0]?.id ?? null,
        etag: etag ?? null,
        notModified,
        mediaStatus,
        mediaBytes,
        incrementalStories,
        contractErrors: 0,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
