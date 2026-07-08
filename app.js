import { XF, xfeatInit, xfeatDetectDescribe } from './xfeat.js';

"use strict";
const S={imgs:[],seams:[],frames:null,result:null};
const $=s=>document.querySelector(s);
const tick=()=>new Promise(r=>setTimeout(r,0));

/* ---- controls ---- */
const res=$("#res"),feat=$("#feat");
res.oninput=()=>$("#oRes").textContent=res.value+" px";
const ovlEl=$("#ovl"); if(ovlEl)ovlEl.oninput=()=>$("#oOvl").textContent=ovlEl.value+"%";
feat.oninput=()=>$("#oFeat").textContent=feat.value;
const engineSel=$("#engine");
// The model is served from this app's own origin (models/xfeat.onnx) and cached by the
// service worker — no file picker needed. Selecting XFeat pre-initializes the runtime so
// the first stitch isn't slowed by GPU shader compilation.
let xfInitPromise=null;
function ensureXFeat(){
  if(!xfInitPromise){
    xfInitPromise=xfeatInit(msg=>banner("info","XFeat: "+msg))
      .then(be=>{ banner("info","XFeat ready on "+(be==="webgpu"?"GPU (WebGPU/Metal)":"CPU (WASM)")+"."); return be; })
      .catch(e=>{ xfInitPromise=null; banner("warn","XFeat init failed: "+(e&&e.message||e)+". You can still use ORB."); throw e; });
  }
  return xfInitPromise;
}
engineSel.addEventListener("change",()=>{ if(engineSel.value==="xfeat") ensureXFeat().catch(()=>{}); });
// NOTE: the model is loaded only here (file picker) or lazily at stitch time — never on a
// settings toggle, so changing engines can't trigger a network/WASM load or crash the tab.

/* ---- intake (inputs overlay their zones; no programmatic click) ---- */
const drop=$("#drop"),file=$("#file"),cap=$("#cap");
["dragenter","dragover"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();ev.stopPropagation();drop.classList.add("hot")}));
["dragleave","dragend"].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove("hot")}));
drop.addEventListener("drop",ev=>{ev.preventDefault();drop.classList.remove("hot");if(ev.dataTransfer&&ev.dataTransfer.files.length)addFiles(ev.dataTransfer.files);});
file.addEventListener("change",()=>{if(file.files&&file.files.length)addFiles(file.files);file.value="";});
cap.addEventListener("change",()=>{if(cap.files&&cap.files.length)addFiles(cap.files);cap.value="";});

async function addFiles(list){
  // accept by MIME or by extension (some pickers report empty type for jpeg/heic)
  const arr=[...list].filter(f=> (f.type&&f.type.startsWith("image/")) || /\.(jpe?g|png|webp|heic|heif|tiff?)$/i.test(f.name||""));
  if(!arr.length){ banner("warn","No image files in that selection. JPEG or PNG work best."); return; }
  const startCount=S.imgs.length;
  banner("info",`Decoding ${arr.length} image${arr.length>1?"s":""}…`);
  let failed=[];
  for(const f of arr){
    // No object URLs: the artifact sandbox proxies blob: to blob-request:// and <img> loads fail.
    // Decode from the File directly; fall back to a FileReader data URL; thumbnail is a small data URL.
    let el=null,w=0,h=0;
    // Preferred: createImageBitmap applies EXIF rotation ('from-image') so portrait JPEGs aren't sideways,
    // and decodes off the main thread. Fall back to <img src=dataURL> if unavailable or it throws.
    if("createImageBitmap" in window){
      try{ const bmp=await createImageBitmap(f,{imageOrientation:"from-image"}); el=bmp; w=bmp.width; h=bmp.height; }
      catch(_){ el=null; }
    }
    if(!el){
      try{ const durl=await fileToDataURL(f); const im=await loadImage(durl); el=im; w=im.naturalWidth; h=im.naturalHeight; }
      catch(_){ failed.push(f.name||"image"); continue; }
    }
    if(!w||!h){ failed.push(f.name||"image"); continue; }
    S.imgs.push({name:f.name||`frame ${S.imgs.length+1}`,url:makeThumb(el,w,h),w,h,el,included:true,forceKeep:false,exReason:null});
  }
  renderTray();
  const added=S.imgs.length-startCount;
  if(failed.length) banner("warn",`Added ${added}. Couldn’t read ${failed.length} file${failed.length>1?"s":""} (${failed.slice(0,3).join(", ")}${failed.length>3?"…":""}). If these are HEIC, re-export as JPEG.`);
  else banner("info",`Added ${added} image${added>1?"s":""}. Tap Stitch when ready.`);
}
function loadImage(url){return new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=()=>no(new Error("decode failed"));i.src=url;});}
function fileToDataURL(f){return new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=()=>no(new Error("read failed"));r.readAsDataURL(f);});}
// Small JPEG data URL for the tray thumbnail — sandbox-safe and far lighter than holding full-res strings.
function makeThumb(el,w,h,max=120){
  const sc=Math.min(1,max/Math.max(w,h)),tw=Math.max(1,Math.round(w*sc)),th=Math.max(1,Math.round(h*sc));
  const c=document.createElement("canvas");c.width=tw;c.height=th;
  c.getContext("2d").drawImage(el,0,0,tw,th);
  return c.toDataURL("image/jpeg",0.7);
}

function renderTray(){
  const t=$("#tray");t.innerHTML="";
  S.imgs.forEach((m,i)=>{
    const row=document.createElement("div");row.className="frame"+(m.included===false?" excluded":"");
    const badge=m.included===false?`<span class="exbadge">${m.exReason||"excluded"}</span>`:"";
    const keepBtn=m.included===false?`<button class="ib keep" data-keep title="Keep this frame">keep</button>`:"";
    row.innerHTML=`<div class="idx">${String(i+1).padStart(2,"0")}</div>
      <img src="${m.url}" alt=""><div class="meta"><div class="nm">${m.name}</div><div class="dim">${m.w}×${m.h}${badge}</div></div>
      <div class="ctl">${keepBtn}<button class="ib" data-up ${i===0?"disabled":""}>↑</button>
      <button class="ib" data-dn ${i===S.imgs.length-1?"disabled":""}>↓</button><button class="ib x" data-rm>✕</button></div>`;
    row.querySelector("[data-up]").onclick=()=>swap(i,i-1);
    row.querySelector("[data-dn]").onclick=()=>swap(i,i+1);
    row.querySelector("[data-rm]").onclick=()=>{S.imgs.splice(i,1);renderTray();};
    const kb=row.querySelector("[data-keep]");
    if(kb)kb.onclick=()=>{m.included=true;m.forceKeep=true;m.exReason=null;renderTray();};
    t.appendChild(row);
  });
  $("#count").textContent=S.imgs.length?`— ${S.imgs.length}`:"";
  $("#tools").style.display=S.imgs.length?"flex":"none";
  $("#run").disabled=S.imgs.filter(m=>m.included!==false).length<2;
}
function swap(a,b){if(b<0||b>=S.imgs.length)return;[S.imgs[a],S.imgs[b]]=[S.imgs[b],S.imgs[a]];renderTray();}
$("#btnRev").onclick=()=>{S.imgs.reverse();renderTray();};
$("#btnClear").onclick=()=>{S.imgs=[];renderTray();$("#result").innerHTML="";$("#banner").className="banner";$("#seams").innerHTML="";};
$("#btnOrder").onclick=()=>{S.imgs.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));renderTray();};

/* ================= feature-based registration (jsfeat) ================= */
// Detection is capped in resolution to bound memory (jsfeat needs a corner buffer
// sized to the pixel count). Output/compositing uses the full working resolution.
const DET_CAP=1400;                 // detection width — higher = more precise feature localization

/* ============================ XFeat neural backend ============================
   Detector-free-quality matching via XFeat (CVPR 2024), run on-device with
   onnxruntime-web (WASM). The ONNX graph is ONLY the CNN feature extractor;
   all matching/RANSAC/refinement stays in the JS pipeline already tested above.
   XFeat descriptors are learned + L2-normalized, so they're vastly more
   distinctive than ORB on low-texture rock — the direct fix for weak seams.

   Model: DavideCatto/XFeat-ONNX release V1.0.0 → xfeat.onnx (sparse extractor).
   The user loads the .onnx once (file picker); it's cached in IndexedDB so it's
   picked one time and works offline thereafter.
   ============================================================================ */
/* XFeat runtime moved to xfeat.js (WebGPU-first) */

let _cornBuf=null,_cornCap=0;       // reusable corner buffer across frames
function cornerBuffer(n){
  if(_cornCap<n){ _cornBuf=new Array(n); for(let i=0;i<n;i++)_cornBuf[i]=new jsfeat.keypoint_t(0,0,0,0); _cornCap=n; }
  return _cornBuf;
}
// Draw the frame at output width; also produce a detection-scale gray. Returns both plus ratio.
function toWorking(el,maxW,skipDetect){
  const iw=el.naturalWidth||el.width, ih=el.naturalHeight||el.height;
  const s=Math.min(1,maxW/iw);
  const w=Math.round(iw*s),h=Math.round(ih*s);
  const c=document.createElement("canvas");c.width=w;c.height=h;
  c.getContext("2d").drawImage(el,0,0,w,h);
  if(skipDetect){
    // XFeat path: it works on the color canvas and returns points already in working px,
    // so the jsfeat grayscale/blur detection matrices are pure waste (memory + time), and
    // ratio must be 1 (no detection→working rescale of the model's coordinates).
    return {canvas:c,w,h,blur:null,dw:w,dh:h,ratio:1};
  }
  // detection image (bounded)
  const ds=Math.min(1,DET_CAP/w);
  const dw=Math.max(2,Math.round(w*ds)),dh=Math.max(2,Math.round(h*ds));
  const dc=document.createElement("canvas");dc.width=dw;dc.height=dh;
  const dctx=dc.getContext("2d",{willReadFrequently:true});dctx.drawImage(el,0,0,dw,dh);
  const id=dctx.getImageData(0,0,dw,dh);
  const gray=new jsfeat.matrix_t(dw,dh,jsfeat.U8_t|jsfeat.C1_t);
  jsfeat.imgproc.grayscale(id.data,dw,dh,gray,jsfeat.COLOR_RGBA2GRAY);
  const blur=new jsfeat.matrix_t(dw,dh,jsfeat.U8_t|jsfeat.C1_t);
  jsfeat.imgproc.gaussian_blur(gray,blur,5,0);
  dc.width=dc.height=0;                           // release detection canvas backing store now
  return {canvas:c,w,h,blur,dw,dh,ratio:w/dw};   // ratio: output px per detection px
}
// returns {pts:[{x,y}], desc, count} — pts are plain snapshots (safe across buffer reuse)
// Corners are spatially bucketed (per-cell cap) so features cover the whole frame instead of
// clustering in one textured patch — a well-spread set conditions the similarity fit far better.
// FAST threshold adapts downward on weak texture until the budget is reasonably filled.
/* ---- tape / ruler suppression ----
   A measuring tape is a bright, desaturated, VERTICALLY-CONTINUOUS band — the worst feature
   source for vertical stitching, since it looks the same along its length and pins horizontal
   position while leaving the vertical (stitch) axis unconstrained, yielding confident-but-wrong
   matches. Detect the band per frame; return [x0,x1] (working px) to exclude, or null. */
