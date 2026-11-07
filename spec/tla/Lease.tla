---------------- MODULE Lease ----------------
EXTENDS Claims
LeaseNext == ApproveSubmit \/ FreshClaim \/ StartBreak \/ Revoke \/ Clock \/ Sweep \/ Done
LeaseSpec == (Init /\ fixed = FALSE) /\ [][LeaseNext]_vars /\ WF_vars(Clock) /\ WF_vars(Sweep)
================================================
