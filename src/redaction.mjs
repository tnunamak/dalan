// One content policy for admission and every worker-visible text path.
// Known-prefix families match even glued to a word character; the generic shapes keep a leading word boundary.
const tokenContent=/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|\bsk-[A-Za-z0-9_-]{24,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|(?:xoxe\.)?(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}|xoxe-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{35}|whsec_[A-Za-z0-9+/=_-]{8,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|(?:https:\/\/)?hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|GOCSPX-[A-Za-z0-9_-]{20,}|\bya29\.[A-Za-z0-9_-]{20,}|\b1\/\/[A-Za-z0-9_-]{30,}|\b\d{8,10}:[A-Za-z0-9_-]{35}|\b[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27})\b|(?<![a-z0-9+.-])\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|db|postgres|mysql|redis|mongo|example\.(?:com|org|net)|host\.docker\.internal)\b)[^\s\/]+/i;

function dashEnd(input,start) {
  let end=start+1;
  while(input[end]==='-') end++;
  return end;
}

// Keep a source span for every normalized code unit: compatibility characters
// may expand, and ignored characters must still be covered by a mask.
function normalizedKeyMarkers(input) {
  const normalize=text=>text.replace(/\\u00([0-7][0-9a-f])/gi,(_match,hex)=>String.fromCharCode(parseInt(hex,16))).normalize('NFKC').toUpperCase().replace(/[\p{Default_Ignorable_Code_Point}\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu,'').replace(/\u0399/g,'I').replace(/[\p{Dash}\u02d7\u2043\u2796]/gu,'-');
  const chunks=[],starts=[],ends=[];
  let marks=0,rawMarks=0,lineStart=0,lineChunks=[],sourceStarts=[],sourceEnds=[],segmenter;
  const finishLine=lineEnd=>{
    const source=input.slice(lineStart,lineEnd),line=normalize(source);
    let exact=lineChunks.join('')===line;
    if(!exact) {
      segmenter??=new Intl.Segmenter('und',{granularity:'grapheme'});
      const pieces=[],segmentStarts=[],segmentEnds=[];
      for(const part of segmenter.segment(source)) {
        const piece=normalize(part.segment);
        pieces.push(piece);
        for(let i=0;i<piece.length;i++) {segmentStarts.push(lineStart+part.index);segmentEnds.push(lineStart+part.index+part.segment.length);}
      }
      if(pieces.join('')===line) {sourceStarts=segmentStarts;sourceEnds=segmentEnds;exact=true;}
    }
    chunks.push(line);
    for(let i=0;i<line.length;i++) {
      starts.push(exact?sourceStarts[i]:lineStart);
      ends.push(exact?sourceEnds[i]:lineEnd);
    }
    lineChunks=[];sourceStarts=[];sourceEnds=[];
  };
  // ASCII text without escapes already has identity source offsets. Normalize
  // the whole string once instead of invoking Unicode operations for each byte.
  if(/^[\t\r\n\x20-\x7e]*$/.test(input)&&!input.includes('\\')) {
    chunks.push(input.toUpperCase());
    for(let i=0;i<input.length;i++) {starts.push(i);ends.push(i+1);}
  } else {
    for(let offset=0;offset<input.length;) {
      const escape=input[offset]==='\\'?/^\\u00[0-7][0-9a-f]/i.exec(input.slice(offset,offset+6)):null;
      const char=escape?String.fromCharCode(parseInt(escape[0].slice(2),16)):String.fromCodePoint(input.codePointAt(offset));
      const end=offset+(escape?6:char.length);
      const escapedBreak=char==='\\'&&/[nN]/.test(input[offset+1]??'')?2:
        char==='\\'&&/[rR]/.test(input[offset+1]??'')&&input[offset+2]==='\\'&&/[nN]/.test(input[offset+3]??'')?4:0;
      if(escapedBreak) {
        finishLine(offset);
        for(let i=0;i<escapedBreak;i++) {chunks.push(normalize(input[offset+i]));starts.push(offset+i);ends.push(offset+i+1);}
        offset+=escapedBreak;lineStart=offset;marks=0;rawMarks=0;continue;
      }
      if(char==='\n') {
        finishLine(offset);chunks.push(char);starts.push(offset);ends.push(end);
        lineStart=end;marks=0;rawMarks=0;offset=end;continue;
      }
      if(/\p{M}/u.test(char)) rawMarks++;
      else if(!/\p{Default_Ignorable_Code_Point}/u.test(char)) rawMarks=0;
      if(rawMarks>64) return [{kind:'OVERFLOW',start:0,end:input.length}];
      // Count NFKC marks before case folding can turn one into a letter.
      for(const unit of char.normalize('NFKC')) {
        if(/\p{Default_Ignorable_Code_Point}/u.test(unit)) continue;
        marks=/\p{M}/u.test(unit)?marks+1:0;
        if(marks>64) return [{kind:'OVERFLOW',start:0,end:input.length}];
      }
      const normalized=normalize(char);
      lineChunks.push(normalized);
      for(let i=0;i<normalized.length;i++) {sourceStarts.push(offset);sourceEnds.push(end);}
      offset=end;
    }
    finishLine(input.length);
  }
  let text=chunks.join('');
  // Join line folds only inside marker words, retaining original source offsets.
  const fold=String.raw`(?:\r?\n|\\R\\N|\\N)`;
  const words=['BEGIN','END','PRIVATE','KEY'];
  const patterns=words.flatMap(word=>Array.from({length:word.length-1},(_,required)=>
    [...word].map((char,i)=>i===0?char:`${fold}${i-1===required?'+':'*'}${char}`).join('')));
  const removed=[];
  for(const hit of text.matchAll(new RegExp(patterns.join('|'),'g'))) {
    for(const part of hit[0].matchAll(new RegExp(fold,'g'))) removed.push([hit.index+part.index,part[0].length]);
  }
  if(removed.length) {
    const parts=[];let cursor=0,write=0;
    for(const [start,length] of removed) {
      parts.push(text.slice(cursor,start));
      for(let i=cursor;i<start;i++) {starts[write]=starts[i];ends[write++]=ends[i];}
      cursor=start+length;
    }
    parts.push(text.slice(cursor));
    for(let i=cursor;i<text.length;i++) {starts[write]=starts[i];ends[write++]=ends[i];}
    starts.length=write;ends.length=write;text=parts.join('');
  }
  const sep=String.raw`(?:[\s:/_\-]|\\[RN])`;
  const header=new RegExp(String.raw`(BEGIN|END)(?:[\s:/\-]|\\[RN]){0,3}(?:(?:SSH2${sep}+ENCRYPTED|RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP|ED25519|SSH2)${sep}+)?PRIVATE${sep}*KEY(?:[ \t]+BLOCK)?`,'g');
  const label=new RegExp(String.raw`\bPRIVATE(?:[\s_\-]|\\[RN])*KEY\b`,'g');
  const styleAt=position=>{
    let start=position;
    while(start>0&&(text[start-1]===' '||text[start-1]==='\t')) start--;
    const end=start;
    while(start>0&&text[start-1]==='-') start--;
    if(start===end) return '';
    const style=input.slice(starts[start],ends[end-1]);
    return /^[-\u2010-\u2015\u2212]+$/u.test(style)?style:null;
  };
  let controls=[];
  const labelEnd=/[ \t\-"'*]*(?=\r?\n|\\R\\N|\\N|$)/y;
  for(const match of text.matchAll(header)) {
    const start=match.index;let end=start+match[0].length;
    const style=styleAt(start);
    let left=start;
    while(left>0&&(text[left-1]===' '||text[left-1]==='\t')) left--;
    let dashStart=left;
    while(dashStart>0&&text[dashStart-1]==='-') dashStart--;
    let dashCount=left-dashStart;
    if(style==='') {
      // Soft hyphens are deleted by normalization but remain a dash-shaped opener.
      let before=starts[start]-1;
      while(before>=0&&(input[before]===' '||input[before]==='\t'||/\p{Default_Ignorable_Code_Point}/u.test(input[before]))) {
        if(input[before]==='\u00ad') dashCount++;
        before--;
      }
      if(!dashCount) continue;
    }
    const keyEnd=start+match[0].lastIndexOf('KEY')+3;
    if(!/^-+$/.test(style??'')&&/[A-Z0-9_]/.test(text[keyEnd]??'')) continue;
    const labelSeparators=match[0].slice(match[0].indexOf('PRIVATE')+7,match[0].lastIndexOf('KEY'));
    if(style===''&&/[:/]/.test(labelSeparators)) continue;
    while(text[end]==='-') end++;
    labelEnd.lastIndex=end;
    controls.push({kind:match[1],start:starts[start],end:ends[end-1],headerEnd:ends[start+match[0].length-1],style,dashCount,terminal:labelEnd.test(text),normalizedStart:start,normalizedEnd:start+match[0].length});
  }
  // Index line boundaries and body lines once; later labels advance monotonically.
  const lineStarts=[0],breaks=/\r\n|\n|\\R\\N|\\N/g;
  for(const hit of text.matchAll(breaks)) lineStarts.push(hit.index+hit[0].length);
  const bodyLines=[],armorBodyLines=[],strongArmorBodyLines=[];
  for(let i=0;i<lineStarts.length;i++) {
    const end=i+1<lineStarts.length?lineStarts[i+1]:text.length;
    const body=/^[ \t>]*(?:(?:#|\/\/)[ \t]*)?([A-Z0-9+/]{16,}={0,2})[ \t]*(?:\r?\n|\\R\\N|\\N|$)/.exec(text.slice(lineStarts[i],end));
    if(body) {
      armorBodyLines.push(i);
      // A bare 40/64-character hex string is a Git/SHA ID, not key evidence.
      if(!/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/i.test(body[1])) strongArmorBodyLines.push(i);
      if(body[1].length>=40&&!/^[A-F0-9]+$/.test(body[1])) bodyLines.push(i);
    }
  }
  let controlLine=0,armorBody=0,strongBody=0;
  controls=controls.filter(marker=>{
    while(controlLine+1<lineStarts.length&&lineStarts[controlLine+1]<=marker.normalizedEnd) controlLine++;
    while(armorBody<armorBodyLines.length&&armorBodyLines[armorBody]<=controlLine) armorBody++;
    while(strongBody<strongArmorBodyLines.length&&strongArmorBodyLines[strongBody]<=controlLine) strongBody++;
    // Only a label that ends its line (a canonical banner shape) may rely on a hex body.
    const lines=marker.terminal?armorBodyLines:strongArmorBodyLines,at=marker.terminal?armorBody:strongBody;
    const hasBody=at<lines.length&&lines[at]<=controlLine+2;
    return marker.kind!=='BEGIN'||((marker.dashCount>=3||hasBody)&&(/^-+$/.test(marker.style??'')||marker.terminal||hasBody));
  });
  const bodyMarkers=[];let line=0,labelLine=0,body=0,control=0;
  for(const match of text.matchAll(label)) {
    while(control<controls.length&&controls[control].normalizedEnd<=match.index) control++;
    if(control<controls.length&&controls[control].kind==='BEGIN'&&controls[control].normalizedStart<=match.index) continue;
    while(labelLine+1<lineStarts.length&&lineStarts[labelLine+1]<=match.index) labelLine++;
    if(!/^[ \t]*(?:(?:\/\/|[#*>"'])[ \t]*)*$/.test(text.slice(lineStarts[labelLine],match.index))) continue;
    labelEnd.lastIndex=match.index+match[0].length;
    if(!labelEnd.test(text)) continue;
    while(line+1<lineStarts.length&&lineStarts[line+1]<=match.index+match[0].length) line++;
    while(body<bodyLines.length&&bodyLines[body]<=line) body++;
    if(body<bodyLines.length&&bodyLines[body]<=line+2) bodyMarkers.push({kind:'BEGIN',start:starts[match.index],end:ends[match.index+match[0].length-1],style:null,normalizedStart:match.index});
  }
  const markers=[];let i=0,j=0;
  while(i<controls.length||j<bodyMarkers.length) {
    if(j===bodyMarkers.length||(i<controls.length&&controls[i].normalizedStart<=bodyMarkers[j].normalizedStart)) markers.push(controls[i++]);
    else markers.push(bodyMarkers[j++]);
  }
  return markers;
}
// Scan each control's label once, stopping at a closing dash line or the next
// control. Failed labels never retry the same suffix for every KEY candidate.
function* armorMarkers(input) {
  // These dashes occupy one UTF-16 code unit, so marker offsets still index
  // the original text that callers redact.
  const original=input;
  input=input.replace(/[\p{Dash}\u02d7\u2043\u2796]/gu,char=>char.length===1?'-':char);
  // Raw controls are case-sensitive: hyphenated prose is not key armor.
  // normalizedKeyMarkers still handles canonical lowercase private-key labels.
  const control=/\s*(BEGIN|END)\b/y;
  const controlAt=start=>{
    control.lastIndex=start;
    const match=control.exec(input);
    return match?{kind:match[1].toUpperCase(),end:control.lastIndex}:null;
  };
  // Discover openers independently so parsing one marker cannot hide another.
  const controls=[];
  for(let cursor=0;cursor<input.length;) {
    const start=input.indexOf('-',cursor);
    if(start<0) break;
    const end=dashEnd(input,start),kind=controlAt(end);
    if(kind&&(input[kind.end]==='-'||/\s/.test(input[kind.end]??''))) controls.push({start,leftEnd:end,kind});
    cursor=end;
  }
  const closing=(from,width,limit,substring)=>{
    let cursor=from,hasKey=false,first=null;
    const keyLabel=substring?/(?:KEY|PRIVATE)/i:/\b(?:KEY|PRIVATE)\b/i;
    while(cursor<limit) {
      const start=input.indexOf('-',cursor);
      if(start<0||start>=limit) break;
      const text=input.slice(cursor,start);
      hasKey ||= keyLabel.test(text);
      const end=dashEnd(input,start),right=end-start;
      if(hasKey) {
        const candidate={start,end,right};
        first??=candidate;
        if(right===width) return {close:candidate};
      }
      // Interior hyphens may belong to a label. Prefer equal delimiters, but
      // retain the first permissive close when the marker is malformed.
      if(end===input.length||input[end]==='\n'||input.startsWith('\r\n',end)) return {close:first};
      cursor=end;
    }
    // A recognizable key label may be cut off before its closing dashes.
    hasKey ||= keyLabel.test(input.slice(cursor,limit));
    return {close:first??(hasKey?{start:limit,end:limit,right:0}:null)};
  };
  // A key label whose line is followed by a base64 (or PEM header) body line,
  // across a real or a JSON-escaped line break. Searches resume monotonically,
  // and the last line verdict is reused, so a long line stays linear.
  const keyWord=/(?:KEY|PRIVATE)/gi,keyWordWhole=/\b(?:KEY|PRIVATE)\b/gi,lineBreak=/\r?\n|\\(?:r\\)?n/g,bodyLine=/(?:[ \t>]*(?:(?:Comment|Version):[^\r\n\\]*|Bag Attributes[^\r\n\\]*)?(?:\r?\n|\\(?:r\\)?n)){0,3}[ \t>]*(?:[A-Za-z0-9+\/]{16,}={0,2}[ \t]*(?:\\[rn]|[\r\n]|$)|(?:Proc-Type|DEK-Info):)/iy;
  // The strong variant rejects a bare 40/64-character hex line (a commit ID).
  const strongBodyLine=new RegExp(bodyLine.source.replace('[ \\t>]*(?:[A-Za-z0-9+','[ \\t>]*(?:(?![0-9a-f]{40}(?:[0-9a-f]{24})?={0,2}[ \\t]*(?:\\\\[rn]|[\\r\\n]|$))[A-Za-z0-9+'),'iy');
  if(strongBodyLine.source===bodyLine.source) throw new Error('strong body-line pattern not derived');
  const bodyVerdict=pattern=>{
    const states = [0, 1].map(() => ({ lastBreak: -1, lastVerdict: false, nextKey: null, exhausted: false }));
    return (from,substring)=>{
      const state = states[substring ? 1 : 0];
      const search=substring?keyWord:keyWordWhole;
      // Callers advance from left to right. Reuse a future hit (or EOF)
      // instead of searching the same suffix again for every marker.
      if(!state.exhausted&&(!state.nextKey||state.nextKey.index<from)) {
        search.lastIndex=from;
        state.nextKey=search.exec(input);
        state.exhausted=!state.nextKey;
      }
      const key=state.nextKey;
      if(!key) return false;
      if(key.index>state.lastBreak) {
        lineBreak.lastIndex=key.index;
        const hit=lineBreak.exec(input);
        state.lastBreak=hit?hit.index:Infinity;
        pattern.lastIndex=lineBreak.lastIndex;
        state.lastVerdict=!!hit&&pattern.test(input);
      }
      return state.lastVerdict;
    };
  };
  const bodyAfterKey=bodyVerdict(bodyLine),strongBodyAfterKey=bodyVerdict(strongBodyLine);
  for(let i=0;i<controls.length;i++) {
    const {start,leftEnd,kind}=controls[i],left=leftEnd-start;
    const style=original.slice(start,leftEnd),substring=/^-+$/.test(style);
    const limit=controls[i+1]?.start??input.length;
    let parsed;
    if(input[kind.end]==='-'&&kind.end<limit) {
      const end=dashEnd(input,kind.end);
      parsed={close:{start:kind.end,end,right:end-kind.end}};
    } else parsed=closing(kind.end,left,limit,substring);
    if(!parsed.close) continue;
    const {end,right}=parsed.close;
    const name=input.slice(kind.end,parsed.close.start).trim().replace(/\s+/g,' ').toUpperCase();
    if(!substring&&!/^(?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP|ED25519|SSH2(?:[ _-]+ENCRYPTED)?)[ _-]+)?PRIVATE[ _-]+KEY$/.test(name)&&!(/\b(?:KEY|PRIVATE)\b/.test(name)&&strongBodyAfterKey(kind.end,false))) continue;
    // Five or more dashes are an unmistakable delimiter. A shorter run is armor
    // when it stands alone (no glued word, equal closing run, bare label) or when
    // a key label is followed by a base64 body line, however the run is glued,
    // paired or punctuated. Hyphenated prose such as "front-end private API" and
    // markdown "- End one: ..." bullets are neither.
    if(left<5) {
      const bare=!/\w/.test(input[start-1]??'')&&right===left&&/^[\w\s\/+-]*$/.test(input.slice(kind.end,parsed.close.start));
      const keyLabel=substring?/(?:KEY|PRIVATE)/:/\b(?:KEY|PRIVATE)\b/;
      const canonical=/^(?:(?:RSA|DSA|EC|OPENSSH|ENCRYPTED|PGP|ED25519|SSH2(?:[ _-]+ENCRYPTED)?)[ _-]+)?PRIVATE[ _-]+KEY$/.test(name);
      const hasBody=substring||canonical?bodyAfterKey:strongBodyAfterKey;
      if(!bare&&!(keyLabel.test(name)&&hasBody(kind.end,substring))) continue;
    }
    if(substring?/(?:KEY|PRIVATE)/.test(name):/\b(?:KEY|PRIVATE)\b/.test(name)) yield {start,end,left,right,kind:kind.kind,name,style,closeStyle:original.slice(parsed.close.start,end)};
  }
}

// Original main-branch armor scanner, retained for main-parity.
function* legacyArmorMarkers(input) {
  // Match raw controls like armorMarkers; do not reopen lowercase prose spans.
  const control=/\s*(BEGIN|END)\b/y;
  const controlAt=start=>{
    control.lastIndex=start;
    const match=control.exec(input);
    return match?{kind:match[1].toUpperCase(),end:control.lastIndex}:null;
  };
  const closing=(from,width)=>{
    let cursor=from,hasKey=false,first=null;
    while(cursor<input.length) {
      const start=input.indexOf('-',cursor);
      if(start<0) break;
      const text=input.slice(cursor,start);
      hasKey ||= /KEY|PRIVATE/i.test(text);
      const end=dashEnd(input,start),right=end-start;
      if(hasKey) {
        const candidate={start,end,right};
        first??=candidate;
        if(right===width) return {close:candidate};
      }
      // Interior hyphens may belong to a label. Prefer equal delimiters, but
      // retain the first permissive close when the marker is malformed.
      if(end===input.length||input[end]==='\n'||input.startsWith('\r\n',end)||controlAt(end)) return {close:first,resume:start};
      cursor=end;
    }
    // A recognizable key label may be cut off before its closing dashes.
    hasKey ||= /KEY|PRIVATE/i.test(input.slice(cursor));
    return {close:first??(hasKey?{start:input.length,end:input.length,right:0}:null),resume:input.length};
  };
  let cursor=0;
  while(cursor<input.length) {
    const start=input.indexOf('-',cursor);
    if(start<0) return;
    const leftEnd=dashEnd(input,start),left=leftEnd-start,kind=controlAt(leftEnd);
    if(!kind||!(input[kind.end]==='-'||/\s/.test(input[kind.end]??''))) {cursor=leftEnd;continue;}
    let parsed;
    if(input[kind.end]==='-') {
      const end=dashEnd(input,kind.end);
      parsed={close:{start:kind.end,end,right:end-kind.end}};
    } else parsed=closing(kind.end,left);
    if(!parsed.close) {cursor=parsed.resume;continue;}
    const {end,right}=parsed.close;
    const name=input.slice(kind.end,parsed.close.start).trim().replace(/\s+/g,' ').toUpperCase();
    if(/KEY|PRIVATE/.test(name)) yield {start,end,left,right,kind:kind.kind,name};
    cursor=end;
  }
}

// Callers share a .test interface; neither detection path reintroduces the
// unbounded armor expression during admission or the final output pass.
export const privateKeyHeader=Object.freeze({test(value) {
  const input=String(value);
  for(const marker of normalizedKeyMarkers(input)) if(marker.kind==='BEGIN'||marker.kind==='OVERFLOW') return true;
  for(const marker of armorMarkers(input)) if(marker.kind==='BEGIN') return true;
  for(const marker of legacyArmorMarkers(input)) if(marker.kind==='BEGIN') return true;
  return false;
}});
export const secretContent=Object.freeze({test(value) {return knownSecretRanges(String(value)).length>0||privateKeyHeader.test(value)||tokenContent.test(value);}});

// Intake refuses only known values and strong formats (armor, PEM bodies, token families, URL userinfo).
// Inspect actual string values: JSON serialization hides marker line breaks.
// Past the depth cap or on a cycle the value cannot be inspected, so fail closed.
const MAX_DEPTH=100;
export function hasSecretContent(value,depth=0,seen=new WeakSet()) {
  if(typeof value==='string') return secretContent.test(value)||pemBodyRanges(value).next().done===false;
  if(value&&typeof value==='object') {
    if(depth>MAX_DEPTH||seen.has(value)) return true;
    seen.add(value);
    const found=Object.entries(value).some(([key,item])=>secretContent.test(key)||hasSecretContent(item,depth+1,seen));
    seen.delete(value);
    return found;
  }
  return false;
}

// A PEM body with its BEGIN line cut off: two or more full-width (64 or 76)
// base64 lines followed by a short tail line, or base64 lines directly above
// an END ... KEY footer. Long unwrapped base64 and code are not matched.
export function* pemBodyRanges(text) {
  // A JSON-escaped newline (a literal backslash-n) also ends a line, so an escaped key body is found too.
  // Quoting around a line (a JSON string) is not part of the body: the line is the base64 run inside it. `=` is not a
  // delimiter here, because base64 padding ends a body.
  const lines=[...String(text).matchAll(/(?:(?!\\[rn])(?<!\\)[^\r\n\u2028\u2029])+/g)].map(m=>{
    const run=/^(.*?[\s"'`:,([{])??([A-Za-z0-9+/=]+)([\s"'`,)\]}]*(?:["'`]\s*:\s*[\w.+-]*[\s"'`,)\]}]*)?)$/s.exec(m[0]);
    if(!run) return {start:m.index,end:m.index+m[0].length,text:m[0].trim()};
    const start=m.index+(run[1]?.length??0);
    return {start,end:start+run[2].length,text:run[2]};
  });
  const b64=line=>line&&/^[A-Za-z0-9+/]+={0,2}$/.test(line.text)&&!/^[a-f0-9]+$/i.test(line.text);
  const full=line=>b64(line)&&(line.text.length===64||line.text.length===76);
  const footer=line=>line&&/^-*\s*END\b[^\r\n]*KEY/i.test(line.text);
  const covered=new Set();
  const emit=(from,to)=>{for(let i=from;i<=to;i++) covered.add(i);};
  for(let i=0;i<lines.length;) {
    if(!full(lines[i])) {i++;continue;}
    let j=i;
    while(full(lines[j+1])&&lines[j+1].text.length===lines[i].text.length) j++;
    if(j>i||footer(lines[j+1])) emit(i,j+(b64(lines[j+1])&&lines[j+1].text.length<lines[i].text.length?1:0));
    i=j+1;
  }
  for(let i=0;i<lines.length;i++) {
    if(!footer(lines[i+1])||!b64(lines[i])) continue;
    let k=i;
    while(b64(lines[k-1])) k--;
    emit(k,i);
  }
  for(const i of [...covered].sort((a,b)=>a-b)) yield {start:lines[i].start,end:lines[i].end};
}

// Each scanner produces ordered ranges. Keep their matching state independent:
// main's scanner closes by label and width; the newer scanner also tracks style.
function* markerMaskRanges(input,markers,legacy) {
  const lines=[],opens=new Map();
  let lineStart=0,lineEnd=input.indexOf('\n');
  const lineAt=position=>{
    while(lineEnd>=0&&lineEnd<position) {lineStart=lineEnd+1;lineEnd=input.indexOf('\n',lineStart);}
    return {start:lineStart,end:lineEnd<0?input.length:lineEnd};
  };
  for(const marker of markers) {
    const startLine=lineAt(marker.start),endLine=lineAt(marker.end);
    let bucket=lines.at(-1);
    if(bucket?.start!==startLine.start) {bucket={start:startLine.start,wholeEnd:0,ranges:[]};lines.push(bucket);}
    const matched=legacy?marker.left===marker.right:
      marker.left===marker.right&&marker.style===marker.closeStyle&&/^[-\u2010-\u2015\u2212]+$/u.test(marker.style);
    const key=matched?`${legacy?marker.left:marker.style}:${marker.name}`:null;
    if(marker.kind==='BEGIN') {
      const range={start:marker.start,end:input.length};bucket.ranges.push(range);
      if(key!==null) (opens.get(key)??opens.set(key,[]).get(key)).push(range);
    } else {
      const range=opens.get(key)?.pop();
      if(range) range.end=marker.end;
      else bucket.wholeEnd=Math.max(bucket.wholeEnd,endLine.end);
    }
  }
  for(const bucket of lines) {
    if(bucket.wholeEnd) yield {start:bucket.start,end:bucket.wholeEnd};
    yield* bucket.ranges;
  }
}

// Exposes the exact armor spans for parity checks without parsing masked text.
export function* armorMaskRanges(value,includeTokens=false) {
  const input=String(value),normalizedRanges=[],normalizedOpens=[];
  for(const marker of normalizedKeyMarkers(input)) {
    if(marker.kind==='OVERFLOW') {yield {start:0,end:input.length};return;}
    if(marker.kind==='BEGIN') {
      const range={start:marker.start,end:input.length,headerEnd:marker.headerEnd??marker.end,style:marker.style};
      normalizedRanges.push(range);normalizedOpens.push(range);
    } else {
      const range=normalizedOpens.at(-1);
      if(range&&range.style!==null&&range.style===marker.style&&marker.start>=range.headerEnd) {normalizedOpens.pop();range.end=marker.end;}
    }
  }
  const streams=[markerMaskRanges(input,armorMarkers(input),false),markerMaskRanges(input,legacyArmorMarkers(input),true),normalizedRanges[Symbol.iterator]()];
  if(includeTokens) streams.push((function*(){for(const match of input.matchAll(new RegExp(tokenContent.source,'gi'))) yield {start:match.index,end:match.index+match[0].length};})(),knownSecretRanges(input)[Symbol.iterator]());
  const heads=streams.map(stream=>stream.next());
  let pending;
  while(true) {
    let first=-1;
    for(let i=0;i<heads.length;i++) if(!heads[i].done&&(first<0||heads[i].value.start<heads[first].value.start)) first=i;
    if(first<0) break;
    const {start,end}=heads[first].value;
    heads[first]=streams[first].next();
    if(end<=start) continue;
    if(pending&&start<=pending.end) pending.end=Math.max(pending.end,end);
    else {if(pending) yield pending;pending={start,end};}
  }
  if(pending) yield pending;
}

export function redactSecrets(value) {
  let redacted=0;
  const input=String(value),chunks=[];let cursor=0;
  const ranges=[...armorMaskRanges(input,true),...pemBodyRanges(input)].sort((a,b)=>a.start-b.start);
  for(const {start,end} of ranges) {
    if(end<=cursor) continue;
    chunks.push(input.slice(cursor,Math.max(cursor,start)),'[redacted secret]'+input.slice(start,end).replace(/[^\n]/g,''));cursor=end;redacted++;
  }
  chunks.push(input.slice(cursor));
  return {text:chunks.join(''),redacted};
}

export function redactOutput(value,depth=0,seen=new WeakSet()) {
  if(typeof value==='string') return maskText(value);
  if(value&&typeof value==='object') {
    if(depth>MAX_DEPTH) return '[depth]';
    if(seen.has(value)) return '[circular]';
    seen.add(value);
    try {return redactContainer(value,depth,seen);} finally {seen.delete(value);}
  }
  return value;
}

function redactContainer(value,depth,seen) {
  if(Array.isArray(value)) {
    const entries=value.map((item,i)=>[i,redactOutput(item,depth+1,seen),false]);
    return splitSiblings(value,entries).map(([,clean])=>clean);
  }
  // Admission refuses a secret held in a property name, so the output pass
  // must not return one either. Masked names stay distinct so no value is lost.
  const names=new Set(),nextSuffix=new Map(),entries=[],raws=[];
  for(const [key,item] of Object.entries(value)) {
    const base=maskText(key);
    let name=base;
    let n=nextSuffix.get(base)??2;
    while(names.has(name)) name=`${base} (${n++})`;
    nextSuffix.set(base,n);
    names.add(name);
    raws.push(item);
    entries.push([name,redactEntry(value,key,item,depth,seen),false]);
  }
  return Object.fromEntries(splitSiblings(raws,entries).map(([name,clean])=>[name,clean]));
}

const MAX_TEXT = 16384;
// Field names. Exact identifier fields pass; a credential name is an exact key or a delimiter-bounded suffix.
// No substring rule: `code`, `encode`, `author`, `token_count` and `idempotency_key` are not credential names.
const correlationFields = new Set(['request_id', 'worker', 'call_id', 'claim_id', 'event_id', 'message_id', 'subscription_id']);
const safeStructuredFields = new Set(['request_id', 'worker', 'kind', 'count', 'status', 'call_id', 'subject', 'tool', 'at']);
const nonSecretKeyFields = new Set(['idempotency_key', 'cache_key', 'public_key', 'sort_key', 'dedupe_key', 'group_key', 'request_ids']);
const credentialKeys = new Set(['auth', 'authorization', 'proxy_authorization', 'cookie', 'cookies', 'set_cookie', 'credential', 'credentials',
  'password', 'passwd', 'pwd', 'pass', 'passphrase', 'passcode', 'secret', 'token', 'otp', 'jwt', 'bearer', 'session', 'refresh', 'signature',
  'apikey', 'code_verifier', 'auth_code', 'authorization_code']);
const credentialSuffix = /(?:^|_)(?:tokens?|secrets?|passwords?|passwd|api_?key|private_?key|access_?key|secret_?key|signing_?key|encryption_?key|credentials?|cookies?)$/;
const fieldName = key => String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[-.]/g, '_');
const isSafeField = key => {
  const name = fieldName(key);
  return correlationFields.has(name) || safeStructuredFields.has(name) || nonSecretKeyFields.has(name);
};
// A field name that marks its value as a credential, whatever the value looks like.
export function isCredentialField(key) {
  const name = fieldName(key);
  return !isSafeField(key) && (credentialKeys.has(name) || credentialSuffix.test(name));
}

// Values that are code or prose about a credential, not a credential: literals, numbers, placeholders, masks.
const placeholder = /^(?:|true|false|yes|no|on|off|null|undefined|none|nil|-?\d+(?:\.\d+)?|\[redacted.*|\$\{?[\w.]+\}?|\{\{[^{}]*\}\}|%\w|process\.env[\w.]*|<[^<>]*>|\.{3}|…|\*+|x+)$/i;
// A labelled value in free text needs 3 characters; a header value or a credential-named field is masked whatever its length.
const realValue = (raw, min = 3) => {
  const value = String(raw).trim().replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/^(?:Bearer|Basic|Token)\s+/i, '').trim();
  return value.length >= min && !placeholder.test(value);
};
// A value under a credential-named field is explicit: no prose placeholder exemption applies, so a numeric password or
// one-time code is masked. Only an empty value or an existing mask passes.
const explicitValue = raw => { const value = String(raw).trim(); return value.length > 0 && !value.startsWith('[redacted'); };
const cookieAttributes = /^(?:path|domain|expires|max-age|samesite|secure|httponly|priority|partitioned)$/i;
const realCookie = raw => {
  const parts = String(raw).trim().replace(/^["']|["']\s*[}\]]*\s*$/g, '').split(';').map(part => part.trim()).filter(Boolean);
  return parts.some((part, i) => {
    const eq = part.indexOf('=');
    if (eq < 0) return i === 0 && realValue(part, 1);
    return !cookieAttributes.test(part.slice(0, eq).trim()) && realValue(part.slice(eq + 1), 1);
  });
};

// Known values: every credential the process holds, with the encoded forms it can appear in (GitHub runner, Buildkite,
// Jenkins). Raw values need at least 6 characters, derived forms 3; literals such as `true` are never registered.
const knownSecrets = new Set();
const registeredValues = new Set();
let knownPattern = null;
const base64At = (bytes, offset) => {
  const text = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64').replace(/=+$/, '');
  return text.slice(Math.ceil(offset * 8 / 6), Math.floor((offset + bytes.length) * 8 / 6));
};
export function registerSecret(value) {
  const raw = String(value ?? '');
  // Explicit registration has no placeholder exemption beyond literals that occur everywhere in text.
  if (raw.trim().length < 6 || /^(?:true|false|null|undefined)$/i.test(raw.trim())) return;
  registeredValues.add(raw);
  const forms = [raw, ...raw.split(/\r?\n/).map(line => line.trim()).filter(line => line.length >= 6)];
  const bytes = Buffer.from(raw);
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  forms.push(hex.map(h => `%${h}`).join(''), hex.map(h => `%${h.toUpperCase()}`).join(''), encodeURIComponent(raw), JSON.stringify(raw).slice(1, -1), raw.replaceAll("'", `'\\''`), raw.replace(/[^\w@%+=:,./-]/g, '\\$&'));
  for (const offset of [0, 1, 2]) forms.push(base64At(bytes, offset), base64At(bytes, offset).replaceAll('+', '-').replaceAll('/', '_'));
  const before = knownSecrets.size;
  for (const form of forms) if (form.length >= 3) knownSecrets.add(form);
  if (knownSecrets.size === before) return;
  // Longest first, so an encoded form that contains a shorter one is masked whole.
  knownPattern = new RegExp([...knownSecrets].sort((a, b) => b.length - a.length).map(form => form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
}
// A worker thread starts with its own module state; pass it these values so it masks and refuses the same secrets.
export const registeredSecrets = () => [...registeredValues];
function knownSecretRanges(input) {
  if (!knownPattern) return [];
  return [...input.matchAll(knownPattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}
// Credential-named environment values are known at load time (Buildkite `*_TOKEN`-style anchored names).
for (const [name, value] of Object.entries(process.env)) {
  if (/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)$/i.test(name)) registerSecret(value);
}

// Credential labels and headers in free text, matched by the same anchored field-name rule, plus the Bearer and Basic
// header shapes (Sentry Relay, GIT_TRACE_REDACT). A placeholder value is left alone.
const headerText = /((?:^|[^A-Za-z0-9_.-])(?:proxy-authorization|authorization|set-cookie|cookie))(["']?\s*:\s*)([^\r\n]*)/ig;
const labelText = /(^|[^A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|<[^<>\n]*>|(?:Bearer|Basic|Token)\s+[^\s,;"'&]+|[^\s,;"'&]+)/g;
const headerName = /^(?:proxy-authorization|authorization|set-cookie|cookie)$/i;
const bearerText = /\b(Bearer\s+)(?!\[redacted)([A-Za-z0-9._~+/=-]{16,})/gi;
const basicText = /\b(Basic\s+)([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/g;
export function maskCredentialFields(text) {
  return String(text)
    .replace(headerText, (match, key, _separator, value) => {
      const cookie = /cookie$/i.test(key);
      return (cookie ? realCookie(value) : realValue(value, 1)) ? `${key}=[redacted secret]` : match;
    })
    // Header names were judged by the header rule, which reads the whole header value.
    .replace(labelText, (match, prefix, key, _separator, value) => !headerName.test(key) && isCredentialField(key) && realValue(value) ? `${prefix}${key}=[redacted secret]` : match)
    .replace(bearerText, '$1[redacted secret]')
    .replace(basicText, '$1[redacted secret]');
}
// Medium-precision hits (labels, headers, Bearer) are masked at every sink; intake only warns about them.
export function hasCredentialFieldText(text) {
  return maskCredentialFields(text) !== String(text);
}
export function hasCredentialHints(value, depth = 0) {
  if (typeof value === 'string') return hasCredentialFieldText(value);
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return false;
  return Object.entries(value).some(([key, item]) => (typeof item === 'string' && isCredentialField(key) && explicitValue(item)) || hasCredentialHints(item, depth + 1));
}

// The text core every sink shares: known values, strong formats, then labelled values. JSON text first gets the
// structural split check, so a credential split across its fields or elements is masked like a structured one.
const maskCore = text => maskCredentialFields(redactSecrets(text).text);
export const maskText = text => maskCore(splitSafeJson(text) ?? String(text));

// A credential may be split across sibling strings ("Bearer" / value, "password=" / value). If scanning the
// siblings joined masks more than scanning each alone, none of them can be trusted.
function splitSiblings(raws, cleaned) {
  const at = raws.flatMap((item, i) => typeof item === 'string' && !cleaned[i][2] ? [i] : []);
  if (at.length < 2) return cleaned;
  const texts = at.map(i => raws[i]);
  const kept = text => text.replaceAll('[redacted secret]', '').length;
  // Join the pieces after each is masked on its own: a secret that is complete in one piece is already a mask and
  // cannot absorb its neighbour, so only a secret that needs two pieces is found.
  const masked = texts.map(maskCore), remasked = masked.map(maskCore);
  if (!['', ' ', '='].some(glue => kept(maskCore(masked.join(glue))) < kept(remasked.join(glue)))) return cleaned;
  for (const i of at) cleaned[i][1] = '[redacted secret]';
  return cleaned;
}

// Known values, armor and PEM bodies (armorMaskRanges), a dashless armor header, and base64 lines that continue a
// masked block. No long-run, entropy or decode-and-withhold rules: mature redactors document those as the main source
// of false positives.
function logTextRanges(text, armor = true) {
  const ranges = armor ? [...armorMaskRanges(text, true), ...pemBodyRanges(text)] : [];
  const dashless = /(?:^|\n)BEGIN[ \t]+PRIVATE[ \t]+KEY[ \t]*\r?\n[A-Za-z0-9+/]{16,}={0,2}/i.exec(text);
  if (dashless) ranges.push({ start: dashless.index, end: text.length });
  if (armor) {
    const lines = [...text.matchAll(/[^\r\n\u2028\u2029]+/g)];
    const masked = lines.map(line => ranges.some(range => range.start < line.index + line[0].length && range.end > line.index));
    const footer = line => /END[^\r\n]*KEY/i.test(line?.[0] ?? '');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^[ \t]*[A-Za-z0-9+/]{4,}={0,2}[ \t]*$/.test(line[0]) &&
          (masked[i - 1] || masked[i + 1] || footer(lines[i + 1]))) {
        ranges.push({ start: line.index, end: line.index + line[0].length });
      }
    }
  }
  return ranges;
}

function redactLogText(value, keywords = true, armor = true) {
  // Mask the whole input, then clip: a token or quoted value crossing the cutoff cannot leak a prefix.
  const ranges = logTextRanges(value, armor).sort((a, b) => a.start - b.start);
  const chunks = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (end <= cursor) continue;
    chunks.push(value.slice(cursor, Math.max(cursor, start)), '[redacted secret]');
    cursor = end;
  }
  chunks.push(value.slice(cursor));
  const text = keywords ? maskCredentialFields(chunks.join('')) : chunks.join('');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…[truncated]' : text;
}

// Redact credential-bearing field values even when their contents are opaque.
export function redactLogEntry(value, seen = new WeakSet(), depth = 0, idValue = false) {
  if (depth > 100) return '[depth]';
  if (typeof value === 'string') return redactLogText(splitSafeJson(value) ?? value);
  if (typeof value === 'function') return undefined;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return `[binary ${value.byteLength} bytes]`;
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    const output = Array.from(value, item => redactLogEntry(item, seen, depth + 1, idValue));
    if (Array.from(value).every(item => typeof item === 'string')) {
      // Empty joins catch material or markers split in the middle of a word;
      // newline joins preserve the shape of arrays containing separate lines.
      for (const separator of ['', '\n']) {
        if (value.reduce((total, item) => total + item.length + separator.length, 0) > MAX_TEXT) {
          seen.delete(value);
          return value.map(() => '[redacted secret]');
        }
        const joined = value.join(separator);
        const ranges = logTextRanges(joined);
        let start = 0;
        for (let i = 0; i < value.length; i++) {
          const end = start + value[i].length;
          if (ranges.some(range => range.start < end && range.end > start)) output[i] = '[redacted secret]';
          start = end + separator.length;
        }
      }
    }
    seen.delete(value);
    // A credential split across elements (['Bearer', value], ['password=', value]). Elements the join pass already
    // masked take no further part, so unrelated neighbours stay readable.
    if (idValue) return output;
    return splitSiblings(Array.from(value), output.map((clean, i) => [i, clean, clean === '[redacted secret]'])).map(([, clean]) => clean);
  }
  if (value && typeof value === 'object') {
    const raws = [], entries = [], names = new Set(), nextSuffix = new Map();
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function') continue;
      const base = redactLogText(key);
      let name = base, suffix = nextSuffix.get(base) ?? 2;
      while (names.has(name)) name = `${base} (${suffix++})`;
      nextSuffix.set(base, suffix);
      names.add(name);
      const normalized = key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
      let clean;
      if (correlationFields.has(normalized) || normalized === 'request_ids') clean = redactLogEntry(item, seen, depth + 1, true);
      else if (normalized === 'code') clean = typeof item === 'number' || (typeof item === 'string' && /^[A-Z0-9_]{1,40}$/.test(item)) ? (typeof item === 'string' ? redactLogText(item, false) : item) : '[redacted secret]';
      else if (safeStructuredFields.has(normalized)) clean = redactLogEntry(item, seen, depth + 1);
      else if (isCredentialField(key)) clean = '[redacted secret]';
      else clean = redactLogEntry(item, seen, depth + 1);
      raws.push(item);
      // Safe names skip only the name rule: their values still take part in the split check.
      entries.push([name, clean, clean === '[redacted secret]']);
    }
    seen.delete(value);
    return Object.fromEntries(splitSiblings(raws, entries).map(([name, clean]) => [name, clean]));
  }
  return value;
}

// JSON text bound for a sink: only the structural split check runs here, so ordinary JSON values (identifier keys,
// long base64 fields) pass unchanged; the text core then masks the serialized text.
function splitJson(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  const keys = Object.keys(value), raws = keys.map(key => value[key]);
  const entries = keys.map((key, i) => [key, splitJson(raws[i], depth + 1), false]);
  const out = Array.isArray(value) ? [] : {};
  for (const [key, clean] of splitSiblings(raws, entries)) out[key] = clean;
  return out;
}
// Strings that belong to one record: any that combine into a secret are masked; the others are returned unchanged.
export const splitFields = texts => splitSiblings(texts, texts.map((text, i) => [i, text, false])).map(([, clean]) => clean);
function splitSafeJson(value) {
  const text = String(value);
  if (!/^\s*[[{"]/.test(text)) return undefined;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!parsed || (typeof parsed !== 'object' && typeof parsed !== 'string')) return undefined;
  const cleaned = JSON.stringify(splitJson(parsed));
  // The text scans below read escape sequences literally. Serialized again, the parsed value spells every key and
  // string in its decoded form, so a secret written with a \u escape is found. Clean JSON keeps its own formatting.
  return cleaned === JSON.stringify(parsed) && maskCore(cleaned) === cleaned ? undefined : cleaned;
}

// Free text bound for an outside sink (alerts, owner reports, MCP error text).
export function redactSinkText(value) {
  const json = splitSafeJson(value);
  if (json !== undefined) value = json;
  // The armor scanner runs once, first, over the whole input, so its exact spans survive and nothing is clipped before
  // it is masked. The log pass then adds the encoding and label checks and clips.
  return redactLogText(redactSecrets(String(value)).text, true, false);
}

function redactEntry(value,key,item,depth,seen) {
  // A number under a credential name is masked like a string; plural `tokens` is a usage counter, not a credential.
  if((typeof item==='string'||(typeof item==='number'&&!/(?:^|_)tokens$/.test(fieldName(key))))&&isCredentialField(key)&&explicitValue(item)) return '[redacted secret]';
  // Old previews can start inside a PEM body and have no recognizable markers.
  // Only bridge-generated, versioned evidence can attest a complete scan.
  if(key==='diff_preview'&&typeof item==='string'&&value.output_redaction_version!==1) return '[legacy diff preview withheld; owner patch required]';
  if(key==='output_preview'&&typeof item==='string'&&value.output_redaction_version!==1&&value.evidence?.output_redaction_version!==1) return '[legacy check output withheld; owner artifact required]';
  return redactOutput(item,depth+1,seen);
}