function detectTapeBand(canvas){
  const w=canvas.width,h=canvas.height;
  const sw=Math.min(240,w), sh=Math.min(360,h);
  const c=document.createElement("canvas");c.width=sw;c.height=sh;
  const x=c.getContext("2d",{willReadFrequently:true});
  x.drawImage(canvas,0,0,sw,sh);
  const d=x.getImageData(0,0,sw,sh).data; c.width=c.height=0;
  const cont=new Float32Array(sw);
  for(let cx=0;cx<sw;cx++){ let n=0;
    for(let cy=0;cy<sh;cy++){ const o=(cy*sw+cx)*4, r=d[o],g=d[o+1],b=d[o+2];
      const mx=Math.max(r,g,b),mn=Math.min(r,g,b), val=mx/255, sat=mx>0?(mx-mn)/mx:0;
      if(val>0.60&&sat<0.22)n++; }
    cont[cx]=n/sh; }
  const half=4,sm=new Float32Array(sw);
  for(let i=0;i<sw;i++){let s=0,c2=0;for(let j=-half;j<=half;j++){const t=i+j;if(t>=0&&t<sw){s+=cont[t];c2++;}}sm[i]=s/c2;}
  // Sunlit gray rock and pale lichen are ALSO bright & desaturated — on such frames the raw
  // fraction is high everywhere and the tape hides in it (previously: band too wide → null →
  // masking silently OFF, exactly on the frames that need it most). A tape is a NARROW column
  // that stands OUT of its surroundings, so measure the peak above the median background.
  const srt=Array.from(sm).sort((a,b)=>a-b), bg=srt[sw>>1];
  let peak=0,xc=0;for(let i=0;i<sw;i++){const v=sm[i]-bg;if(v>peak){peak=v;xc=i;}}
  if(peak<0.22)return null;                                // nothing stands out → no tape
  let lo=xc;while(lo>0&&sm[lo]-bg>0.5*peak)lo--;
  let hi=xc;while(hi<sw-1&&sm[hi]-bg>0.5*peak)hi++;
  const margin=Math.round((hi-lo)*0.25)+Math.round(sw*0.008);
  lo=Math.max(0,lo-margin);hi=Math.min(sw-1,hi+margin);
  if((hi-lo)/sw>0.35)return null;                          // implausibly wide → not a tape
  const scale=w/sw;
  return {x0:lo*scale, x1:hi*scale};
}
// Drop features whose x falls inside the tape band. `sx` scales feature-x → working px
// (1 for XFeat, `ratio` for ORB). Never removes so many that <30% remain (safety).
function filterTapeFeatures(feat,band,sx){
  if(!band||!feat||!feat.count)return feat;
  const keep=[];
  for(let i=0;i<feat.count;i++){ const wx=feat.pts[i].x*sx;
    if(wx<band.x0||wx>band.x1)keep.push(i); }
  if(keep.length<feat.count*0.30)return feat;             // tape ~= whole frame? leave as-is
  const dim=feat.desc.dim||32, D=dim, K=keep.length;
  const pts=new Array(K);
  const isF=feat.desc.float;
  const data=isF?new Float32Array(K*D):new Uint8Array(K*D);
  for(let n=0;n<K;n++){ const i=keep[n]; pts[n]=feat.pts[i];
    for(let c=0;c<D;c++)data[n*D+c]=feat.desc.data[i*D+c]; }
  const desc={data,dim:D,float:isF,absGate:feat.desc.absGate,guidedGate:feat.desc.guidedGate};
  return {pts,desc,count:K};
}
function detectDescribe(mat,maxc,startTh=15){
  const w=mat.cols,h=mat.rows;
  const corners=cornerBuffer(w*h);
  let count=0,th=startTh;
  for(;;){
    jsfeat.fast_corners.set_threshold(th);
    count=jsfeat.fast_corners.detect(mat,corners,7);
    if(count>=maxc*0.5||th<=6)break;
    th=Math.max(6,th-3);
  }
  const idx=[];for(let i=0;i<count;i++)idx.push(i);
  idx.sort((a,b)=>corners[b].score-corners[a].score);
  // spatial bucketing: strongest-first, capped per 32px cell
  const CELL=32,gw=Math.ceil(w/CELL),gh=Math.ceil(h/CELL);
  const perCell=Math.max(2,Math.ceil(maxc/(gw*gh)*1.4));
  const cellCnt=new Uint16Array(gw*gh);
  const sel=[],pts=[],spill=[];
  for(let i=0;i<count&&sel.length<maxc;i++){
    const c=corners[idx[i]];
    const cx=(c.x/CELL)|0,cy=(c.y/CELL)|0,ci=cy*gw+cx;
    if(cellCnt[ci]<perCell){cellCnt[ci]++;c.level=0;sel.push(c);pts.push({x:c.x,y:c.y});}
    else spill.push(idx[i]);
  }
  // if texture is concentrated, top up from the spill so weak frames still get their budget
  for(let k=0;k<spill.length&&sel.length<maxc;k++){
    const c=corners[spill[k]];c.level=0;sel.push(c);pts.push({x:c.x,y:c.y});
  }
  const keep=sel.length;
  const desc=new jsfeat.matrix_t(32,Math.max(1,keep),jsfeat.U8_t|jsfeat.C1_t);
  jsfeat.orb.describe(mat,sel,keep,desc);
  desc.float=false;desc.absGate=60;desc.guidedGate=70;   // Hamming gates (unchanged behavior)
  return {pts,desc,count:keep};
}
function ham(d,i,e,j){let s=0;const a=d.data,b=e.data,oi=i*32,oj=j*32;
  for(let k=0;k<32;k++){let x=a[oi+k]^b[oj+k];x=x-((x>>1)&0x55);x=(x&0x33)+((x>>2)&0x33);s+=((x+(x>>4))&0x0f);}return s;}
// Squared-L2 for float descriptors (XFeat). Descriptors are L2-normalized → distance in [0,4].
function l2(d,i,e,j){const a=d.data,b=e.data,D=d.dim,oi=i*D,oj=j*D;let s=0;
  for(let k=0;k<D;k++){const t=a[oi+k]-b[oj+k];s+=t*t;}return s;}
// One distance dispatch: descriptors carry `.float=true` when they're XFeat vectors.
function dist(dA,i,dB,j){return dA.float?l2(dA,i,dB,j):ham(dA,i,dB,j);}
function bestOf(A,B,i){let b1=1e9,b2=1e9,bj=-1;for(let j=0;j<B.count;j++){const d=dist(A.desc,i,B.desc,j);if(d<b1){b2=b1;b1=d;bj=j;}else if(d<b2)b2=d;}return{bj,b1,b2};}
function matchMutual(A,B){
  const out=[];
  for(let i=0;i<A.count;i++){const {bj,b1,b2}=bestOf(A,B,i);
    if(bj<0||b1>0.8*b2||b1>A.desc.absGate)continue;
    if(bestOf(B,A,bj).bj!==i)continue;              // mutual cross-check
    out.push([i,bj]);
  }
  return out;
}
/* ---- pass-2 guided matching: once a coarse model exists, geometry disambiguates the
   repetitive texture that defeats the ratio test. Each B feature is projected into A and
   only candidates within `rad` px compete — inlier counts typically multiply 3–5×. ---- */
