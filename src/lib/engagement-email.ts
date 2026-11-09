import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "mongodb";
import type { PlatformEnv, ProposalSummaryView, SessionUser } from "./types.ts";
import { ballotDeadlineLabel, ballotExpired, closesWithinSevenDays } from "./ballot-deadline.ts";
import { listMembers, listProposals, canViewProposal } from "./store.ts";
import { PROPOSAL_VOTES, proposalBallotId } from "./vote-storage.ts";

export const escapeEmailHtml = (value: string) => value.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export const digestEnabled = (preference: { [key:string]: unknown; digestEnabled?: boolean; suppressed?: boolean } | null) => preference?.digestEnabled === true && !preference.suppressed;
export function safeEqual(a: string, b: string) {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function emailOrigin(env: PlatformEnv) {
  const origin = new URL(env.PUBLIC_ORIGIN || env.BETTER_AUTH_URL || "");
  if (origin.protocol !== "https:" && env.APP_MODE === "production") throw new Error("HTTPS public origin required");
  return origin.origin;
}
export function unsubscribeToken(memberId: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({v:1, memberId})).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function readUnsubscribeToken(token: string, secret: string): string | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra || !secret) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()); return data.v === 1 && typeof data.memberId === "string" ? data.memberId : null; } catch { return null; }
}
export type DigestBallot = { key:string; title:string; href:string; closesAt:Date; proposalId:string };
export function renderDigest(name: string, ballots: DigestBallot[], origin: string, unsubscribeUrl: string) {
  const e = escapeEmailHtml;
  const text = `Hello ${name || "member"},\n\n${ballots.length} ballot(s) close within seven days and still need your vote.\n\n` + ballots.map(b=>`${b.title}\nCloses ${ballotDeadlineLabel(b.closesAt)}\n${origin}${b.href}`).join("\n\n") + `\n\nMy Engage: ${origin}/member/\nEmail preferences: ${origin}/member/?view=account\nUnsubscribe: ${unsubscribeUrl}\n\nYou receive this because you enabled Engage ballot reminders. Voting is optional; review the exact wording before deciding.`;
  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your Engage ballot digest</title></head><body style="margin:0;background:#f2eef9;color:#271047;font-family:Outfit,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="600" style="width:100%;max-width:600px;background:#fff;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="background:#32105a;color:white;padding:28px;border-bottom:6px solid #00c9d2"><p style="margin:0;font-size:12px;letter-spacing:3px">FUSION · HORIZON</p><p style="font-family:Newsreader,Georgia,serif;font-size:38px;margin:8px 0 0">Engage</p></td></tr><tr><td style="padding:28px"><h1 style="font-family:Newsreader,Georgia,serif;font-size:30px;line-height:1.15">A few decisions need your voice.</h1><p>Hello ${e(name || "member")},</p><p>These ${ballots.length} ballot(s) close within seven days. You haven’t voted on them yet.</p>${ballots.map(b=>`<div style="border-top:1px solid #ded6e7;padding:22px 0"><h2 style="font-family:Newsreader,Georgia,serif;font-size:24px;margin:0 0 10px">${e(b.title)}</h2><p style="font-size:14px;line-height:1.6">Closes ${e(ballotDeadlineLabel(b.closesAt))}</p><a style="display:inline-block;background:#00c9d2;color:#271047;padding:12px 20px;border-radius:24px;font-weight:bold;text-decoration:none" href="${e(origin + b.href)}">Read the wording &amp; vote →</a></div>`).join("")}<p style="line-height:1.6">Voting is optional. Your choice is yours—review the exact wording and supporting discussion before deciding.</p><p><a href="${origin}/member/" style="color:#32105a">Open My Engage →</a></p></td></tr><tr><td style="padding:24px 28px;background:#f8f5fc;font-size:12px;line-height:1.7;color:#54465f">Fusion Party Australia · Engage member participation<br>You enabled ballot reminder emails. <a href="${origin}/member/?view=account">Email preferences</a> · <a href="${e(unsubscribeUrl)}">Unsubscribe from reminders</a><br>Unsubscribing does not affect sign-in or your membership.</td></tr></table></td></tr></table></body></html>`;
  return {subject:`Engage: ${ballots.length} ballot${ballots.length === 1 ? "" : "s"} closing soon`, text, html};
}

