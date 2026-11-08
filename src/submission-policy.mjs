import { defaultPath } from './paths.mjs';
import { secretContent, hasSecretContent, hasCredentialHints, registerSecret, registeredSecrets } from './redaction.mjs';
import {gitEnv} from './git-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { assignmentInput, prepareGithubRepo } from './projects.mjs';
import { firstSegment, laterSegment, readablePath, hasRouterSyntax } from './path-syntax.mjs';

const infrastructureError=message=>Object.assign(new Error(message),{code:'DOT_BRIDGE_INFRASTRUCTURE'});
export const submissionLimits = Object.freeze({brief:16384,instructions:24576,note:4096,notes:16384});
function bytes(value) { return Buffer.byteLength(value,'utf8'); }
// What the worker is told besides the brief: the instruction total that submissionLimits.instructions caps.
export const instructionBytes=r=>bytes(r.brief)+bytes(r.expected_output)+bytes(r.execution_scope||'')+bytes(typeof r.scope_text==='string'?r.scope_text:'')+bytes((r.scope_paths||[]).join('\n'))+bytes((Array.isArray(r.output_paths)?r.output_paths:[]).join('\n'));
// Tree paths a mistyped path may have meant: the same file name elsewhere, or a path within a small edit distance.
export function nearestPaths(target,files,limit=3) {
  const edit=(a,b)=>{ let prev=Array.from({length:b.length+1},(_,i)=>i); for(let i=1;i<=a.length;i++) { const row=[i]; for(let j=1;j<=b.length;j++) row[j]=Math.min(prev[j]+1,row[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); prev=row; } return prev[b.length]; };
  const base=target.split('/').pop(), max=Math.max(2,Math.floor(target.length*0.12));
  const dirs=new Set();for(const f of files) for(let i=f.indexOf('/');i>0;i=f.indexOf('/',i+1)) dirs.add(f.slice(0,i));
  const scored=[];
  for(const f of [...files,...dirs]) {
    if(Math.abs(f.length-target.length)>max+3) continue;
    const d=edit(target,f);
    if(d<=max) scored.push([d,f]); else if(f.split('/').pop()===base) scored.push([max+1,f]);
  }
  return scored.sort((x,y)=>x[0]-y[0]||x[1].localeCompare(y[1])).slice(0,limit).map(x=>x[1]);
}
function cap(value,limit,label) {
  if(typeof value!=='string') throw new Error(`invalid ${label}`);
  const measured=bytes(value);
  if(measured>limit) throw new Error(`${label}: ${measured} UTF-8 bytes exceeds ${limit}; cut at least ${measured-limit} bytes`);
  return measured;
}
export function validateOwnerNote(text,existingNotes=[]) {
  if(!text) throw new Error('invalid note text');
  const measured=cap(text,submissionLimits.note,'owner note');
  const total=existingNotes.reduce((sum,n)=>sum+bytes(n.text),measured);
  if(total>submissionLimits.notes) throw new Error(`aggregate owner notes: ${total} UTF-8 bytes exceeds ${submissionLimits.notes}; cut at least ${total-submissionLimits.notes} bytes`);
}
// Brackets and parentheses are allowed only as whole router segments (`[id]`, `[...slug]`, `(group)`, `(.)x`; src/path-syntax.mjs).
function paths(value,label) {
  if(!Array.isArray(value)||!value.length||value.some(p=>typeof p!=='string'||!p||p.includes('\0')||p.includes('\\')||p.startsWith('/')||p.split('/').some(x=>x==='..')||/[\x00-\x1f\x7f*?]/.test(p)||(hasRouterSyntax(p)&&!readablePath(p.replace(/^\.\//,'').replace(/\/$/,''))))) throw new Error(`invalid ${label}; explicit repository-relative paths required`);
  return value.map(p=>p.replace(/^\.\//,'').replace(/\/$/,''));
}
// output_paths: NEW files the job may create (see docs/usage.md "Creating new files"). Shape only; existence and sensitivity are
// checked against the pinned tree in validateSubmission. Entries must already be in canonical form, so the assignment hash the
// submitter sent is the one that is stored.
export const outputPathLimits=Object.freeze({count:10,length:256});
export const outputPathsHeading='Output paths (output_paths; may create):';
// Comparison keys only: the assignment keeps the submitter's original path strings.
const outputPathKeys=[p=>p,p=>p.toLowerCase(),p=>p.normalize('NFC'),p=>p.normalize('NFC').toLowerCase()];
export function validateOutputPaths(value) {
  const fail=reason=>{throw new Error(`invalid output_paths: ${reason}`);};
  if(!Array.isArray(value)||!value.length) fail('give a non-empty list of repository-relative file paths, e.g. ["docs/notes/research.md"]');
  if(value.length>outputPathLimits.count) fail(`${value.length} paths; at most ${outputPathLimits.count}. Split the job or write fewer files`);
  const seen=new Set();
  for(const p of value) {
    if(typeof p!=='string'||!p) fail('every entry must be a non-empty string');
    if(p.length>outputPathLimits.length) fail(`${p.slice(0,40)}... is ${p.length} characters; at most ${outputPathLimits.length}`);
    if(p.startsWith('/')||/^(?:~|\$HOME)(?:\/|$)/.test(p)||p.includes('\\')) fail(`${p} is not repository-relative; write it relative to the repository root`);
    if(p.split('/').includes('..')) fail(`${p} contains "..": name the file by its path from the repository root`);
    if(/[\x00-\x1f\x7f*?]/.test(p)) fail(`${p} contains a glob or control character; name each file`);
    if(p==='.'||p.endsWith('/')) fail(`${p} names a directory; list the files the job should create`);
    if(p.startsWith('./')) fail(`${p}: write ${p.replace(/^(?:\.\/)+/,'')} (no leading ./)`);
    if(p.split('/').some(x=>!x||x==='.'||x==='.git')) fail(`${p} has an empty, "." or ".git" segment`);
    try { paths([p],'output_paths'); } catch { fail(`${p} has characters that scope paths cannot hold`); }
    if(seen.has(p)) fail(`${p} is listed twice`);
    const conflict=[...seen].find(other=>outputPathKeys.some(key=>{
      const file=key(p),prior=key(other);
      return file===prior||file.startsWith(`${prior}/`)||prior.startsWith(`${file}/`);
    }));
    if(conflict&&outputPathKeys.some(key=>key(p)===key(conflict))) fail(`${p} and ${conflict} name the same file on case-insensitive or Unicode-normalizing filesystems; choose distinct output paths`);
    if(conflict) fail(`${p} and ${conflict} overlap as file and directory; list each new file, not its containing directory`);
    seen.add(p);
  }
  return [...value];
}
// Advisory only: extensionless files are legitimate. Prose never authorizes paths or changes scope.
function warnOutputDirectoryMentions(outputs,text,warn) {
  const mentions=mentionedPaths(text,outputs);
  for(const output of outputs) {
    if(path.posix.extname(output)) continue;
    const nested=mentions.find(file=>file.startsWith(`${output}/`));
    if(nested) warn(`output_paths entry ${output} is an exact new file, not a directory, but the instructions mention ${nested} beneath it. List each new file in output_paths; directories are not supported`);
  }
}
const outputBlock=list=>`${outputPathsHeading}\n${list.join('\n')}`;
export function renderAssignment(assignment) {
  if(!assignment||typeof assignment!=='object') throw new Error('invalid assignment');
  if(assignment.objective===undefined&&assignment.stop_rule===undefined) return assignment;
  if(typeof assignment.objective!=='string'||!assignment.objective.trim()||typeof assignment.stop_rule!=='string'||!assignment.stop_rule.trim()) throw new Error('structured assignment requires objective and stop_rule');
  const scope=assignment.scope_paths===undefined||assignment.scope_paths?.length===0?[]:paths(assignment.scope_paths,'scope_paths');
  if(assignment.inputs?.some(i=>i.github_repo)&&!scope.length) throw new Error('structured repository assignment requires scope_paths');
  const revisions=(assignment.inputs||[]).map(i=>i.github_repo?`${i.github_repo} at ${i.head_sha||i.base_sha}`:JSON.stringify(i)).join('\n')||'No repository inputs';
  const outs=Array.isArray(assignment.output_paths)&&assignment.output_paths.length&&assignment.output_paths.every(p=>typeof p==='string')?`\n\n${outputBlock(assignment.output_paths)}`:'';
  return {...assignment,brief:`Objective:\n${assignment.objective}\n\nExact inputs:\n${revisions}\n\nRead allow-list:\n${scope.length?scope.join('\n'):'No repository scope'}${outs}\n\nExpected output:\n${assignment.expected_output}\n\nStop rule:\n${assignment.stop_rule}`};
}
function loadPolicy() {
  const file=defaultPath(os.homedir(),'.config/dot-bridge/submission-policy.json');
  if(!fs.existsSync(file)) return {version:1,sensitive_paths:[],exceptions:[],sandbox_source_exemptions:[]};
  if((fs.statSync(file).mode&0o777)!==0o600) throw new Error('submission policy must be mode 0600');
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  if(p.version!==1||!Array.isArray(p.sensitive_paths??[])||!Array.isArray(p.exceptions??[])||!Array.isArray(p.sandbox_source_exemptions??[])) throw new Error('invalid submission policy');
  paths(p.sensitive_paths?.length?p.sensitive_paths:['placeholder'],'sensitive_paths');
  for(const e of p.exceptions||[]) {
    if(!e.id||typeof e.id!=='string'||!e.github_repo||typeof e.reason!=='string'||!e.reason.trim()) throw new Error('invalid sensitive scope exception');
    paths([e.path],'exception path');
  }
  const sourceExemptions=(p.sandbox_source_exemptions||[]).map(e=>{
    if(!e||Object.keys(e).sort().join(',')!=='blob_sha,github_repo,path,reason'||typeof e.github_repo!=='string'||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(e.github_repo)||e.github_repo.split('/').some(part=>part==='.'||part==='..'||part.includes('..'))||typeof e.blob_sha!=='string'||!/^[a-f0-9]{40}$/.test(e.blob_sha)||typeof e.reason!=='string'||!e.reason.trim()) throw new Error('invalid sandbox source exemption');
    const [normalized]=paths([e.path],'sandbox source exemption path');
    if(normalized!==e.path||e.path.length>256||e.path.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git')||!isSourceExemptionPath(e.path)) throw new Error('invalid sandbox source exemption path');
    return {github_repo:e.github_repo,path:e.path,blob_sha:e.blob_sha,reason:e.reason};
  });
  return {version:1,sensitive_paths:(p.sensitive_paths||[]).map(s=>paths([s],'sensitive_paths')[0]),exceptions:(p.exceptions||[]).map(e=>({...e,path:paths([e.path],'exception path')[0]})),sandbox_source_exemptions:sourceExemptions};
}
// Shared names and suffixes retain the same boundaries for both sensitive-path rules.
const alwaysHardNames=String.raw`\.env[^/]*|\.ssh|\.gnupg|\.aws|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.pypirc|\.htpasswd|kubeconfig(?:\.[^/]*)?|id_(?:rsa|dsa|ed25519|ecdsa)(?:[-_.][^/]*)?|sign[-_][^/]*release[^/]*`;
const sensitivePathTail=String.raw`(?:\/|$)|(?:^|\/)(?:\.docker|\.kube)\/config(?:\.json)?$|\.(?:pem|p12|pfx|key|keystore|jks|ppk|tfstate(?:\.backup)?)$`;
const alwaysHard=new RegExp(`(?:^|/)(?:${alwaysHardNames})${sensitivePathTail}`,'i');
const hardPath=new RegExp(String.raw`(?:^|/)(?:${alwaysHardNames}|service[-_]account(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*(?:credentials?|private[-_.]?key|gpg[-_.]?secret)[^/]*|(?:[^/]*[-_.])?signing(?:[-_.][^/]*)?)${sensitivePathTail}`,'i');
// "token" alone is not a credential: tokens.css and design-tokens.json are design tokens. A token file is sensitive when a
// credential word qualifies it (auth-token, access_token, gh-tokens.txt, npm.token), or it is a bare `token` file or a
// `tokens.txt|env|key|secret`. Plain `tokens/` and `tokens.json` are the usual design-token names and pass.
const credentialToken=/(?:^|[\/_.-])(?:auth|access|refresh|api|bearer|session|oauth|id|gh|github|gitlab|npm|pypi|slack|discord|telegram|bot|personal|service|deploy|registry|vault|jwt)[-_.]?tokens?(?=[\/_.-]|$)|(?:^|\/)\.?token(?:\.(?:txt|json|env|yaml|yml|key|secret|cfg|conf|ini))?(?=\/|$)|(?:^|\/)\.?tokens\.(?:txt|env|key|secret)(?=\/|$)|(?:^|[\/_.-])tokens?[-_.](?:secret|key|env)(?=[\/_.-]|$)/i;
const softPath=new RegExp(`(?:^|\\/)[^/]*(?:auth|secret|credential)[^/]*(?:\\/|$)|(?:^|[\\/_.-])sign(?:ing|ature)?(?=[\\/_.-]|$)|${credentialToken.source}`,'i');
// Source, test and documentation files often name credentials as code topics rather than secret material. Apply only the
// name rules that mark secret material regardless of extension; secret content is still refused by secretContent, and
// policy-listed paths by sensitive_paths. Shell scripts and SQL keep every name rule because they can hold secrets as plain
// variables, which secretContent does not catch.
const codeFile=/\.(?:ts|tsx|js|jsx|mjs|cjs|py|pyi|rs|go|java|kt|kts|swift|rb|php|cs|c|h|cc|cpp|hpp|m|mm|scala|css|scss|less|html|vue|svelte|astro|md|mdx|rst|adoc|snap|graphql|gql|proto|dart|ex|exs|elm|lua|r|jl|zig|nix)$/i;
// A host pin may expose reviewed source code with a sensitive-looking filename (for example credentials.ts), but never a
// credential store, key, environment file, or file below a secret/credentials data directory.
export function isSourceExemptionPath(file) {
  return typeof file==='string'&&(codeFile.test(file)||/\.sql$/i.test(file))&&!alwaysHard.test(file)&&!passwordName.test(file)&&!secretDirectory.test(file);
}
// In a code file's own name, the precise secret words still mark secret material (credentials.ts, secrets.py, private-key.ts,
// service-account.ts, owner-credential.ts); a word inside a longer name (logout-cancels-credential-setup.test.ts) does not.
const codeSecretName=/(?:^|\/)(?:credentials?|secrets?|private[-_.]?key|service[-_.]?account|[^/]*[-_.](?:credentials?|secrets?))\.[^/.]+$/i;
// Password stores are secret material by name in any form.
const passwordName=/(?:^|\/)(?:\.?htpasswd|shadow|[^/]*passw(?:or)?ds?(?:\.[^/]*)?)$/i;
const secretDirectory=/(?:^|\/)(?:secrets?|credentials?)\//i;
const hardName=file=>passwordName.test(file)||(codeFile.test(file)?alwaysHard.test(file)||codeSecretName.test(file)||secretDirectory.test(file):hardPath.test(file));
// The soft rule reads the file name only: a directory named for what its code does (provider-auth/, unified-auth-data-access/)
// marks no secret. The hard rules still read every segment (secrets/, .ssh/).
// A name without an extension is usually a directory (add-agent-authored-connectors): only the credential-token pattern applies.
const softName=file=>{ if(codeFile.test(file)) return false; const base=file.split('/').pop(); return base.includes('.')?softPath.test(base):credentialToken.test(base)||/secret|credential/i.test(base); };
// A host path the worker is told to read (never a repository path); other leading-slash tokens in prose are routes (/v1, /me).
// A token shaped like a file (a path, a dotfile, a home path or a known file extension), not an identifier like input.privateKey.
const fileShaped=file=>/[\/~$]/.test(file)||file.startsWith('.')||sourceExtension.test(file);
const hostPath=/^(?:~|\$HOME)(?:\/|$)|^\/(?:home|root|etc|var|tmp|usr|opt|proc|sys|dev|run|mnt|media|srv|boot|private|Users|Library|Volumes)(?:\/|$)/;
// Secret values by shape: private keys, GitHub/AWS/OpenAI/Stripe/Slack/Google/GitLab/npm tokens, URLs with an inline password
// (local and example hosts excepted: postgres://postgres:postgres@localhost is a test fixture).
export { secretContent } from './redaction.mjs';
const authority=/\b(?:we|you|dot)\s+(?:have|has|can use)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:free|available|live|idle|worker)\s+)*(?:slots?|lanes?|workers?)\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:free|available|live|idle)\s+(?:slots?|lanes?|workers?)\b|\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:free|available|live|idle|worker|dot)\s+)*(?:slots?|lanes?|workers?)\s+(?:are\s+)?(?:free|available|idle|remaining|open)\b|\b(?:keep|fill|maintain)\s+(?:all\s+)?(?:\d+\s+)?(?:slots?|lanes?)\s+(?:full|busy)/i;
// Role words only. A regex cannot tell a named person from a role or a product, so named-person claims are a documented residual.
const grantedAuthority=/\b(?:the\s+)?(?:owner|user|operator|admin(?:istrator)?|maintainer|requester)\s+(?:has\s+)?(?:grants?|granted|approves?|approved|authorizes?|authorized)\s+(?:new|additional|expanded)\s+(?:authority|access|permissions?)\b/i;
function within(p,scope) { return !/^(?:\/|~\/|\$HOME\/)/.test(p)&&!p.split('/').includes('..')&&scope.some(s=>s==='.'||p===s||p.startsWith(`${s}/`)); }
const sourceExtension=/\.(?:mjs|cjs|jsx|ts|tsx|py|rs|go|md|txt|html|css|scss|sh|json|yaml|yml|toml|ini|conf|sql|vue|svelte|xml|pem|key|asc|jks|keystore|ppk|tfstate(?:\.backup)?)$/i;
const pathToken=new RegExp(`(?<![A-Za-z0-9_.@-])((?:(?:~|\\$HOME)?\\/|\\.?\\.?\\/)?${firstSegment}(?:\\/${laterSegment})*\\/?)(?![A-Za-z0-9_@-])`,'gm');
const plainToken=/(?<![A-Za-z0-9_.@-])((?:(?:~|\$HOME)?\/|\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/?)(?![A-Za-z0-9_@-])/g;
// Router segments (`[id]`, `(group)`, `+page.svelte`) join a token only in a path with a `/`. A slash-free token with brackets or
// parentheses ("(credentials)", "[1]", "(x).env") is read as before, on plain characters, so a wrapped name is still seen.
function pathTokens(text) {
  return [...text.matchAll(pathToken)].flatMap(m=>hasRouterSyntax(m[1])&&!m[1].includes('/')?[...m[1].matchAll(plainToken)].map(sub=>Object.assign([sub[0],sub[1]],{index:m.index+sub.index})):[m]);
}
// Prose outside the repository is context, never a scope grant. Capture the whole
// spelling so a token inside $CONFIG_DIR/client.toml cannot become a repo path.
function externalPathMentions(text) {
  const pattern=/(?<![A-Za-z0-9_./:@)\]}-])((?:~[A-Za-z0-9_-]*[\/\\]|\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})[\/\\]|[A-Za-z]:[\/\\]|\\\\|\/)[^\s`"'<>;,!?]*)/g;
  return [...text.matchAll(pattern)];
}
function mentionedPaths(text,knownPaths=[]) {
  const known=new Set(knownPaths.flatMap(file=>{const parts=file.split('/');return [file,...parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'))];}));
  const authoritative=file=>known.has(file)||knownPaths.some(scope=>file.startsWith(`${scope}/`));
  const unwrap=file=>{const name=file.replace(/^_+|_+$/g,'');return file.startsWith('_')&&file.endsWith('_')&&(known.has(name)||hardPath.test(name)||(name.startsWith('@')&&(known.has(name.slice(1))||hardPath.test(name.slice(1)))))?name:file;};
  // Names written with a slash (./old.mjs, Makefile/) stay explicit paths after normalization.
  const explicit=new Set(),external=new Set();
  const hostMentions=externalPathMentions(text);
  const tokens=[...hostMentions,...pathTokens(text).filter(m=>!hostMentions.some(h=>m.index>=h.index&&m.index<h.index+h[0].length))];
  const candidates=tokens.map(m=>{
    const outside=hostMentions.includes(m),file=outside?m[1].replace(/[.)]+$/,''):normalize(m);
    if(file!==null) {
      if(outside) external.add(file);
      if(m[1].includes('/')) explicit.add(file);
    }
    return file;
  });
  function normalize(m) {
    const raw=m[1];
    // A JSX/HTML tag name right after `<` or `</` (</Button>, <Card.Header>, <Icon />) is markup, not a path. A hard
    // sensitive name in that position (<credentials>) is still treated as a reference.
    if(text[m.index-1]==='<'&&/^\/?[A-Za-z][A-Za-z0-9_.:-]*$/.test(raw)&&!hardPath.test(raw.replace(/^\//,''))) return null;
    if(authoritative(raw)) return raw;
    // A leading slash inside an HTTP URL is not a host filesystem reference.
    if(/https?:\/$/i.test(text.slice(0,m.index))) return null;
    let file=raw.replace(/\/+$/,'').replace(/\.+$/,'');
    if(authoritative(file)) return file;
    file=unwrap(file);
    const referenced=unwrap(file.replace(/^@/,''));
    if(file.startsWith('@')&&(authoritative(referenced)||referenced.includes('/')||referenced.startsWith('.')||sourceExtension.test(referenced)||hardPath.test(referenced))) file=referenced;
    if(authoritative(file)) return file;
    if(/^(?:~\/|\$HOME\/|\/)/.test(file)) return file;
    return file.replace(/^\.\//,'').replace(/^[ab]\//,'');
  }
  const found=candidates.filter(file=>{
    // Exact tree/scope names and explicit lists carry authority. Ordinary words,
    // framework brands and hostnames do not establish repository paths.
    if(file===null) return false;
    if(external.has(file)) return true;
    if(authoritative(file)) return true;
    if(/^(?:e\.g\.|i\.e\.)\/(?:e\.g|i\.e)\.?$/i.test(file)) return false;
    if(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\//.test(file)) return false;
    if(/^(?:~\/|\$HOME\/|\/)/.test(file)) return true;
    if(file.startsWith('.')) return hardPath.test(file)||file.includes('/');
    if(file.includes('/')) return sourceExtension.test(file)||file.split('/').some(part=>part.includes('.'));
    return sourceExtension.test(file)||(file.includes('.')&&hardPath.test(file));
  });
  return Object.assign(found,{explicit,external});
}
export function scanGit(mirror,args,spawn=spawnSync) {
  const maxBuffer=32*1024*1024;
  const r=spawn('git',['-C',mirror,...args],{encoding:'utf8',timeout:30000,maxBuffer,env:gitEnv()});
  if(r.error?.code==='ENOBUFS'||r.error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`PR diff too large to scan: more than ${maxBuffer/1024/1024} MiB; split the review or name fewer files`);
  if(r.error||r.status!==0) {
    // Inspect before clipping: a token crossing a clipping boundary must not leak.
    const stderr=String(r.stderr??'');
    let excerpt='';
    if(!hasSecretContent(stderr)) {
      const safe=mirror?stderr.split(String(mirror)).join('[mirror]'):stderr;
      const data=Buffer.from(safe,'utf8'),limit=2048;
      excerpt=(data.length>2*limit
        ?data.subarray(0,limit).toString('utf8')+'[truncated]'+data.subarray(-limit).toString('utf8')
        :safe).trim();
      if(secretContent.test(excerpt)) excerpt='';
    }
    // Never interpolate argv, environment, or the spawn error's raw message.
    const subcommand=/^[a-z][a-z-]{0,31}$/.test(args[0]??'')&&!secretContent.test(args[0])?args[0]:'command';
    const outcome=r.error?.code==='ETIMEDOUT'?'timed out':r.signal?`was stopped by ${r.signal}`:Number.isInteger(r.status)?`exited ${r.status}`:'failed to start';
    throw infrastructureError(`submission scope scanner failed: git ${subcommand} ${outcome}${excerpt?': '+excerpt:''}`);
  }
  return r.stdout;
}
const git=scanGit;
// A bare word (no `/`, no extension) is prose, not a path: `web`, `data`, `tests`. Only a sensitive name that exists in
// the tree (credentials, id_rsa, kubeconfig) is still refused. A bare filename (README.md) names a path only when it
// resolves to exactly one file in the tree; ambiguous or absent names, and in-scope matches, are not rejections.
const bareToken=file=>!file.includes('/')&&!/^(?:~|\$HOME)/.test(file);
const bareWord=file=>bareToken(file)&&!file.slice(1).includes('.')&&!file.startsWith('.');
// The worker's auto-reviewer judges reads against the brief's prose as well as structured scope_paths. Include the scoped files
// in a free-form brief so both descriptions agree. Structured briefs already carry the list (renderAssignment). Idempotent:
// a brief that has the marker is left as it is.
// A unified diff inlined in a brief (raw or fenced) is code under review, not instructions: its content lines hold regex
// literals, URL routes, shebangs and relative imports (/changed/, /me, /usr/bin/env, ../../x.js). Only lines inside a real
// hunk count: a `diff --git` header, then `@@ -a,b +c,d @@`
// whose line counts are consumed exactly, so prose after a hunk (or under a forged header) is scanned as prose. Path-shaped
// tokens in code still go through inspect (hard and policy-listed names); the secret scan sees the whole assignment;
// header paths (diff --git, ---, +++) keep their scope checks.
const diffMeta=/^(?:index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;
const npmSpecifier=/^@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?:\/|$)/;
function codeInDiffFences(brief,inspect) {
  const checkTokens=code=>{
    for(let token of code.split(/[\s'"`(),;{}\[\]<>=|]+/)) {
      if(!token||/^https?:\/\//i.test(token)||npmSpecifier.test(token)) continue;
      const raw=token.slice(token.lastIndexOf(':')+1).replace(/^@/,'').replace(/^\/+/,'/');
      token=raw.replace(/^(?:\.{1,2}\/)+|^\/+/,'').replace(/[.\/]+$/,'');
      if(token&&(token.includes('/')||/\.[A-Za-z0-9]{1,8}$/.test(token))) inspect(token,raw);
    }
  };
  // A hunk is code only if its line counts are consumed exactly; one cut short by a non-diff line is scanned as prose, whole.
  const out=[];let state='prose',oldLeft=0,newLeft=0,hunk=null;
  const closeHunk=complete=>{ if(!hunk) return; if(complete) { checkTokens(hunk.context);for(const l of hunk.lines) if(l[0]!=='\\') checkTokens(l.slice(1)); out.push(hunk.header,...hunk.lines.map(l=>l[0]==='\\'?l:l[0])); } else out.push(hunk.raw,...hunk.lines); hunk=null; };
  for(const line of brief.split('\n')) {
    if(hunk&&(oldLeft>0||newLeft>0)) {
      const kind=line[0];
      if(line==='\\ No newline at end of file') { hunk.lines.push(line);continue; }
      if(kind===' '&&oldLeft>0&&newLeft>0) { oldLeft--;newLeft--;hunk.lines.push(line);continue; }
      if(kind==='-'&&oldLeft>0) { oldLeft--;hunk.lines.push(line);continue; }
      if(kind==='+'&&newLeft>0) { newLeft--;hunk.lines.push(line);continue; }
      closeHunk(false);state='prose';
    } else if(hunk&&line==='\\ No newline at end of file') { hunk.lines.push(line);continue; }
    else closeHunk(true);
    const header=/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/.exec(line);
    if(line.startsWith('diff --git ')) state='file';
    else if(header&&state==='file') { hunk={raw:line,header:line.slice(0,line.length-header[3].length),context:header[3],lines:[]};oldLeft=Number(header[1]??1);newLeft=Number(header[2]??1);continue; }
    else if(state==='file'&&!diffMeta.test(line)) state='prose';
    out.push(line);
  }
  closeHunk(!(oldLeft>0||newLeft>0));
  return out.join('\n');
}
const allowListMarker='Read allow-list (scope_paths';
export const allowListHeading=`${allowListMarker}; every path below, and everything under a listed directory, may be read):`;
const vagueExclusion=/\[excluded (?:file|path)\]|\b(?:omitted|excluded) by policy\b/i;
function withAllowList(result,warn) {
  if(vagueExclusion.test(result.brief)) warn('the brief mentions an excluded file without naming it; the worker\'s reviewer then refuses in-scope reads that look like it. Name the path, or drop the sentence: the bridge scope note names dropped sensitive files');
  const scope=result.scope_paths||[];
  // The whole repository ('.', the ACP scope) needs no list.
  if(!scope.length||scope.includes('.')||result.brief.includes(allowListMarker)||result.brief.includes('\nRead allow-list:\n')) return result;
  const head=`\n\n${allowListHeading}\n`;
  const room=Math.min(submissionLimits.brief-bytes(result.brief),submissionLimits.instructions-(bytes(result.brief)+bytes(result.expected_output)+bytes(result.execution_scope||'')+bytes(typeof result.scope_text==='string'?result.scope_text:'')+bytes(scope.join('\n'))))-bytes(head)-80;
  const listed=[];let used=0;
  for(const p of scope) { if(used+bytes(p)+1>room) break; listed.push(p);used+=bytes(p)+1; }
  if(!listed.length) { warn('the brief has no room for the scope_paths allow-list; the worker\'s reviewer may refuse in-scope reads'); return result; }
  const more=scope.length-listed.length;
  const expanded={...result,brief:`${result.brief}${head}${listed.join('\n')}${more?`\n...and ${more} more paths in scope_paths, all readable`:''}`};
  const n=bytes(expanded.brief);
  if(n>submissionLimits.brief) throw Object.assign(new Error(`brief: ${n} UTF-8 bytes exceeds ${submissionLimits.brief}; cut at least ${n-submissionLimits.brief} bytes`),{expandedPayload:expanded});
  return expanded;
}
// The brief names the files the job may create; the worker's reviewer judges a write by the brief's prose. Idempotent.
function withOutputPaths(result) {
  const list=result.output_paths||[];
  if(!list.length||result.brief.includes(outputPathsHeading)) return result;
  const brief=`${result.brief}\n\n${outputBlock(list)}`;
  const expanded={...result,brief},n=bytes(brief);
  if(n>submissionLimits.brief) throw Object.assign(new Error(`brief: ${n} UTF-8 bytes exceeds ${submissionLimits.brief}; cut at least ${n-submissionLimits.brief} bytes`),{expandedPayload:expanded});
  return expanded;
}
// The scope deny rule as a yes/no on one repository path: hard names (keys, env files, credential stores), the soft credential/auth/
// signing name lint, a router-group spelling of a hard name, and the owner's `sensitive_paths`. Submit uses these rules to refuse or drop
// scope paths; the check sandbox uses them to mask the same files (src/workspace.mjs). Exceptions are per-submission and do not unmask.
export function isSensitiveRepoPath(file,policyPaths=[]) {
  return hardName(file)||(hasRouterSyntax(file)&&hardName(file.replace(/\[[^\]/]*\]\]?|\([^)/]*\)/g,'')))||softName(file)||policyPaths.some(x=>file===x||file.startsWith(`${x}/`));
}
// The owner's sensitive_paths, or an error message when the policy file cannot be read (execution callers must fail closed).
export function sensitivePolicyPaths() {
  try { const policy=loadPolicy();return {paths:policy.sensitive_paths,sourceExemptions:policy.sandbox_source_exemptions,error:null}; } catch(error) { return {paths:[],sourceExemptions:[],error:error.message}; }
}
export function validateSubmission(assignment,{sensitiveScopeOverride=null,scanInput,warnings=null,excludeSensitive=false,review=false,worker}={}) {
  const warn=message=>{if(warnings&&!warnings.includes(message)) warnings.push(message);};
  let p;
  try { p=loadPolicy(); } catch(error) { throw infrastructureError(error.message); }
  let rendered=renderAssignment(assignment);
  const briefBytes=cap(rendered.brief,submissionLimits.brief,'brief');
  const outputBytes=cap(rendered.expected_output,submissionLimits.instructions,'expected output');
  if(rendered.scope_text!==undefined&&typeof rendered.scope_text!=='string') throw new Error('invalid scope_text');
  const scopeText=typeof rendered.scope_text==='string'?rendered.scope_text:'';
  const checkInstructionSize=r=>{
    const total=instructionBytes(r);
    if(total>submissionLimits.instructions) throw Object.assign(new Error(`task instructions: ${total} UTF-8 bytes exceeds ${submissionLimits.instructions}; cut at least ${total-submissionLimits.instructions} bytes`),{expandedPayload:r});
  };
  checkInstructionSize(rendered);
  if([authority,grantedAuthority].some(pattern=>pattern.test([rendered.brief,rendered.expected_output,scopeText].join('\n')))) throw new Error('live-slot or expanded-authority claim in instructions');
  if(hasSecretContent(rendered)) throw new Error('hard sensitive content exclusion');
  // Labelled values are medium precision: every output sink masks them, so intake warns instead of refusing.
  if(hasCredentialHints(rendered)) warn('the assignment contains a credential-labelled value; output to the worker masks it, so pass credentials through the bridge, not the brief');
  const input=rendered.execution_scope==='implementation'||rendered.inputs?.some(i=>i.github_repo!==undefined)?assignmentInput(rendered):null;
  const mismatch=(reads,scope)=>[...reads.filter(p=>!scope.includes(p)),...scope.filter(p=>!reads.includes(p))].join(', ')||'lists differ in length';
  const scope=rendered.scope_paths===undefined||rendered.scope_paths?.length===0?[]:[...paths(rendered.scope_paths,'scope_paths')];
  if(input&&!scope.length) throw new Error('unknown repository scope; scope_paths required');
  if(rendered.read_paths!==undefined) {
    const reads=paths(rendered.read_paths,'read_paths');
    if(reads.length!==scope.length||reads.some(p=>!scope.includes(p))) throw new Error(`contradictory read_paths and scope_paths: ${mismatch(reads,scope)}`);
  }
  if(rendered.read_list!==undefined) {
    const reads=paths(rendered.read_list,'read_list');
    if(reads.length!==scope.length||reads.some(p=>!scope.includes(p))) throw new Error(`contradictory read_list and scope_paths: ${mismatch(reads,scope)}`);
  }
  const exception=sensitiveScopeOverride===null?null:p.exceptions.find(e=>e.id===sensitiveScopeOverride&&e.github_repo===input?.github_repo);
  if(sensitiveScopeOverride!==null&&!exception) throw new Error('unknown sensitive scope override');
  // Why a path is sensitive, for the record kept when a directory scope drops it.
  const sensitiveReason=file=>hardName(file)||(hasRouterSyntax(file)&&hardName(file.replace(/\[[^\]/]*\]\]?|\([^)/]*\)/g,'')))?'hard sensitive path (credential, key or signing material)':p.sensitive_paths.some(x=>file===x||file.startsWith(`${x}/`))?'listed in the submission policy sensitive_paths':'name matches the credential, auth or signing lint';
  function inspectPath(file) {
    // A router group cannot hide a sensitive name: `(x).env` is also checked as `.env`.
    if(hardName(file)||(hasRouterSyntax(file)&&hardName(file.replace(/\[[^\]/]*\]\]?|\([^)/]*\)/g,'')))) throw new Error(`hard sensitive path exclusion: ${file}`);
    if((softName(file)||p.sensitive_paths.some(s=>file===s||file.startsWith(`${s}/`)))&&(!exception||file!==exception.path)) throw new Error(`sensitive scope path: ${file}`);
  }
  for(const file of scope) inspectPath(file);
  // output_paths: shape here, the pinned tree below. Review mode is read-only, so it takes no output file.
  const outputs=rendered.output_paths===undefined?[]:validateOutputPaths(rendered.output_paths);
  if(outputs.length) {
    if(review) throw new Error('output_paths are not allowed with --review: review mode is read-only. Remove output_paths from the assignment, or submit without --review');
    if(!input) throw new Error('output_paths require pinned repository input (inputs: [{github_repo, base_sha}])');
    if(input.input_patch) throw new Error('output_paths cannot be combined with input_patch: the patch is applied to the workspace and would count as a change outside output_paths. Submit the input patch as a separate job, or push it and pin head_sha');
    for(const file of outputs) {
      try { inspectPath(file); }
      catch(error) { throw new Error(`output_paths: ${error.message}. Name the new file so that it does not look like credential, auth or signing material`); }
    }
  }
  const outputSet=new Set(outputs);
  // Unified-diff /dev/null markers are sentinels, not filesystem requests. An exact exclusion diagnostic grants no
  // read permission. Keep scanning its content for secrets above and checking scope/diff paths below; remove only
  // a well-formed, actually sensitive name from instruction references.
  const instructionBrief=rendered.brief.replace(/^(?:---|\+\+\+) \/dev\/null$/gm,'').replace(/^omitted: (.+) \(sensitive\)$/gm,(line,file)=>{
    try { paths([file],'omitted path'); } catch { return line; }
    try { inspectPath(file); return line; }
    catch(error) { if(/^(?:hard sensitive path exclusion|sensitive scope path): /.test(error.message)) return '';throw error; }
  });
  // input_patch is a diff, linted as one below (numstat paths, sensitive names, secrets), not instruction prose.
  // A name in code is a reference, not a read. The worker reads only scope files, and every scope and diff file gets inspectPath.
  // A code token refuses only when it points at host secret material (for example, ~/.ssh/id_rsa) or a policy-listed path.
  const inspectCode=(file,raw=file)=>{
    if(hostPath.test(raw)&&hardPath.test(file)) throw new Error(`hard sensitive path exclusion: ${raw}`);
    if(p.sensitive_paths.some(x=>file===x||file.startsWith(`${x}/`))&&(!exception||file!==exception.path)) throw new Error(`sensitive scope path: ${file}`);
  };
  const text=[codeInDiffFences(instructionBrief,inspectCode),rendered.expected_output,scopeText,rendered.objective||'',rendered.stop_rule||'',JSON.stringify((rendered.inputs||[]).map(({input_patch,...rest})=>rest))].join('\n\n');
  warnOutputDirectoryMentions(outputs,text,warn);
  if(input) {
    for(const list of text.matchAll(/(?:read[- ](?:allow[- ]?list|list|paths)|allowed (?:files|paths))[ \t]*:[ \t]*(?:\n)?([^\n]*(?:\n(?!\n)[^\n]+)*)/gi)) {
      const reads=list[1].split(/[\n,]/).map(line=>line.trim().replace(/^[-*] +/,'').replace(/^[`'"]|[`'"]$/g,'')).filter(Boolean);
      for(const file of paths(reads,'brief read-list')) {
        inspectPath(file);
        if(!within(file,scope)) throw new Error(`contradictory brief read-list and scope_paths: ${file} is read-listed but outside scope_paths`);
      }
    }
  }
  const dropped=[];let narrowedScope=null;
  const firstPass=mentionedPaths(text,scope);
  for(const file of firstPass) {
    const bare=bareToken(file)&&!firstPass.explicit.has(file);
    if(bare&&bareWord(file)&&!hardPath.test(file)) continue;
    // Repository work resolves every mention against the tree below; without a repository, mentions are only inspected.
    if(input) continue;
    inspectPath(file);
  }
  if(input) {
    const scan=scanInput?scanInput(input):(()=>{
      let mirror;
      try { mirror=prepareGithubRepo(input,{worker}); } catch(error) { if(error.code==='DOT_BRIDGE_INVALID_INPUT') throw error;throw infrastructureError(error.message); }
      const revision=input.head_sha||input.base_sha;
      const tree=git(mirror,['ls-tree','-r','-z',revision]).split('\0').filter(Boolean).map(entry=>{const tab=entry.indexOf('\t');if(tab<0) throw infrastructureError('submission scope scanner failed');return {mode:entry.slice(0,6),path:entry.slice(tab+1)};});
      const files=tree.map(entry=>entry.path),symlinks=tree.filter(entry=>entry.mode==='120000').map(entry=>entry.path);
      const diff=input.head_sha?git(mirror,['diff','--no-ext-diff','--no-textconv','--binary',input.base_sha,input.head_sha]):'';
      const diffFiles=input.head_sha?git(mirror,['diff','--no-ext-diff','--name-only','-z',input.base_sha,input.head_sha]).split('\0').filter(Boolean):[];
      return {files,diff,diffFiles,symlinks};
    })();
    if(!scan||!Array.isArray(scan.files)||!Array.isArray(scan.diffFiles)||typeof scan.diff!=='string') throw infrastructureError('submission scope scanner failed');
    // A free-form read-only or review assignment may grow its scope by the files its own brief names and its PR changes: the
    // submitter asked for them, each still passes inspectPath, and the workspace enforces the result. Implementation work,
    // structured briefs and explicit read lists keep the scope exactly as declared.
    const growable=(rendered.execution_scope==='read-only'||review)&&rendered.objective===undefined&&rendered.read_paths===undefined&&rendered.read_list===undefined&&!scope.includes('.');
    const added=[],undeclared=[],fixable=[],ambiguous=[],mentionedAs=new Map();
    // Review mode cannot write (apply_patch refuses review submissions), so growing a review assignment's scope adds read access only.
    const maxGrowth=200;
    const want=(file,mention=file)=>{ if(within(file,scope)) return; if(mention!==file) mentionedAs.set(file,mention); if(growable) { if(added.length>=maxGrowth) throw new Error(`scope growth limit: the brief names more than ${maxGrowth} files outside scope_paths; list them in scope_paths`); scope.push(file);added.push(file); } else fixable.push(file); };
    const treeFiles=new Set(scan.files),isTreeDir=file=>scan.files.some(f=>f.startsWith(`${file}/`));
    const treePass=mentionedPaths(text,[...scope,...scan.files]);
    for(const file of treePass) {
      if(file===input.github_repo||outputSet.has(file)) continue;
      if(treePass.external.has(file)) {
        inspectPath(file.replaceAll('\\','/'));
        warn(`the brief mentions external path ${file}; this does not grant repository or host-file access`);
        continue;
      }
      const bare=bareToken(file)&&!treePass.explicit.has(file);
      if(bare&&bareWord(file)&&!hardPath.test(file)) { if(!within(file,scope)) warn(`bare word "${file}" matches a repository path outside scope_paths; it is not treated as a path reference`); continue; }
      // In scope, or a directory that holds scope entries (`gateway` for gateway/x.py): context, not a new read.
      if(within(file,scope)) { inspectPath(file);continue; }
      if(scope.some(s=>s.startsWith(`${file}/`))) continue;
      // A bare filename (README.md) names a file only when it resolves to exactly one tree path.
      if(bare) {
        const matches=scan.files.filter(f=>f===file||f.endsWith(`/${file}`));
        if(matches.some(f=>within(f,scope))) continue;
        if(matches.length===1) { inspectPath(matches[0]);want(matches[0],file);continue; }
        // A file name the tree lacks (gh-tokens.txt, secrets.yaml) may point the worker at a host file: full inspect. An identifier
        // (input.privateKey) is not file-shaped and passes.
        if(fileShaped(file)) inspectPath(file);
        // Both outcomes predict a broken job: the worker looks for a file it cannot pick out, or cannot find. Refused with the fix.
        ambiguous.push(matches.length?`ambiguous bare filename "${file}": it matches ${matches.length} repository paths outside scope_paths (${matches.slice(0,5).join(', ')}${matches.length>5?', ...':''}). Write the full path of the one you mean, for example ${matches[0]===file?'./':''}${matches[0]} instead of ${file}`:`unknown bare filename "${file}": it is not in the repository tree. Write the full repository path of the file (a new file needs its full path too; ./${file} names a file at the repository root), or remove the mention`);
        continue;
      }
      if(treeFiles.has(file)) { inspectPath(file);want(file);continue; }
      if(isTreeDir(file)) { inspectPath(file);warn(`the brief mentions directory ${file}, outside scope_paths; the worker cannot read it`);continue; }
      // Not in the tree: an identifier, route or URL path (input.privateKey, secrets.API_TOKEN, /v1) names no file the worker could
      // read. A file-shaped secret name (/home/u/credentials, .env, secrets.yaml) still refuses, and so do host paths, parent
      // traversal and an absolute spelling of a repository path (/README.md never inherits scope).
      // A router group cannot hide a sensitive name: web/(x).env is checked as web/.env.
      if(fileShaped(file)&&(hardName(file)||(hasRouterSyntax(file)&&hardName(file.replace(/\[[^\]/]*\]\]?|\([^)/]*\)/g,''))))) throw new Error(`hard sensitive path exclusion: ${file}`);
      const rest=file.replace(/^\/+/,''),unrouted=file.replace(/\[[^\]/]*\]\]?|\([^)/]*\)/g,'');
      // A relative path the tree lacks is usually abbreviated (bin/x.ts for packages/p/bin/x.ts) or not a path (a branch name):
      // it resolves like a bare filename, by suffix, and otherwise warns. Invalid syntax, traversal and router segments the tree
      // lacks (x/$(id)/y.ts) refuse. Leading-slash routes (/v1, /me) pass; a file extension makes it a host file (/y.ts).
      // A bare host directory in prose ("use ~/.tmp, not /tmp") names no file: it warns.
      if(/^~\/\.(?:docker|kube)\/?$/.test(file)) throw new Error(`hard sensitive path exclusion: ${file}`);
      if(/^(?:\/(?:tmp|home|var|etc|usr|opt)|~|~\/\.?\w[\w-]*|\$HOME)\/?$/.test(file)) { warn(`the brief mentions host directory ${file}; the worker cannot read host paths`);continue; }
      if(hostPath.test(file)||hostPath.test(unrouted)) { undeclared.push(file);continue; }
      if(!file.startsWith('/')) {
        const invalid=hasRouterSyntax(file)||file.split('/').includes('..')||(()=>{try{paths([file],'mention');return false;}catch{return true;}})();
        if(invalid) { undeclared.push(file);continue; }
        const matches=scan.files.filter(f=>f.endsWith(`/${file}`));
        if(matches.some(f=>within(f,scope))) continue;
        if(matches.length===1) { inspectPath(matches[0]);want(matches[0],file);continue; }
        if(matches.length) { ambiguous.push(`ambiguous abbreviated path "${file}": it matches ${matches.length} repository paths outside scope_paths (${matches.slice(0,5).join(', ')}${matches.length>5?', ...':''}). Write the full path of the one you mean, for example ${matches[0]===file?'./':''}${matches[0]} instead of ${file}`);continue; }
        warn(`the brief names ${file}, which is not in the repository tree`);
        continue;
      }
      // A leading-slash token with no file extension whose remainder is a tree directory (/showcase/docs) is a URL route.
      if(!file.split('/').includes('..')&&!/\.[^/]*$/.test(file)&&!treeFiles.has(rest)&&isTreeDir(rest)) { warn(`the brief mentions ${file}, read as a route; the worker cannot read it`);continue; }
      if(hostPath.test(file)||(file.startsWith('/')&&sourceExtension.test(file))||hostPath.test(unrouted)||file.split('/').includes('..')||(file.startsWith('/')&&(treeFiles.has(rest)||isTreeDir(rest)))) undeclared.push(file);
    }
    for(const file of scan.diffFiles) { inspectPath(file);if(!within(file,scope)) { if(growable&&input.head_sha) { scope.push(file);added.push(file); } else throw new Error(`diff outside scope_paths: ${file}`); } }
    if(undeclared.length||fixable.length||ambiguous.length) {
      const named=[...new Set([...undeclared,...fixable])];
      const label=file=>mentionedAs.has(file)?`${file} (the brief names it as "${mentionedAs.get(file)}"; write the full path)`:file;
      // Every offender is listed in one refusal. Without ambiguous mentions the first line keeps its short form.
      const lines=[...(named.length?[`undeclared instruction path: ${named.map(label).join(', ')}`]:[]),...new Set(ambiguous)];
      const error=new Error(lines.join('\n'));
      // Only repository files that passed inspectPath are fixable: with any other kind of path the brief itself must change.
      if(!undeclared.length&&!ambiguous.length) error.suggested_scope_paths=[...new Set([...scope,...fixable])];
      throw error;
    }
    if(added.length) { warn(`scope_paths grew by ${added.length} path(s) the brief names or the PR changes: ${added.slice(0,10).join(', ')}${added.length>10?', ...':''}`);rendered={...rendered,scope_paths:[...scope]}; }
    const taken=[];
    // Case-insensitive and Unicode-normalizing filesystems (macOS) hold one file under several spellings. An output path that matches
    // an existing tree path, directory or PR-diff path after lowercasing or NFC normalization (or both) would overwrite it there.
    const lookalikeKeys=outputPathKeys.slice(1);
    const existingPaths=new Set([...scan.files,...scan.diffFiles]);
    for(const f of scan.files) for(let i=f.indexOf('/');i>0;i=f.indexOf('/',i+1)) existingPaths.add(f.slice(0,i));
    const lookalikes=lookalikeKeys.map(key=>{const byKey=new Map();for(const e of existingPaths) { const k=key(e); if(!byKey.has(k)) byKey.set(k,e); } return byKey;});
    // The output itself or any ancestor directory: an exact existing path is handled by the branches below, not here.
    const lookalikeOf=file=>{
      const parts=file.split('/');
      for(let i=1;i<=parts.length;i++) {
        const p=parts.slice(0,i).join('/');
        if(existingPaths.has(p)) continue;
        const hit=lookalikes.map((byKey,k)=>byKey.get(lookalikeKeys[k](p))).find(Boolean);
        if(hit) return hit;
      }
      return undefined;
    };
    for(const file of outputs) {
      const parts=file.split('/'),parent=parts.slice(1).map((_,i)=>parts.slice(0,i+1).join('/')).find(x=>treeFiles.has(x)),near=lookalikeOf(file);
      if(treeFiles.has(file)||scan.diffFiles.includes(file)) taken.push(`${file} already exists at ${input.head_sha||input.base_sha}. output_paths declare NEW files only; ${rendered.execution_scope==='implementation'?'to change an existing file list it in scope_paths':'read-only scope cannot change an existing file'}, or choose a new path`);
      else if(near) taken.push(`output path ${file} collides with existing ${near} on case-insensitive or Unicode-normalizing filesystems (macOS); choose another name`);
      else if(isTreeDir(file)||scan.diffFiles.some(f=>f.startsWith(`${file}/`))) taken.push(`${file} is an existing directory (or the prefix of existing files); name a new file inside it, for example ${file}/notes.md`);
      else if(parent) taken.push(`${file} cannot be created: ${parent} is a file at ${input.head_sha||input.base_sha}; choose a path whose parent directories are not files`);
    }
    if(taken.length) throw new Error(`output_paths: ${taken.join('\n')}`);
    const unknown=scope.filter(s=>s!=='.'&&!scan.files.some(f=>f===s||f.startsWith(`${s}/`))&&!scan.diffFiles.includes(s));
    if(unknown.length) {
      const error=new Error(`unknown scope path: ${unknown.join(', ')}`), rest=scope.filter(s=>!unknown.includes(s));
      // Where a path looks like a typo, the requester gets the tree paths it may have meant.
      error.candidates=Object.fromEntries(unknown.map(u=>[u,nearestPaths(u,scan.files)]).filter(([,c])=>c.length));
      if(rest.length) error.suggested_scope_paths=rest;
      throw error;
    }
    // A directory scope can hold a sensitive file the submitter never named. With excludeSensitive those files leave the scope
    // (it only narrows) and the reason is recorded; without it the whole submit fails, as before. A path the submitter named
    // (a scope entry, a brief mention, a diff file) is never dropped quietly.
    for(const file of scan.files.filter(f=>within(f,scope)&&!scope.includes(f))) {
      try { inspectPath(file); }
      catch(error) {
        if(!/^(?:hard sensitive path exclusion|sensitive scope path): /.test(error.message)) throw error;
        if(!excludeSensitive) throw error;
        // Narrowing turns a directory into a file list; for implementation work that would forbid new files, so it is refused.
        if(rendered.execution_scope==='implementation') throw new Error(`${error.message} (--exclude-sensitive applies to read-only work, not implementation scope)`);
        dropped.push({path:file,reason:sensitiveReason(file)});
      }
    }
    for(const file of scan.files.filter(f=>scope.includes(f))) inspectPath(file);
    // A symlink inside a directory scope: the workspace never follows one (list skips it, read refuses), so read-only work
    // with excludeSensitive records it as dropped instead of refusing the scope. A named symlink still refuses.
    for(const file of scan.symlinks||[]) if(within(file,scope)&&!scope.includes(file)&&excludeSensitive&&rendered.execution_scope!=='implementation') dropped.push({path:file,reason:'symlink (the workspace never follows symlinks)'});
    // A scope whose narrowing needs more than maxNarrowedEntries entries is refused (fail closed): keeping the broad scope
    // would rest on an exact-path exclusion that a case or Unicode alias on a case-insensitive filesystem can miss.
    if(dropped.length) narrowedScope=narrowScope(scope,[...new Set([...scan.files,...scan.diffFiles])],dropped.map(d=>d.path));
    for(const file of scan.symlinks||[]) if(within(file,narrowedScope??scope)&&!dropped.some(d=>d.path===file)) throw new Error(`symlink in repository scope: ${file}`);
    if(input.input_patch) {
      if(/^new (?:file )?mode 120000$/m.test(input.input_patch)) throw new Error('symlink in input patch scope');
      const parsed=spawnSync('git',['apply','--numstat','-z','-'],{input:input.input_patch,encoding:'utf8',timeout:10000,maxBuffer:1048576,env:gitEnv()});
      if(parsed.error) throw infrastructureError('input patch scanner unavailable');
      if(parsed.status!==0||!parsed.stdout) throw new Error('incomplete input patch; scanner failed');
      for(const entry of parsed.stdout.split('\0').filter(Boolean)) {
        const file=entry.includes('\t')?entry.split('\t').slice(2).join('\t'):entry;
        if(!file) continue;
        inspectPath(file);if(!within(file,scope)) throw new Error(`patch outside scope_paths: ${file}`);
      }
    }
    const patch=[scan.diff,input.input_patch||''].join('\n');
    if(secretContent.test(patch)) throw new Error('hard sensitive patch content exclusion');
    // The PR diff and input_patch are code under review: path-shaped tokens get the hard and policy checks, like an inlined diff.
    codeInDiffFences(patch,inspectCode);
    for(const m of patch.matchAll(/^(?:diff --git a\/(.+) b\/(.+)|(?:---|\+\+\+) [ab]\/(.+)|(?:rename (?:from|to)|copy (?:from|to)) (.+))$/gm)) for(const file of m.slice(1).filter(Boolean)) {
      inspectPath(file);if(!within(file,scope)) throw new Error(`patch outside scope_paths: ${file}`);
    }
    if(input.input_patch&&!/^diff --git /m.test(input.input_patch)) throw new Error('incomplete input patch');
  } else if(scope.length) throw new Error('scope_paths require pinned repository input');
  if(!dropped.length) {const done=withOutputPaths(withAllowList(rendered,warn));checkInstructionSize(done);return done;}
  const final=renderAssignment({...assignment,scope_paths:narrowedScope});
  const note=`\n\nBridge scope note: ${dropped.length} sensitive file(s) are outside scope_paths; do not read them: ${dropped.slice(0,20).map(d=>d.path).join(', ')}${dropped.length>20?`, and ${dropped.length-20} more`:''}.`;
  const brief=final.brief+note;
  const expanded={...final,brief,scope_paths:narrowedScope,scope_excluded:dropped,...(final.read_paths!==undefined?{read_paths:narrowedScope}:{}),...(final.read_list!==undefined?{read_list:narrowedScope}:{})};
  const finalBriefBytes=bytes(brief);
  if(finalBriefBytes>submissionLimits.brief) throw Object.assign(new Error(`brief: ${finalBriefBytes} UTF-8 bytes exceeds ${submissionLimits.brief}; cut at least ${finalBriefBytes-submissionLimits.brief} bytes`),{expandedPayload:expanded});
  warn(`${dropped.length} sensitive file(s) dropped from the directory scope (reasons in scope_excluded): ${dropped.slice(0,5).map(d=>d.path).join(', ')}${dropped.length>5?', ...':''}`);
  // read_paths and read_list must keep equalling scope_paths, or they would still name a dropped file's directory.
  const result=expanded;
  checkInstructionSize(result);
  const done=withOutputPaths(withAllowList(result,warn));
  checkInstructionSize(done);
  return done;
}

