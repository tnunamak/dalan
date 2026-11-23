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
// The golden test always passes; the admin-socket probe (scripts/admin-socket-probe.mjs) is ready unless MODE says otherwise.
const node = `#!/bin/sh
case "$1" in scripts/catalog-golden-test.mjs) exit 0;; scripts/admin-socket-probe.mjs) ;; *) exit 24;; esac
tree=$(cat "$FAKE_DIR/tree")
if [ "$tree" = candidate ]; then
  case "$MODE" in not-ready) exit 1;; esac
fi
exit 0
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
  for(const [name,body] of Object.entries({git,systemctl,node:node,sleep:'#!/bin/sh\\nexit 0\\n'}))
    writeFileSync(join(fake,name),body.replaceAll('\\n','\n'),{mode:0o700});
  for(const [name,value] of Object.entries({branch:'previous',tree:'previous',service:'previous',checks:'0',events:'',head:'refs/heads/main'}))
    writeFileSync(join(fake,name),value+'\n');
  const result=spawnSync('bash',[join(bin,'catalog-release.sh'),'candidate-branch'],{
    env:{PATH:fake+':/usr/bin:/bin',HOME:root,FAKE_DIR:fake,MODE:mode},encoding:'utf8',timeout:5000,
  });
  const read=name=>readFileSync(join(fake,name),'utf8').trim();
  return {result,branch:read('branch'),service:read('service'),tree:read('tree'),head:read('head'),events:read('events').split('\n')};
}

for (const mode of ['success','delayed','timeout','not-ready','restart-fails']) test('catalog release '+mode,t=>{
  const {result,branch,service,tree,head,events}=release(t,mode);
  assert.equal(result.error,undefined);
  const success=mode==='success'||mode==='delayed';
  assert.equal(result.status,success?0:1,result.stderr);
  assert.equal(branch,success?'candidate':'previous');
  assert.equal(service,branch);
  assert.equal(tree,branch);
  assert.equal(head,'refs/heads/main');
  const candidateProbes=events.filter(x=>x==='probe:candidate').length;
  assert.equal(candidateProbes,{success:1,delayed:4,timeout:20,'not-ready':20,'restart-fails':0}[mode]);
  assert.equal(events.includes('promote:candidate'),success);
  if(success)assert.ok(events.lastIndexOf('probe:candidate')<events.indexOf('promote:candidate'));
  else assert.ok(events.includes('restart:previous')&&events.includes('probe:previous'));
});

// The real probe, on both data layouts a legacy-named service can use: it must find the socket the daemon would bind.
import net from 'node:net';
import {bridgeSocket} from './admin-socket-probe-lib.mjs';
import {fileURLToPath} from 'node:url';
import {cpSync} from 'node:fs';
import {adminSocketPath} from '../src/admin-socket.mjs';
function listen(file){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(file,()=>resolve(server));});}
const probeFile=fileURLToPath(new URL('./admin-socket-probe.mjs',import.meta.url));
function probe(home,file=probeFile,out={}){const r=spawnSync(process.execPath,[file],{env:{...process.env,HOME:home},timeout:5000,encoding:'utf8'});out.stderr=r.stderr;return r.status;}
for (const [layout,dir] of [['legacy','dot-bridge'],['current','dalan']]) test(`admin socket probe finds a bridge on the ${layout} data layout`,async t=>{
  const home=mkdtempSync(join(tmpdir(),'probe-home-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const data=join(home,'.local/share',dir);
  mkdirSync(data,{recursive:true});
  writeFileSync(join(data,'bridge.db'),'x'); // an initialized root, so the daemon's own resolution picks it
  const expected=bridgeSocket(home);
  assert.equal(expected,adminSocketPath(data),'the probe picked another data root');
  assert.equal(probe(home),1,'nothing listens yet');
  const server=await listen(expected);
  t.after(()=>server.close());
  assert.equal(probe(home),0,'a listener on the daemon socket is found');
});

// A checkout path with a space (and other URL-escaped characters) must still probe: a skipped probe would exit 0 and read as ready.
test('admin socket probe runs from a checkout path with a space and reports no listener',t=>{
  const root=mkdtempSync(join(tmpdir(),'probe spaced '));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const dir of ['scripts','src']) mkdirSync(join(root,dir));
  for(const file of ['scripts/admin-socket-probe.mjs','scripts/admin-socket-probe-lib.mjs','src/admin-socket.mjs','src/paths.mjs','src/env.mjs'])
    cpSync(fileURLToPath(new URL('../'+file,import.meta.url)),join(root,file));
  const home=mkdtempSync(join(tmpdir(),'probe-home-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const out={};
  assert.equal(probe(home,join(root,'scripts/admin-socket-probe.mjs'),out),1);
  assert.equal(out.stderr,'','the probe failed to load instead of probing');
});
