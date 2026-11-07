# Queue

TLC reached 5 states and 10 steps. The chart draws 5 states and 5 arrows.
The chart does not draw 5 steps that stay in one chart state.

## QueueProgress breaks
TLC's counterexample is in tlc.out. It has 2 steps:
0. new; connection A; lease 0; returned none; read none; finish none/none; break false; fixed lease false
1. owner approves A and requester submits: queued; connection A; lease 0; returned none; read none; finish none/none; break false; fixed lease false
2. owner replaces A with B: queued; connection B; lease 0; returned none; read none; finish none/none; break false; fixed lease false
The run stops in "queued; connection B; lease 0; returned none; read none; finish none/none; break false; fixed lease false" forever.

## Rules that hold
NoDeadlock
