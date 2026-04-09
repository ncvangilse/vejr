import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(__dirname, 'tests/fixtures/vordingborg.json'), 'utf8'));
const lat = 55.008, lon = 11.9106;
const dLat = 6/111.32, dLon = 6/(111.32*Math.cos(lat*Math.PI/180));
const bbox = {s:lat-dLat, n:lat+dLat, w:lon-dLon, e:lon+dLon};
const out = [];
const log = s => out.push(s);

log('bbox: s='+bbox.s.toFixed(4)+' n='+bbox.n.toFixed(4)+' w='+bbox.w.toFixed(4)+' e='+bbox.e.toFixed(4));

const inBbox = pt => pt.lat>=bbox.s&&pt.lat<=bbox.n&&pt.lon>=bbox.w&&pt.lon<=bbox.e;
const ways = data.elements
  .filter(e=>e.type==='way'&&e.tags&&e.tags.natural==='coastline')
  .map(e=>e.geometry.map(g=>({lat:g.lat,lon:g.lon})));

const ptKey = pt => pt.lat.toFixed(5)+','+pt.lon.toFixed(5);
const index = new Map();
ways.forEach((w,i)=>{ const add=(pt,side)=>{const k=ptKey(pt);if(!index.has(k))index.set(k,[]);index.get(k).push({i,side});}; add(w[0],'start');add(w[w.length-1],'end'); });
const used=new Set(), chains=[];
for(let i=0;i<ways.length;i++){
  if(used.has(i))continue; used.add(i); let c=[...ways[i]];
  for(;;){const k=ptKey(c[c.length-1]);const m=(index.get(k)||[]).filter(m=>!used.has(m.i)&&m.side==='start');if(!m.length)break;used.add(m[0].i);c=c.concat(ways[m[0].i].slice(1));}
  for(;;){const k=ptKey(c[0]);const m=(index.get(k)||[]).filter(m=>!used.has(m.i)&&m.side==='end');if(!m.length)break;used.add(m[0].i);c=ways[m[0].i].slice(0,-1).concat(c);}
  chains.push(c);
}
log('\n=== '+chains.length+' chains after stitch ===');

