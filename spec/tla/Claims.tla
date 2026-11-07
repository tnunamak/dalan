----------------------------- MODULE Claims -----------------------------
EXTENDS Naturals, TLC
VARIABLES jobCount, job, live, holder, lease, readBy, grantTo, pending, liveAtCommit,
          commits, lost, restarted, onBreak, reason, epoch, fixed
vars == <<jobCount,job,live,holder,lease,readBy,grantTo,pending,liveAtCommit,
          commits,lost,restarted,onBreak,reason,epoch,fixed>>
Init == /\ jobCount = 0 /\ job = "new" /\ live = "A" /\ holder = "none" /\ lease = 0
        /\ readBy = "none" /\ grantTo = "none" /\ pending = "none"
        /\ liveAtCommit = "none" /\ commits = 0 /\ lost = FALSE
        /\ restarted = FALSE /\ onBreak = FALSE /\ reason = ""
        /\ epoch = 0 /\ fixed \in BOOLEAN
ApproveSubmit == /\ jobCount' = 1 /\ job = "new" /\ live = "A" /\ job' = "queued"
                 /\ UNCHANGED <<live,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
Replace == /\ job # "new" /\ live = "A" /\ live' = "B"
           /\ UNCHANGED <<jobCount,job,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
Revoke == /\ live \in {"A","B"} /\ live' = "none"
          /\ UNCHANGED <<jobCount,job,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
FreshClaim == /\ job = "queued" /\ live = "A"
              /\ job' = "claimed" /\ holder' = "A" /\ grantTo' = "A" /\ lease' = 2 /\ epoch' = 1
              /\ onBreak' = FALSE
              /\ UNCHANGED <<jobCount,live,readBy,pending,liveAtCommit,commits,lost,restarted,reason,fixed>>
\* Both expired-active-claim branches perform the same destination admission.
\* They differ in the server/Store route; the replay exercises each route.
Regrant == /\ job = "claimed" /\ lease = 0 /\ live = "A"
           /\ lease' = 2 /\ epoch' = (IF epoch = 1 THEN 2 ELSE 1)
           /\ grantTo' = "A" /\ onBreak' = FALSE
           /\ pending' = "none"
           /\ UNCHANGED <<jobCount,job,live,holder,readBy,liveAtCommit,commits,lost,restarted,reason,fixed>>
IdleRotation == Regrant
Takeover == Regrant
Progress == /\ job = "claimed" /\ lease > 0 /\ live = "A"
            /\ lease' = (IF fixed THEN lease ELSE 2) /\ onBreak' = FALSE
            /\ UNCHANGED <<jobCount,job,live,holder,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
\* A duplicate claim retry is accepted only from the connection the grant was given to (A) while it is live.
Duplicate == /\ job = "claimed" /\ lease > 0 /\ live = "A"
             /\ grantTo' = live /\ lease' = (IF fixed THEN lease ELSE 2)
             /\ onBreak' = FALSE
              /\ UNCHANGED <<jobCount,job,live,holder,readBy,pending,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
ReadAssignment == /\ job \in {"queued","claimed"} /\ live \in {"A","B"}
                  /\ readBy' = live
                  /\ onBreak' = FALSE
              /\ UNCHANGED <<jobCount,job,live,holder,lease,grantTo,pending,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
BeginFinish == /\ job = "claimed" /\ lease > 0 /\ live = "A" /\ pending = "none"
               /\ pending' = "A"
               /\ onBreak' = FALSE
              /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
\* The connection liveness read happens inside the committing transaction: a finish whose connection was revoked or replaced after admission is refused.
CommitFinish == /\ pending = "A" /\ job = "claimed" /\ lease > 0 /\ live = "A"
                /\ job' = "finished" /\ commits' = 1 /\ liveAtCommit' = live /\ pending' = "none"
                /\ UNCHANGED <<jobCount,live,holder,lease,readBy,grantTo,lost,restarted,onBreak,reason,epoch,fixed>>
RefuseFinish == /\ pending = "A" /\ live # "A" /\ pending' = "none"
                /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
Cancel == /\ job \in {"queued","claimed"} /\ job' = "cancelled" /\ reason' = "owner"
          /\ UNCHANGED <<jobCount,live,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,onBreak,epoch,fixed>>
Clock == /\ lease > 0 /\ lease' = lease-1
         /\ UNCHANGED <<jobCount,job,live,holder,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
\* The lease sweep releases an expired claim whether or not a usage break is open.
Sweep == /\ job = "claimed" /\ lease = 0
         /\ job' = "queued" /\ holder' = "none"
         /\ pending' = "none"
           /\ UNCHANGED <<jobCount,live,lease,readBy,grantTo,liveAtCommit,commits,lost,restarted,onBreak,reason,epoch,fixed>>
StartBreak == /\ job = "claimed" /\ ~onBreak /\ onBreak' = TRUE
              /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
EndBreak == /\ onBreak /\ onBreak' = FALSE
            /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,lost,restarted,reason,epoch,fixed>>
Restart == /\ ~restarted /\ restarted' = TRUE
           /\ pending' = "none"
           /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,liveAtCommit,commits,lost,onBreak,reason,epoch,fixed>>
LoseReply == /\ ~lost /\ job \in {"queued","claimed","finished"} /\ lost' = TRUE
             /\ UNCHANGED <<jobCount,job,live,holder,lease,readBy,grantTo,pending,liveAtCommit,commits,restarted,onBreak,reason,epoch,fixed>>
Retry == /\ lost /\ UNCHANGED vars
OtherWorker == UNCHANGED vars
Done == UNCHANGED vars
Next == IdleRotation \/ Takeover \/ Progress \/ ApproveSubmit \/ Replace \/ Revoke \/ FreshClaim \/ Duplicate \/ ReadAssignment
        \/ BeginFinish \/ CommitFinish \/ RefuseFinish \/ Cancel \/ Clock \/ Sweep \/ StartBreak \/ EndBreak
        \/ Restart \/ LoseReply \/ Retry \/ OtherWorker \/ Done
Spec == Init /\ [][Next]_vars /\ WF_vars(Clock) /\ WF_vars(Sweep)
GrantAdmitted == grantTo \in {"none","A"}
ReadAdmitted == readBy \in {"none","A"}
RevokedCannotCommit == job = "finished" => liveAtCommit = "A"
CancelWins == job = "cancelled" => commits = 0
ResultDurable == job = "finished" => commits = 1
AtMostOnce == commits <= 1
RequesterAtMostOnce == jobCount <= 1
NoStuck == (job = "claimed" /\ holder # live) ~> (job # "claimed")
QueueProgress == (job = "queued") ~> ((live = "A") \/ (job = "cancelled" /\ reason # ""))
=============================================================================