function ptGrid(pts,cell){
  const map=new Map();
  for(let i=0;i<pts.length;i++){const k=((pts[i].x/cell)|0)+","+((pts[i].y/cell)|0);
    let a=map.get(k);if(!a){a=[];map.set(k,a);}a.push(i);}
  return map;
}
function matchGuided(A,B,M,rad){
  const grid=ptGrid(A.pts,rad), r2=rad*rad;
  const bestForA=new Map();                          // one-to-one: keep best j per i
  for(let j=0;j<B.count;j++){
    const p={x:M[0]*B.pts[j].x+M[1]*B.pts[j].y+M[2], y:M[3]*B.pts[j].x+M[4]*B.pts[j].y+M[5]};
    const cx=(p.x/rad)|0, cy=(p.y/rad)|0;
    let b1=999,b2=999,bi=-1;
    for(let gx=cx-1;gx<=cx+1;gx++)for(let gy=cy-1;gy<=cy+1;gy++){
      const arr=grid.get(gx+","+gy); if(!arr)continue;
      for(const i of arr){
        const dx=A.pts[i].x-p.x,dy=A.pts[i].y-p.y;
        if(dx*dx+dy*dy>r2)continue;
        const d=dist(A.desc,i,B.desc,j);
        if(d<b1){b2=b1;b1=d;bi=i;}else if(d<b2)b2=d;
      }
    }
    if(bi<0||b1>A.desc.guidedGate)continue;
    if(b2<1e9&&b1>0.9*b2)continue;                   // relaxed ratio — geometry already gates
    const prev=bestForA.get(bi); if(!prev||b1<prev.d)bestForA.set(bi,{j,d:b1});
  }
  const out=[];bestForA.forEach((v,i)=>out.push([i,v.j]));
  return out;
}
// RANSAC over matches m (B→A) with pixel threshold eps. Returns inlier point sets {P,Q} or null.
function ransacIn(A,B,m,eps,iters){
  if(m.length<4)return null;
  const from=[],to=[];
  m.forEach(([i,j])=>{from.push({x:B.pts[j].x,y:B.pts[j].y});to.push({x:A.pts[i].x,y:A.pts[i].y});});
  const model=new jsfeat.matrix_t(3,2,jsfeat.F32_t|jsfeat.C1_t);
  const kernel=new jsfeat.motion_model.affine2d();
  const params=new jsfeat.ransac_params_t(3,eps,0.5,0.995);
  const mask=new jsfeat.matrix_t(m.length,1,jsfeat.U8_t|jsfeat.C1_t);
  if(!jsfeat.motion_estimator.ransac(params,kernel,from,to,m.length,model,mask,iters))return null;
  const P=[],Q=[];for(let i=0;i<m.length;i++)if(mask.data[i]){P.push(from[i]);Q.push(to[i]);}
  return P.length>=3?{P,Q}:null;
}
// Full 6-dof least-squares affine P→Q. Captures the local shear/foreshortening left by a
// forward/back-tilted camera or a bending scale — things a similarity cannot represent.
function fitAffine(P,Q){
  const n=P.length; if(n<3)return null;
  let Sx=0,Sy=0,Sxx=0,Sxy=0,Syy=0,Su=0,Sv=0,Sxu=0,Syu=0,Sxv=0,Syv=0;
  for(let i=0;i<n;i++){const x=P[i].x,y=P[i].y,u=Q[i].x,v=Q[i].y;
    Sx+=x;Sy+=y;Sxx+=x*x;Sxy+=x*y;Syy+=y*y;Su+=u;Sv+=v;Sxu+=x*u;Syu+=y*u;Sxv+=x*v;Syv+=y*v;}
  const A=[Sxx,Sxy,Sx, Sxy,Syy,Sy, Sx,Sy,n];
  const det=A[0]*(A[4]*A[8]-A[5]*A[7])-A[1]*(A[3]*A[8]-A[5]*A[6])+A[2]*(A[3]*A[7]-A[4]*A[6]);
  if(Math.abs(det)<1e-6)return null;
  const solve=(b0,b1,b2)=>{
    const dx=b0*(A[4]*A[8]-A[5]*A[7])-A[1]*(b1*A[8]-b2*A[5])+A[2]*(b1*A[7]-b2*A[4]);
    const dy=A[0]*(b1*A[8]-b2*A[5])-b0*(A[3]*A[8]-A[5]*A[6])+A[2]*(A[3]*b2-A[6]*b1);
    const dz=A[0]*(A[4]*b2-A[7]*b1)-A[1]*(A[3]*b2-A[6]*b1)+b0*(A[3]*A[7]-A[4]*A[6]);
    return [dx/det,dy/det,dz/det];
  };
  const [a,b,c]=solve(Sxu,Syu,Su), [d,e,f]=solve(Sxv,Syv,Sv);
  return [a,b,c, d,e,f];
}
const rmsFit=(M,P,Q)=>{let s=0;for(let i=0;i<P.length;i++){
  const dx=M[0]*P[i].x+M[1]*P[i].y+M[2]-Q[i].x, dy=M[3]*P[i].x+M[4]*P[i].y+M[5]-Q[i].y;
  s+=dx*dx+dy*dy;}return Math.sqrt(s/P.length);};
// scale = sqrt|det| (area-true), rot from nearest rotation, anisotropy from AᵀA eigenvalues
function affStats(M){
  const a=M[0],b=M[1],d=M[3],e=M[4],det=a*e-b*d;
  const g00=a*a+d*d,g01=a*b+d*e,g11=b*b+e*e,tr=g00+g11;
  const disc=Math.sqrt(Math.max(0,tr*tr-4*det*det));
  const l1=(tr+disc)/2,l2=Math.max(1e-12,(tr-disc)/2);
  return {scale:Math.sqrt(Math.abs(det)),rot:Math.atan2(d-b,a+e)*180/Math.PI,
          anis:Math.sqrt(l1/l2),flip:det<=0};
}
// median translation from raw matches — a robust safety estimate (no spurious rotation/scale)
function medianTranslation(A,B,m){
  const dxs=[],dys=[];
  m.forEach(([i,j])=>{dxs.push(A.pts[i].x-B.pts[j].x);dys.push(A.pts[i].y-B.pts[j].y);});
  dxs.sort((a,b)=>a-b);dys.sort((a,b)=>a-b);
  const md=a=>a.length?a[a.length>>1]:0;
  return [1,0,md(dxs), 0,1,md(dys)];
}
// least-squares similarity (rotation + uniform scale + translation) mapping p(B)->q(A)
// over correspondence arrays P,Q. Closed form (Umeyama-style) — stable & accurate on inliers.
function fitSimilarity(P,Q){
  const n=P.length; if(n<2) return null;
  let mpx=0,mpy=0,mqx=0,mqy=0;
  for(let i=0;i<n;i++){mpx+=P[i].x;mpy+=P[i].y;mqx+=Q[i].x;mqy+=Q[i].y;}
  mpx/=n;mpy/=n;mqx/=n;mqy/=n;
  let a=0,b=0,sp=0;
  for(let i=0;i<n;i++){const px=P[i].x-mpx,py=P[i].y-mpy,qx=Q[i].x-mqx,qy=Q[i].y-mqy;
    a+=qx*px+qy*py; b+=qy*px-qx*py; sp+=px*px+py*py;}
  if(sp<1e-9) return null;
  const s=Math.sqrt(a*a+b*b)/sp, th=Math.atan2(b,a);
  const cs=s*Math.cos(th), sn=s*Math.sin(th);
  return [cs,-sn, mqx-(cs*mpx-sn*mpy),  sn,cs, mqy-(sn*mpx+cs*mpy)];
}
// Core, two passes: mutual match → RANSAC(3px) → similarity; then GUIDED re-match with the
// coarse model → RANSAC(2px) over a far larger, cleaner inlier set. Finally, MODEL SELECTION:
// an affine refit replaces the similarity only when it clearly reduces residuals (tilted-camera
// foreshortening, bending scale) AND passes distortion bounds — so it can't overfit or shear.
// Returns {model(6)|null, affine, inliers, matches, scale, rot, dx, dy}. Model maps B->A, detection px.
function estimate(A,B,keep){
  // keep(aPt,bPt): optional match filter. Two uses:
  //  - advance floor (kills the entire family of small-step self-similar correspondences —
  //    ruler ticks, tape digits, repeated lichen — in one pass)
  //  - capture-time prior window (guided capture knows roughly where the next tile sits)
  const R={model:null,affine:false,inliers:0,matches:0,scale:0,rot:0,dx:0,dy:0};
  let m=matchMutual(A,B);
  if(keep)m=m.filter(([i,j])=>keep(A.pts[i],B.pts[j]));
  R.m=m; R.matches=m.length;
  let inl=ransacIn(A,B,m,3,2000);
  if(!inl) return R;
  let Ms=fitSimilarity(inl.P,inl.Q);
  if(!Ms) return R;
  let gm=matchGuided(A,B,Ms,14);
  if(keep)gm=gm.filter(([i,j])=>keep(A.pts[i],B.pts[j]));
  if(gm.length>=Math.max(8,m.length)){
    const inl2=ransacIn(A,B,gm,2,3000);
    if(inl2&&inl2.P.length>inl.P.length){
      const Ms2=fitSimilarity(inl2.P,inl2.Q);
      if(Ms2){inl=inl2;Ms=Ms2;R.matches=gm.length;}
    }
  }
  R.inliers=inl.P.length;
  let M=Ms;
  if(R.inliers>=12){                     // enough support for 6 dof
    const Ma=fitAffine(inl.P,inl.Q);
    if(Ma){const st=affStats(Ma);
      if(!st.flip&&st.anis<=1.08&&rmsFit(Ma,inl.P,inl.Q)<=0.85*rmsFit(Ms,inl.P,inl.Q)){M=Ma;R.affine=true;}}
  }
  const st=affStats(M);
  R.model=M;R.scale=st.scale;R.rot=st.rot;R.dx=M[2];R.dy=M[5];
  return R;
}
/* ---- anti-aliasing knockout ----
   Rulers, tick marks, and repetitive lichen let a frame match ITSELF one period off:
   RANSAC finds a confident consensus whose vertical step is tiny — geometrically wrong,
   but with plenty of inliers (guided rematch then amplifies it). Sequential section
   photos MUST advance, so a confident fit with |dy| < minAdv is suspect: remove the
   matches that agree with it and re-estimate. If a plausible fit with a real advance
   exists underneath (the rock), it surfaces; if not, keep the strongest original fit
   and let the consistency pass judge it. */
const plausibleE=e=> e.model && e.inliers>=8 && Math.abs(e.rot)<12 && e.scale>0.6 && e.scale<1.6;
function estimateRobust(A,B,minAdv){
  const e=estimate(A,B);
  if(!(minAdv>0)||!plausibleE(e)||Math.abs(e.dy)>=minAdv) return e;   // fine as is
  // Confident fit that barely advances: re-estimate on advancing matches only.
  const e2=estimate(A,B,(a,b)=>Math.abs(a.y-b.y)>=minAdv);
  if(plausibleE(e2)&&Math.abs(e2.dy)>=minAdv&&e2.inliers>=Math.max(8,0.4*e.inliers)){e2.aliased=1;return e2;}
  return e;   // no real advance underneath — a true duplicate / true high overlap; keep the measurement
}
// returns {model, inliers, matches, quality} mapping B(from) -> A(to), in DETECTION px.
// quality: 'firm' (similarity trusted) | 'coarse' (median translation) | 'stack' (no info)
// minAdv (optional, detection px): minimum plausible vertical advance for sequential frames.
// prior (optional): {dy,dx,dh,dw} in detection px — the offset measured live at capture time
// by guided capture. Matching restricted to a window around it defeats ruler self-similarity
// outright: the aliased correspondences never enter RANSAC at all.
function registerPair(A,B,lockScale,minAdv,prior){
  let e=null,usedPrior=0;
  if(prior){
    const wy=Math.max(24,0.16*prior.dh), wx=Math.max(24,0.22*prior.dw);
    const eP=estimate(A,B,(a,b)=>Math.abs(a.y-b.y-prior.dy)<wy && Math.abs(a.x-b.x-prior.dx)<wx);
    // the fit must still clear the advance floor (unless the prior itself is legitimately
    // small) — otherwise a wrong prior whose window overlaps the ruler's small-step alias
    // family would be "confirmed" by the aliases it contains
    if(plausibleE(eP)&&(Math.abs(eP.dy)>=minAdv||Math.abs(prior.dy)<minAdv)){e=eP;usedPrior=1;}
  }
  if(!e)e=estimateRobust(A,B,minAdv);
  if(plausibleE(e)){return {model:lockScale?deScale(e.model):e.model,affine:e.affine,inliers:e.inliers,matches:e.matches,quality:"firm",aliased:e.aliased||0,prior:usedPrior};}
  if(e.matches>=6){return {model:medianTranslation(A,B,e.m||matchMutual(A,B)),inliers:e.inliers,matches:e.matches,quality:"coarse",prior:usedPrior};}
  return {model:null,inliers:e.inliers,matches:e.matches,quality:"stack"};
}
// normalize a transform to unit area scale (works for similarity and affine alike)
function deScale(M){
  const s=Math.sqrt(Math.abs(M[0]*M[4]-M[1]*M[3]))||1;
  return [M[0]/s,M[1]/s,M[2], M[3]/s,M[4]/s,M[5]];
}

