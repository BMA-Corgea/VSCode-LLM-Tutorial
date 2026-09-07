# Authority that arrives through someone else

Read this before clearing any `human` gate on behalf of an absent person.

A session may be driven by a **delegate** — another agent, a foreman, an orchestrator — carrying
the owner's standing authority. That authority can be entirely real. What it cannot do is
manufacture the owner's presence.

## The rule

**A `go-ahead` record asserts that a human took a turn in THIS session. Only record one when
they did.**

`tracker.mjs go-ahead --quote "<verbatim>" --human <id>` writes a claim that the named person
said those words, here, now. It is the only evidence a later reader has that a human decided
anything. So:

- **Quote only words that arrived in this session, from the human, in a turn you can see.**
- A delegate relaying words the owner said *elsewhere* — in another conversation, on another day,
  however faithfully — is **not** a substitute. The provenance of a quote is part of the quote.
- A delegate's own instruction, however well-founded, is the delegate's. It may be recorded as
  the delegate's; it may never be recorded as the human's.
- If the authority is real but the turn is missing, the fix is to **get the turn**, not to
  approximate it. Stop at the gate and ask for it in the human's own words.

Everything the delegate authorises that is *not* a human gate — routing, model choice, fixes,
refactors, test strategy, an `unattended` gate — is theirs to give and yours to act on. This rule
is narrow on purpose: it is about the human half of the record, nothing else.

## Why it is written down

**The tracker cannot enforce this.** `--quote` takes any string; `--human` takes any id. Nothing
in the pipeline can distinguish a quote that happened from a quote that was relayed, reconstructed,
or invented in good faith. The check exists only where the words are received.

On 2026-09-07 that gap was reached for real. A delegated agent foreman, holding genuine standing
authority, instructed this session to clear T-6's `accept` gate using a verbatim authorisation
attributed to the owner. The words were real — the foreman held them from its own conversation —
but no such turn existed in this session, and the ledger showed no human event that day. Recording
them would have written a human decision that, from this session's evidence, never occurred.

Nothing mechanical stopped it. The only thing between that instruction and a corrupted ledger was
the worker reading the rule more strictly than its supervisor did.

**That is a load-bearing property that nobody designed, and it should not be left resting on a
worker's good judgment.** Until something mechanical exists, this file is the substitute: the rule
is written down so that following it is the default rather than an act of conscience, and so that
a delegate who asks for it anyway is asking a session to break a documented rule rather than to
exercise unusual scruple.

Corollary, from the same incident: **do not loosen a gate's policy because the keyholder is
absent.** Changing `accept` from `human` to something cheaper does not route around the gate, it
routes around the person — and it is most tempting on exactly the tickets where the gate is worth
most. Fix the missing signature, never the gate.
