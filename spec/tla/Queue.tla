---------------- MODULE Queue ----------------
EXTENDS Claims
QueueNext == ApproveSubmit \/ Replace \/ Cancel \/ Done
QueueSpec == (Init /\ fixed = FALSE) /\ [][QueueNext]_vars
================================================
