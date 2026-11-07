#!/usr/bin/env node
import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as implementation from '../src/redaction.mjs';
import armorEvasionCases from './armor-evasion-corpus.mjs';
import {assertLegacyCoverage,legacyKeyHeader,legacyRedactArmor} from './armor-legacy-oracle.mjs';

const audited=new Set();
let generatedParityCases=0;
const auditText=value=>{
  const text=String(value);
  if(audited.has(text)) return;
  assertLegacyCoverage(text,implementation);audited.add(text);
};
const auditValue=value=>{
  if(typeof value==='string') auditText(value);
  else if(value&&typeof value==='object') for(const [key,item] of Object.entries(value)) {auditText(key);auditValue(item);}
};
// Audit every string passed to the armor suite, including nested object keys.
const redaction={
  ...implementation,
  privateKeyHeader:{test(value){auditText(value);return implementation.privateKeyHeader.test(value);}},
  secretContent:{test(value){auditText(value);return implementation.secretContent.test(value);}},
  hasSecretContent(value){auditValue(value);return implementation.hasSecretContent(value);},
  redactSecrets(value){auditText(value);return implementation.redactSecrets(value);},
  redactOutput(value){auditValue(value);return implementation.redactOutput(value);},
};
const legacyOracleUrl=new URL('./armor-legacy-oracle.mjs',import.meta.url).href;

for(const width of [1,2,3,5]) for(const symmetric of [false,true]) test(`r12: ${width} Unicode dashes ${symmetric?'symmetric':'opening-only'} rotation prose`,()=>{
  const d=String.fromCodePoint(0x2014).repeat(width);
  const text=d+' Be'+'gin private '+'key rotation'+(symmetric?d:'')+'\nCheck the deployment checklist.';
  assert.equal(redaction.hasSecretContent(text),false);
  assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});