/* ---- frame cleaning: metrics come from the same accurate estimator ---- */
// Knockout applies here too: an aliased small-step fit would wrongly read as "redundant";
// a TRUE duplicate keeps its small dy (no real advance exists underneath to recover).
function rawAffine(a,b){ return estimateRobust(a.feat,b.feat,0.08*Math.min(a.dh,b.dh)); }
const plausibleFit=r=> r.inliers>=8 && Math.abs(r.rot)<12 && r.scale>0.6 && r.scale<1.6;
const isDuplicate=(r,dw,dh)=> r.inliers>=12 && Math.abs(r.dy)<0.06*dh && Math.abs(r.dx)<0.06*dw && r.scale>0.95 && r.scale<1.05 && Math.abs(r.rot)<2.5;
// Iterative cleaner: register the current kept set, flag the single best frame to remove
// (a redundant "same-section" shot or a non-matching intruder), then RE-MATCH and repeat.
// F: array of {feat,dw,dh,forceKeep}. Returns {inc:[bool], reason:{i:str}}.
function analyzeFrames(F){
  const n=F.length, inc=F.map(()=>true), reason={};
  const dh=F[0].dh;
  const advFrac=r=>Math.abs(r.dy)/dh;
  for(let iter=0; iter<n; iter++){
    const kl=[]; for(let i=0;i<n;i++) if(inc[i]) kl.push(i);
    if(kl.length<3) break;
    // register consecutive kept pairs
    const seam=[]; for(let k=0;k<kl.length-1;k++) seam.push(rawAffine(F[kl[k]], F[kl[k+1]]));
    // typical advance across plausible seams (adapts to how much overlap the user shot)
    const advs=seam.filter(plausibleFit).map(advFrac).sort((a,b)=>a-b);
    const medAdv=advs.length? advs[advs.length>>1] : 0.4;
    // score interior frames for removal; pick the strongest-bridge candidate
    let bestCand=null;
    for(let k=1;k<kl.length-1;k++){
      const a=kl[k-1],b=kl[k],c=kl[k+1];
      if(F[b].forceKeep) continue;
      const rab=seam[k-1], rbc=seam[k], rac=rawAffine(F[a],F[c]);
      const bridgeOK = plausibleFit(rac) && rac.inliers>=10 && advFrac(rac) < 1.5*medAdv;
      const redundant = plausibleFit(rab) && advFrac(rab) < 0.5*medAdv;   // b barely advances beyond a → same section
      const intruder  = !plausibleFit(rab) && !plausibleFit(rbc);          // b matches neither neighbor
      if(bridgeOK && (redundant||intruder)){
        if(!bestCand || rac.inliers>bestCand.score)
          bestCand={b,score:rac.inliers,why:redundant?"another shot of the same section":"doesn’t match the frames around it"};
      }
    }
    if(!bestCand) break;                 // stable — nothing more to remove
    inc[bestCand.b]=false; reason[bestCand.b]=bestCand.why;   // flag, then loop re-matches
  }
  // terminal near-duplicate (last kept frame identical to the one before it — no successor to bridge)
  const kl=[]; for(let i=0;i<n;i++) if(inc[i]) kl.push(i);
  if(kl.length>=2){
    const b=kl[kl.length-1], a=kl[kl.length-2];
    if(!F[b].forceKeep && isDuplicate(rawAffine(F[a],F[b]),F[0].dw,dh)){
      inc[b]=false; reason[b]="near-duplicate of the previous frame";
    }
  }
  return {inc,reason};
}
/* 3x3 helpers for chaining */
const to3=M=>[M[0],M[1],M[2], M[3],M[4],M[5], 0,0,1];
function mul3(P,Q){const o=new Array(9);
  for(let r=0;r<3;r++)for(let c=0;c<3;c++)o[r*3+c]=P[r*3]*Q[c]+P[r*3+1]*Q[3+c]+P[r*3+2]*Q[6+c];
  return o;}
const apply=(M,x,y)=>({x:M[0]*x+M[1]*y+M[2], y:M[3]*x+M[4]*y+M[5]});

/* ---- photometric sub-pixel polish ----
   Features localize to ~1px at DETECTION scale, which is 1–3px of error at output scale.
   After the geometric fit, render both frames' actual overlap band at output resolution,
   and slide B over A maximizing normalized cross-correlation (NCC — exposure-invariant),
   with parabolic sub-pixel interpolation at the peak. Corrects M's translation in place.
   Returns the correction magnitude in output px, or -1 if there was no reliable signal. */
function refineSeam(fa,fb,M){
  let byMin=1e9,byMax=-1e9;
  [[0,0],[fb.w,0],[fb.w,fb.h],[0,fb.h]].forEach(([x,y])=>{const p=apply(M,x,y);
    byMin=Math.min(byMin,p.y);byMax=Math.max(byMax,p.y);});
  const y0=Math.max(0,byMin), y1=Math.min(fa.h,byMax);
  if(y1-y0<24) return -1;                              // overlap too thin to measure
  const SW=Math.min(fa.w,640), s=SW/fa.w, SH=Math.max(24,Math.round((y1-y0)*s));
  const strip=(src,G)=>{const c=document.createElement("canvas");c.width=SW;c.height=SH;
    const x=c.getContext("2d",{willReadFrequently:true});
    x.imageSmoothingQuality="high";
    x.setTransform(G[0],G[3],G[1],G[4],G[2],G[5]);x.drawImage(src,0,0);
    const d=x.getImageData(0,0,SW,SH).data;
    c.width=c.height=0;                           // release backing store immediately
    return d;};
  const SA=[s,0,0, 0,s,-s*y0];                          // a-space → strip
  const da=strip(fa.canvas,SA);
  const GB=mul3(to3(SA),to3(M));                        // b image → a-space → strip
  const db=strip(fb.canvas,[GB[0],GB[1],GB[2],GB[3],GB[4],GB[5]]);
  const N=SW*SH, ga=new Float32Array(N), gb=new Float32Array(N), mk=new Uint8Array(N);
  for(let k=0,p=0;p<N;k+=4,p++){
    ga[p]=0.299*da[k]+0.587*da[k+1]+0.114*da[k+2];
    gb[p]=0.299*db[k]+0.587*db[k+1]+0.114*db[k+2];
    mk[p]=db[k+3]>200?1:0;                              // only where B actually has pixels
  }
  const R=6;
  const ncc=(dx,dy)=>{
    let sa=0,sb=0,saa=0,sbb=0,sab=0,n=0;
    for(let y=R;y<SH-R;y+=2){const ra=y*SW,rb=(y+dy)*SW+dx;
      for(let x=R;x<SW-R;x+=2){
        const q=rb+x; if(!mk[q])continue;
        const a=ga[ra+x],b=gb[q];
        sa+=a;sb+=b;saa+=a*a;sbb+=b*b;sab+=a*b;n++;
      }}
    if(n<200)return -2;
    const cov=sab-sa*sb/n, va=saa-sa*sa/n, vb=sbb-sb*sb/n;
    return (va<=0||vb<=0)?-2:cov/Math.sqrt(va*vb);
  };
  let best=-2,bx=0,by=0;
  const grid={};
  for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++){
    const v=ncc(dx,dy);grid[dx+","+dy]=v;
    if(v>best){best=v;bx=dx;by=dy;}
  }
  if(best<0.25)return -1;                               // no usable photometric signal
  // parabolic sub-pixel on each axis (only if the peak is interior)
  const sub=(m1,c0,p1)=>{const d=m1-2*c0+p1;return Math.abs(d)>1e-9?Math.max(-0.5,Math.min(0.5,0.5*(m1-p1)/d)):0;};
  let fx=bx,fy=by;
  if(Math.abs(bx)<R){const m1=grid[(bx-1)+","+by],p1=grid[(bx+1)+","+by];if(m1>-1&&p1>-1)fx+=sub(m1,best,p1);}
  if(Math.abs(by)<R){const m1=grid[bx+","+(by-1)],p1=grid[bx+","+(by+1)];if(m1>-1&&p1>-1)fy+=sub(m1,best,p1);}
  // best (fx,fy) = B's current displacement error in strip px → subtract it, back in output px
  M[2]-=fx/s; M[5]-=fy/s;
  return Math.hypot(fx,fy)/s;
}

/* ================= pipeline ================= */
$("#run").onclick=run;
function setProg(p,msg){$("#prog").style.display="block";$("#barfill").style.width=(p*100)+"%";if(msg!=null)$("#plog").textContent=msg;}
function banner(kind,html){const b=$("#banner");b.className="banner "+kind;b.innerHTML=html;}

