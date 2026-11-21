import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const git = `#!/bin/sh
case "$1" in
 status) exit 0;;
 symbolic-ref)
  if [ "$2" = "-q" ]; then printf 'refs/heads/main\\n'; else printf '%s\\n' "$3" > "$FAKE_DIR/head"; fi;;
 rev-parse)
  case "$*" in *'^{commit}'*) printf 'candidate\\n';; *) cat "$FAKE_DIR/branch";; esac;;
 merge-base) exit 0;;
 switch)
  printf '%s\\n' "$3" > "$FAKE_DIR/tree"
  printf 'switch:%s\\n' "$3" >> "$FAKE_DIR/events";;
 update-ref)
  test "$(cat "$FAKE_DIR/branch")" = "$4" || exit 1
  printf '%s\\n' "$3" > "$FAKE_DIR/branch"
  printf 'promote:%s\\n' "$3" >> "$FAKE_DIR/events";;
 merge)
  # Baseline support makes the regression fail for behavior rather than an unknown fake command.
  printf 'candidate\\n' > "$FAKE_DIR/branch"
  printf 'candidate\\n' > "$FAKE_DIR/tree";;
 *) exit 22;;
esac
`;
const systemctl = `#!/bin/sh
tree=$(cat "$FAKE_DIR/tree")
case "$2" in
 restart)
  printf 'restart:%s\\n' "$tree" >> "$FAKE_DIR/events"
  if [ "$tree" = candidate ] && [ "$MODE" = restart-fails ]; then exit 1; fi
  printf '%s\\n' "$tree" > "$FAKE_DIR/service";;
 is-active)
  n=$(cat "$FAKE_DIR/checks"); n=$((n+1)); printf '%s\\n' "$n" > "$FAKE_DIR/checks"
  printf 'probe:%s\\n' "$tree" >> "$FAKE_DIR/events"
  if [ "$tree" = previous ]; then exit 0; fi
  case "$MODE" in timeout) exit 1;; delayed) test "$n" -ge 4;; *) exit 0;; esac;;
 *) exit 23;;
esac
`;
function release(t, mode) {
  const root=mkdtempSync(join(tmpdir(),'catalog-release-fake-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bin=join(root,'bin'),fake=join(root,'fake');
  mkdirSync(bin);mkdirSync(fake);
  copyFileSync(new URL('../bin/catalog-release.sh',import.meta.url),join(bin,'catalog-release.sh'));
  for(const [name,body] of Object.entries({git,systemctl,node:'#!/bin/sh\\nexit 0\\n',sleep:'#!/bin/sh\\nexit 0\\n'}))
    writeFileSync(join(fake,name),body.replaceAll('\\n','\n'),{mode:0o700});
  for(const [name,value] of Object.entries({branch:'previous',tree:'previous',service:'previous',checks:'0',events:'',head:'refs/heads/main'}))
    writeFileSync(join(fake,name),value+'\n');
  const result=spawnSync('bash',[join(bin,'catalog-release.sh'),'candidate-branch'],{
    env:{PATH:fake+':/usr/bin:/bin',FAKE_DIR:fake,MODE:mode},encoding:'utf8',timeout:5000,
  });
  const read=name=>readFileSync(join(fake,name),'utf8').trim();
  return {result,branch:read('branch'),service:read('service'),tree:read('tree'),head:read('head'),events:read('events').split('\n')};
}

for (const mode of ['success','delayed','timeout','restart-fails']) test('catalog release '+mode,t=>{
  const {result,branch,service,tree,head,events}=release(t,mode);
  assert.equal(result.error,undefined);
  const success=mode==='success'||mode==='delayed';
  assert.equal(result.status,success?0:1,result.stderr);
  assert.equal(branch,success?'candidate':'previous');
  assert.equal(service,branch);
  assert.equal(tree,branch);
  assert.equal(head,'refs/heads/main');
  const candidateProbes=events.filter(x=>x==='probe:candidate').length;
  assert.equal(candidateProbes,{success:1,delayed:4,timeout:20,'restart-fails':0}[mode]);
  assert.equal(events.includes('promote:candidate'),success);
  if(success)assert.ok(events.lastIndexOf('probe:candidate')<events.indexOf('promote:candidate'));
  else assert.ok(events.includes('restart:previous')&&events.includes('probe:previous'));
});