test('r11: overlapping armor and URL credentials mask the original full span',()=>{
  const d=String.fromCodePoint(0x2014).repeat(3),body='AbCdGhIj'.repeat(6);
  const text='https://'+'public-user:'+d+'BE'+'GIN'+'PRI'+'VATE'+'K'+'EY'+d+'\\n'+body+'\\n'+d+'EN'+'D'+'PRI'+'VATE'+'K'+'EY'+d+'PASSWORD_'+'TAIL'+'@service.invalid';
  assert.deepEqual(redaction.redactSecrets(text),{text:'[redacted secret]',redacted:1});
  assert(!JSON.stringify(redaction.redactOutput({text})).includes('PASSWORD_'+'TAIL'));
});
test('r11: overlapping and adjacent token and armor spans form one mask',()=>{
  const d='-'.repeat(5),label='PRI'+'VATE'+'K'+'EY';
  const open=d+'BE'+'GIN '+label+d,close=d+'EN'+'D '+label+d;
  const url='https://'+'u:'+'pass'+'@host.invalid',token='gh'+'p_'+'A'.repeat(20);
  const block=open+'\n'+url+'\n'+close;
  assert.deepEqual(redaction.redactSecrets(block+'\nvisible'),{text:'[redacted secret]'+'\n'.repeat(3)+'visible',redacted:1});
  const tightOpen=d+'BE'+'GIN:'+label+d,tightClose=d+'EN'+'D:'+label+d;
  const crossing='https://'+'u:'+tightOpen+'\\n'+'PASSWORD_'+'TAIL@host.invalid'+'\n'+tightClose+'VISIBLE_SUFFIX';
  assert.deepEqual(redaction.redactSecrets(crossing),{text:'[redacted secret]\nVISIBLE_SUFFIX',redacted:1});
  for(const text of [token+block,block+token])
    assert.deepEqual(redaction.redactSecrets(text),{text:'[redacted secret]'+'\n'.repeat(2),redacted:1});
});
// r13: a bare 40/64-character hex line (a Git commit ID) is not key evidence for a non-canonical label.
const dashes13=[0x2013,0x2014,0x2212];
for(const code of dashes13) for(const width of [1,2,3]) for(const hexLength of [40,64]) test(`r13: U+${code.toString(16)} x${width} rotation heading then ${hexLength}-hex commit ID stays unchanged`,()=>{
  const d=String.fromCodePoint(code).repeat(width);
  const text=d+' Be'+'gin private '+'key rotation'+d+'\n'+'a'.repeat(hexLength)+'\nCheck the deployment checklist.';
  assert.equal(redaction.hasSecretContent(text),false);
  assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
for(const code of dashes13) for(const width of [1,2,3]) for(const body of ['a'.repeat(40),'0123456789ABCDEF'.repeat(4),'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC']) test(`r13: canonical U+${code.toString(16)} x${width} banner with ${body.length}-char body is still masked`,()=>{
  const d=String.fromCodePoint(code).repeat(width);
  const text=d+'BE'+'GIN PRIVATE '+'KEY'+d+'\n'+body+'\n'+d+'EN'+'D PRIVATE '+'KEY'+d+'\nafter';
  assert.equal(redaction.hasSecretContent(text),true);
  assert.equal(redaction.redactSecrets(text).text.includes(body),false);
});

for(const width of [1,2,3]) test(`r11: ${width} Unicode dashes before rotation prose stay unchanged`,()=>{
  const text=String.fromCodePoint(0x2014).repeat(width)+' Be'+'gin private '+'key rotation\nCheck the deployment checklist.';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});

for(const [name,prefix,label] of [
  ['Unicode prefix before ASCII run','‐'+'-'.repeat(5),'MON'+'KEY'],
  ['Unicode prefix before private substring','—'+'-'.repeat(5),'PRI'+'VATE'+'K'+'EYX'],
  ['mixed opener','--—--','PRI'+'VATE'+'K'+'EYX'],
]) test(`legacy dashed marker ${name}`,()=>{
  const body='SYNTHETIC_'+'BODY',text=prefix+'BE'+'GIN '+label+'-'.repeat(5)+'\n'+body;
  assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
});
test('an em-dash checklist item stays prose',()=>{
  const text='— Be'+'gin private '+'key rotation\nCheck the deployment checklist.';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('public payload commentary stays prose',()=>{
  const text='// Public test payload, not a private '+'key\n// '+'SGVsbG8gd29ybGQh'.repeat(3);
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('standalone decorated labels retain the body fallback',()=>{
  const body='M'.repeat(48),label='PRI'+'VATE '+'K'+'EY';
  for(const [prefix,suffix] of [['',''],['// ',''],['# ',''],['* ',''],['> ',''],['"','"'],["'","'"]]) {
    const text=prefix+label+suffix+'\n'+(prefix==='// '?'// ':'')+body;
    assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
  }
});

for(const [name,suffix] of [['alone',''],['with armor','\n'+'-'.repeat(5)+'BE'+'GIN PRI'+'VATE '+'K'+'EY'+'-'.repeat(5)+'\n'+'M'.repeat(64)]]) {
  test(`combining case-fold marks ${name}`,()=>{
    const worker=`
      import assert from 'node:assert/strict';
      import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
      import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
      const {hasSecretContent,redactSecrets}=redaction;
      const text=(String.fromCodePoint(0x345)+String.fromCodePoint(0x316)).repeat(16000)+${JSON.stringify(suffix)};
      const start=performance.now();assert(hasSecretContent(text));
      assert(redactSecrets(text).text.startsWith('[redacted secret]'));
      assert(performance.now()-start<200,'case-fold mark scan exceeded 200 ms');
      console.log((performance.now()-start).toFixed(1)+' ms');
      assertLegacyCoverage(text,redaction);
    `;
    const result=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL'});
    assert.equal(result.status,0,`${result.error??result.stderr}`);
    console.log(`Case-fold marks ${name}: ${result.stdout.trim()}`);
  });
}
for(const label of [['RSA','PRI'+'VATE','K'+'EY'].join('_'),['PRI'+'VATE','K'+'EY'].join('_'),'PRI'+'VATE'+'K'+'EYX','K'+'EYNOTE ADDRESS','MON'+'KEY BUSINESS','PRI'+'VATELY OWNED']) {
  test(`transformed armor label ${label}`,()=>{
    const dash='-'.repeat(5),body='A'.repeat(64),text=dash+'BE'+'GIN '+label+dash+'\n'+body+'\n'+dash+'EN'+'D '+label+dash;
    assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
  });
}
for(const [name,text] of [
  ['camelCase identifier','+ const '+'begin'+'Private'+'Key'+' = false;'],
  ['rotation prose','Be'+'gin '+'private '+'key'+' rotation after staging is healthy.'],
  ...[40,64].map(n=>[`${n}-hex commit`, 'Fix handling of the '+'private '+'key'+'\n'+'a'.repeat(n)+'\nContinue review.']),
]) test(`ordinary ${name} stays unchanged`,()=>{
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('dashless body labels retain word boundaries',()=>{
  const text='notpri'+'vate'+'key\n'+'M'.repeat(64);
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
for(const name of ['K'+'EYNOTE ADDRESS','MON'+'KEY','MON'+'KEY BUSINESS','PRI'+'VATELY OWNED']) test(`en-dash ${name} heading stays prose`,()=>{
  const d='–'.repeat(5),text=d+'BE'+'GIN '+name+d+'\nWelcome.';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('en-dash underscore private-key armor is masked',()=>{
  const d='–'.repeat(5),label=['PRI'+'VATE','K'+'EY'].join('_'),body='A'.repeat(64);
  const text=d+'BE'+'GIN '+label+d+'\n'+body+'\n'+d+'EN'+'D '+label+d;
  assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
});
test('complete en-dash monkey banner stays prose',()=>{
  const d='–'.repeat(5),label='MON'+'KEY',text=d+'BE'+'GIN '+label+d+'\nordinary body\n'+d+'EN'+'D '+label+d;
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});

test('normalized combining-mark runs stay bounded across compatibility and invisible characters',()=>{
  const worker=`
    import assert from 'node:assert/strict';
    import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
    import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
    const {hasSecretContent,redactSecrets}=redaction;
    const inputs=[(String.fromCodePoint(0xff9e)+String.fromCodePoint(0x334)).repeat(32000),(String.fromCodePoint(0x301).repeat(64)+String.fromCodePoint(0x200b)).repeat(4000)];
    for(const text of inputs) {
      const started=performance.now();assert(hasSecretContent(text));
      assert(redactSecrets(text).text.startsWith('[redacted secret]'));
      const elapsed=performance.now()-started;assert(elapsed<200,'combining run took '+elapsed+' ms');
      console.log(elapsed.toFixed(1)+' ms');
      assertLegacyCoverage(text,redaction);
    }
    const ordinary=('e'+String.fromCodePoint(0x301)).repeat(32000),start=performance.now();
    assert.equal(hasSecretContent(ordinary),false);assert.equal(redactSecrets(ordinary).text,ordinary);
    assert(performance.now()-start<1000,'decomposed text exceeded one second');
    assertLegacyCoverage(ordinary,redaction);
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:1500,killSignal:'SIGKILL'});
  assert.equal(result.status,0,`${result.error??result.stderr}`);
  console.log(`Normalized combining runs: ${result.stdout.trim().replaceAll('\n',' / ')}`);
});

test('private-key prose followed by a commit hash stays unchanged',()=>{
  const text='A pri'+'vate k'+'ey is not included. Commit:\n'+'a'.repeat(40);
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});

test('decomposed prose on another line does not widen an armor mask',()=>{
  const dash='-'.repeat(5),begin='BE'+'GIN',end='EN'+'D',label='PRI'+'VATE '+'K'+'EY',body='M'.repeat(48);
  const before='cafe\u0301\nline two\nline three\nline four\n',after='\nordinary after\n';
  const text=before+dash+begin+' '+label+dash+'\n'+body+'\n'+body+'\n'+dash+end+' '+label+dash+after;
  const output=redaction.redactSecrets(text).text;
  assert(output.startsWith(before));assert(output.endsWith(after));assert(!output.includes(body));
  assert.equal(output.split('\n').length,text.split('\n').length);
});

test('decomposed prose across escaped line breaks does not widen an armor mask',()=>{
  const dash='-'.repeat(5),begin='BE'+'GIN',end='EN'+'D',label='PRI'+'VATE '+'K'+'EY',body='M'.repeat(48);
  for(const newline of ['\\n','\\r\\n']) {
    const before='cafe\u0301'+newline+'ordinary'+newline,after=newline+'ordinary after';
    const text=before+dash+begin+' '+label+dash+newline+body+newline+dash+end+' '+label+dash+after;
    const output=redaction.redactSecrets(text).text;
    assert(output.startsWith(before));assert(output.endsWith(after));assert(!output.includes(body));
  }
});

test('decomposed accents on the opener line preserve the matching footer and tail',()=>{
  const dash='-'.repeat(5),begin='BE'+'GIN',end='EN'+'D',label='PRI'+'VATE '+'K'+'EY',body='M'.repeat(48);
  const before='cafe\u0301 ',after='\nordinary after';
  const text=before+dash+begin+' '+label+dash+' cafe\u0301\n'+body+'\n'+dash+end+' '+label+dash+after;
  const output=redaction.redactSecrets(text).text;
  assert(output.startsWith(before));assert(output.endsWith(after));assert(!output.includes(body));
});

test('a key label preceded by compatibility filler is not a standalone body label',()=>{
  const body='M'.repeat(48),text='BE'+'GIN '+String.fromCodePoint(0xfb01).repeat(130)+' PRI'+'VATE '+'K'+'EY\n'+body;
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('exotic dashed opener cannot be closed by dashless body text',()=>{
  const d='˗'.repeat(5),body='M'.repeat(48),label='PRI'+'VATE '+'K'+'EY';
  const text=d+'BE'+'GIN '+label+d+'\n'+body+'EN'+'D'+'x'.repeat(10)+'K'+'EY'+body+'\n'+d+'EN'+'D '+label+d;
  assert(redaction.hasSecretContent(text));const output=redaction.redactSecrets(text).text;
  assert(!output.includes(body));assert(!output.includes(d+'EN'+'D'));
  const spaced=d+' '+text.slice(d.length);
  assert(!redaction.redactSecrets(spaced).text.includes(body));
});
test('a different dash style cannot close an open key',()=>{
  const body='M'.repeat(48),ascii='-'.repeat(5),unicode='–'.repeat(5),label='PRI'+'VATE '+'K'+'EY';
  const text=ascii+'BE'+'GIN '+label+ascii+'\n'+body+'\n'+unicode+'EN'+'D '+label+unicode+'\n'+body;
  assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
});
test('ordinary instructions and regex alternation remain available',()=>{
  for(const text of ['To be'+'gin, the pri'+'vate k'+'ey must be rotated regularly.', 'Be'+'gin by generating a pri'+'vate k'+'ey.', 'To be'+'gin: pri'+'vate/k'+'ey rotation tomorrow.', 'text.matchAll(/BE'+'GIN|EN'+'D|PRI'+'VATE|K'+'EY/g)']) {
    assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
  }
});
test('a beginner who owns a keyboard is ordinary prose',()=>{
  const text='BE'+'GINNER pri'+'vately owns a key'+'board.';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('multiple algorithm words without a key body stay prose',()=>{
  const text='BE'+'GIN RSA EC PRI'+'VATE '+'K'+'EY discussion';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('a dashless key rotation phrase stays prose',()=>{
  const text='We be'+'gin pri'+'vate k'+'ey rotation tomorrow.';
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});
test('labels with long key body lines mask without an opening control',()=>{
  const body='M'.repeat(48),text='PRI'+'VATE '+'K'+'EY\n'+body;
  assert(redaction.hasSecretContent(text));assert(!redaction.redactSecrets(text).text.includes(body));
});
test('pathological combining runs fail closed before normalization',()=>{
  const worker=`
    import assert from 'node:assert/strict';
    import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
    import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
    const {hasSecretContent,redactSecrets}=redaction;
    for(const suffix of ['', '\\n'+'BE'+'GIN '+'PRI'+'VATE '+'K'+'EY\\n'+'M'.repeat(48)]) {
      const text='a'+String.fromCodePoint(0x315).repeat(32000)+String.fromCodePoint(0x300).repeat(32000)+suffix;
      const start=performance.now();assert(hasSecretContent(text));const out=redactSecrets(text).text;
      assert(!out.includes('M'.repeat(48)));assert(out.startsWith('[redacted secret]'));
      assert(performance.now()-start<1000);
      assertLegacyCoverage(text,redaction);
    }
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL'});
  assert.equal(result.status,0,`${result.error??result.stderr}`);
});

const home=fs.mkdtempSync(path.join(os.tmpdir(),'armor-boundaries-'));
process.env.HOME=home;
const {validateSubmission:validateSubmissionBase}=await import('../src/submission-policy.mjs');
const validateSubmission=(value,...args)=>{auditValue(value);return validateSubmissionBase(value,...args);};
console.log(`Armor boundary fixtures retained: ${home}`);

const corpusBodies=[['U1lO','VEhF','VElD','X0JP','RFlf','QQ=='].join(''),['U1lO','VEhF','VElD','X0JP','RFlf','Qg=='].join('')];
const mainMaskedCorpus=new Set(['prose-keynote-banner','prose-monkey-business','prose-privately-owned']);
for(const item of armorEvasionCases) {
  const mustMask=item.mustMask||mainMaskedCorpus.has(item.name);
  test(`evasion corpus: ${item.name}`,()=>{
    const text=item.text,out=redaction.redactSecrets(text);
    const detections=[redaction.privateKeyHeader.test(text),redaction.secretContent.test(text),redaction.hasSecretContent(text),redaction.hasSecretContent({nested:{value:text}}),redaction.hasSecretContent({[text]:'value'})];
    const structured=JSON.stringify(redaction.redactOutput({[text]:text,nested:{value:text}}));
    assert(detections.every(value=>value===mustMask));
    if(mustMask) {
      for(const body of corpusBodies) if(text.includes(body)) {
        assert(!out.text.includes(body));assert(!structured.includes(body));
      }
    } else assert.deepEqual(out,legacyRedactArmor(text));
    if(item.name==='offset-normalization-removes-invisibles') {
      assert(out.text.startsWith('before 🐟\n'));assert(out.text.endsWith('AFTER_CORPUS'));
    }
  });
}

test('seeded concatenated controls never expose a valid key body',()=>{
  const seed=0x2031103;let state=seed;
  const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*n);};
  const begin='BE'+'GIN',end='EN'+'D',key='KEY';
  const labels=['PRIVATE '+key,'RSA PRIVATE '+key,'OPENSSH PRIVATE '+key];
  const body='U1lOVEhFVElDX0tFWV9CT0RZX09OTFk=';
  const run=()=>{const width=1+random(8),style=random(3);return Array.from({length:width},(_,i)=>style===0?'-':style===1?'–':i%2?'–':'-').join('');};
  const pieces=[begin,end,...labels,'','ordinary',' ','\n'];
  const failures=[];
  for(let i=0;i<3000;i++) {
    let prefix=i===0?'-'.repeat(5)+end:'';
    if(i>0) for(let j=0,n=random(8);j<n;j++) prefix+=random(2)?run():pieces[random(pieces.length)];
    const dash=i===0?'-'.repeat(5):run(),label=i===0?labels[0]:labels[random(labels.length)];
    const text=prefix+dash+begin+' '+label+dash+'\n'+body+'\n'+(random(2)?dash+end+' '+label+dash+'\n':'');
    if(!redaction.hasSecretContent({text})||redaction.redactSecrets(text).text.includes(body)) failures.push(i);
  }
  assert.deepEqual(failures,[],`seed ${seed}, failing cases: ${failures.slice(0,20).join(', ')}`);
});

const variantBody='U1lOVEhFVElDX0tFWV9CT0RZX09OTFk=';
const variantBegin='BE'+'GIN',variantEnd='EN'+'D',variantPrivate='PRI'+'VATE',variantKey='K'+'EY';
const variantCases={
  'folded glued short': 'x---'+variantBegin+' '+variantPrivate+'\n'+variantKey+'---\n'+variantBody,
  'folded unequal short': '---'+variantBegin+' '+variantPrivate+'\n'+variantKey+'----\n'+variantBody,
  'folded truncated short': 'x---'+variantBegin+' '+variantPrivate+'\n'+variantKey+'\n'+variantBody,
  'folded after adjacent control': '-'.repeat(5)+variantEnd+'---'+variantBegin+' '+variantPrivate+'\n'+variantKey+'---\n'+variantBody,
  'fullwidth dashes': '－'.repeat(5)+variantBegin+' '+variantPrivate+' '+variantKey+'－'.repeat(5)+'\n'+variantBody,
  'small hyphen-minus': '﹣'.repeat(5)+variantBegin+' '+variantPrivate+' '+variantKey+'﹣'.repeat(5)+'\n'+variantBody,
  'small em dash': '﹘'.repeat(5)+variantBegin+' '+variantPrivate+' '+variantKey+'﹘'.repeat(5)+'\n'+variantBody,
  'soft hyphen': '-'.repeat(5)+'\u00ad'+variantBegin+' '+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'zero width before control': '-'.repeat(5)+'\u200b'+variantBegin+' '+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'zero width inside control': '-'.repeat(5)+'BE\u200bGIN '+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'zero width before label': '-'.repeat(5)+variantBegin+'\u200b'+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'colon separator': '-'.repeat(5)+variantBegin+': '+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'no separator': '-'.repeat(5)+variantBegin+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
  'same line body': 'x-'+variantBegin+' '+variantPrivate+' '+variantKey+'- '+variantBody,
  'NFKC across code points': 'e\u0301 '+'-'.repeat(5)+variantBegin+' '+variantPrivate+' '+variantKey+'-'.repeat(5)+'\n'+variantBody,
};
for(const [name,text] of Object.entries(variantCases)) test(`variant armor: ${name}`,()=>{
  assert(redaction.hasSecretContent({text}));
  assert(!redaction.redactSecrets(text).text.includes(variantBody));
  if(text.includes('M'.repeat(48))) assert(!redaction.redactSecrets(text).text.includes('M'.repeat(48)));
});

test('an unmarked label preceded by another word is not a standalone body label',()=>{
  const text=variantBegin+variantEnd+' '+variantPrivate+variantKey+'\n'+'M'.repeat(48);
  assert.equal(redaction.hasSecretContent(text),false);assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
});

test('unknown dash style masks through the end of the input',()=>{
  const text='before 🐟\n－'+variantBegin+':'+variantPrivate+'/'+variantKey+'－\n'+variantBody+'\n－'+variantEnd+':'+variantPrivate+'/'+variantKey+'－\nafter';
  const output=redaction.redactSecrets(text).text;
  assert(output.startsWith('before 🐟\n'));
  assert(!output.includes('after'));
  assert(!output.includes(variantBody));
});

test('seeded folded and normalized key starts never expose their body',()=>{
  const seed=0x5031103;let state=seed;
  const random=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/0x100000000*n);};
  const dashes=['-','–','—','‐','‑','−','－','﹣','﹘'];
  const invisible=['','\u00ad','\u200b','\u200c','\u200d','\ufeff'];
  const separators=[' ',': ','','\r\n','\n','\\n','/'];
  const failures=[];
  for(let i=0;i<4000;i++) {
    const dash=dashes[random(dashes.length)].repeat(1+random(8));
    const casing=s=>random(2)?s.toLowerCase():s;
    const begin=casing(variantBegin),priv=casing(variantPrivate),key=casing(variantKey);
    const fold=s=>{const at=1+random(s.length-1);return s.slice(0,at)+invisible[random(invisible.length)]+s.slice(at);};
    const text=(random(2)?'x':'')+dash+fold(begin)+separators[random(separators.length)]+fold(priv)+separators[random(separators.length)]+fold(key)+(random(3)?dash:'')+'\r\n'+variantBody+'\r\n';
    auditText(text);generatedParityCases++;
    if(!redaction.hasSecretContent({text})||redaction.redactSecrets(text).text.includes(variantBody)) failures.push(i);
  }
  assert.deepEqual(failures,[],`seed ${seed}, ${failures.length} failures, first: ${failures.slice(0,20).join(', ')}`);
});

test('normalized key scanning scales with input size',()=>{
  const worker=`
    import assert from 'node:assert/strict';
    import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
    import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
    const piece='x－'+'be\\u200bgin:'+'pri'+'vate/'+'k'+'ey－\\n';
    const measure=n=>{const input=piece.repeat(n),start=performance.now();redaction.redactSecrets(input);const elapsed=performance.now()-start;assertLegacyCoverage(input,redaction);return elapsed;};
    measure(1000);
    const small=measure(8000),large=measure(16000);
    assert(large<1500 && large<small*5+100, 'scan timings: '+small+', '+large);
    console.log(small.toFixed(1)+' ms / '+large.toFixed(1)+' ms');
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',worker],{encoding:'utf8',timeout:5000,killSignal:'SIGKILL'});
  assert.equal(result.status,0,`${result.error??result.stderr}`);
  console.log(`Normalized scaling (8000 / 16000): ${result.stdout.trim()}`);
});

test('many redacted object keys keep their values and avoid suffix collisions',()=>{
  const prefix='s'+'k-',count=20000;
  const input=Object.fromEntries([['[redacted secret] (2)','reserved'],...Array.from({length:count},(_,i)=>[prefix+i.toString(36).padStart(24,'A'),i])]);
  auditValue(input);
  const started=performance.now(),output=redaction.redactOutput(input),elapsed=performance.now()-started;
  assert(elapsed<1000,`object key redaction took ${elapsed.toFixed(1)} ms`);
  assert.equal(Object.keys(output).length,count+1);
  assert.equal(output['[redacted secret] (2)'],'reserved');
  assert.equal(new Set(Object.values(output)).size,count+1);
  console.log(`Object key collisions: ${count}, ${elapsed.toFixed(1)} ms`);
});

for(const [name,run] of [['ASCII','-'.repeat(5)],['en dash','–'.repeat(5)],['mixed','-–—‐‑']]) {
  const label='PRIVATE '+'KEY',begin='BE'+'GIN',end='EN'+'D',body='U1lOVEhFVElDX0tFWV9CT0RZX09OTFk=';
  const text=run+end+' '+label+'\n'+run+begin+' '+label+run+'\n'+body+'\n'+run+end+' '+label+run+'\nafter';
  test(`truncated END before BEGIN: admission ${name}`,()=>{
    assert.equal(redaction.privateKeyHeader.test(text),true);
    assert.equal(redaction.hasSecretContent({text}),true);
    assert.throws(()=>validateSubmission({schema_version:1,request_id:'req_truncated_fixture',brief:text,inputs:[],expected_output:'report',execution_scope:'read-only'}),/hard sensitive content exclusion/);
  });
  test(`truncated END before BEGIN: redaction ${name}`,()=>{
    assert(!redaction.redactSecrets(text).text.includes(body));
    assert(!JSON.stringify(redaction.redactOutput({text})).includes(body));
  });
}

test('glued short controls scan a long line within one second',()=>{
  const worker=`
    import assert from 'node:assert/strict';
    import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
    import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
    const input=('x–'+'BE'+'GIN '+'KEY'+'– ').repeat(32000)+(process.argv[1]==='newline'?'\\n':'');
    const start=performance.now(),output=redaction.redactSecrets(input).text,elapsed=performance.now()-start;
    assert.equal(output,input);
    assert(elapsed<1000, 'scan exceeded one second: '+elapsed+' ms');
    assertLegacyCoverage(input,redaction);
    console.log(elapsed.toFixed(1)+' ms');
  `;
  for(const ending of ['none','newline']) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',worker,ending],{encoding:'utf8',timeout:2000,killSignal:'SIGKILL'});
    assert.equal(result.status,0,`${ending}: ${result.error??result.stderr}`);
    console.log(`Glued controls, ${ending}: ${result.stdout.trim()}`);
  }
});

test('P2: large malformed armor stays within a bounded child process',()=>{
  const worker=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import * as redaction from ${JSON.stringify(new URL('../src/redaction.mjs',import.meta.url).href)};
    import {assertLegacyCoverage} from ${JSON.stringify(legacyOracleUrl)};
    const {input,header,masked}=JSON.parse(fs.readFileSync(0,'utf8'));
    const started=performance.now(),output=redaction.redactSecrets(input).text;
    assert.equal(redaction.privateKeyHeader.test(input),header);
    assert.equal(redaction.secretContent.test(input),header);
    assert.equal(redaction.hasSecretContent({input}),header);
    if(masked==='line') assert(!output.includes('END'));
    else if(masked) assert(!output.includes('SYNTHETIC_BODY'));
    else if(!header) assert(output===input);
    assertLegacyCoverage(input,redaction);
    console.log(Math.round(performance.now()-started)+' ms');
  `;
  const words='KEY\n'.repeat(131072),body='SYNTHETIC_BODY';
  for(const [name,input,header,masked] of [
    ['repeated label candidates without a closing dash','-'.repeat(5)+'BE'+'GIN '+words,true,true],
    ['many incomplete control markers',('-'+'BE'+'GIN ordinary\n').repeat(32768),false,false],
    ['one long dash run','-'.repeat(524288),false,false],
    ['many stray END markers on one line',('-'+'EN'+'D '+'K'+'EY- ').repeat(32768),false,'line'],
    ['an unclosed block','-'+'BE'+'GIN '+'K'+'EY-\n'+body+'\n'+words,true,true],
    ['a large matched label','-'+'BE'+'GIN '+words+'-\n'+body+'\n-'+'EN'+'D '+words+'-\nafter',true,true],
  ]) {
    const result=spawnSync(process.execPath,['--input-type=module','-e',worker],{input:JSON.stringify({input,header,masked}),encoding:'utf8',timeout:4000,killSignal:'SIGKILL'});
    assert.equal(result.error?.code,undefined,`${name}: exceeded 4-second child bound (${result.error?.code})`);
    assert.equal(result.status,0,`${name}: ${result.stderr.slice(0,2000)}`);
    console.log(`Armor scalability: ${name}: ${Buffer.byteLength(input)} bytes, ${result.stdout.trim()}`);
  }
});

test('N6/N7: one grammar masks short and folded key armor',()=>{
  const body='U1lOVEhFVElDX0tFWV9CT0RZX09OTFk=',failures=[];let generated=0;
  const cases=[s=>s.toUpperCase(),s=>s.toLowerCase()];
  const marker=(kind,label,dashes,space,casing)=>'-'.repeat(dashes)+space+casing(kind)+(label?(space||' '):'')+casing(label.replaceAll(' ',space||' '))+space+'-'.repeat(dashes);
  for(const casing of cases) for(const dashes of [1,2,5]) for(const space of ['',' \t ','\n','\r\n']) {
    for(const label of ['RSA PRIVATE KEY','KEY','PRIVATE','OPENSSH-KEY/V2','PRIVATE-ARCHIVE KEY','KEY-ARCHIVE']) for(const prefix of ['','const key = `']) for(const ending of ['matched','missing','mismatched']) {
      const begin=marker('BEGIN',label,dashes,space,casing),end=marker('END',ending==='mismatched'?'OTHER PRIVATE MATERIAL':label,dashes,space,s=>s.toUpperCase());
      const text=`before\n${prefix}${begin}\n${body}\n${ending==='missing'?'':end+'\n'}AFTER_ARMOR\n`;
      const variant=JSON.stringify({begin,dashes,space,label,prefix,ending});generated++;
      try {
        assert(text.includes(begin)&&text.includes(body));
        const output=redaction.redactSecrets(text).text;
        assert(!output.includes(body),'body leaked');
        assert(output.startsWith(`before\n${prefix}`));
        assert.equal(output.includes('AFTER_ARMOR'),ending==='matched');
        assert.equal(output.split('\n').length,text.split('\n').length);
        assert(redaction.privateKeyHeader.test(text));assert(redaction.secretContent.test(text));
        assert(!JSON.stringify(redaction.redactOutput({text})).includes(body));
        const orphan=`before\nprefix ${end}\nafter\n`,stray=redaction.redactSecrets(orphan).text;
        assert(stray.startsWith('before\n[redacted secret]'));assert(stray.endsWith('\nafter\n'));
        assert.equal(stray.split('\n').length,orphan.split('\n').length);assert(!stray.includes(end));
      } catch(error) {failures.push(`${variant}: ${error.message.split('\n')[0]}`);}
    }
  }
  const prose='We begin with a key idea and end this private discussion.\n--- begin chapter ---\nA key detail stays private.\n--- end chapter ---\n';
  assert.deepEqual(redaction.redactSecrets(prose),{text:prose,redacted:0});
  assert.equal(redaction.hasSecretContent({prose}),false);
  console.log(`Armor boundary table: ${generated} generated forms, ${failures.length} failures`);
  assert.equal(failures.length,0,failures.slice(0,12).join('\n'));
});

test('N7: admission inspects folded armor in structured instruction strings',()=>{
  const brief='-'.repeat(5)+'BE'+'GIN\nPRI'+'VATE '+'K'+'EY'+'-'.repeat(5)+'\nU1lOVEhFVElDX0JPRFk=\n';
  assert.throws(()=>validateSubmission({schema_version:1,request_id:'req_folded_fixture',brief,inputs:[],expected_output:'report',execution_scope:'read-only'}),/hard sensitive content exclusion/);
});

test('N7: structured inspection scans nested string values and property names',()=>{
  const marker='-'.repeat(5)+'BE'+'GIN\nPRI'+'VATE '+'K'+'EY'+'-'.repeat(5);
  assert(redaction.hasSecretContent({nested:[{contents:marker}]}));
  assert(redaction.hasSecretContent({nested:[{[marker]:'ordinary'}]}));
  assert.equal(redaction.hasSecretContent({nested:[{contents:'We begin with a key idea.'}]}),false);
});

for(const banner of ['-- BE'+'GIN --', '-'.repeat(5)+'BE'+'GIN'+'-'.repeat(5), '-- EN'+'D --']) test(`ordinary banner is preserved: ${banner}`,()=>{
  const text=banner+'\nSKIP example\n';
  assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
  assert.equal(redaction.secretContent.test(text),false);
});
for(const suffix of ['', '\nSYNTHETIC_BODY', '\r\nSYNTHETIC_BODY']) test(`truncated key header is masked: ${JSON.stringify(suffix)}`,()=>{
  const text='-'.repeat(5)+'BE'+'GIN OPENSSH PRI'+'VATE '+'K'+'EY'+suffix;
  assert.equal(redaction.privateKeyHeader.test(text),true);
  assert.equal(redaction.secretContent.test(text),true);
  assert(!redaction.redactSecrets(text).text.includes('OPENSSH'));
  assert(!redaction.redactSecrets(text).text.includes('SYNTHETIC_BODY'));
});

// Fixtures are assembled from parts so this file holds no contiguous token shape.
const H='-';
test('hyphenated prose is not armor and detection agrees with redaction',()=>{
  const prose=[
    'the front'+H+'e'+'nd priv'+'ate API',
    'back'+H+'e'+'nd k'+'ey rotation',
    'the front'+H+'e'+'nd ships.\nLater, the priv'+'ate API stays.',
    '- E'+'nd one: `run --clear`. The priv'+'ate API stays.\n- Next k'+'ey item',
    'wrap'+H+'up b'+'egin priv'+'ate k'+'ey'+H+'rotation',
  ];
  for(const text of prose) {
    assert.deepEqual(redaction.redactSecrets(text),legacyRedactArmor(text),JSON.stringify(text));
    assert.equal(redaction.hasSecretContent(text),legacyKeyHeader(text));
    assert.equal(redaction.hasSecretContent({text}),legacyKeyHeader(text));
  }
  // Real armor next to prose retains main's existing mask coverage.
  const block=H.repeat(5)+'BE'+'GIN PRI'+'VATE '+'K'+'EY'+H.repeat(5)+'\nSYNTHETIC_BODY\n'+H.repeat(5)+'EN'+'D PRI'+'VATE '+'K'+'EY'+H.repeat(5);
  const mixed=prose[0]+'\n'+block+'\nafter';
  const out=redaction.redactSecrets(mixed);
  assert(out.text.startsWith('[redacted secret]\n'));
  assert(!out.text.includes('SYNTHETIC_BODY'));
  assert(out.text.endsWith('\nafter'));
  // Short symmetric armor that stands alone is still masked.
  for(const width of [1,2,3,4]) {
    const short=H.repeat(width)+'BE'+'GIN '+'K'+'EY'+H.repeat(width)+'\nSYNTHETIC_BODY\n';
    assert(redaction.redactSecrets(short).redacted>0,`width ${width}`);
    assert.equal(redaction.hasSecretContent(short),true);
  }
});

// Short armor that the standalone gate rejects must still mask when a base64
// body follows its key label. One case per leak shape; each failed before the rule.
const BODY='MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7'+'x'.repeat(40);
const bg='BE'+'GIN',nd='EN'+'D',label='PRIVATE '+'KEY';
const armor=(left,right,{pre='',tail='',name=label,close=true}={})=>
  pre+H.repeat(left)+bg+' '+name+H.repeat(right)+tail+'\n'+BODY+'\n'+(close?H.repeat(left)+nd+' '+label+H.repeat(right):'');
for(const [name,run] of [['en dash','–'.repeat(5)],['mixed dashes','-–—‐‑‒―−'],['short mixed dashes','-–—']]) test(`Unicode armor masks: ${name}`,()=>{
  const text=`before 🐟\n${run}${bg} ${label}${run}\n${BODY}\n${run}${nd} ${label}${run}\nafter`;
  assert.equal(redaction.privateKeyHeader.test(text),true);
  assert.equal(redaction.hasSecretContent({text}),true);
  const output=redaction.redactSecrets(text).text;
  assert(!output.includes(BODY));
  assert(output.startsWith('before 🐟\n[redacted secret]'));
  assert(output.endsWith('\nafter'));
  assert(!JSON.stringify(redaction.redactOutput({text})).includes(BODY));
});
test('Unicode dash prose remains unchanged',()=>{
  for(const text of ['pages 3–5','a pause — then']) {
    assert.equal(redaction.hasSecretContent(text),false);
    assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0});
  }
});
for(const [name,text] of Object.entries({
  'glued marker with comment':armor(3,3,{pre:'x'}).replace('\n'+BODY,'\nComment: backup\n\n'+BODY),
  'unequal marker with blank line':armor(3,4).replace('\n'+BODY,'\n\n'+BODY),
  'qualified marker with blank line':armor(3,3,{name:label+' (old)'}).replace('\n'+BODY,'\n\n'+BODY),
  'metadata before escaped body':JSON.stringify(armor(3,3,{pre:'x'}).replace('\n'+BODY,'\nVersion: 1\nBag Attributes\n\n'+BODY)),
})) test(`review: masks ${name}`,()=>{
  assert.equal(redaction.hasSecretContent(text),true);
  assert(!redaction.redactSecrets(text).text.includes(BODY));
});
for(const name of ['KEYNOTE ADDRESS','MONKEY BUSINESS','PRIVATELY OWNED']) test(`review: dashed substring label masks ${name}`,()=>{
  const text=H.repeat(5)+bg+' '+name+H.repeat(5)+'\nordinary text';
  assert.equal(redaction.hasSecretContent(text),true);
  assert.notEqual(redaction.redactSecrets(text).text,text);
});
for(const [name,text] of Object.entries({
  'unequal opening and closing runs (3 and 4)':armor(3,4),
  'unequal opening and closing runs (4 and 3)':armor(4,3),
  'run glued to a word character':armor(3,3,{pre:'wor'+'d'}),
  'run after a JSON-escaped newline':JSON.stringify({k:'x\n'+armor(3,3)}),
  'unequal run inside a JSON string':JSON.stringify({k:'x\n'+armor(3,4)}),
  'label with a parenthesised qualifier':armor(3,3,{name:label+' (old)'}),
  'label with trailing punctuation':armor(2,2,{name:label+'.'}),
  'header with no closing dashes or footer':armor(3,0,{close:false}),
})) test(`short key armor masks: ${name}`,()=>{
  assert.equal(redaction.hasSecretContent(text),true);
  assert.equal(redaction.secretContent.test(text),true);
  const out=redaction.redactSecrets(text).text;
  assert(!out.includes(BODY.slice(0,30)),'body leaked');
  assert(!out.includes(bg+' '+label),'header leaked');
  assert(!JSON.stringify(redaction.redactOutput({text})).includes(BODY.slice(0,30)));
});
test('short key headings are masked even without a base64 body',()=>{
  for(const text of [
    H.repeat(3)+bg+' '+label+H.repeat(4)+'\nThe sentence after the heading is plain prose.\n',
    'wor'+'d'+H.repeat(3)+bg+' '+label+' (old)'+H.repeat(3)+'\n- Next k'+'ey item\n',
  ]) {assert(redaction.hasSecretContent(text));assert.notEqual(redaction.redactSecrets(text).text,text);}
});

test('shipped docs retain main-branch redaction behavior',()=>{
  for(const doc of ['docs/claude-worker-onboarding.md','docs/usage.md']) {
    const text=fs.readFileSync(new URL('../'+doc,import.meta.url),'utf8');
    assert.deepEqual(redaction.redactSecrets(text),legacyRedactArmor(text),doc);
  }
});

const tokenFixtures={
  'Telegram bot token':'123456789'+':'+'A'.repeat(35),
  'Discord bot token':['MTIzNDU2Nzg5MDEyMzQ0NTY3','Gabcde','X'.repeat(27)].join('.'),
  'URL with short password':'https://alice:'+'abc'+'@api.example.com',
  'Slack rotating refresh token':'xoxe'+'-1-'+'a'.repeat(24),
  'Slack rotating access token':'xoxe.'+'xoxb-1-'+'a'.repeat(24),
  'Slack webhook URL':'https://hooks.slack.com/services/'+'T00000000/B00000000/'+'X'.repeat(24),
  'JWT':['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9','eyJzdWIiOiIxMjM0NTY3ODkwIn0','SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.'),
  'Google OAuth client secret':'GOCSPX'+H+'abcdefghijklmnopqrstuvwx',
  'Google OAuth access token':'ya29'+'.'+'a0AfH6SMBabcdefghijklmnopqrstuv',
  'Google OAuth refresh token':'1/'+'/'+'0gabcdefghijklmnopqrstuvwxyz0123456789ABC',
};
for(const [name,token] of Object.entries(tokenFixtures)) test(`credential shape is detected and masked: ${name}`,()=>{
  const text=`before ${token} after`;
  assert.equal(redaction.hasSecretContent(text),true);
  assert.deepEqual(redaction.redactSecrets(text),{text:'before [redacted secret] after',redacted:1});
  assert.equal(redaction.hasSecretContent({nested:[token]}),true);
  assert.equal(redaction.redactOutput({nested:[token]}).nested[0],'[redacted secret]');
});

test('lookalikes of those shapes stay unchanged',()=>{
  for(const text of [
    'see hooks.slack.com/services for webhook setup',
    'a JWT starts with eyJ and has three period-separated parts',
    'set GOCSPX'+H+'<client-secret> in the console',
    'refresh tokens start with 1/'+'/0 and access tokens with ya29.',
  ]) assert.deepEqual(redaction.redactSecrets(text),{text,redacted:0},text);
});

test('redactOutput masks a secret held in an object key, as admission refuses it',()=>{
  const token='s'+'k-'+'abcdefghijklmnopqrstuvwxyz0123456789';
  const input={[token]:'value',nested:{[token+'b']:['x'],plain:'y'},[token+'c']:'z'};
  assert.equal(redaction.hasSecretContent(input),true);
  const output=redaction.redactOutput(input);
  assert.equal(JSON.stringify(output).includes('abcdefghijklmnopqrstuvwxyz'),false);
  assert.equal(redaction.hasSecretContent(output),false);
  // Distinct masked keys keep distinct values; nothing is overwritten.
  assert.deepEqual(Object.values(output).filter(item=>typeof item==='string').sort(),['value','z']);
  assert.deepEqual(Object.values(output.nested).map(item=>JSON.stringify(item)).sort(),['"y"','["x"]']);
  // Ordinary keys and the legacy-preview rule are unchanged.
  assert.deepEqual(redaction.redactOutput({a:{b:1},diff_preview:'x'}),{a:{b:1},diff_preview:'[legacy diff preview withheld; owner patch required]'});
});

test('legacy admission and mask spans cover the corpus and generator',()=>{
  assert.equal(generatedParityCases,4000);
  for(const item of armorEvasionCases) assert(audited.has(item.text),item.name);
  console.log(`Legacy parity: ${armorEvasionCases.length} corpus cases, ${generatedParityCases} generated cases, ${audited.size} unique suite strings`);
});