async function run(){
  const engine=$("#engine").value;
  if(engine==="orb" && typeof jsfeat==="undefined"){banner("warn","Couldn’t load the vision library (jsfeat). Check your connection once to cache it, then works offline.");return;}
  if(engine==="xfeat"){
    try{ await ensureXFeat(); }
    catch(_){ $("#run").disabled=false; return; }
  }
  $("#run").disabled=true;$("#result").innerHTML="";$("#seams").innerHTML="";$("#banner").className="banner";
  const maxW=+res.value,maxc=+feat.value,lock=$("#lock").checked;
  try{
    setProg(0.02,"Preparing frames…");
    // features for ALL frames (attach to img objects so exclusions/Keep don't recompute)
    const ALL=[];
    for(let i=0;i<S.imgs.length;i++){
      const m=S.imgs[i];
      const wk=toWorking(m.el,maxW,engine==="xfeat");
      let fd = engine==="xfeat"
        ? await xfeatDetectDescribe(wk.canvas,maxW,maxc)
        : detectDescribe(wk.blur,maxc);
      if($("#notape") && $("#notape").checked){
        const band=detectTapeBand(wk.canvas);            // band in working px
        const sx = engine==="xfeat" ? 1 : wk.ratio;      // ORB pts are in detection px
        const before=fd.count;
        fd=filterTapeFeatures(fd,band,sx);
        if(band) setProg(0.05+0.33*(i+1)/S.imgs.length,`Frame ${i+1}: masked tape (${before}→${fd.count} features)`);
      }
      ALL.push({canvas:wk.canvas,w:wk.w,h:wk.h,feat:fd,blur:wk.blur,ratio:wk.ratio,dw:wk.dw,dh:wk.dh,forceKeep:!!m.forceKeep,idx:i});
      setProg(0.02+0.30*(i+1)/S.imgs.length,`Finding features — frame ${i+1}/${S.imgs.length} (${fd.count} corners)`);
      await tick();
    }
    // clean: flag duplicates & non-matching photos (reversible)
    S.imgs.forEach(m=>{m.included=true;m.exReason=null;});
    let excluded=0;
    if($("#clean").checked && ALL.length>=3){
      setProg(0.34,"Checking for duplicates & mismatches…");await tick();
      const {inc,reason}=analyzeFrames(ALL);
      inc.forEach((keep,i)=>{ if(!keep){S.imgs[ALL[i].idx].included=false;S.imgs[ALL[i].idx].exReason=reason[i];excluded++;} });
      renderTray();
    }
    // build working set = kept frames, in order
    const F=ALL.filter((_,i)=>S.imgs[ALL[i].idx].included);
    if(F.length<2){
      $("#prog").style.display="none";
      banner("warn","Fewer than 2 usable frames after cleaning. Tap Keep on an excluded frame, or turn off auto-clean.");
      $("#run").disabled=false;return;
    }
    S.seams=[];
    const qRank={firm:2,coarse:1,stack:0};
    // lazy high-effort feature set (1.6× budget, FAST threshold from 8) for seams that need it
    const featHi = engine==="xfeat" ? (f=>f.feat) : (f=>f._hi||(f._hi=detectDescribe(f.blur,Math.round(maxc*1.6),8)));
    // capture-time priors: guided tiles carry the offset that was MEASURED live when the
    // shutter fired — consecutive tiles from the same session register inside that window
    const capPrior=(fa,fb)=>{
      const a=S.imgs[fa.idx]&&S.imgs[fa.idx].cap, b=S.imgs[fb.idx]&&S.imgs[fb.idx].cap;
      if(!a||!b||a.session!==b.session||b.seq!==a.seq+1||b.dyFrac==null)return null;
      return {dy:b.dyFrac*fa.dh, dx:b.dxFrac*fa.dw, dh:fa.dh, dw:fa.dw};
    };
    for(let i=0;i<F.length-1;i++){
      const minAdv=0.08*Math.min(F[i].dh,F[i+1].dh);   // sequential shots must advance
      let r=registerPair(F[i].feat,F[i+1].feat,lock,minAdv,capPrior(F[i],F[i+1]));
      if(r.quality!=="firm" && engine!=="xfeat"){  // ORB: escalate with a bigger feature budget.
        setProg(0.4+0.45*(i+0.5)/(F.length-1),`Seam ${i+1}: weak match — retrying at high effort…`);
        await tick();
        const r2=registerPair(featHi(F[i]),featHi(F[i+1]),lock,minAdv);
        if(qRank[r2.quality]>qRank[r.quality]||(r2.quality===r.quality&&r2.inliers>r.inliers))r=r2;
      }
      let M=r.model,q=r.quality;
      const rr=F[i].ratio;                       // detection→output px
      if(!M){M=[1,0,0, 0,1, Math.round(F[i].h*0.55)];q="stack";}
      else { M=[M[0],M[1],M[2]*rr, M[3],M[4],M[5]*rr]; }   // scale translation to output res
      // photometric sub-pixel polish on any geometric seam (firm or coarse)
      let ref=-1;
      if(q!=="stack") ref=refineSeam(F[i],F[i+1],M);
      S.seams.push({i,M,inliers:r.inliers,matches:r.matches,quality:q,refined:ref>=0,affine:!!r.affine,aliased:r.aliased||0,prior:!!r.prior,ux:0,uy:0});
      setProg(0.4+0.45*(i+1)/(F.length-1),`Registering seam ${i+1}/${F.length-1} — ${r.inliers} inliers (${q}${ref>=0?", sub-px":""})`);
      await tick();
    }
    S.frames=F;
    ALL.forEach(f=>{f.blur=null;f._hi=null;});   // detection matrices no longer needed — free memory
    enforceConsistency(S.seams,F);
    const weak=S.seams.filter(s=>s.quality==="stack").length;
    const coarse=S.seams.filter(s=>s.quality==="coarse").length;
    const suspects=S.seams.filter(s=>s.suspect).length;
    setProg(0.9,"Compositing column…");await tick();
    composite();
    setProg(1,"Done.");setTimeout(()=>$("#prog").style.display="none",500);
    const exNote = excluded?`Set aside ${excluded} frame${excluded>1?"s":""} (duplicate or non-matching — see the list; tap Keep to restore). `:"";
    if(suspects) banner("warn",`${exNote}${suspects} seam${suspects>1?"s":""} matched but with an inconsistent step (marked “check”) — their measured offsets were KEPT, not overwritten. Inspect those joins; each chip shows its Δ step and reason.`);
    else if(weak) banner("warn",`${exNote}${weak} seam${weak>1?"s":""} couldn’t match reliably and were stacked straight — check the flagged seams and nudge.`);
    else if(coarse||excluded) banner("info",`${exNote}Locked${coarse?`, ${coarse} seam(s) used a translation-only fit`:""}. Verify and nudge if needed.`);
    else banner("info","All seams locked firmly on rock features and polished to sub-pixel (✓). Fine-tune any seam with the ± nudges.");
  }catch(err){
    $("#prog").style.display="none";
    banner("warn","Stitch failed: "+(err&&err.message?err.message:err)+". If this repeats, try lowering the working resolution, then reload.");
    console.error(err);
  }
  finally{$("#run").disabled=false;}
}

// A measured section is shot in ONE direction, so every seam's vertical step should share sign
// and be within a sane magnitude band. Repair outliers that RANSAC occasionally produces.
function enforceConsistency(seams,F){
  const dys=seams.map(s=>s.M[5]);
  const signs=dys.map(Math.sign).filter(x=>x!==0);
  const domSign=signs.reduce((a,b)=>a+b,0)>=0?1:-1;
  // typical step from FIRM seams only — a run of aliased/coarse fits must not set the median
  const firmMags=seams.filter(s=>s.quality==="firm").map(s=>Math.abs(s.M[5])).filter(v=>v>1).sort((a,b)=>a-b);
  const allMags=dys.map(Math.abs).filter(v=>v>1).sort((a,b)=>a-b);
  const mags=firmMags.length>=2?firmMags:allMags;
  const medMag=mags.length?mags[mags.length>>1]:Math.round(F[0].h*0.5);
  const flag=s=>{
    const dy=s.M[5], adv=dy*domSign, h=F[s.i].h;
    const strongFirm = s.quality==="firm" && s.inliers>=15;
    if(Math.abs(dy)>h*0.95) return "step exceeds frame";
    if(strongFirm) return adv<h*0.03 ? "no forward advance" : null;   // trust strong fits otherwise
    if(adv<h*0.10) return "step too small";
    if(Math.abs(dy)>2.2*medMag) return "step ≫ typical";
    if(Math.abs(dy)<0.35*medMag) return "step ≪ typical";
    return null;
  };
  const flags=seams.map(flag);
  const nbad=flags.filter(Boolean).length;
  // If MOST seams look wrong, the median itself is meaningless — rewriting the column from
  // it would replace every real measurement with a fabricated uniform step (silent data
  // destruction). Keep the models, mark the seams, and let the caller warn the user.
  if(nbad>Math.max(1,seams.length*0.6)){
    seams.forEach((s,k)=>{ if(flags[k]) s.suspect=flags[k]; });
    return seams;
  }
  seams.forEach((s,k)=>{
    if(!flags[k])return;
    if(s.quality==="firm"&&s.inliers>=15){ s.suspect=flags[k]; return; }  // flag, never overwrite strong fits
    s.M=[1,0,0, 0,1, domSign*medMag]; // safe stack in the dominant direction, median step
    s.quality="stack"; s.repaired=true; s.repairReason=flags[k];
  });
  return seams;
}

