import path from 'node:path';

const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

// The command that starts a trial bridge for `home`. `dalan try` alone starts the default trial home, so only another
// home needs --home.
export function tryCommand(cli, home, realHome) {
  return path.resolve(home) === path.join(realHome, '.local/share/dalan-trial') ? `${cli} try` : `${cli} try --home ${shellQuote(home)}`;
}

export const stoppedTrialFix = (cli, home, realHome) => `start it in another terminal, then run this command again: ${tryCommand(cli, home, realHome)}`;
