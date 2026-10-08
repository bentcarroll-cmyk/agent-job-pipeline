// Re-fetch one posting for materials generation:
//
//   npx tsx tools/materials/fetch-posting.ts <posting url>
//
// Prints one JSON object on stdout. Exit codes let the caller branch without
// parsing: 0 live, 2 unsupported URL, 3 posting closed, 4 identity conflict.
// Exit 1 is a transient fetch error — retry it; never record a transient
// failure as posting_closed. Exit 4 means the provider answered for another
// posting than the URL names: retrying cannot fix that, so don't.
//
// This file is intentionally glue only. It sits outside tsconfig's include
// because it needs Node globals the Workers types do not declare, so every
// line of logic worth type-checking lives in src/fetch-job.ts, which is
// typechecked and tested.
import { jobRefId, parseJobUrl } from "../../src/unbounded/discovery";
import { fetchJobForRef } from "../../src/fetch-job";
import { isPostingIdentityConflict } from "../../src/sources";
import { MAX_MATERIALS_CHARS } from "../../src/description";

const url = process.argv[2];
if (!url) {
  console.error("usage: fetch-posting.ts <posting url>");
  // 64 (EX_USAGE, sysexits.h) is a CLI-invocation error, not a posting
  // outcome — deliberately outside the 0/1/2/3 contract above, which only
  // describes what happens once a URL was actually supplied.
  process.exit(64);
}

const ref = parseJobUrl(url, "");
if (!ref) {
  console.log(JSON.stringify({ status: "unsupported_url", url }));
  process.exit(2);
}

const job = await fetchJobForRef(ref, MAX_MATERIALS_CHARS).catch(error => {
  if (!isPostingIdentityConflict(error)) throw error;
  console.log(JSON.stringify({ status: "identity_conflict", id: jobRefId(ref), url, error: error.message }));
  process.exit(4);
});
if (!job) {
  console.log(JSON.stringify({ status: "posting_closed", id: jobRefId(ref), url }));
  process.exit(3);
}

console.log(JSON.stringify({ status: "live", id: job.id, job }, null, 2));