/* cumulative transforms into frame-0 space, bbox, big canvas, feather blend */
// Reused canvases: iOS Safari has a hard total-canvas-memory budget and reclaims dead
// canvases lazily — allocating fresh full-size canvases per composite (and per frame for
// feathering) piles up backing stores until the OS kills the page. Reuse instead.
let _outCv=null,_offCv=null;
function buildTransforms(){
  const F=S.frames;
  const T=[ to3([1,0,0,0,1,0]) ];
  for(const s of S.seams){
    const seam=to3([s.M[0],s.M[1],s.M[2]+s.ux, s.M[3],s.M[4],s.M[5]+s.uy]); // frame i+1 -> frame i (+ nudge)
    T.push( mul3(T[T.length-1], seam) );
  }
  let minX=1e9,minY=1e9,maxX=-1e9,maxY=-1e9;const cyc=[],yr=[];
  F.forEach((f,i)=>{const M=T[i];let y0=1e9,y1=-1e9;
    [[0,0],[f.w,0],[f.w,f.h],[0,f.h]].forEach(([x,y])=>{const p=apply(M,x,y);
      minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);
      y0=Math.min(y0,p.y);y1=Math.max(y1,p.y);});
    const c=apply(M,f.w/2,f.h/2);cyc.push(c.y);yr.push([y0,y1]);
  });
  return {T,minX,minY,W:Math.ceil(maxX-minX),H:Math.ceil(maxY-minY),cyc,yr};
}
// exposure gain + leading-edge feather mask for frame i, rendered into the shared offscreen
function prepFrame(F,i,cyc,expo,feather){
  const f=F[i];let gain=1;
  if(expo&&i>0){const pm=meanLum(F[i-1].canvas),cm=meanLum(f.canvas);if(cm>1)gain=Math.max(0.6,Math.min(1.7,pm/cm));}
  const off=_offCv||(_offCv=document.createElement("canvas"));
  off.width=f.w;off.height=f.h;                 // resets content each frame
  const oc=off.getContext("2d");oc.drawImage(f.canvas,0,0);
  if(feather && i>0){
    const band=Math.min(f.h*0.10,110);          // narrow band = minimal blended zone
    const below = cyc[i] >= cyc[i-1];            // is this frame below its predecessor?
    oc.globalCompositeOperation="destination-in";
    if(below){                                   // overlap at this frame's TOP
      const g=oc.createLinearGradient(0,0,0,band);
      g.addColorStop(0,"rgba(0,0,0,0)");g.addColorStop(1,"rgba(0,0,0,1)");
      oc.fillStyle=g;oc.fillRect(0,0,f.w,band);
      oc.fillStyle="#000";oc.fillRect(0,band,f.w,f.h-band);
    }else{                                        // overlap at this frame's BOTTOM
      const y0=f.h-band;
      const g=oc.createLinearGradient(0,y0,0,f.h);
      g.addColorStop(0,"rgba(0,0,0,1)");g.addColorStop(1,"rgba(0,0,0,0)");
      oc.fillStyle="#000";oc.fillRect(0,0,f.w,y0);
      oc.fillStyle=g;oc.fillRect(0,y0,f.w,band);
    }
    oc.globalCompositeOperation="source-over";
  }
  return {off,gain};
}
function composite(){
  const F=S.frames;
  const bt=buildTransforms();
  const {T,minX,minY,cyc}=bt;
  let W=bt.W,H=bt.H;
  // iOS Safari canvas limits: ~8192 max side and ~16.7M total px. Downscale to fit.
  const MAX_SIDE=8000, MAX_AREA=15000000;
  let os=1;
  os=Math.min(os, MAX_SIDE/H, MAX_SIDE/W);
  if(W*H*os*os>MAX_AREA) os=Math.min(os, Math.sqrt(MAX_AREA/(W*H)));
  if(os<1){W=Math.max(1,Math.round(W*os));H=Math.max(1,Math.round(H*os));} else os=1;

  const railW=$("#rail").checked?58:0;            // rail lives IN the output — no second full-res canvas
  const out=_outCv||(_outCv=document.createElement("canvas"));
  out.width=W+railW;out.height=H;                 // resizing also clears prior content
  const ctx=out.getContext("2d");
  if(!ctx) throw new Error("canvas too large for this device — lower the working resolution");
  ctx.imageSmoothingQuality="high";
  ctx.fillStyle="#0d0b08";ctx.fillRect(0,0,out.width,out.height);
  const feather=$("#feather").checked,expo=$("#expo").checked;

  // draw top→down; feather only each frame's LEADING (top) edge over a narrow band → clean cross-fade, less ghosting
  F.forEach((f,i)=>{
    const {off,gain}=prepFrame(F,i,cyc,expo,feather);
    const M=T[i];
    ctx.save();
    ctx.setTransform(os*M[0],os*M[3],os*M[1],os*M[4], os*(M[2]-minX)+railW,os*(M[5]-minY));
    if(expo&&gain!==1)ctx.filter=`brightness(${gain})`;
    ctx.drawImage(off,0,0);
    ctx.restore();
  });
  ctx.setTransform(1,0,0,1,0,0);
  if(railW)drawRail(ctx,railW,H);
  // full-resolution geometry for the band-streamed export (bypasses canvas limits)
  S.full={T,minX,minY,W:bt.W,H:bt.H,cyc,yr:bt.yr,railW,feather,expo,downscaled:os<1,os};
  S.result={canvas:out};S.exportCanvas=out;
  showResult(out);
}
let _lumCv=null;
function meanLum(cv){const w=Math.min(60,cv.width),h=Math.round(cv.height*w/cv.width);
  const t=_lumCv||(_lumCv=document.createElement("canvas"));t.width=w;t.height=h;const c=t.getContext("2d",{willReadFrequently:true});
  c.drawImage(cv,0,0,w,h);const d=c.getImageData(0,0,w,h).data;let s=0,n=0;
  for(let k=0;k<d.length;k+=4){s+=0.299*d[k]+0.587*d[k+1]+0.114*d[k+2];n++;}return s/n;}

/* ---- result: bounded preview + on-demand export ----
   The full-resolution canvas never enters the DOM (Safari would keep an extra rendered
   layer for it). A ≤4MP preview is shown instead; the download encodes from the full-res
   composite only when tapped — PNG for small columns, JPEG for large ones (a big-column
   PNG data URL is a ~50MB string, which is exactly what gets the page killed on mobile). */
let _dispCv=null;
function showResult(base){
  const disp=_dispCv||(_dispCv=document.createElement("canvas"));
  let ps=Math.min(1,1100/base.width);
  if(base.width*ps*base.height*ps>4.2e6)ps=Math.sqrt(4.2e6/(base.width*base.height));
  disp.width=Math.max(1,Math.round(base.width*ps));disp.height=Math.max(1,Math.round(base.height*ps));
  disp.style.width="";disp.style.height="";
  const g=disp.getContext("2d");g.imageSmoothingQuality="high";
  g.clearRect(0,0,disp.width,disp.height);
  g.drawImage(base,0,0,disp.width,disp.height);
  const big=base.width*base.height>6e6;
  const box=$("#result");
  box.innerHTML=`<div class="rmeta"><span>output ${base.width}×${base.height}px</span><span>${S.imgs.length} frames · ${S.seams.length} seams</span></div>
    <div class="viewer"></div><a class="dl" id="dl" download="section.${big?"jpg":"png"}" href="#">⬇ Download ${big?"JPEG":"PNG"} (${base.width}×${base.height})</a>${S.full&&S.full.downscaled?`<a class="dl" id="dlfull" href="#" style="border-color:#D49A3E;color:#D49A3E">⬇ Full-resolution PNG (${S.full.W+S.full.railW}×${S.full.H})</a>`:""}`;
  box.querySelector(".viewer").appendChild(disp);
  const vw=box.querySelector(".viewer").clientWidth;
  if(disp.width>vw){const sc=vw/disp.width;disp.style.width=vw+"px";disp.style.height=(disp.height*sc)+"px";}
  const dlf=$("#dlfull");
  if(dlf)dlf.onclick=ev=>{ev.preventDefault();exportFullPNG();};
  const dl=$("#dl");
  dl.onclick=function(ev){
    if(this._ready)return;                        // second pass-through navigates
    ev.preventDefault();
    try{this.href=big?base.toDataURL("image/jpeg",0.92):base.toDataURL("image/png");this._ready=true;this.click();}
    catch(_){banner("warn","Couldn’t encode the image on this device — lower the working resolution and re-stitch.");}
  };
  renderSeams();
}
function drawRail(g,railW,H){
  const thick=parseFloat($("#thick").value);
  g.fillStyle="#1b1710";g.fillRect(0,0,railW,H);
  g.strokeStyle="#382F23";g.beginPath();g.moveTo(railW-.5,0);g.lineTo(railW-.5,H);g.stroke();
  g.font="11px ui-monospace,Menlo,monospace";g.textBaseline="middle";
  const n=Math.max(4,Math.round(H/160));
  for(let i=0;i<=n;i++){const y=Math.round(i/n*(H-1))+.5,major=(i%2===0);
    g.strokeStyle=major?"#5a4d38":"#3a3226";g.beginPath();g.moveTo(railW-(major?16:9),y);g.lineTo(railW,y);g.stroke();
    if(major){g.fillStyle="#A99C85";let lab;
      // rail labels increase downward as depth-from-top unless thickness given (then metres from base at bottom)
      if(isFinite(thick)&&thick>0)lab=(thick*(1-i/n)).toFixed(1)+"m";else lab=Math.round(i/n*100)+"%";
      g.save();g.translate(4,y);g.fillText(lab,0,0);g.restore();}}
  g.fillStyle="#D49A3E";g.font="9px ui-monospace,Menlo,monospace";
  g.save();g.translate(13,H-6);g.rotate(-Math.PI/2);g.fillText("TOP → BASE",0,0);g.restore();
}
function renderSeams(){
  const box=$("#seams");box.innerHTML="";
  S.seams.forEach((s,k)=>{
    let cls,label;
    const dY=Math.round(s.M[5]+s.uy);   // actual vertical step this seam contributes (output px)
    if(s.quality==="stack"){cls="low";label=s.repaired?`auto: ${s.repairReason||"repaired"}`:"stacked";}
    else if(s.quality==="coarse"){cls="mid";label=`~${s.inliers} inl`;}
    else {cls=s.suspect?"mid":(s.inliers>=25?"ok":"mid");label=`${s.inliers} inl${s.refined?" ✓":""}${s.affine?" tilt":""}${s.aliased?" ≠ruler":""}${s.prior?" ◎":""}`;}
    const note=s.suspect?` · check: ${s.suspect}`:(s.quality==="stack"?" · fallback":s.quality==="coarse"?" · coarse":"");
    const el=document.createElement("div");el.className="seam";
    el.innerHTML=`<span class="join">${String(k+1).padStart(2,"0")}→${String(k+2).padStart(2,"0")}${note} · Δ${dY}</span>
      <span class="chip ${cls}">${label}</span>
      <div class="nudge"><button data-a="uy--">↑</button><button data-a="uy++">↓</button><button data-a="ux--">←</button><button data-a="ux++">→</button></div>`;
    el.querySelectorAll(".nudge button").forEach(b=>b.onclick=()=>{const a=b.dataset.a;
      if(a==="uy--")s.uy-=3;if(a==="uy++")s.uy+=3;if(a==="ux--")s.ux-=3;if(a==="ux++")s.ux+=3;composite();});
    box.appendChild(el);
  });
}
["rail","thick"].forEach(id=>$("#"+id).addEventListener("input",()=>{if(S.result)composite();}));

/* ================= guided capture =================
   Microscope-stitcher-style tile acquisition. A low-res tracker registers the live
   viewfinder against the LAST captured tile (same estimator as the stitcher, tape
   masked), and the HUD steers x (lateral drift), y (advance to the target overlap)
   and z (scale = distance) until the next tile is in position — then auto-fires.
   Every capture stores the offset that was measured at the moment the shutter went,
   and the stitcher uses it as a registration prior. */
const GC={on:false,stream:null,pc:null,pctx:null,gray:null,blur:null,
  last:null,          // {feat,thumb,w,h} of the last captured tile at preview scale
  fit:null,           // accepted live fit {M,inliers,scale,rot} mapping live->last (preview px)
  prevFit:null,band:0,bandN:0,dir:0,dirVotes:0,holdSince:0,lost:0,
  session:0,seq:0,cumScale:1,busy:false,timer:null};
const PW=280;                                   // preview/tracking width
const gEl=id=>document.getElementById(id);

