/* ============================================================================
   XFeat neural matcher — PWA runtime layer (WebGPU-first, WASM fallback).

   Differences from the artifact version:
   - Runs in real Safari (iOS 26+), so WebGPU/Metal is available: ~20× faster than
     multi-threaded WASM and ~550× vs single-threaded, with far more memory headroom.
   - The model + ONNX runtime are served from this app's own origin and cached by the
     service worker, so after first load everything is offline with no file picker.
   - Model is fetched from ./models/xfeat.onnx (bundle it there when you host).
   ============================================================================ */
export const XF = {
  ort:null, sess:null, inName:null, outNames:null, chan:3, ready:false,
  backend:"(none)", INFER_CAP:1600,   // higher cap is safe on GPU
  MODEL_URL:"./models/xfeat.onnx",
  ORT_URL:"https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js",
  WASM_PATHS:"https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/",
};

function loadORT(){return new Promise((ok,no)=>{
  if(window.ort) return ok(window.ort);
  const s=document.createElement("script");
  s.src=XF.ORT_URL;
  s.onload=()=>{ try{ if(window.ort?.env?.wasm) window.ort.env.wasm.wasmPaths=XF.WASM_PATHS; }catch(_){}
                ok(window.ort); };
  s.onerror=()=>no(new Error("couldn't load the ONNX runtime (needs network once, then cached)"));
  document.head.appendChild(s);
});}

async function hasWebGPU(){
  if(!("gpu" in navigator)) return false;
  try{ const a=await navigator.gpu.requestAdapter(); return !!a; }catch(_){ return false; }
}

/* Create the session, WebGPU first with WASM fallback. Returns the backend actually used. */
export async function xfeatInit(onStatus){
  if(XF.ready) return XF.backend;
  const ort=await loadORT(); XF.ort=ort;
  if(!ort?.InferenceSession) throw new Error("ONNX runtime unavailable");
  onStatus && onStatus("Fetching model…");
  const resp=await fetch(XF.MODEL_URL);
  if(!resp.ok) throw new Error("model not found at "+XF.MODEL_URL+" (did you add models/xfeat.onnx?)");
  const bytes=new Uint8Array(await resp.arrayBuffer());

  const tryCreate=async(eps)=>ort.InferenceSession.create(bytes,{executionProviders:eps,graphOptimizationLevel:"all"});
  const gpu=await hasWebGPU();
  try{
    if(gpu){ onStatus && onStatus("Initializing GPU (WebGPU/Metal)…");
      XF.sess=await tryCreate(["webgpu","wasm"]); XF.backend="webgpu"; }
    else   { onStatus && onStatus("Initializing CPU (WASM)…");
      try{ ort.env.wasm.numThreads=navigator.hardwareConcurrency>1?2:1; }catch(_){}
      XF.sess=await tryCreate(["wasm"]); XF.backend="wasm"; }
  }catch(e){
    onStatus && onStatus("GPU path failed, using CPU…");
    XF.sess=await tryCreate(["wasm"]); XF.backend="wasm";
  }
  XF.inName=XF.sess.inputNames[0];
  XF.outNames=XF.sess.outputNames.slice();
  XF.chan=3;
  try{ const md=XF.sess.inputMetadata, meta=md&&(md[XF.inName]||md[0]);
    const dims=meta&&(meta.dimensions||meta.shape||meta.dims);
    if(dims&&dims.length>=2&&typeof dims[1]==="number"&&dims[1]>0)XF.chan=dims[1];
  }catch(_){}
  XF.ready=true;

  // Warm up: first inference compiles GPU shaders (50-200ms). Do it on a tiny dummy input
  // so the first real frame isn't janky.
  try{
    onStatus && onStatus("Warming up shaders…");
    const W=64,H=64,d=new Float32Array(XF.chan*W*H);
    const t=new ort.Tensor("float32",d,[1,XF.chan,H,W]);
    const feeds={}; feeds[XF.inName]=t;
    const o=await XF.sess.run(feeds);
    for(const nm of XF.outNames){ try{o[nm]?.dispose?.();}catch(_){} }
    try{t.dispose?.();}catch(_){}
  }catch(_){}
  return XF.backend;
}

function xfeatTensor(srcCanvas,maxW,chan){
  const iw=srcCanvas.width, ih=srcCanvas.height;
  const cap=Math.min(maxW, XF.INFER_CAP||maxW);
  const s=Math.min(1,cap/Math.max(iw,ih));
  const W=Math.max(32,Math.round(iw*s/32)*32), H=Math.max(32,Math.round(ih*s/32)*32);
  const c=document.createElement("canvas");c.width=W;c.height=H;
  const x=c.getContext("2d",{willReadFrequently:true});
  x.imageSmoothingQuality="high";x.drawImage(srcCanvas,0,0,W,H);
  const d=x.getImageData(0,0,W,H).data;
  const N=W*H, f=new Float32Array(chan*N);
  if(chan===1){ for(let p=0,k=0;p<N;p++,k+=4)f[p]=(0.299*d[k]+0.587*d[k+1]+0.114*d[k+2])/255; }
  else { for(let p=0,k=0;p<N;p++,k+=4){f[p]=d[k]/255;f[N+p]=d[k+1]/255;f[2*N+p]=d[k+2]/255;} }
  c.width=c.height=0;
  return {data:f,W,H,C:chan,sx:iw/W,sy:ih/H};
}

