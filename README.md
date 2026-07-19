# mint-hq-poller

Starts Mint HQ runner chains when a card is dragged to **In Progress**.

Deliberately public and deliberately empty of anything sensitive: GitHub Actions
minutes are free on public repos, so this can poll every 5 minutes at no cost,
while the private `mint-hq` repo only spends minutes doing real work.

## Why polling and not a webhook

`projects_v2_item` webhooks are available for **organisation** projects only.
Mint HQ is a user-owned project and GitHub has no user-level webhooks, so there
is no event to subscribe to. Polling the GraphQL API is the only option
available on a personal account.

## How a chain starts

    card dragged to In Progress
      -> poll.mjs sees it has no `runner:active` label
      -> adds the label, fires repository_dispatch at mint-hq
      -> board-runner.yml takes over and loops there

The label is the lock. While it is on the issue this poller ignores the card,
so a long-running chain is never started twice. The runner removes it when the
chain ends.

If a chain ever wedges, remove `runner:active` from the issue and the next poll
picks it up again.

## Secret

`GH_DISPATCH_TOKEN` - fine-grained PAT, read+write on Issues and Contents for
`mint-hq`, plus read on Projects. Nothing else.
