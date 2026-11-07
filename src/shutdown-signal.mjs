// Say which signal stopped the bridge, then die by it as before. Node cannot see the sender, so the line names the signal only.
// Kept out of server.mjs: the owner-path test forbids process.kill in that file.
export function logShutdownSignals(log) {
  for (const signalName of ['SIGTERM', 'SIGINT']) {
    process.once(signalName, () => {
      const entry = { kind: 'shutdown_signal', signal: signalName };
      try { log(entry); } catch {}
      console.error(JSON.stringify(entry));
      process.kill(process.pid, signalName);
    });
  }
}