export async function xfeatDetectDescribe(workCanvas,maxW,topk){
  const ort=XF.ort, T=xfeatTensor(workCanvas,maxW,XF.chan||3);
  const inputT=new ort.Tensor("float32",T.data,[1,T.C,T.H,T.W]);
  const feeds={}; feeds[XF.inName]=inputT;
  const out=await XF.sess.run(feeds);
  try{ return xfeatExtract(out,T,topk,workCanvas); }
  finally{
    try{inputT.dispose?.();}catch(_){}
    for(const nm of XF.outNames){ try{out[nm]?.dispose?.();}catch(_){} }
    T.data=null;
  }
}

function xfeatExtract(out,T,topk,workCanvas){
  const cand=XF.outNames.map(nm=>({nm,t:out[nm],d:(out[nm]&&out[nm].dims)||[]}));
  // Sparse format: keypoints[N,2], descriptors[N,>=16], scores[N]
  const kpT=cand.find(c=>c.d.length===2&&c.d[1]===2);
  const descT=cand.find(c=>c.d.length===2&&c.d[1]>=16);
  const scoreT=cand.find(c=>c.d.length===1);
  if(kpT&&descT){
    const N=descT.d[0], dim=descT.d[1], kp=kpT.t.data, dd=descT.t.data, sc=scoreT?scoreT.t.data:null;
    const mx=T.sx, my=T.sy;
    const order=[...Array(N).keys()]; if(sc) order.sort((a,b)=>sc[b]-sc[a]);
    const budget=Math.min(Math.max(topk,4000), N, 8000);
    const bw=Math.max(1,Math.round(workCanvas.width/24)), bh=Math.max(1,Math.round(workCanvas.height/24));
    const gw=Math.max(1,Math.ceil(workCanvas.width/bw)), gh=Math.max(1,Math.ceil(workCanvas.height/bh));
    const perCell=Math.max(2,Math.ceil(budget/(gw*gh)*1.4)), cc=new Uint16Array(gw*gh);
    const keep=[];
    for(let n=0;n<order.length&&keep.length<budget;n++){
      const i=order[n], x=kp[i*2]*mx, y=kp[i*2+1]*my;
      const gi=Math.min(gh-1,(y/bh)|0)*gw+Math.min(gw-1,(x/bw)|0);
      if(sc&&cc[gi]>=perCell)continue; cc[gi]++; keep.push(i);
    }
    const K=keep.length, desc=new Float32Array(K*dim), pts=new Array(K);
    for(let n=0;n<K;n++){ const i=keep[n];
      let nrm=0;for(let ch=0;ch<dim;ch++){const v=dd[i*dim+ch];nrm+=v*v;} nrm=Math.sqrt(nrm)||1;
      for(let ch=0;ch<dim;ch++)desc[n*dim+ch]=dd[i*dim+ch]/nrm;
      pts[n]={x:kp[i*2]*mx, y:kp[i*2+1]*my};
    }
    return {pts,desc:{data:desc,dim,float:true,absGate:0.9,guidedGate:1.1},count:K};
  }
  // Dense grid fallback [1,C,Hc,Wc]
  let feats=null,heat=null;
  for(const c of cand){
    if(c.d.length===4&&c.d[1]>=16&&c.d[1]<=512&&c.d[1]!==65){
      if(!feats||(c.d[1]*c.d[2]*c.d[3]>feats.dims[1]*feats.dims[2]*feats.dims[3]))feats=c.t; }
    if((c.d.length===4&&c.d[1]===1)||c.d.length===3)heat=c.t;
  }
  if(!feats){ for(const c of cand){ if(c.d.length===4&&c.d[1]!==65){feats=c.t;break;} } }
  if(!feats){ throw new Error("couldn't find descriptor output: "+cand.map(c=>`${c.nm}[${c.d.join(",")}]`).join(" ")); }
  const [_,C,Hc,Wc]=feats.dims, fd=feats.data;
  const scaleX=T.sx*(T.W/Wc), scaleY=T.sy*(T.H/Hc), cells=Hc*Wc, score=new Float32Array(cells);
  if(heat){const hd=heat.data;for(let i=0;i<cells;i++)score[i]=hd[i];}
  else{for(let i=0;i<cells;i++){let s=0;for(let ch=0;ch<C;ch++){const v=fd[ch*cells+i];s+=v*v;}score[i]=s;}}
  const budget=Math.min(Math.max(topk,Math.round(cells/4)),8000);
  const idx=Array.from(score.keys()).sort((a,b)=>score[b]-score[a]);
  const CELL=2, gw=Math.ceil(Wc/CELL), gh=Math.ceil(Hc/CELL);
  const perCell=Math.max(2,Math.ceil(budget/(gw*gh)*1.4)), cc=new Uint16Array(gw*gh), keepIdx=[];
  for(let n=0;n<idx.length&&keepIdx.length<budget;n++){
    const i=idx[n],cx=i%Wc,cy=(i/Wc)|0,gi=((cy/CELL)|0)*gw+((cx/CELL)|0);
    if(cc[gi]>=perCell)continue;cc[gi]++;keepIdx.push(i);
  }
  const K=keepIdx.length,dim=C,desc=new Float32Array(K*dim),pts=new Array(K);
  for(let n=0;n<K;n++){const i=keepIdx[n],cx=i%Wc,cy=(i/Wc)|0;
    let nrm=0;for(let ch=0;ch<dim;ch++){const v=fd[ch*cells+i];nrm+=v*v;}nrm=Math.sqrt(nrm)||1;
    for(let ch=0;ch<dim;ch++)desc[n*dim+ch]=fd[ch*cells+i]/nrm;
    pts[n]={x:(cx+0.5)*scaleX,y:(cy+0.5)*scaleY};}
  return {pts,desc:{data:desc,dim,float:true,absGate:0.9,guidedGate:1.1},count:K};
}