async function gcOpen(){
  if(GC.on)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    banner("warn","Camera capture needs Safari over https (or the installed app).");return;}
  try{
    GC.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{
      facingMode:{ideal:"environment"},width:{ideal:2160},height:{ideal:3840}}});
  }catch(e){banner("warn","Camera permission was declined — allow camera access in Settings › Safari to use guided capture.");return;}
  // push the video track to the maximum the device reports — this raises the quality
  // of the stream-grab fallback; tracking still runs on a downscaled copy either way
  try{
    const tr=GC.stream.getVideoTracks()[0];
    const cap=tr.getCapabilities?tr.getCapabilities():null;
    if(cap&&cap.width&&cap.width.max)await tr.applyConstraints({width:{ideal:cap.width.max},height:{ideal:cap.height&&cap.height.max||cap.width.max}});
  }catch(_){}
  const v=gEl("gvid"); v.srcObject=GC.stream;
  try{await v.play();}catch(_){}
  GC.on=true;GC.session=Date.now();GC.seq=0;GC.cumScale=1;GC.last=null;GC.fit=null;GC.prevFit=null;GC.cal=undefined;GC.ic=null;
  GC.dir=0;GC.dirVotes=0;GC.holdSince=0;GC.band=null;GC.bandN=0;
  gEl("gcap").style.display="block";document.body.style.overflow="hidden";
  gEl("gcount").textContent="0 tiles";gEl("gthumb").innerHTML="";
  gEl("ginstr").textContent="Frame the BASE (or top) of the section, hold steady, and capture the first tile.";
  GC.timer=setInterval(gcTick,150);
}
function gcClose(){
  if(!GC.on)return;
  clearInterval(GC.timer);GC.timer=null;
  try{GC.stream.getTracks().forEach(t=>t.stop());}catch(_){}
  GC.stream=null;GC.on=false;
  gEl("gcap").style.display="none";document.body.style.overflow="";
  renderTray();
  if(GC.seq>=2)banner("info",`Guided session captured ${GC.seq} tiles with measured overlaps (◎). Tap Stitch — the seams will register inside those measured windows.`);
}
document.addEventListener("visibilitychange",()=>{if(document.hidden&&GC.on)gcClose();});

function gcPreview(){
  const v=gEl("gvid"); if(!v.videoWidth)return null;
  const w=PW, h=Math.round(v.videoHeight*PW/v.videoWidth);
  if(!GC.pc){GC.pc=document.createElement("canvas");}
  if(GC.pc.width!==w||GC.pc.height!==h){GC.pc.width=w;GC.pc.height=h;GC.pctx=GC.pc.getContext("2d",{willReadFrequently:true});
    GC.gray=new jsfeat.matrix_t(w,h,jsfeat.U8_t|jsfeat.C1_t);GC.blur=new jsfeat.matrix_t(w,h,jsfeat.U8_t|jsfeat.C1_t);}
  GC.pctx.drawImage(v,0,0,w,h);
  const id=GC.pctx.getImageData(0,0,w,h);
  jsfeat.imgproc.grayscale(id.data,w,h,GC.gray,jsfeat.COLOR_RGBA2GRAY);
  jsfeat.imgproc.gaussian_blur(GC.gray,GC.blur,5,0);
  let fd=detectDescribe(GC.blur,350,12);
  if((GC.bandN++%6)===0)GC.band=detectTapeBand(GC.pc);       // refresh mask ~every 0.9s
  fd=filterTapeFeatures(fd,GC.band,1);
  return {feat:fd,w,h};
}
function gcTick(){
  if(!GC.on||GC.busy)return;
  const pv=gcPreview(); if(!pv)return;
  const ov=gEl("gov"), vw=gEl("gvid").clientWidth, vh=gEl("gvid").clientHeight;
  if(ov.width!==vw||ov.height!==vh){ov.width=vw;ov.height=vh;}
  const g=ov.getContext("2d");g.clearRect(0,0,ov.width,ov.height);
  const instr=gEl("ginstr"), shut=gEl("gshut"), fill=gEl("gfill");
  if(!GC.last){instr.textContent="Frame the BASE (or top) of the section, hold steady, and capture the first tile.";
    shut.classList.add("ready");fill.style.height="0%";GC.cur=pv;return;}
  // register live -> last tile (same estimator as the stitcher)
  const e=estimate(GC.last.feat,pv.feat);
  const H=pv.h,Wp=pv.w;
  let ok = e.model && e.inliers>=8 && Math.abs(e.rot)<15 && e.scale>0.55 && e.scale<1.8;
  if(ok&&GC.fit&&Math.abs(e.dy-GC.fit.dy)>0.2*H&&e.inliers<20)ok=false;  // continuity gate vs alias jumps
  if(!ok){
    GC.lost++;
    if(GC.lost>3){GC.fit=null;instr.textContent="Lost the last tile — drift back toward it until the ghost reappears.";
      shut.classList.remove("ready");fill.style.height="0%";}
    GC.cur=pv;return;
  }
  GC.lost=0;GC.prevFit=GC.fit;GC.fit=e;GC.cur=pv;
  // direction: first sustained motion sets it
  if(!GC.dir&&Math.abs(e.dy)>0.12*H){GC.dirVotes+=Math.sign(e.dy);if(Math.abs(GC.dirVotes)>=3)GC.dir=Math.sign(GC.dirVotes);}
  const ovl=(+gEl("ovl").value||40)/100, target=(1-ovl)*H;
  const adv=GC.dir?e.dy*GC.dir:Math.abs(e.dy);
  const prog=Math.max(0,Math.min(1.25,adv/target));
  fill.style.height=Math.min(100,prog*100)+"%";
  gEl("gtarget").style.bottom="0%"; // target notch is the top of the meter (100%)
  // ghost of the last tile, warped by the CURRENT fit into live view (onion skin)
  const s=ov.width/Wp, M=e.model;                       // live->last; ghost needs last->live
  const det=M[0]*M[4]-M[1]*M[3];
  if(GC.last.thumb&&Math.abs(det)>1e-6){
    const i0=M[4]/det,i1=-M[1]/det,i3=-M[3]/det,i4=M[0]/det;
    const i2=-(i0*M[2]+i1*M[5]), i5=-(i3*M[2]+i4*M[5]);
    g.save();g.globalAlpha=0.35;
    g.setTransform(s*i0,s*i3,s*i1,s*i4,s*i2,s*i5);
    g.drawImage(GC.last.thumb,0,0);
    g.restore();
    // leading-edge line of the last tile + target line: align the two
    const edgeLastY=GC.dir<0?0:GC.last.h;               // moving up: last tile's TOP edge leads
    const yLive=(i3*0+i4*edgeLastY+i5)*s;               // x-independent enough for a level line
    const yGoal=(GC.dir<0? target : H-target)*s;
    g.lineWidth=2;
    g.strokeStyle="#D49A3E";g.setLineDash([8,6]);g.beginPath();g.moveTo(0,yGoal);g.lineTo(ov.width,yGoal);g.stroke();
    g.setLineDash([]);g.strokeStyle="rgba(233,226,212,.9)";g.beginPath();g.moveTo(0,yLive);g.lineTo(ov.width,yLive);g.stroke();
  }
  // gates: y (advance), x (drift), z (scale/distance), tilt, steadiness
  const dyOK=Math.abs(adv-target)<0.06*H;
  const dxOK=Math.abs(e.dx)<0.07*Wp;
  const zNow=e.scale*GC.cumScale;                       // distance drift vs tile 1
  const zOK=e.scale>0.94&&e.scale<1.06&&zNow>0.85&&zNow<1.18;
  const rotOK=Math.abs(e.rot)<4;
  const steady=GC.prevFit?Math.hypot(e.dy-GC.prevFit.dy,e.dx-GC.prevFit.dx)<0.02*H:false;
  let msg=null;
  if(!GC.dir) msg="Start moving along the section — I’ll lock the direction.";
  else if(adv<target-0.06*H) msg=`Keep going ${GC.dir<0?"↑":"↓"} — ${Math.max(0,Math.round((target-adv)/target*100))}% to the next tile.`;
  else if(adv>target+0.06*H) msg=`Too far — ease back ${GC.dir<0?"↓":"↑"} a touch.`;
  else if(!dxOK) msg=`Drifting sideways — shift ${e.dx>0?"→":"←"} to line the ghost up.`;
  else if(!zOK) msg=(e.scale*GC.cumScale<1?"You’ve crept closer — step back to match tile 1.":"You’ve drifted away — step in to match tile 1.");
  else if(!rotOK) msg="Level the phone — the ghost is rotated.";
  else if(!steady) msg="In position — hold steady…";
  const ready=dyOK&&dxOK&&zOK&&rotOK;
  shut.classList.toggle("ready",ready);
  if(ready&&steady){
    if(!GC.holdSince)GC.holdSince=Date.now();
    const left=700-(Date.now()-GC.holdSince);
    if(gEl("gautoc").checked){
      if(left<=0){gcCapture();return;}
      msg=`Hold… capturing`;
    } else msg="Perfect — tap the shutter.";
  } else GC.holdSince=0;
  instr.textContent=msg;
}
async function gcCapture(){
  if(!GC.on||GC.busy)return;GC.busy=true;
  try{
    const v=gEl("gvid"); if(!v.videoWidth){GC.busy=false;return;}
    const fit=GC.last?GC.fit:null, pv=GC.cur;
    if(!pv){GC.busy=false;return;}
    // no fit (gap in the outcrop / cover): still allow a manual capture — it simply starts a
    // new anchor and that one seam registers without a prior
    const grab=await gcGrab(v);
    let bmp=await boundBitmap(grab.bmp);            // cap at ~24MP so 10+ native tiles can't exhaust iOS memory
    const flash=gEl("gflash");flash.style.opacity=".8";setTimeout(()=>flash.style.opacity="0",120);
    GC.seq++;
    // photo path: the native photo's field of view can differ from the video stream's
    // (4:3 sensor vs 16:9 stream). Calibrate ONCE per session by registering the photo
    // against the live preview of the same moment — that maps stream-measured offsets
    // into photo-frame fractions. If calibration isn't possible, drop the prior for this
    // seam (registration falls back to the knockout) rather than record a skewed one.
    if(grab.src==="photo"&&GC.cal===undefined)GC.cal=await gcCalibrate(bmp,pv);
    let dyFrac=fit?fit.dy/pv.h:null, dxFrac=fit?fit.dx/pv.w:null;
    if(fit&&grab.src==="photo"){
      const sameAspect=Math.abs(bmp.height/bmp.width - pv.h/pv.w)<0.02;
      if(GC.cal){dyFrac=fit.dy*GC.cal.s/GC.cal.hp; dxFrac=fit.dx*GC.cal.s/GC.cal.wp;}
      else if(!sameAspect){dyFrac=null;dxFrac=null;}
    }
    const cap={session:GC.session,seq:GC.seq,dyFrac,dxFrac,scale:fit?fit.scale:1};
    S.imgs.push({name:`tile ${String(GC.seq).padStart(2,"0")}`,url:makeThumb(bmp,bmp.width,bmp.height),
      w:bmp.width,h:bmp.height,el:bmp,included:true,forceKeep:true,exReason:null,cap});
    if(fit)GC.cumScale*=fit.scale;
    // the live preview of THIS moment becomes the new anchor tile
    const th=document.createElement("canvas");th.width=pv.w;th.height=pv.h;
    th.getContext("2d").drawImage(GC.pc,0,0);
    GC.last={feat:pv.feat,thumb:th,w:pv.w,h:pv.h};
    GC.fit=null;GC.prevFit=null;GC.holdSince=0;
    gEl("gcount").textContent=`${GC.seq} tile${GC.seq>1?"s":""} · ${bmp.width}×${bmp.height}${grab.src==="photo"?" 📷":""}`;
    const t=gEl("gthumb");const im=new Image();im.src=S.imgs[S.imgs.length-1].url;
    t.innerHTML="";t.appendChild(im);
  }finally{GC.busy=false;}
}
/* capture ladder: ImageCapture.takePhoto (true native photo — shipping in newer Safari;
   feature-detect PER METHOD, the constructor alone isn't enough) → high-res stream grab. */
