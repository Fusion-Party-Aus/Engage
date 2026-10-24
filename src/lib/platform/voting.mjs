export function isBallotOpen(ballot, now = new Date()) {
  return ballot.status === "open" && ballot.opensAt <= now && now < ballot.closesAt;
}

export function calculateStrictMajority(approve, doNotApprove) {
  const votesCast = approve + doNotApprove;
  return {
    votesCast,
    outcome: votesCast === 0 ? "no-valid-votes" : approve > votesCast / 2 ? "approved" : "not-approved",
  };
}

export function validateVoteChoice(choice) {
  return choice === "approve" || choice === "do-not-approve";
}

export function formalVotingIsEnabled(env) {
  return env.APP_MODE === "production" && (env.FORMAL_BALLOTS_ENABLED === "true" || env.BINDING_BALLOTS_ENABLED === "true");
}

export async function upsertCurrentVote(votes, selection, choice, now) {
  try {
    await votes.updateOne(selection, {
      $set: { choice, updatedAt: now, synthetic: true },
      $setOnInsert: { createdAt: now },
    }, { upsert: true });
  } catch (error) {
    // A simultaneous first vote can race on the compound unique index. Retry as an update of the single current vote.
    if (!error || typeof error !== "object" || error.code !== 11000) throw error;
    await votes.updateOne(selection, { $set: { choice, updatedAt: now, synthetic: true } });
  }
}
