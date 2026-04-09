const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./tests/fixtures/vordingborg.json', 'utf8'));
const lat = 55.008, lon = 11.9106;
const dLat = 6/111.32, dLon = 6/(111.32*Math.cos(lat*Math.PI/180));
const bbox = {s:lat-dLat, n:lat+dLat, w:lon-dLon, e:lon+dLon};

const inBbox = pt => pt.lat>=bbox.s&&pt.lat<=bbox.n&&pt.lon>=bbox.w&&pt.lon<=bbox.e;
const ways = data.elements
  .filter(e=>e.type==='way'&&e.tags&&e.tags.natural==='coastline')
  .map(e=>e.geometry.map(g=>({lat:g.lat,lon:g.lon})));

const ptKey = pt => pt.lat.toFixed(5)+','+pt.lon.toFixed(5);
const index = new Map();
ways.forEach((w,i)=>{
  const add=(pt,side)=>{const k=ptKey(pt);if(!index.has(k))index.set(k,[]);index.get(k).push({i,side});};
  add(w[0],'start');
  add(w[w.length-1],'end');
});

const used=new Set(), chains=[];
for(let i=0;i<ways.length;i++){
  if(used.has(i))continue; used.add(i); let c=[...ways[i]];
  for(;;){const k=ptKey(c[c.length-1]);const m=(index.get(k)||[]).filter(m=>!used.has(m.i)&&m.side==='start');if(!m.length)break;used.add(m[0].i);c=c.concat(ways[m[0].i].slice(1));}
  for(;;){const k=ptKey(c[0]);const m=(index.get(k)||[]).filter(m=>!used.has(m.i)&&m.side==='end');if(!m.length)break;used.add(m[0].i);c=ways[m[0].i].slice(0,-1).concat(c);}
  chains.push(c);
}

const lines = [
  'bbox: '+JSON.stringify({s:+bbox.s.toFixed(4),n:+bbox.n.toFixed(4),w:+bbox.w.toFixed(4),e:+bbox.e.toFixed(4)}),
  'Ways: '+ways.length,
  'Chains after stitch: '+chains.length,
];
chains.forEach((c,i)=>{
  const h=c[0],t=c[c.length-1];
  const closed=Math.abs(h.lat-t.lat)<1e-5&&Math.abs(h.lon-t.lon)<1e-5;
  lines.push('chain'+i+' n='+c.length+(closed?' CLOSED':'')+
    ' head=('+h.lat.toFixed(4)+','+h.lon.toFixed(4)+')['+( inBbox(h)?'IN':'OUT')+']'+
    ' tail=('+t.lat.toFixed(4)+','+t.lon.toFixed(4)+')['+( inBbox(t)?'IN':'OUT')+']');
});

// Now also run the closure and check entry/exit for each open chain
function bboxSegmentCrossing(p1, p2, box) {
  const dLat=p2.lat-p1.lat, dLon=p2.lon-p1.lon, EPS=1e-9;
  const cands=[];
  const tryEdge=(t,la,lo)=>{if(t>EPS&&t<=1+EPS&&la>=box.s-EPS&&la<=box.n+EPS&&lo>=box.w-EPS&&lo<=box.e+EPS)cands.push({t,lat:Math.max(box.s,Math.min(box.n,la)),lon:Math.max(box.w,Math.min(box.e,lo))});};
  if(Math.abs(dLon)>EPS){const tE=(box.e-p1.lon)/dLon;tryEdge(tE,p1.lat+tE*dLat,box.e);const tW=(box.w-p1.lon)/dLon;tryEdge(tW,p1.lat+tW*dLat,box.w);}
  if(Math.abs(dLat)>EPS){const tN=(box.n-p1.lat)/dLat;tryEdge(tN,box.n,p1.lon+tN*dLon);const tS=(box.s-p1.lat)/dLat;tryEdge(tS,box.s,p1.lon+tS*dLon);}
  if(!cands.length)return null;
  cands.sort((a,b)=>a.t-b.t);
  return cands[0];
}

function findEntry(chain, box) {
  if(!inBbox(chain[0])) {
    for(let i=0;i<chain.length-1;i++){
      if(!inBbox(chain[i])&&inBbox(chain[i+1])){return bboxSegmentCrossing(chain[i],chain[i+1],box)||chain[i+1];}
    }
    return null;
  }
  // extrapolate backward
  if(chain.length>=2){
    const SCALE=1000;
    const dLa=chain[0].lat-chain[1].lat, dLo=chain[0].lon-chain[1].lon;
    const far={lat:chain[0].lat+SCALE*dLa,lon:chain[0].lon+SCALE*dLo};
    const c=bboxSegmentCrossing(chain[0],far,box);
    if(c)return c;
  }
  return chain[0];
}

function findExit(chain, box) {
  const last=chain[chain.length-1];
  if(!inBbox(last)) {
    for(let i=chain.length-1;i>0;i--){
      if(inBbox(chain[i-1])&&!inBbox(chain[i])){return bboxSegmentCrossing(chain[i-1],chain[i],box)||chain[i-1];}
    }
    return null;
  }
  // extrapolate forward
  if(chain.length>=2){
    const n=chain.length, SCALE=1000;
    const dLa=chain[n-1].lat-chain[n-2].lat, dLo=chain[n-1].lon-chain[n-2].lon;
    const far={lat:last.lat+SCALE*dLa,lon:last.lon+SCALE*dLo};
    const c=bboxSegmentCrossing(last,far,box);
    if(c)return c;
  }
  return last;
}

chains.forEach((c,i)=>{
  const h=c[0],t=c[c.length-1];
  const closed=Math.abs(h.lat-t.lat)<1e-5&&Math.abs(h.lon-t.lon)<1e-5;
  if(closed) return;
  const entry=findEntry(c,bbox);
  const exit=findExit(c,bbox);
  lines.push('  chain'+i+' entry='+(entry?'('+entry.lat.toFixed(4)+','+entry.lon.toFixed(4)+')':'NULL')+
    ' exit='+(exit?'('+exit.lat.toFixed(4)+','+exit.lon.toFixed(4)+')':'NULL'));
});

fs.writeFileSync('chain_debug.txt', lines.join('\n')+'\n');
console.log('Written chain_debug.txt');