async function gcGrab(v){
  const track=GC.stream&&GC.stream.getVideoTracks&&GC.stream.getVideoTracks()[0];
  if(track&&track.readyState==="live"&&window.ImageCapture&&ImageCapture.prototype.takePhoto){
    try{
      if(!GC.ic)GC.ic=new ImageCapture(track);
      let opts;
      try{const pc=await GC.ic.getPhotoCapabilities();
        if(pc&&pc.imageWidth&&pc.imageWidth.max)opts={imageWidth:pc.imageWidth.max,imageHeight:pc.imageHeight.max};}catch(_){}
      let blob=null;
      try{blob=await GC.ic.takePhoto(opts);}catch(_){ try{blob=await GC.ic.takePhoto();}catch(_){} }
      if(blob){
        const bmp=await createImageBitmap(blob,{imageOrientation:"from-image"}).catch(()=>createImageBitmap(blob));
        if(bmp)return {bmp,src:"photo"};
      }
    }catch(_){/* fall through to the stream */}
  }
  const c=document.createElement("canvas");c.width=v.videoWidth;c.height=v.videoHeight;
  c.getContext("2d").drawImage(v,0,0);
  const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.95));
  c.width=c.height=0;
  return {bmp:await createImageBitmap(blob),src:"stream"};
}
// keep single tiles ≤ ~24MP: far beyond anything the composite can carry, and 10+ full
// 48MP ImageBitmaps would blow the iOS memory budget
async function boundBitmap(bmp,maxPx=24e6){
  const px=bmp.width*bmp.height; if(px<=maxPx)return bmp;
  const sc=Math.sqrt(maxPx/px), w=Math.round(bmp.width*sc), h=Math.round(bmp.height*sc);
  const c=document.createElement("canvas");c.width=w;c.height=h;
  const x=c.getContext("2d");x.imageSmoothingQuality="high";x.drawImage(bmp,0,0,w,h);
  const nb=await createImageBitmap(c);c.width=c.height=0;
  try{bmp.close&&bmp.close();}catch(_){}
  return nb;
}
// register the native photo against the live preview of the same moment → mapping from
// video-preview px to photo px (scale s) and photo preview dims for normalizing priors
async function gcCalibrate(bmp,pv){
  try{
    const w=PW, h=Math.round(bmp.height*w/bmp.width);
    const c=document.createElement("canvas");c.width=w;c.height=h;
    const x=c.getContext("2d",{willReadFrequently:true});
    x.imageSmoothingQuality="high";x.drawImage(bmp,0,0,w,h);
    const id=x.getImageData(0,0,w,h);c.width=c.height=0;
    const gray=new jsfeat.matrix_t(w,h,jsfeat.U8_t|jsfeat.C1_t), blur=new jsfeat.matrix_t(w,h,jsfeat.U8_t|jsfeat.C1_t);
    jsfeat.imgproc.grayscale(id.data,w,h,gray,jsfeat.COLOR_RGBA2GRAY);
    jsfeat.imgproc.gaussian_blur(gray,blur,5,0);
    const pf=detectDescribe(blur,350,12);
    const e=estimate(pf,pv.feat);                 // maps video-preview -> photo-preview
    if(e.model&&e.inliers>=10&&e.scale>0.4&&e.scale<2.5)return {s:e.scale,hp:h,wp:w};
  }catch(_){}
  return null;
}
gEl("guideBtn")&&(gEl("guideBtn").onclick=gcOpen);
gEl("gclose")&&(gEl("gclose").onclick=gcClose);
gEl("gshut")&&(gEl("gshut").onclick=gcCapture);

/* ================= full-resolution export =================
   iOS caps a single canvas at ~8192px per side / ~16.7M px total, so a long column can
   never exist as one canvas at working resolution. Render it in horizontal BANDS instead
   and stream the scanlines straight into a PNG encoder (pako deflate) — the only canvases
   that ever exist are one band tall. Encoder is DOM-free so it can be unit-tested. */
function crc32Table(){const t=new Uint32Array(256);
  for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c;}return t;}
const _crcT=crc32Table();
function crc32(bytes,crc=0xFFFFFFFF){for(let i=0;i<bytes.length;i++)crc=_crcT[(crc^bytes[i])&0xFF]^(crc>>>8);return crc;}
const u32be=v=>new Uint8Array([(v>>>24)&255,(v>>>16)&255,(v>>>8)&255,v&255]);
function pngChunk(type,data){
  const t=new Uint8Array([type.charCodeAt(0),type.charCodeAt(1),type.charCodeAt(2),type.charCodeAt(3)]);
  const crc=~crc32(data,crc32(t))>>>0;
  return [u32be(data.length),t,data,u32be(crc)];
}
/* Streaming PNG: getBand(y0,h) must return RGBA (Uint8ClampedArray) for rows y0..y0+h.
   onProgress(frac) optional. Returns an array of Uint8Array parts for a Blob. */
async function encodePNG(W,H,getBand,pakoRef,onProgress,bandH){
  const pk=pakoRef||(typeof pako!=="undefined"?pako:null);
  if(!pk)throw new Error("deflate library not loaded");
  const parts=[new Uint8Array([137,80,78,71,13,10,26,10])];
  const ihdr=new Uint8Array(13);
  ihdr.set(u32be(W),0);ihdr.set(u32be(H),4);
  ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;   // 8-bit, RGB, deflate, adaptive, no interlace
  parts.push(...pngChunk("IHDR",ihdr));
  const df=new pk.Deflate({level:2});
  const idats=[];
  df.onData=chunk=>idats.push(chunk);
  const BH=bandH||512, row=new Uint8Array(1+W*3);
  for(let y0=0;y0<H;y0+=BH){
    const h=Math.min(BH,H-y0);
    const rgba=await getBand(y0,h);
    for(let r=0;r<h;r++){
      row[0]=0;                                   // filter: None (fast; deflate still bites)
      let o=1,p=r*W*4;
      for(let x=0;x<W;x++,p+=4){row[o++]=rgba[p];row[o++]=rgba[p+1];row[o++]=rgba[p+2];}
      df.push(row,false);
    }
    if(onProgress)onProgress((y0+h)/H);
    if(typeof tick==="function")await tick();
  }
  df.push(new Uint8Array(0),true);
  if(df.err)throw new Error("deflate failed: "+df.msg);
  for(const c of idats)parts.push(...pngChunk("IDAT",c));
  parts.push(...pngChunk("IEND",new Uint8Array(0)));
  return parts;
}
if(typeof module!=="undefined"&&module.exports){module.exports.encodePNG=encodePNG;} // Node test hook

let _bandCv=null;
async function exportFullPNG(){
  if(!S.full||!S.frames){banner("warn","Stitch the column first.");return;}
  if(typeof pako==="undefined"){banner("warn","The PNG encoder isn’t cached yet — open the app online once, then retry.");return;}
  const {T,minX,minY,W,H,cyc,yr,railW,feather,expo}=S.full;
  const F=S.frames, outW=W+railW;
  if(outW>16000||outW*H>2.4e8){banner("warn",`Full column is ${outW}×${H}px (${Math.round(outW*H/1e6)} MP) — too large to encode on-device. Lower the working resolution and re-stitch.`);return;}
  const dlfull=$("#dlfull"); if(dlfull)dlfull.textContent="Encoding…";
  try{
    setProg(0.02,`Rendering full column ${outW}×${H}px in bands…`);await tick();
    const band=_bandCv||(_bandCv=document.createElement("canvas"));
    const getBand=async(y0,h)=>{
      if(band.width!==outW||band.height!==h){band.width=outW;band.height=h;}
      const g=band.getContext("2d",{willReadFrequently:true});
      g.setTransform(1,0,0,1,0,0);g.imageSmoothingQuality="high";
      g.fillStyle="#0d0b08";g.fillRect(0,0,outW,h);
      for(let i=0;i<F.length;i++){
        if(yr[i][1]-minY<y0-1||yr[i][0]-minY>y0+h+1)continue;   // frame doesn't touch this band
        const {off,gain}=prepFrame(F,i,cyc,expo,feather);
        const M=T[i];
        g.save();
        g.setTransform(M[0],M[3],M[1],M[4], (M[2]-minX)+railW, (M[5]-minY)-y0);
        if(expo&&gain!==1)g.filter=`brightness(${gain})`;
        g.drawImage(off,0,0);
        g.restore();
      }
      if(railW){g.save();g.translate(0,-y0);drawRail(g,railW,H);g.restore();}
      return g.getImageData(0,0,outW,h).data;
    };
    const parts=await encodePNG(outW,H,getBand,null,f=>setProg(0.02+0.96*f,`Encoding full PNG — ${Math.round(f*100)}%`));
    const blob=new Blob(parts,{type:"image/png"});
    setProg(1,"Done.");setTimeout(()=>$("#prog").style.display="none",400);
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob);a.download="section-full.png";
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),60000);
    if(dlfull)dlfull.textContent=`⬇ Full-resolution PNG (${outW}×${H})`;
    banner("info",`Exported the full-resolution column: ${outW}×${H}px, ${(blob.size/1e6).toFixed(1)} MB.`);
  }catch(err){
    $("#prog").style.display="none";
    if(dlfull)dlfull.textContent="⬇ Full-resolution PNG";
    banner("warn","Full-resolution export failed: "+(err&&err.message||err)+". Lower the working resolution and re-stitch.");
  }
}
