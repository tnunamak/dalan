# Durability review notes

This page lists what Dalan guarantees across a crash or restart, and what an operator must settle by hand: notification delivery, claim leases, dead-man alerts, fenced waiters and protocol retention.

The notification ledger commits a pending reservation before publishing. A process that restarts with a pending reservation treats the notification as uncertain and does not publish it again without reconciliation. An operator can inspect pending hashes through `GET /notify-pending` and settle one through `POST /notify-reconcile` after checking the receiver. Definite rejections become retryable without manual intervention. Delivered keys are retained, so a wall-clock jump cannot prune them and permit a duplicate send.

Owner cancellation waits when a result notification is sending or uncertain. The owner can reconcile the delivery before deciding whether to cancel.

## Claim leases

Every new claim stores an absolute lease deadline. Ordinary activity moves that deadline; protocol claims keep their fixed deadline. The authoritative lease rule, including usage breaks, is in [connection longevity](connection-longevity.md). Preparation deadlines (the time a job may wait in the queue) are a different rule and are covered in [pull workers](pull-workers.md). The service anchors its runtime clock to a monotonic source so wall-clock adjustments do not change lease authority while it runs. Claims created before the deadline column use their last recorded activity plus the stored lease duration as a fallback.

The acknowledgment ledger records a receiver response before the main database marks delivery. If the service stops between those local writes, recovery uses the stored acknowledgment without sending again. A stop after receiver acceptance but before the acknowledgment write remains a remote-delivery window. Each webhook sends its stable event ID as Idempotency-Key; receivers must deduplicate that key to prevent a repeated effect, and the header cannot force them to do so.

An expired durable waiter can still expose already materialized deliveries through its inbox and accept their acknowledgments.

## Interrupted dead-man alerts

An alert that was accepted just before the dead-man process stopped may remain `uncertain`. The alert includes a stable delivery reference. Check the receiver for that reference, then run `dalan-deadman reconcile EPISODE initial|reminder sent|unsent --evidence RECEIPT` with evidence that identifies the receiver's result. Reconciliation is sent to the running dead-man service, which refuses while a publish is still `sending`; restart the service after a crash so it can mark that send uncertain before reconciliation. `sent` records confirmed delivery; `unsent` allows a new attempt with the same delivery reference. Do not reconcile an ambiguous result as `unsent` without checking the receiver. The `status` command opens the database read-only and cannot change a live send.

A waiter reserved by a process in a different PID namespace can also remain waiting after a container replacement. The bridge cannot safely infer that the old process exited from a namespace mismatch. Keep the reservation fenced until an operator or supervisor can provide reliable process-incarnation evidence; a timeout alone must not release it.

Regrant also remains blocked when any historical host check lacks a verified stop receipt. Elapsed time or a finished check does not prove that the old process stopped. Resolve the block only with trusted stop evidence.

## Protocol retention

Assignments whose protocol retention has expired no longer count as queued, appear in the worker queue, or set the queue wake bit. Logical expiry writes a tombstone that fences later reads and claims. Physical purge is not implemented: the tombstone remains pending, and late stop observations are rejected after that fence. Retention expiry therefore does not mean that stored bytes were erased.