const EPS = 1e-9, TOL = 1e-5;
function bboxSeg(p1, p2, box) {
  const dLa=p2.lat-p1.lat, dLo=p2.lon-p1.lon;
  const cands=[];
  const tryEdge=(t,la,lo)=>{if(t>EPS&&t<=1+EPS&&la>=box.s-EPS&&la<=box.n+EPS&&lo>=box.w-EPS&&lo<=box.e+EPS)cands.push({t,lat:Math.max(box.s,Math.min(box.n,la)),lon:Math.max(box.w,Math.min(box.e,lo))});};
  if(Math.abs(dLo)>EPS){const tE=(box.e-p1.lon)/dLo;tryEdge(tE,p1.lat+tE*dLa,box.e);const tW=(box.w-p1.lon)/dLo;tryEdge(tW,p1.lat+tW*dLa,box.w);}
  if(Math.abs(dLa)>EPS){const tN=(box.n-p1.lat)/dLa;tryEdge(tN,box.n,p1.lon+tN*dLo);const tS=(box.s-p1.lat)/dLa;tryEdge(tS,box.s,p1.lon+tS*dLo);}
  if(!cands.length)return null;
  cands.sort((a,b)=>a.t-b.t);
  return cands[0];
}
function findEntry(chain, box) {
  if(!inBbox(chain[0])) {
    for(let i=0;i<chain.length-1;i++){
      if(!inBbox(chain[i])&&inBbox(chain[i+1])){return bboxSeg(chain[i],chain[i+1],box)||chain[i+1];}
    }
    return null;
  }
  if(chain.length>=2){
    const S=1000,dLa=chain[0].lat-chain[1].lat,dLo=chain[0].lon-chain[1].lon;
    const c=bboxSeg(chain[0],{lat:chain[0].lat+S*dLa,lon:chain[0].lon+S*dLo},box);
    if(c)return c;
  }
  return chain[0];
}
function findExit(chain, box) {
  const last=chain[chain.length-1];
  if(!inBbox(last)) {
    for(let i=chain.length-1;i>0;i--){
      if(inBbox(chain[i-1])&&!inBbox(chain[i])){return bboxSeg(chain[i-1],chain[i],box)||chain[i-1];}
    }
    return null;
  }
  if(chain.length>=2){
    const n=chain.length,S=1000,dLa=chain[n-1].lat-chain[n-2].lat,dLo=chain[n-1].lon-chain[n-2].lon;
    const c=bboxSeg(last,{lat:last.lat+S*dLa,lon:last.lon+S*dLo},box);
    if(c)return c;
  }
  return last;
}
function snapToBbox(pt,box){
  const cL=la=>Math.max(box.s,Math.min(box.n,la));
  const cO=lo=>Math.max(box.w,Math.min(box.e,lo));
  const oLa=pt.lat>box.n||pt.lat<box.s,oLo=pt.lon>box.e||pt.lon<box.w;
  if(oLa&&!oLo)return{lat:pt.lat>box.n?box.n:box.s,lon:cO(pt.lon)};
  if(oLo&&!oLa)return{lat:cL(pt.lat),lon:pt.lon>box.e?box.e:box.w};
  const dE=Math.abs(pt.lon-box.e),dW=Math.abs(pt.lon-box.w),dN=Math.abs(pt.lat-box.n),dS=Math.abs(pt.lat-box.s);
  const m=Math.min(dE,dW,dN,dS);
  if(m===dN)return{lat:box.n,lon:cO(pt.lon)};if(m===dS)return{lat:box.s,lon:cO(pt.lon)};
  if(m===dE)return{lat:cL(pt.lat),lon:box.e};return{lat:cL(pt.lat),lon:box.w};
}
function cpos(pt,box){
  if(Math.abs(pt.lon-box.e)<TOL)return(box.n-pt.lat)/(box.n-box.s);
  if(Math.abs(pt.lat-box.s)<TOL)return 1+(box.e-pt.lon)/(box.e-box.w);
  if(Math.abs(pt.lon-box.w)<TOL)return 2+(pt.lat-box.s)/(box.n-box.s);
  return 3+(pt.lon-box.w)/(box.e-box.w);
}
function cwPath(from, to, box){
  const corners=[{lat:box.n,lon:box.e},{lat:box.s,lon:box.e},{lat:box.s,lon:box.w},{lat:box.n,lon:box.w}];
  const fS=snapToBbox(from,box),tS=snapToBbox(to,box);
  let fP=cpos(fS,box),oTP=cpos(tS,box),tP=oTP;
  if(tP<=fP){if(Math.floor(fP)===Math.floor(oTP))return[tS];tP+=4;}
  const cors=[];
  for(let ci=0;ci<4;ci++){let cp=ci;while(cp<=fP)cp+=4;if(cp<tP)cors.push({cp,pt:corners[ci]});}
  cors.sort((a,b)=>a.cp-b.cp);
  return [...cors.map(c=>c.pt),tS];
}

chains.forEach((c,i)=>{
  const h=c[0],t=c[c.length-1];
  const closed=Math.abs(h.lat-t.lat)<TOL&&Math.abs(h.lon-t.lon)<TOL;
  const hTag=inBbox(h)?'IN':'OUT',tTag=inBbox(t)?'IN':'OUT';
  if(closed){
    log('chain['+i+'] n='+c.length+' CLOSED head=('+h.lat.toFixed(4)+','+h.lon.toFixed(4)+')');
    return;
  }
  const entry=findEntry(c,bbox);
  const exit=findExit(c,bbox);
  const from=exit||snapToBbox(t,bbox);
  const to=entry||snapToBbox(h,bbox);
  const closure=cwPath(from,to,bbox);
  log('chain['+i+'] n='+c.length+
    ' head=('+h.lat.toFixed(4)+','+h.lon.toFixed(4)+')['+hTag+']'+
    ' tail=('+t.lat.toFixed(4)+','+t.lon.toFixed(4)+')['+tTag+']');
  log('  entry=('+to.lat.toFixed(4)+','+to.lon.toFixed(4)+')'+
    ' exit=('+from.lat.toFixed(4)+','+from.lon.toFixed(4)+')');
  log('  closure('+closure.length+'): '+closure.map(p=>'('+p.lat.toFixed(4)+','+p.lon.toFixed(4)+')').join(' → '));
});

const result = out.join('\n')+'\n';
writeFileSync(join(__dirname, 'diag2_out.txt'), result);
process.stdout.write(result);