/** The same visibility, verified membership and recognised branch electorate boundaries as voting. */
export async function digestBallots(db: Db, user: SessionUser, proposals: ProposalSummaryView[], now = new Date()): Promise<DigestBallot[]> {
  if (!user.canParticipate) return [];
  const [memberships, branches, votes, amendments] = await Promise.all([
    db.collection("branch_memberships").find({memberId:user.memberId, status:"active"}).project({branchId:1}).toArray(),
    db.collection("branches").find({recognised:true}).project({branchId:1}).toArray(),
    db.collection(PROPOSAL_VOTES).find({memberId:user.memberId}).project({ballotId:1, revisionId:1, amendmentRevisionId:1}).toArray(),
    db.collection("amendments").find({status:"voting"}).project({amendmentId:1, proposalId:1, title:1, ballotClosesAt:1, ballotRevisionId:1, ballotAmendmentRevisionId:1, currentRevisionId:1, baseRevisionId:1}).toArray(),
  ]);
  const memberBranches = new Set(memberships.map(m=>m.branchId));
  const recognised = new Set(branches.map(b=>b.branchId));
  const viewer = {...user, activeBranchIds:[...memberBranches] as string[]};
  const result: DigestBallot[] = [];
  for (const p of proposals) {
    if (p.stage !== "decide" || ballotExpired(p,now) || !p.ballotRevisionId || !canViewProposal(p, viewer)) continue;
    if (p.jurisdictionBranchId && (!memberBranches.has(p.jurisdictionBranchId) || !recognised.has(p.jurisdictionBranchId))) continue;
    if (closesWithinSevenDays(p, now) && !votes.some(v=>v.ballotId === proposalBallotId(p.proposalId) && v.revisionId === p.ballotRevisionId)) {
      result.push({key:`proposal:${p.proposalId}:${p.ballotRevisionId}:${new Date(p.ballotClosesAt!).toISOString()}`, proposalId:p.proposalId, title:p.title, href:`/proposals/${encodeURIComponent(p.slug)}/#proposal-vote`, closesAt:new Date(p.ballotClosesAt!)});
    }
    for (const a of amendments.filter(a=>a.proposalId === p.proposalId && a.ballotRevisionId === p.ballotRevisionId && a.baseRevisionId === p.ballotRevisionId && a.currentRevisionId === a.ballotAmendmentRevisionId)) {
      const closesAt = a.ballotClosesAt || p.ballotClosesAt;
      if (!a.ballotAmendmentRevisionId || !closesWithinSevenDays({ballotClosesAt:closesAt}, now) || votes.some(v=>v.ballotId === `amendment:${a.amendmentId}` && v.revisionId === a.ballotRevisionId && v.amendmentRevisionId === a.ballotAmendmentRevisionId)) continue;
      result.push({key:`amendment:${a.amendmentId}:${a.ballotAmendmentRevisionId}:${new Date(closesAt).toISOString()}`, proposalId:p.proposalId, title:`Amendment: ${a.title || p.title}`, href:`/proposals/${encodeURIComponent(p.slug)}/#deliberation`, closesAt:new Date(closesAt)});
    }
  }
  return result.sort((a,b)=>a.closesAt.getTime()-b.closesAt.getTime());
}

