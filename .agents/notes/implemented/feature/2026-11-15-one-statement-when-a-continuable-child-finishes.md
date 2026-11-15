# Agent Note: One statement when a continuable child finishes

Status: implemented

English | [中文](2026-11-15-one-statement-when-a-continuable-child-finishes.zh.md)

## Problem

A continuable background child that did exactly what it was told cost its parent two messages for one event.

[The report obligation](2026-08-06-continuable-child-report-obligation.md) instructs the child to call `report` with a self-contained result before it finishes, and made `wakeup` the default so that report reaches a parked parent. [Manager-owned settlement delivery](2026-08-06-manager-owned-subagent-settlement-delivery.md) then has the runtime state what became of the child, unconditionally, carrying the child's final assistant content. Each is right on its own. Together, a compliant child produces:

```text
Background subagent <id> reported:
<the result>

Background subagent <id> finished and will do no further work unless you send it more.
Its closing message:
<the same result, in slightly different words>
```

Measured on a real coordinator's log, the two arrived nine seconds apart and the second restated the first: the parent paid for the same answer twice and had to work out that two messages described one ending. The restatement is not an accident of wording. The child is told the report is the result channel and that a closing remark such as "done" is useless, so a child that reports well writes its answer twice — once where it counts, once on the way out.

The two were also unorderable. The `subagent-report` snapshot scenario could not be authored at all against the shipped default, because the report's wake and the settlement's wake raced 50/50 over whether the second extended the first's turn or opened its own; that scenario pinned `reportDelivery: quiet` purely to dodge it.

Merging them after the fact is impossible. The report's waking delivery makes the parent claim it seconds before settlement, so by the time the notice exists the duplicate has already been consumed.

## Decision

A third `reportDelivery` mode, `settlement`, holds the report and delivers it inside the child's own settlement notice. It is the default.

```text
Background subagent <id> finished and will do no further work unless you send it more.
Its report:
<the result>
```

One message, carrying both the outcome and the result, with one wake.

The notice replaces its closing-message restatement with the held reports rather than adding to them. A child that reported has already said what it produced through the channel its own instructions name as the result; restating the closing remark after it is the duplication this mode exists to remove. Several held reports each get a labelled lead-in — `Its report:` alone, `Its report 1 of 3:` and so on when there are more — so the parent can see where one ends and in what order the child made them.

`wakeup` and `quiet` are unchanged, down to the notice still carrying the closing message. They are what a deployment keeps when the parent must act on an early report before the child has finished, and taking the closing message out of them would cost such a deployment the only copy of a final answer the child never got round to reporting. No mode produces a message that restates another.

### Delivery stays unconditional; only the content moves

[Settlement delivery](2026-08-06-manager-owned-subagent-settlement-delivery.md) rejected "deliver only when the child did not report" because it "makes the parent-facing promise conditional", and rejected making delivery configurable at all. Both still hold and neither is touched: every announced child's settlement sends exactly one notice, in every mode, whatever the child did. What this note changes is which blocks that one notice carries. The condition is not bookkeeping about a channel the manager does not own — it is whether the manager is itself holding content for this epoch, which is its own state and nothing else's.

The promise therefore stays statable, and `tool-subagent` states it: the notice carries the outcome and the child's result — what it reported, or its final assistant message when it reported nothing.

### Provenance

The merged message keeps `{ kind: 'subagent-settled', form: 'notice' }`. The kind names the author of the account, not the provenance of every block inside it, and the notice already quoted the child under a lead-in the manager wrote. `Its report:` is that same construction. The collapsed `notice` row stays the manager's one-line outcome, so the child's words never reach a UI as though the runtime had written them.

### The hold never outlives the child's own work

A residency epoch does not end at idle. `stateOf()` returns `waiting` while the Activation owns live descendants, so a child that delegates and then goes quiet is not settling and no notice is coming. Holding until its whole subtree finished would strand a result the parent could already act on, with no way out: `interrupt()` cancels the current turn of an already idle child and does not cascade.

So the hold is released at the child's own quiescence, not at the Activation's. When the settlement watcher observes a quiescent child it cannot settle, it flushes every held report through the ordinary waking report path and keeps waiting. A delegating child therefore degrades to exactly today's two messages — never to an indefinite wait — and the merged single message remains the normal case, which is every child that does not itself delegate.

A report accepted while the child is *already* quiescent has missed that observation, so holding it pokes the watcher to re-observe. Only the service API can reach that state; a `report` tool call runs inside a turn.

### The acknowledgement names a real message