// The scope entries that cover every file under `scope` except `bad`: a directory with no bad file below it stays whole, one with
// a bad file is replaced by its children. Throws when that needs more entries than a scope should hold.
const maxNarrowedEntries=200;
export function narrowScope(scope,files,bad) {
  const badSet=new Set(bad),badDirs=new Set(),children=new Map(),add=(dir,child)=>{if(!children.has(dir)) children.set(dir,new Set());children.get(dir).add(child);};
  for(const file of files) {
    const parts=file.split('/');
    for(let i=0;i<parts.length;i++) add(parts.slice(0,i).join('/'),parts.slice(0,i+1).join('/'));
  }
  for(const file of badSet) { const parts=file.split('/'); for(let i=0;i<parts.length;i++) badDirs.add(parts.slice(0,i).join('/')); }
  const out=[];
  const visit=path=>{
    if(badSet.has(path)) return;
    if(!children.has(path)) { out.push(path); return; }               // a file
    if(!badDirs.has(path)) { out.push(path===''?'.':path); return; }  // a directory with no bad file below
    for(const child of [...children.get(path)].sort()) visit(child);
  };
  for(const entry of scope) visit(entry==='.'?'':entry);
  const narrowed=[...new Set(out)];
  if(!narrowed.length) throw new Error(`sensitive scope path: ${bad[0]} (every file in the scope is sensitive)`);
  if(narrowed.length>maxNarrowedEntries) throw new Error(`sensitive scope path: ${bad[0]} (too many files to exclude from ${scope.map(s=>`"${s}"`).join(', ')}: dropping ${bad.length} sensitive file(s) would need ${narrowed.length} scope entries, over the ${maxNarrowedEntries} limit; submit a narrower scope that avoids them)`);
  const unnameable=narrowed.find(entry=>{try{paths([entry],'scope_paths');return false;}catch{return true;}});
  if(unnameable!==undefined) throw new Error(`sensitive scope path: ${bad[0]} (cannot narrow the scope: ${unnameable} has a name that scope_paths cannot hold; exclude it or name the files you want)`);
  return paths(narrowed,'scope_paths');
}

