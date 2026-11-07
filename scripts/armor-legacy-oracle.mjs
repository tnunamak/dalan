function dashEnd(input,start) {
  let end=start+1;
  while(input[end]==='-') end++;
  return end;
}

// Scan each control's label once, stopping at a closing dash line or the next
// control. Failed labels never retry the same suffix for every KEY candidate.
function* armorMarkers(input) {
  const control=/\s*(BEGIN|END)\b/iy;
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

export function legacyKeyHeader(value) {
  for(const marker of armorMarkers(String(value))) if(marker.kind==='BEGIN') return true;
  return false;
}

export function legacyArmorRanges(value) {
  const input=String(value),lines=[],opens=new Map();
  let lineStart=0,lineEnd=input.indexOf('\n');
  const lineAt=position=>{
    while(lineEnd>=0&&lineEnd<position) {lineStart=lineEnd+1;lineEnd=input.indexOf('\n',lineStart);}
    return {start:lineStart,end:lineEnd<0?input.length:lineEnd};
  };
  for(const marker of armorMarkers(input)) {
    const startLine=lineAt(marker.start),endLine=lineAt(marker.end);
    let bucket=lines.at(-1);
    if(bucket?.start!==startLine.start) {bucket={start:startLine.start,wholeEnd:0,ranges:[]};lines.push(bucket);}
    const key=marker.left===marker.right?`${marker.left}:${marker.name}`:null;
    if(marker.kind==='BEGIN') {
      const range={start:marker.start,end:input.length};bucket.ranges.push(range);
      if(key!==null) (opens.get(key)??opens.set(key,[]).get(key)).push(range);
    } else {
      const range=opens.get(key)?.pop();
      if(range) range.end=marker.end;
      else bucket.wholeEnd=Math.max(bucket.wholeEnd,endLine.end);
    }
  }
  const ranges=[];let cursor=0;
  const append=(start,end)=>{
    if(end<=cursor) return;
    const maskedStart=Math.max(cursor,start);
    if(end>maskedStart) ranges.push({start:maskedStart,end});
    cursor=end;
  };
  for(const bucket of lines) {
    if(bucket.wholeEnd) append(bucket.start,bucket.wholeEnd);
    for(const range of bucket.ranges) append(range.start,range.end);
  }
  return ranges;
}

// Compare unions of source intervals; redaction placeholders do not preserve
// character offsets and therefore cannot serve as a span oracle.
export function assertLegacyCoverage(value,redaction) {
  const input=String(value),expected=legacyArmorRanges(input);
  if(legacyKeyHeader(input)&&!redaction.privateKeyHeader.test(input)) throw new Error('Legacy admission lost a key header');
  const union=ranges=>{
    const merged=[];
    for(const range of ranges) {
      if(range.end<=range.start) continue;
      const last=merged.at(-1);
      if(last&&range.start<=last.end) last.end=Math.max(last.end,range.end);
      else merged.push({start:range.start,end:range.end});
    }
    return merged;
  };
  const actual=union(redaction.armorMaskRanges(input));let i=0;
  for(const range of union(expected)) {
    while(i<actual.length&&actual[i].end<=range.start) i++;
    if(i===actual.length||actual[i].start>range.start||actual[i].end<range.end)
      throw new Error(`Legacy mask span ${range.start}:${range.end} was not covered`);
  }
}

export function legacyRedactArmor(value) {
  const input=String(value),ranges=legacyArmorRanges(input),chunks=[];let cursor=0;
  for(const {start,end} of ranges) {
    chunks.push(input.slice(cursor,start),'[redacted secret]'+input.slice(start,end).replace(/[^\n]/g,''));cursor=end;
  }
  chunks.push(input.slice(cursor));
  return {text:chunks.join(''),redacted:ranges.length};
}