`report` returns the `MessageId` of the parent message that accepted it, and [the report tool](2026-07-30-continuable-subagent-report-tool.md) says so. A held report has no message of its own, so the Activation mints the settlement notice's identity when it is created and the notice is built with that exact id. The child's acknowledgement therefore names the message that actually delivers its report instead of a dangling identity, and every report held in one epoch is acknowledged with the id of the one message carrying them all.

### What the child is told

The guidance and the tool description differ by mode, because the child is the one deciding whether to call again and the honest answer differs. Under `settlement` an early report cannot earn an early reaction, so inviting the child to report "whenever a partial finding changes what that agent should do next" would promise something it cannot get; what is true there is that nothing it reports is dropped in favour of a later report. Under `wakeup` and `quiet` the original invitation is still true and is unchanged.

## Alternatives considered

**Drop the closing message under `wakeup` and `quiet` too.** The duplication is real in those modes as well, but there the report has already gone as its own message, so removing the restatement removes content instead of a copy of it: a child that reports progress, works on, and ends with a different answer it never reports would lose that answer. Those modes exist to preserve today's behaviour for deployments that opted out, so they keep it.

**Deduplicate by comparing the closing message against what was reported.** The real restatements are reworded, not identical — the measured pair shared no sentence — so exact matching never fires and anything looser is a guess about meaning. It would also make the notice's content depend on a similarity threshold nobody can check.

**Hold every report until the Activation settles.** Rejected above: a child that delegates would hold a finished result for its whole subtree, unreachable by `interrupt()`.

**Let the child pick the mode per call.** Unchanged from [the report tool's](2026-07-30-continuable-subagent-report-tool.md) original rejection: the model would own scheduler pressure and behaviour would vary per call rather than per deployment.

**Suppress the settlement notice when the child reported.** This is the rejected conditional promise, reached from the other side. A parent that cannot rely on the notice polls anyway.

**Cap the number of reports one notice carries.** The merged message carries exactly the content the parent would have received as separate messages; the token cost is identical and only the message count drops. A cap would silently drop a child's reported result, which is worse than the duplication being fixed.

## Testing

- `packages/subagent/subagent/tests/continuation.spec.ts` pins the merge: one message and no separate relay for a report-then-finish, the closing message replaced rather than appended, several reports in acceptance order under numbered lead-ins, a held report carried under a ceiling so a cut-short child is not reported as finished, the acknowledgement id equal to the delivered notice's id, per-epoch isolation across a cold resume, the flush when a quiescent child still owns a live grandchild, and the warning that names held reports lost with an undeliverable notice. The existing `quiet` test additionally pins that a separately scheduled report leaves the closing message in place.
- `packages/subagent/tool-subagent-report/tests/tool-subagent-report.spec.ts` pins the new default, that an accepted report under it enqueues nothing and starts no parent request while still arriving in the notice, and that the child-facing guidance tells the truth about delivery timing in each mode.
- The assembled ACP `subagent-report` scenario now runs on the shipped default and pins the single merged message end to end. Its `reportDelivery: quiet` overlay is gone: with one wake there is nothing left to race, which is the nondeterminism that overlay existed to dodge.

## Consequences

- A compliant continuable child costs its parent one message and one wake per ending instead of two of each. Fan-out deployments save a turn per child.
- `Activation` carries `heldReports` and `settlementMessageId`. The report package's "no Activation state, no delivery queue" claim no longer holds; [the report tool note](2026-07-30-continuable-subagent-report-tool.md) records the correction.
- The `subagent-report` scenario stopped needing a config overlay to be authorable. `wakeup` and `quiet` keep their coverage in the report package's own tests.
- `tool-subagent` promises the notice's content in both its tool description and its prompt section, so both change with the notice. Every assembled transcript's pinned tool text moves with them.

### Accepted risks

Held reports live only in process memory on the Activation. A crash during the hold loses them with no log line, where an immediately delivered report would already be durable. The child's own session remains the recovery source, as it already is for every other report-delivery failure.

A parent whose own lineage is closing is injected rather than woken, and its own disposal clears the unclaimed notice. The held report shares that fate, where a `wakeup` report would usually have arrived seconds earlier. The notice was already lost in that case; the increment is the result it now carries. `wakeup` is the escape.

The result and the ending now travel together, so a parent cancelled before claiming that one message loses both, where previously the result sat in an earlier message it had already claimed. The window is one step boundary.

A child that reports early, keeps working, and finishes with a different answer it never reports loses that answer from the notice, because the notice drops the closing message once it is carrying a report. The instruction the child receives tells it to report again whenever its conclusions change, and the notice still carries the true stop reason, so a parent is never told a cut-short child finished.