// Git fetch/diff are synchronous legacy helpers. Run admission scans off the
// server thread so slow repository I/O cannot stop progress on existing claims.
export async function validateSubmissionAsync(assignment,options={}) {
  if(assignment.execution_scope!=='implementation'&&!assignment.inputs?.some(input=>input.github_repo!==undefined)) return validateSubmission(assignment,options);
  let worker;
  try { worker=new Worker(new URL(import.meta.url),{workerData:{operation:'submission',assignment,options:{...options,warnings:undefined},secrets:registeredSecrets()}}); }
  catch(error) { throw infrastructureError(error.message); }
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{reject(infrastructureError('submission scope scanner timeout'));worker.terminate();},180000);
    // The worker holds a snapshot of the registry taken when it started. A secret registered later is checked here,
    // in the main thread, before any verdict is returned.
    const lateSecret=()=>{try{return hasSecretContent(renderAssignment(assignment));}catch{return false;}};
    worker.once('message',message=>{clearTimeout(timer);if(lateSecret())reject(new Error('hard sensitive content exclusion'));else if(message.error)reject(message.code==='DOT_BRIDGE_INFRASTRUCTURE'?infrastructureError(message.error):Object.assign(new Error(message.error),message.suggested_scope_paths?{suggested_scope_paths:message.suggested_scope_paths}:{},message.candidates?{candidates:message.candidates}:{},message.expandedPayload?{expandedPayload:message.expandedPayload}:{}));else {for(const w of message.warnings||[]) if(options.warnings&&!options.warnings.includes(w)) options.warnings.push(w);resolve(message.assignment);}});
    worker.once('error',error=>{clearTimeout(timer);reject(infrastructureError(error.message));});
    worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(infrastructureError('submission scope scanner failed'));});
  });
}
if(!isMainThread&&workerData?.operation==='submission') {
  for(const secret of workerData.secrets??[]) registerSecret(secret);
  try {const warnings=[];parentPort.postMessage({assignment:validateSubmission(workerData.assignment,{...workerData.options,warnings}),warnings});}
  catch(error) {parentPort.postMessage({error:error.message,code:error.code,suggested_scope_paths:error.suggested_scope_paths,candidates:error.candidates,expandedPayload:error.expandedPayload??null});}
}
