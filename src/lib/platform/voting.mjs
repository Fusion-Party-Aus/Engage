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
  return env.APP_MODE === "production" && env.FORMAL_BALLOTS_ENABLED === "true";
}