/** A scheduler invokes this in bounded batches. Never retries an ambiguous external send automatically. */
export async function runBallotDigests(db: Db, env: PlatformEnv, send: typeof fetch = fetch, now = new Date()) {
  if (env.ENGAGE_DIGEST_ENABLED !== "true") return {disabled:true, sent:0, held:0};
  if (!env.RESEND_API_KEY || !env.AUTH_EMAIL_FROM || !env.ENGAGE_EMAIL_SECRET) throw new Error("Digest email configuration is incomplete");
  const origin = emailOrigin(env);
  let after: string | undefined;
  for (;;) {
    const unreconciled = await db.collection<any>("engagement_email_events").find({processed:{$ne:true}, ...(after ? {_id:{$gt:after}} : {})}).sort({_id:1}).limit(500).toArray();
    if (!unreconciled.length) break;
    for (const event of unreconciled) await recordEmailEvent(db,event._id,{type:event.type,data:{email_id:event.providerId}},event.receivedAt);
    after = unreconciled[unreconciled.length-1]._id;
  }
  const [members, proposals] = await Promise.all([listMembers(db), listProposals(db, {includeArchived:false})]);
  let sent = 0, held = 0;
  const outbox = db.collection<any>("engagement_email_outbox");
  for (const member of members.filter(m=>m.status === "verified" && m.emailVerified && !m.disabled)) {
    if (sent + held >= 25) break;
    const preference = await db.collection("engagement_email_preferences").findOne({memberId:member.memberId});
    if (!digestEnabled(preference)) continue;
    // Prior sent OR ambiguous reminders hold a ballot from repeat mail, even on another day.
    const prior = await outbox.find({memberId:member.memberId}).project({ballotKeys:1}).toArray();
    const reminded = new Set(prior.flatMap(p=>p.ballotKeys || []));
    const user: SessionUser = {...member, canParticipate:true, isStaff:false, isAdmin:false};
    const ballots = (await digestBallots(db,user,proposals,now)).filter(b=>!reminded.has(b.key));
    if (!ballots.length) continue;
    const id = createHash("sha256").update(`${member.memberId}:${now.toISOString().slice(0,10)}`).digest("hex");
    const unsubscribeUrl = `${origin}/api/email/unsubscribe?token=${unsubscribeToken(member.memberId,env.ENGAGE_EMAIL_SECRET)}`;
    const content = renderDigest(member.name, ballots, origin, unsubscribeUrl);
    const payload = {from:env.AUTH_EMAIL_FROM,to:[member.email],...content,headers:{"List-Unsubscribe":`<${unsubscribeUrl}>`,"List-Unsubscribe-Post":"List-Unsubscribe=One-Click"}};
    try { await outbox.insertOne({_id:id, memberId:member.memberId, status:"sending", createdAt:now, ballotKeys:ballots.map(b=>b.key)}); }
    catch (error) { if ((error as {code?:number}).code === 11000) continue; throw error; }
    // Recheck subscription immediately before handoff.
    const latest = await db.collection("engagement_email_preferences").findOne({memberId:member.memberId});
    if (!digestEnabled(latest)) { await outbox.updateOne({_id:id},{$set:{status:"cancelled"},$unset:{ballotKeys:""}}); continue; }
    try {
      const response = await send("https://api.resend.com/emails", {method:"POST",headers:{authorization:`Bearer ${env.RESEND_API_KEY}`,"content-type":"application/json","Idempotency-Key":`engage-digest-${id}`},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
      const result = await response.json() as {id?:string};
      if (!response.ok || !result.id) throw new Error("Provider did not confirm acceptance");
      await outbox.updateOne({_id:id},{$set:{status:"sent",providerId:result.id,acceptedAt:new Date()}}); sent++;
    } catch {
      await outbox.updateOne({_id:id},{$set:{status:"held",heldAt:new Date()}}); held++;
    }
  }
  return {sent,held};
}

export function verifyResendWebhook(raw: string, headers: Headers, secret: string, now = Date.now()) {
  const id = headers.get("svix-id"), timestamp = headers.get("svix-timestamp"), signature = headers.get("svix-signature");
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_") || !/^\d+$/.test(timestamp) || Math.abs(now/1000-Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256",Buffer.from(secret.slice(6),"base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return signature.split(" ").some(s=>s.startsWith("v1,") && safeEqual(s.slice(3),expected));
}
export async function recordEmailEvent(db:Db, eventId:string, event:{type:string; data:{email_id:string}}, now = new Date()) {
  const supported = ["email.delivered","email.bounced","email.complained","email.failed","email.delivery_delayed","email.opened","email.clicked"];
  if (!supported.includes(event.type) || !event.data?.email_id) return;
  // Store only the provider correlation, not email addresses, click destinations or ballot choices.
  await db.collection<any>("engagement_email_events").updateOne({_id:eventId},{$setOnInsert:{providerId:event.data.email_id,type:event.type,receivedAt:now}}, {upsert:true});
  const outbox = db.collection<any>("engagement_email_outbox");
  const message = await outbox.findOne({providerId:event.data.email_id});
  if (!message) {
    // Ignore unrelated sign-in mail after a day, allowing early engagement events time to correlate.
    if (Date.now() - new Date(now).getTime() > 86400000) await db.collection<any>("engagement_email_events").updateOne({_id:eventId},{$set:{processed:true,unmatched:true}});
    return;
  }
  const field = event.type.replace("email.","");
  await outbox.updateOne({_id:message._id},{$set:{[`${field}At`]:now}});
  if (["email.bounced","email.complained"].includes(event.type)) await db.collection("engagement_email_preferences").updateOne({memberId:message.memberId},{$set:{memberId:message.memberId,suppressed:true,suppressionReason:event.type,updatedAt:now}},{upsert:true});
  await db.collection<any>("engagement_email_events").updateOne({_id:eventId},{$set:{processed:true}});
}
