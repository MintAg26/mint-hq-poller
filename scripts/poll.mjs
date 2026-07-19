#!/usr/bin/env node
// Polls the Mint HQ board for cards sitting in a trigger status and starts a
// runner chain for each one.
//
// Why polling: projects_v2_item webhooks exist only for ORGANISATION projects.
// Mint HQ is a user-owned project (MintAg26), and GitHub has no user-level
// webhooks, so there is no event to subscribe to. Polling the GraphQL API is
// the only mechanism available. This lives in a public repo because GitHub
// Actions minutes are free there; the private repo only burns minutes on real work.
//
// State lives on the issue as the `runner:active` label - no database.
//   no label + In Progress -> start a chain
//   label present          -> a chain is already running, leave it alone

const TOKEN = process.env.GH_DISPATCH_TOKEN;
const OWNER = process.env.BOARD_OWNER || "MintAg26";
const NUMBER = Number(process.env.BOARD_NUMBER || 2);
const FIELD = process.env.STATUS_FIELD || "Status";
const TRIGGER = (process.env.TRIGGER_STATUSES || "In Progress")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const TARGET = process.env.TARGET_REPO || "MintAg26/mint-hq";
const ACTIVE = "runner:active";
const DRY = process.env.DRY_RUN === "true";

if (!TOKEN) { console.error("missing GH_DISPATCH_TOKEN"); process.exit(1); }

async function gql(query, variables, attempt = 1) {
  try {
    return await gqlOnce(query, variables);
  } catch (err) {
    // GitHub returns transient 5xx and secondary rate limits often enough that
    // one blip should not turn into a red run and a five minute stall.
    if (attempt >= 3) throw err;
    const wait = attempt * 2000;
    console.error(`  graphql attempt ${attempt} failed (${String(err).slice(0,120)}), retrying in ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    return gql(query, variables, attempt + 1);
  }
}

async function gqlOnce(query, variables) {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json",
               "User-Agent": "mint-hq-poller" },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`graphql http ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

const Q = `
query($login:String!,$num:Int!,$cursor:String){
  user(login:$login){
    projectV2(number:$num){
      title
      items(first:100, after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{
          fieldValueByName(name:"${FIELD}"){
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
          content{
            __typename
            ... on Issue {
              number title state
              repository{ nameWithOwner }
              labels(first:30){ nodes{ name } }
            }
          }
        }
      }
    }
  }
}`;

const all = [];
let cursor = null, page = 0, title = "";
do {
  const d = await gql(Q, { login: OWNER, num: NUMBER, cursor });
  const p = d.user?.projectV2;
  if (!p) throw new Error(`project #${NUMBER} not found for user ${OWNER}`);
  title = p.title;
  all.push(...p.items.nodes);
  cursor = p.items.pageInfo.hasNextPage ? p.items.pageInfo.endCursor : null;
} while (cursor && ++page < 20);

console.log(`board "${title}": ${all.length} items`);

const due = all.filter(n => {
  const status = n.fieldValueByName?.name;
  const c = n.content;
  if (!status || !TRIGGER.includes(status.toLowerCase())) return false;
  if (c?.__typename !== "Issue" || c.state !== "OPEN") return false;
  return !(c.labels?.nodes ?? []).some(l => l.name === ACTIVE);
});

console.log(`${due.length} card(s) to start`);
if (!due.length) process.exit(0);

let started = 0, failed = 0;
for (const n of due) {
 try {
  const c = n.content;
  const repo = c.repository.nameWithOwner;
  console.log(`  -> ${repo}#${c.number} ${JSON.stringify(c.title.slice(0, 60))}`);
  if (DRY) continue;

  // Label FIRST. If the dispatch then fails we retry next poll; if we dispatched
  // first and labelling failed we would start a second chain every 5 minutes.
  const lr = await fetch(`https://api.github.com/repos/${repo}/issues/${c.number}/labels`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
               "User-Agent": "mint-hq-poller" },
    body: JSON.stringify({ labels: [ACTIVE] }),
  });
  if (!lr.ok) { console.error(`     label failed ${lr.status}: ${await lr.text()}`); continue; }

  const dr = await fetch(`https://api.github.com/repos/${TARGET}/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json",
               "User-Agent": "mint-hq-poller" },
    body: JSON.stringify({
      event_type: "board-status-changed",
      client_payload: { task: { issue_repo: repo, issue_number: c.number, iteration: 1 } },
    }),
  });
  if (!dr.ok) { console.error(`     dispatch failed ${dr.status}: ${await dr.text()}`); failed++; }
  else { console.log(`     dispatched`); started++; }
 } catch (err) {
  // A transient 5xx or secondary rate limit on one card must not kill the run.
  // The label is only written on success, so the next poll retries this card.
  failed++;
  console.error(`     error: ${String(err)}`);
 }
}
console.log(`started=${started} failed=${failed}`);
if (started === 0 && failed > 0) process.exit(1);
