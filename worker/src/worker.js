/* =========================================================
   ANDREW LE SCANNER — Bot nền 24/7 (Cloudflare Worker)
   Full-auto trên TÀI KHOẢN ẢO. Quét EMA34/89 đa khung H4+H1,
   tự mở/đóng lệnh theo quy tắc Underground, báo Telegram.
   Dữ liệu: Binance (crypto) + Twelve Data (vàng/forex).
   State lưu trong Cloudflare KV (binding tên: STATE).
   Cron khuyến nghị: mỗi 15 phút.

   CẬP NHẬT:
   - 40 coin crypto + giữ forex.
   - QUÉT XOAY VÒNG: luôn theo dõi lệnh đang mở + forex,
     mỗi lượt quét thêm 1 nhóm coin -> tránh trần 50 subrequest
     của Cloudflare free, phủ hết danh mục sau ~1 giờ.
   - Gắn NHÃN TÍN HIỆU (sig) cho mỗi lệnh -> bảng Hiệu suất
     bóc tách được theo loại setup (canh mua / vùng giá trị).
   - /status trả về vốn gốc + toàn bộ lịch sử để phân tích.
   ========================================================= */

// ====== CẤU HÌNH (sửa ở đây nếu muốn) ======
const CFG = {
  TG_TOKEN: "8812877418:AAGKENG1iJNoUBPoZ64600fW67ArHkws89U",
  TG_CHAT: "1030359975",
  TWELVE_KEY: "a47179c6317e4dcaace852aa64da73ef",
  RISK_PCT: 2,          // % rủi ro mỗi lệnh trên equity
  MAX_MARGIN_PCT: 10,   // ký quỹ tối đa mỗi lệnh (% tài khoản)
  FEE_PCT: 0.05,        // phí giao dịch mỗi lần vào/ra (% notional)
  DEFAULT_LEV: 1,       // đòn bẩy mặc định
  MAX_OPEN: 8,          // số lệnh mở tối đa cùng lúc
  START_BALANCE: 1000000,
  MAX_SUBREQ: 46,       // trần lượt gọi mạng an toàn mỗi lượt chạy (Cloudflare free ~50)
  MIN_BATCH: 6,         // số coin tối thiểu quét mới mỗi lượt
  TD_BUDGET: 8,         // trần lượt gọi Twelve Data mỗi lượt chạy (forex+CK, ~8/phút free)
  TD_DAILY_CAP: 700,    // trần lượt gọi Twelve Data mỗi NGÀY (gói free 800, chừa 100 dự phòng)
  TD_NEW_EVERY_MIN: 30, // chỉ quét mã forex/CK MỚI mỗi N phút; mã đang có lệnh vẫn quét mỗi lượt
  // --- v3 (15/10/2026): tinh chỉnh từ phân tích 228 lệnh ---
  EARLY_EXIT: false,    // false = KHÔNG đóng lệnh khi gãy xu hướng, chỉ dời SL về hoà vốn nếu đang lãi.
                        //   Lý do: 115 lệnh "THOÁT SỚM" thắng 1%, lỗ -33.264 (nhánh lỗ lớn nhất hệ thống).
  // --- v4 (25/10/2026): sửa lỗi cấu trúc RR phát hiện sau 8 lệnh chạy v3 ---
  // v3 đặt TP1_MAX_R=1.2 + chốt 50% + trailing 1R => lãi điển hình chỉ 0.5*1.2 = 0.60R,
  // trong khi mỗi lệnh thua đủ -1R => CẦN WIN RATE 62% MỚI HOÀ. Hệ trend-following
  // thực tế thắng 30-40% nên cấu trúc đó chắc chắn âm (8 lệnh v3: -0.29R/lệnh, thắng 38%).
  // Cả 2 lệnh TRAILING của v3 đều bị quét ngay về entry (nửa sau ăn ~0.0R) vì trailing
  // distance = 1R bằng đúng khoảng cách SL, giá hồi 1R là bình thường với crypto.
  TP1_MAX_R: 2.5,       // trần khoảng cách TP1 theo R. 2.5R => cần win ~44% để hoà (xem bảng trong chat).
                        //   Vẫn giữ trần để long không quay lại cảnh TP1 Fibo xa 6R+ (chỉ 16% chạm tới).
  TRAIL_R: 1.5,         // khoảng cách trailing sau TP1, tính theo R. 1R quá chặt -> nửa sau luôn hoà vốn.
  TP1_FRAC: 0.4,        // tỷ lệ chốt tại TP1 (trước 0.5). Giữ lại nhiều hơn cho nhánh chạy dài.
  VGT_NEED_HOITU: true, // vgt chỉ vào lệnh khi có hội tụ đáy (vgt: 66 lệnh, thắng 15%, -186;
                        //   riêng yếu tố "hội tụ đáy" TB +104 vs -38 khi không có)
  STOCK_ON: false,      // tắt CK Mỹ: 6 lệnh, -1.570, dữ liệu quá mỏng và lệch (TSLA -1.117 do gap)
  // Danh mục theo dõi — 40 coin thanh khoản cao:
  CRYPTO: [
    "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","ADAUSDT","DOGEUSDT","AVAXUSDT",
    "NEARUSDT","APTUSDT","SUIUSDT","TONUSDT","LINKUSDT","DOTUSDT","LTCUSDT","ATOMUSDT",
    "UNIUSDT","ARBUSDT","OPUSDT","INJUSDT","TIAUSDT","SEIUSDT","AAVEUSDT","FILUSDT",
    "ICPUSDT","ETCUSDT","HBARUSDT","RUNEUSDT","LDOUSDT","IMXUSDT","STXUSDT","FETUSDT",
    "GALAUSDT","SANDUSDT","CRVUSDT","MKRUSDT",
    "SHIBUSDT","PEPEUSDT","WIFUSDT","BONKUSDT"
  ],
  FOREX:  ["XAU/USD","EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD"],
  STOCK:  ["AAPL","MSFT","NVDA","TSLA","AMZN","GOOGL","META","SPY"],
};

// Đa nguồn dữ liệu crypto (Binance chặn IP Cloudflare -> ưu tiên Bybit/OKX)
const CRYPTO_SOURCES = [
  { name:"bybit",
    url:(sym,iv,lim)=>`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${iv==="4h"?"240":"60"}&limit=${lim}`,
    parse:(j)=> (j&&j.result&&Array.isArray(j.result.list)) ? j.result.list.slice().reverse().map(x=>({h:+x[2],l:+x[3],c:+x[4]})) : null },
  { name:"okx",
    url:(sym,iv,lim)=>`https://www.okx.com/api/v5/market/candles?instId=${sym.replace(/USDT$/,"-USDT")}&bar=${iv==="4h"?"4H":"1H"}&limit=${Math.min(lim,300)}`,
    parse:(j)=> (j&&Array.isArray(j.data)) ? j.data.slice().reverse().map(x=>({h:+x[2],l:+x[3],c:+x[4]})) : null },
  { name:"binance",
    url:(sym,iv,lim)=>`https://data-api.binance.vision/api/v3/klines?symbol=${sym}&interval=${iv}&limit=${lim}`,
    parse:(j)=> Array.isArray(j) ? j.map(x=>({h:+x[2],l:+x[3],c:+x[4]})) : null },
];
let CRYPTO_SRC = 0; // nguồn ưu tiên (ghi nhớ trong lúc chạy + lưu state)
const TWELVE  = "https://api.twelvedata.com/time_series";

// ====== CHỈ BÁO ======
function ema(v,p){const k=2/(p+1),o=new Array(v.length).fill(null);let s=0;for(let i=0;i<v.length;i++){if(i<p-1){s+=v[i];continue;}if(i===p-1){s+=v[i];o[i]=s/p;continue;}o[i]=v[i]*k+o[i-1]*(1-k);}return o;}
function macdHist(c){const e12=ema(c,12),e26=ema(c,26);const line=c.map((_,i)=>(e12[i]!=null&&e26[i]!=null)?e12[i]-e26[i]:null);const sig=ema(line.map(x=>x==null?0:x),9);return c.map((_,i)=>(line[i]!=null&&sig[i]!=null)?line[i]-sig[i]:null);}
function pivots(a,k,t){const o=[];for(let i=k;i<a.length-k;i++){let ok=true;for(let j=1;j<=k;j++){if(t==="high"&&!(a[i]>=a[i-j]&&a[i]>=a[i+j]))ok=false;if(t==="low"&&!(a[i]<=a[i-j]&&a[i]<=a[i+j]))ok=false;if(!ok)break;}if(ok)o.push(i);}return o;}
function frame(c,e34,e89){const i=c.length-1,p=c[i],a=e34[i],b=e89[i];if(a==null||b==null)return{state:"NA"};const j=Math.max(0,i-12);const slope=e89[j]?Math.abs(e89[i]-e89[j])/e89[i]:1;const sideway=slope<0.004;const state=(p>a&&p>b)?"UP":(p<a&&p<b)?"DOWN":"MID";return{state,sideway};}
function valueZone(cd,e34,e89){const n=cd.length;if(n<10)return false;const last=cd[n-1];if(!(last.c>e34[n-1]&&last.c>e89[n-1]))return false;for(let i=n-8;i<n;i++){if(e34[i]==null)continue;if(cd[i].l<e34[i]&&cd[i].c>e34[i])return true;}return false;}
function divergence(c,h){const win=70,st=Math.max(0,c.length-win),seg=c.slice(st),hs=h.slice(st);const ph=pivots(seg,3,"high").filter(i=>hs[i]!=null&&hs[i]>0);const pl=pivots(seg,3,"low").filter(i=>hs[i]!=null&&hs[i]<0);let phanKy=false,hoiTu=false;if(ph.length>=2){const[a,b]=ph.slice(-2);if(seg[b]>seg[a]&&hs[b]<hs[a])phanKy=true;}if(pl.length>=2){const[a,b]=pl.slice(-2);if(seg[b]<seg[a]&&hs[b]>hs[a])hoiTu=true;}return{phanKy,hoiTu};}
function fiboPlan(cd){const n=cd.length,look=Math.min(140,n);const seg=cd.slice(n-look);const lows=seg.map(c=>c.l),highs=seg.map(c=>c.h);let iS=0;for(let i=0;i<seg.length;i++)if(lows[i]<lows[iS])iS=i;let iT=iS;for(let i=iS;i<seg.length;i++)if(highs[i]>highs[iT])iT=i;if(iT-iS<5)return null;let iC=iT;for(let i=iT;i<seg.length;i++)if(lows[i]<lows[iC])iC=i;const start=lows[iS],top=highs[iT],c2=lows[iC],range=top-start;if(range<=0)return null;const ext=[1,1.618,2.618].map(r=>c2+r*range);return{ext};}

// ====== DỮ LIỆU ======
async function klinesCrypto(sym,interval,limit){
  const order=[CRYPTO_SRC, ...CRYPTO_SOURCES.map((_,i)=>i).filter(i=>i!==CRYPTO_SRC)];
  const errs=[];
  for(const i of order){
    const src=CRYPTO_SOURCES[i];
    try{
      const r=await fetch(src.url(sym,interval,limit));
      if(r.ok){ const data=src.parse(await r.json()); if(data&&data.length){ CRYPTO_SRC=i; return data; } errs.push(src.name+" rỗng"); }
      else errs.push(src.name+" "+r.status);
    }catch(e){ errs.push(src.name+":"+((e&&e.message)||e)); }
  }
  throw new Error(errs.join(" | "));
}
async function klinesTwelve(sym,interval,size){const r=await fetch(`${TWELVE}?symbol=${encodeURIComponent(sym)}&interval=${interval}&outputsize=${size}&order=ASC&apikey=${CFG.TWELVE_KEY}`);const j=await r.json();if(j.status==="error"||j.code>=400)throw new Error(j.message||"TD error");if(!j.values)throw new Error("no data");return j.values.map(v=>({h:+v.high,l:+v.low,c:+v.close}));}

// v6: tải nhiều nến H1 bằng cách lùi dần mốc thời gian (Bybit trả tối đa 1000/lần,
// mới nhất trước). Trả về mảng [t,h,l,c] theo thứ tự thời gian tăng dần.
async function dumpH1(sym,total){
  const out=[]; let end=null; let guard=0;
  while(out.length<total && guard++<6){
    const lim=Math.min(1000,total-out.length);
    let u=`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=60&limit=${lim}`;
    if(end) u+=`&end=${end}`;
    const r=await fetch(u);
    if(!r.ok) throw new Error("bybit "+r.status);
    const j=await r.json();
    const list=(j&&j.result&&Array.isArray(j.result.list))?j.result.list:[];
    if(!list.length) break;
    const rows=list.map(x=>[+x[0],+x[2],+x[3],+x[4]]).sort((a,b)=>a[0]-b[0]); // cũ -> mới
    out.unshift(...rows);
    end=rows[0][0]-1;                 // lùi về trước nến cũ nhất vừa lấy
    if(list.length<lim) break;        // sàn hết dữ liệu
  }
  if(!out.length) throw new Error("không có dữ liệu");
  return out;
}

// Giờ giao dịch CK Mỹ: 9:30–16:00 giờ New York, T2–T6 (tự xử lý DST qua múi giờ)
function usMarketOpen(){
  try{
    const et=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const day=et.getDay(); if(day===0||day===6) return false;
    const mins=et.getHours()*60+et.getMinutes();
    return mins>=570 && mins<960;
  }catch(e){ return false; }
}

async function analyze(market,sym){
  let h4,h1;
  if(market==="crypto"){[h4,h1]=await Promise.all([klinesCrypto(sym,"4h",220),klinesCrypto(sym,"1h",220)]);}
  else if(market==="stock"){h4=await klinesTwelve(sym,"1day",300);await new Promise(r=>setTimeout(r,300));h1=await klinesTwelve(sym,"1h",300);} // CK Mỹ: D1 + H1
  else{h4=await klinesTwelve(sym,"4h",200);await new Promise(r=>setTimeout(r,300));h1=await klinesTwelve(sym,"1h",200);}
  const c4=h4.map(x=>x.c),c1=h1.map(x=>x.c);
  const e34_4=ema(c4,34),e89_4=ema(c4,89),e34_1=ema(c1,34),e89_1=ema(c1,89);
  const f4=frame(c4,e34_4,e89_4),f1=frame(c1,e34_1,e89_1);
  const div=divergence(c4,macdHist(c4));
  const vgt=(f4.state==="UP")&&valueZone(h1,e34_1,e89_1);
  let cls;
  // 1. Ưu tiên xu hướng đồng nhất (UP hoặc DOWN)
  if(f4.state==="UP"&&f1.state==="UP"){
    cls = div.phanKy ? "wait" : (vgt ? "vgt" : "buy");      // long: gặp phân kỳ đỉnh thì đợi
  }
  else if(f4.state==="DOWN"&&f1.state==="DOWN"){
    cls = div.hoiTu ? "wait" : "short";                     // short: gặp hội tụ đáy thì đợi
  }
  // 2. Không đồng nhất xu hướng -> mới xét sideway
  else if(f4.sideway||f1.sideway){
    cls = "sw";
  }
  // 3. Nhiễu (vd H4 UP nhưng H1 DOWN)
  else {
    cls = "wait";
  }
  const price=c4[c4.length-1];
  const fib=fiboPlan(h4);
  return {sym,market,price,cls,div,vgt,fib,h4,e89_1,f4s:f4.state,f1s:f1.state,sideway:!!(f4.sideway||f1.sideway)};
}

// ====== TELEGRAM ======
async function tg(text){
  try{
    await fetch(`https://api.telegram.org/bot${CFG.TG_TOKEN}/sendMessage`,{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:CFG.TG_CHAT,text,parse_mode:"HTML",disable_web_page_preview:true})
    });
  }catch(e){}
}
const fmt=n=>{if(n==null||isNaN(n))return"—";const a=Math.abs(n),d=a>=1000?2:a>=1?4:a>=0.01?6:8;return Number(n).toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:d});};
const money=n=>Number(n).toLocaleString("en-US",{maximumFractionDigits:2});

// nhãn tín hiệu hiển thị
const SIG_LABEL={buy:"Canh mua",vgt:"Vùng giá trị",short:"Canh short",sw:"Sideway",wait:"Chờ"};

// ====== ĐIỂM KỸ THUẬT (Win Score) ======
// Trả về {score: 0-100, factors: [...string]} — heuristic, không phải xác suất thống kê
function calcWinScore(r, btcRegime, rr){
  // v3: trọng số hiệu chỉnh theo 228 lệnh thực tế. Thang cũ chấm NGƯỢC
  // (nhóm 90-104đ: TB -155, win 17%; nhóm 60-74đ: TB +101, win 39%).
  // Điểm này CHỈ ĐỂ GHI LOG, không dùng lọc lệnh — cần ~100 lệnh nữa mới nên tin.
  const long = r.cls==="buy"||r.cls==="vgt";
  const short = r.cls==="short";
  let score=40; const factors=[];

  // H4+H1 đồng hướng: luôn đúng với mọi lệnh vào -> gần như không phân biệt được gì
  if((long&&r.f4s==="UP"&&r.f1s==="UP")||(short&&r.f4s==="DOWN"&&r.f1s==="DOWN")){
    score+=10; factors.push("H4+H1 đồng hướng +10");
  }
  // BTC regime: đo được TB -11 (cùng chiều) vs -30 (không có) -> yếu, hạ từ 20 xuống 5
  if(r.market==="crypto"&&btcRegime){
    if((long&&btcRegime==="UP")||(short&&btcRegime==="DOWN")){
      score+=5; factors.push("BTC cùng chiều +5");
    } else {
      score-=15; factors.push("BTC ngược chiều -15");
    }
  }
  // Sideway: ĐẢO DẤU so với bản cũ. Đo được: sideway TB +35, không sideway TB -99
  if(!r.sideway){ score-=5; factors.push("Không sideway -5"); }
  else { score+=5; factors.push("Sideway +5"); }
  // Hội tụ đáy: yếu tố mạnh nhất (TB +104 vs -38) -> nâng lên 20
  if(long&&r.div&&r.div.hoiTu){ score+=20; factors.push("Hội tụ đáy +20"); }
  // Phân kỳ đỉnh: đo được gần như trung tính (TB -24 vs -15) -> hạ xuống 5
  if(short&&r.div&&r.div.phanKy){ score+=5; factors.push("Phân kỳ đỉnh +5"); }
  // vgt: bỏ điểm cộng (vgt thắng 15%, -186 trên 66 lệnh)
  if(r.cls==="vgt"){ factors.push("Vùng giá trị +0"); }
  // RR: chỉ thưởng nhẹ khi RR cao, không phạt RR thấp (dữ liệu nhiễu, RR<2 lại TB +201)
  if(rr>=3){ score+=5; factors.push("RR≥3 +5"); }
  else { factors.push("RR "+(rr>=2?"≥2":"<2")+" +0"); }

  score=Math.max(5,Math.min(95,Math.round(score)));
  return {score, factors};
}

// ====== STATE ======
async function loadState(env){
  let s=null;
  try{s=await env.STATE.get("paper",{type:"json"});}catch(e){}
  if(!s)s={balance:CFG.START_BALANCE,start:CFG.START_BALANCE,positions:[],history:[],lastSig:{},scanIdx:0};
  if(s.scanIdx==null)s.scanIdx=0;
  return s;
}
async function saveState(env,s){ try{await env.STATE.put("paper",JSON.stringify(s));}catch(e){} }
function equity(s){let v=0;s.positions.forEach(p=>{v+=p.margin+unreal(p);});return s.balance+v;}
function unreal(p){const d=p.side==="long"?1:-1;return d*(p.last-p.entry)*p.qtyLeft;}
function getCfg(s){return {riskPct:(s.cfg&&s.cfg.riskPct!=null)?s.cfg.riskPct:CFG.RISK_PCT, marginMax:(s.cfg&&s.cfg.marginMax!=null)?s.cfg.marginMax:Math.round(CFG.START_BALANCE*CFG.MAX_MARGIN_PCT/100), paused:!!(s.cfg&&s.cfg.paused), feePct:(s.cfg&&s.cfg.feePct!=null)?s.cfg.feePct:CFG.FEE_PCT, sigOff:(s.cfg&&Array.isArray(s.cfg.sigOff))?s.cfg.sigOff:[], earlyExit:(s.cfg&&s.cfg.earlyExit!=null)?!!s.cfg.earlyExit:CFG.EARLY_EXIT, tp1R:(s.cfg&&s.cfg.tp1R!=null)?s.cfg.tp1R:CFG.TP1_MAX_R, vgtHoiTu:(s.cfg&&s.cfg.vgtHoiTu!=null)?!!s.cfg.vgtHoiTu:CFG.VGT_NEED_HOITU, stockOn:(s.cfg&&s.cfg.stockOn!=null)?!!s.cfg.stockOn:CFG.STOCK_ON, trailR:(s.cfg&&s.cfg.trailR!=null)?s.cfg.trailR:CFG.TRAIL_R, tp1Frac:(s.cfg&&s.cfg.tp1Frac!=null)?s.cfg.tp1Frac:CFG.TP1_FRAC, marginPct:(s.cfg&&s.cfg.marginPct!=null)?s.cfg.marginPct:null};}
function feeFrac(s){return ((s.cfg&&s.cfg.feePct!=null)?s.cfg.feePct:CFG.FEE_PCT)/100;}

// ====== ENGINE ======
function buildOrder(s,r){
  const long = r.cls==="buy"||r.cls==="vgt";
  const price=r.price;
  let sl,tp1,tp2;
  if(long){
    const recentLow=Math.min(...r.h4.slice(-20).map(x=>x.l));
    sl=Math.min(recentLow, r.e89_1[r.e89_1.length-1]||recentLow)*0.997;
    // v3: TP1 phải nằm trong tầm với (trần TP1_MAX_R lần R), nếu không long gần như
    // không bao giờ chạm TP1 -> không dời SL về hoà vốn -> không bật trailing.
    const R=price-sl;
    const tp1R=(s.cfg&&s.cfg.tp1R!=null)?s.cfg.tp1R:CFG.TP1_MAX_R;
    let fibT1=null,fibT2=null;
    if(r.fib){const above=r.fib.ext.filter(p=>p>price*1.005);if(above.length){fibT1=above[0];fibT2=above[1]||null;}}
    if(R>0){
      const capDist=tp1R*R;
      const fibDist=(fibT1!=null)?(fibT1-price):Infinity;
      tp1=price+Math.min(capDist,fibDist);
      tp2=(fibT2!=null&&fibT2>tp1*1.005)?fibT2:((fibT1!=null&&fibT1>tp1*1.005)?fibT1:price+2.5*R);
      if(!(tp2>tp1*1.005))tp2=price+Math.max(tp1R*2, tp1R+1.5)*R;  // v6: fallback cũ có thể cho tp2 == tp1
    }
    if(!tp1||!(tp1>price)){tp1=price*1.02;tp2=price*1.05;}
  }else{
    const recentHigh=Math.max(...r.h4.slice(-12).map(x=>x.h));
    sl=Math.max(recentHigh, r.e89_1[r.e89_1.length-1]||recentHigh)*1.003;
    // v6: SHORT dùng cùng TP1_MAX_R như long. Trước đây short để TP1 = 1R cố định,
    // trong khi trailing = 1.5R — rộng hơn cả TP1 — nên sau khi chốt một phần, SL của
    // short không bao giờ nhích nổi khỏi hoà vốn. Backtest: short trailing 0,40R -> 2,08R.
    const R=sl-price;
    const tp1Rs=(s.cfg&&s.cfg.tp1R!=null)?s.cfg.tp1R:CFG.TP1_MAX_R;
    tp1=price-tp1Rs*R;
    tp2=price-Math.max(tp1Rs*2, tp1Rs+1.5)*R;
    if(!(tp1>0))tp1=price*0.97;
    if(!(tp2>0))tp2=price*0.94;
  }
  const lev=CFG.DEFAULT_LEV;
  const eq=equity(s);
  const riskPct  = (s.cfg && s.cfg.riskPct!=null)  ? s.cfg.riskPct  : CFG.RISK_PCT;
  // v5: trần ký quỹ tính theo % EQUITY (co giãn theo tài khoản), ưu tiên hơn marginMax tuyệt đối.
  // marginMax=10.000 cũ là số cứng, không co giãn, và âm thầm vô hiệu hoá riskPct:
  // risk 2% của 1M = 20.000, nhưng ký quỹ bị cắt còn 10.000 -> với SL cách 10% thì
  // lỗ thật mỗi lệnh chỉ 1.000 = 0,1% tài khoản, không phải 2%.
  const marginPct=(s.cfg && s.cfg.marginPct!=null)? s.cfg.marginPct : null;
  const marginMax = (marginPct!=null) ? eq*marginPct/100
                  : (s.cfg && s.cfg.marginMax!=null) ? s.cfg.marginMax
                  : eq*CFG.MAX_MARGIN_PCT/100;
  const dist=Math.abs(price-sl), riskAmt=eq*riskPct/100;
  const qty=dist>0?riskAmt/dist:0, notional=qty*price;
  let margin=lev>0?notional/lev:notional;
  const cap=marginMax;
  if(!isFinite(margin)||margin<=0)margin=cap;
  margin=Math.max(1,Math.min(margin,cap,s.balance));
  const realQty=(margin*lev)/price;
  const liq=long?price*(1-1/lev*0.97):price*(1+1/lev*0.97);
  return {id:Date.now()+Math.floor(Math.random()*1000),market:r.market,sym:r.sym,side:long?"long":"short",sig:r.cls,entry:price,sl,slOrig:sl,tp1,tp2,lev,margin,marginInit:margin,qtyTotal:realQty,qtyLeft:realQty,liq,tp1Hit:false,last:price,opened:Date.now(),winScore:null}; // winScore gán sau khi buildOrder
}
function pnlClose(p,price,liq){const d=p.side==="long"?1:-1;if(liq)return -p.marginInit;const fr=(p.tp1Frac!=null)?p.tp1Frac:0.5;const t1=p.tp1Hit?d*(p.tp1-p.entry)*(p.qtyTotal*fr):0;return t1+d*(price-p.entry)*p.qtyLeft;}

async function managePosition(s,pos,r,events){
  const price=r.price;
  pos.last=price;
  const long=pos.side==="long",d=long?1:-1, f=feeFrac(s);

  // Dùng nến H4 gần nhất để phát hiện TP/SL bị chạm giữa 2 lần quét (price gap fix)
  const lastCandle=r.h4&&r.h4.length?r.h4[r.h4.length-1]:null;
  const candleHigh=lastCandle?Math.max(lastCandle.h,price):price;
  const candleLow=lastCandle?Math.min(lastCandle.l,price):price;

  // 1) Thanh lý — dùng candleHigh/Low để bắt spike
  if((long&&candleLow<=pos.liq)||(!long&&candleHigh>=pos.liq)){
    const pnl=pnlClose(pos,pos.liq,true); closeIt(s,pos,"THANH LÝ",pos.liq,pnl,0,0,f); events.push(`🔴 <b>THANH LÝ</b> ${pos.sym} ${pos.side.toUpperCase()} ${pos.lev}x · ${money(pnl)}`); return true;
  }
  // 2) Thoát sớm khi xu hướng H4 gãy (chỉ khi chưa dính TP1)
  //    FIX v2: chỉ tính trên NẾN H4 ĐÃ ĐÓNG (bỏ nến đang chạy), mỗi nến H4 chỉ đếm
  //    1 lần (chống đếm trùng do cron 15' quét lệnh mở mọi lượt -> bug cũ: 2 count = 30 phút).
  //    Cần 2 nến H4 ĐÓNG liên tiếp ngược xu hướng (~8 tiếng) mới hành động.
  //    Nếu lệnh đang LÃI: không đóng, chỉ dời SL về hoà vốn để tự bảo vệ.
  if(!pos.tp1Hit && r.h4 && r.h4.length>90){
    const c4=r.h4.map(x=>x.c), e34c=ema(c4,34), e89c=ema(c4,89);
    const ci=c4.length-2; // nến H4 đã đóng gần nhất
    const brokenClosed=(e34c[ci]!=null&&e89c[ci]!=null) &&
      (long ? (c4[ci]<e34c[ci]&&c4[ci]<e89c[ci]) : (c4[ci]>e34c[ci]&&c4[ci]>e89c[ci]));
    const bucket=Math.floor(Date.now()/(4*3600*1000)); // mã định danh nến H4 hiện tại (mốc UTC 0/4/8h)
    if(brokenClosed){
      if(pos.lastBreakBucket!==bucket){
        pos.trendBreakCount=(pos.trendBreakCount||0)+1;
        pos.lastBreakBucket=bucket;
      }
      if(pos.trendBreakCount>=2){
        const inProfit=d*(price-pos.entry)>0;
        if(inProfit){
          // đang lãi -> giữ lệnh, khoá hoà vốn, để SL/TP tự quyết
          if((long&&pos.sl<pos.entry)||(!long&&pos.sl>pos.entry)){
            pos.sl=pos.entry;
            events.push(`🛡️ <b>GÃY XU HƯỚNG (đang lãi)</b> ${pos.sym} ${pos.side.toUpperCase()} · dời SL về hoà vốn thay vì đóng`);
          }
          pos.trendBreakCount=0; pos.lastBreakBucket=null;
        } else {
          // v3: mặc định KHÔNG cắt khi đang lỗ. Rủi ro đã được định nghĩa bằng SL;
          // cắt tại thị trường chỉ hiện thực hoá lỗ và giết luôn những lệnh sẽ hồi vào trailing.
          const earlyExit=(s.cfg&&s.cfg.earlyExit!=null)?!!s.cfg.earlyExit:CFG.EARLY_EXIT;
          if(earlyExit){
            const pnl=pnlClose(pos,price,false); const rest=d*(price-pos.entry)*pos.qtyLeft; closeIt(s,pos,"THOÁT SỚM",price,pnl,pos.margin,rest,f); events.push(`⚠️ <b>THOÁT SỚM (gãy xu hướng 2 nến H4 đóng)</b> ${pos.sym} ${pos.side.toUpperCase()} · ${money(pnl)}`); return true;
          }
          if(!pos.breakNoted){
            pos.breakNoted=true;
            events.push(`📉 <b>GÃY XU HƯỚNG (đang lỗ)</b> ${pos.sym} ${pos.side.toUpperCase()} · giữ lệnh, để SL ${fmt(pos.sl)} tự quyết`);
          }
          pos.trendBreakCount=0; pos.lastBreakBucket=null;
        }
      }
    } else {
      pos.trendBreakCount=0; pos.lastBreakBucket=null; pos.breakNoted=false;
    }
  }
  // 3) Chạm SL — dùng candleLow/High để bắt spike giữa 2 lần quét, chốt đúng tại giá SL
  if((long&&candleLow<=pos.sl)||(!long&&candleHigh>=pos.sl)){
    const exitPrice=pos.sl;
    const pnl=pnlClose(pos,exitPrice,false); const rest=d*(exitPrice-pos.entry)*pos.qtyLeft; closeIt(s,pos,pos.tp1Hit?"TRAILING":"SL",exitPrice,pnl,pos.margin,rest,f); events.push(`${pnl>=0?"🟡":"🔻"} <b>${pos.tp1Hit?"ĐÓNG (trailing)":"DỪNG LỖ"}</b> ${pos.sym} ${pos.side.toUpperCase()} · ${money(pnl)}`); return true;
  }
  // 4) TP1: chốt 50% — dùng candleHigh/Low để bắt TP chạm giữa 2 lần quét, chốt đúng tại giá TP1
  if(!pos.tp1Hit&&((long&&candleHigh>=pos.tp1)||(!long&&candleLow<=pos.tp1))){
    // v4: chốt theo tỷ lệ cấu hình (mặc định 40%), ghi lại tỷ lệ để pnlClose tính đúng
    const frac=(s.cfg&&s.cfg.tp1Frac!=null)?s.cfg.tp1Frac:CFG.TP1_FRAC;
    const cutQty=pos.qtyTotal*frac, cutM=pos.marginInit*frac, cutP=d*(pos.tp1-pos.entry)*cutQty;
    const feeTp1=cutQty*pos.tp1*f;
    s.balance+=cutM+cutP-feeTp1; pos.fees=(pos.fees||0)+feeTp1;
    pos.qtyLeft-=cutQty; pos.margin-=cutM; pos.tp1Hit=true; pos.tp1Frac=frac; pos.sl=pos.entry;
    pos.R=Math.abs(pos.entry-pos.slOrig);
    events.push(`🟢 <b>TP1</b> ${pos.sym} ${pos.side.toUpperCase()} · chốt ${Math.round(frac*100)}% (+${money(cutP)}), dời SL về hoà vốn + bật trailing`);
  }
  // 5) Sau TP1: trailing stop + check TP2 bằng candle high/low
  if(pos.tp1Hit){
    // TP2: đóng toàn bộ phần còn lại
    if((long&&candleHigh>=pos.tp2)||(!long&&candleLow<=pos.tp2)){
      const exitPrice=pos.tp2;
      const pnl=pnlClose(pos,exitPrice,false); const rest=d*(exitPrice-pos.entry)*pos.qtyLeft; closeIt(s,pos,"TP2",exitPrice,pnl,pos.margin,rest,f); events.push(`🏆 <b>TP2</b> ${pos.sym} ${pos.side.toUpperCase()} · đóng toàn bộ (+${money(pnl)})`); return true;
    }
    // Trailing stop cho 50% còn lại
    // v4: trailing rộng hơn (TRAIL_R lần R) để nửa sau có chỗ thở, thay vì luôn bị quét về entry
    const R=pos.R||Math.abs(pos.entry-pos.slOrig);
    const trailR=(s.cfg&&s.cfg.trailR!=null)?s.cfg.trailR:CFG.TRAIL_R;
    const dTrail=R*trailR;
    if(long){ const t=price-dTrail; if(t>pos.sl)pos.sl=t; }
    else    { const t=price+dTrail; if(t<pos.sl)pos.sl=t; }
  }
  return false;
}
function closeIt(s,pos,reason,price,pnl,returnMargin,restPnl,feeF){
  const exitFee=(feeF||0)*pos.qtyLeft*price;
  s.balance+=returnMargin+restPnl-exitFee;
  pos.fees=(pos.fees||0)+exitFee;
  const net=pnl-(pos.fees||0);
  s.history.unshift({sym:pos.sym,mkt:pos.market,side:pos.side,sig:pos.sig||null,lev:pos.lev,entry:pos.entry,exit:price,reason,pnl:net,phi:+((pos.fees||0)).toFixed(2),opened:pos.opened,closed:Date.now(),winScore:pos.winScore||null,winFactors:pos.winFactors||null});
  if(s.history.length>500)s.history.length=500;
  s.positions=s.positions.filter(p=>p.id!==pos.id);
}

// ====== VÒNG QUÉT CHÍNH (xoay vòng) ======
async function runScan(env){
  const s=await loadState(env);
  if(s.cryptoSrc!=null) CRYPTO_SRC=s.cryptoSrc;
  // Đồng bộ 1 lần khi bật short: xoá bộ nhớ tín hiệu cũ để các tín hiệu hiện tại
  // (kể cả short) được coi là "mới" -> bot vào lệnh thay vì bỏ qua.
  if(!s.resyncShort){ s.lastSig={}; s.resyncShort=true; }
  const paused=!!(s.cfg&&s.cfg.paused);
  const fee=feeFrac(s);
  // Lọc theo "vua" BTC: chỉ long alt khi BTC H4 UP, chỉ short alt khi BTC H4 DOWN
  let btcRegime=null, btcErr=null;
  try{ const bk=await klinesCrypto("BTCUSDT","4h",220); const bc=bk.map(x=>x.c); btcRegime=frame(bc,ema(bc,34),ema(bc,89)).state; }catch(e){ btcErr=String((e&&e.message)||e).slice(0,140); }
  const events=[]; let errCount=0; const errSample=[];

  const openSyms=new Set(s.positions.map(p=>p.sym));
  const usOpen=usMarketOpen();
  const cryptoAll=CFG.CRYPTO.map(sym=>["crypto",sym]);
  // Nhóm TD (Twelve Data): forex luôn có; CK Mỹ chỉ thêm khi sàn Mỹ mở cửa
  const stockOn=(s.cfg&&s.cfg.stockOn!=null)?!!s.cfg.stockOn:CFG.STOCK_ON;   // v3: mặc định tắt CK Mỹ
  const tdAll=[ ...CFG.FOREX.map(sym=>["forex",sym]), ...((usOpen&&stockOn)?CFG.STOCK.map(sym=>["stock",sym]):[]) ];

  // ----- Nhóm TD: 2 trần cùng lúc -----
  //  (a) TD_BUDGET lượt gọi mỗi lần chạy  -> không vượt 8 gọi/phút
  //  (b) TD_DAILY_CAP lượt gọi mỗi NGÀY   -> không vượt 800 gọi/ngày của gói free
  // Trước v5: mỗi lượt cron tiêu đúng 8 gọi, cron 15' => 96×8 = 768/ngày, sát trần 800.
  // Chỉ cần vài lần retry là hết credit và forex chết tới 0h UTC.
  // Nay: mã ĐANG CÓ LỆNH vẫn quét mỗi lượt (để bắt TP/SL), mã MỚI chỉ quét mỗi
  // TD_NEW_EVERY_MIN phút — nến H4 bốn tiếng mới đóng, quét mã mới mỗi 15' là thừa.
  const dayKey=new Date().toISOString().slice(0,10);
  if(s.tdDay!==dayKey){ s.tdDay=dayKey; s.tdCalls=0; }          // reset theo ngày UTC
  const tdUsed=s.tdCalls||0;

  const tdOpen=tdAll.filter(([m,sym])=>openSyms.has(sym));        // lệnh mở -> luôn quản lý
  const tdPool=tdAll.filter(([m,sym])=>!openSyms.has(sym));       // còn lại -> xoay vòng
  const tdEveryMin=(s.cfg&&s.cfg.tdEveryMin!=null)?s.cfg.tdEveryMin:CFG.TD_NEW_EVERY_MIN;
  const tdBucket=Math.floor(Date.now()/(tdEveryMin*60*1000));
  const dueForNew = (s.tdBucket!==tdBucket);

  // chừa credit cho lệnh đang mở tới hết ngày; chỉ quét mã mới khi còn dư thoải mái
  const tdRoomLeft=CFG.TD_DAILY_CAP-tdUsed;
  const canScanNew = dueForNew && tdRoomLeft > (tdOpen.length*2 + 40);

  let tdNewN = canScanNew ? Math.max(0, Math.floor((CFG.TD_BUDGET - tdOpen.length*2)/2)) : 0;
  s.tdIdx=s.tdIdx||0;
  const tdStart=tdPool.length ? (s.tdIdx % tdPool.length) : 0;
  const tdBatch=[];
  for(let i=0;i<Math.min(tdNewN,tdPool.length);i++) tdBatch.push(tdPool[(tdStart+i)%tdPool.length]);
  // Sắp cạn credit: giãn cả việc theo dõi lệnh mở xuống cùng nhịp tdEveryMin, thay vì
  // để cạn hẳn rồi mù tịt 9 tiếng cuối ngày. Nến H4 + candleHigh/Low vẫn bắt được TP/SL
  // chạm giữa hai lần quét, nên quét thưa chỉ làm trễ việc ghi nhận, không sai PnL.
  const tight = tdRoomLeft < 120 && tdOpen.length > 0;
  const openTasks = (tight && !dueForNew) ? [] : tdOpen;
  if(tdBatch.length){ s.tdIdx=tdPool.length ? (tdStart+tdBatch.length)%tdPool.length : 0; }
  if(tdBatch.length || (tight && dueForNew)) s.tdBucket=tdBucket;
  // cạn hẳn: bỏ cả lệnh mở, tránh gọi vô ích cho tới khi sang ngày mới (0h UTC)
  const tdTasks = (tdRoomLeft<=0) ? [] : [...openTasks, ...tdBatch];
  s.tdCalls = tdUsed + tdTasks.length*2;

  // ----- Nhóm Crypto (Bybit, không giới hạn/phút): xoay vòng theo trần subrequest CF -----
  const cOpen=cryptoAll.filter(([m,sym])=>openSyms.has(sym));
  const cPool=cryptoAll.filter(([m,sym])=>!openSyms.has(sym));
  const tdCalls=tdTasks.length*2;
  let batchN=Math.floor((CFG.MAX_SUBREQ - cOpen.length*2 - tdCalls - 4)/2); // chừa BTC + Telegram
  batchN=Math.max(CFG.MIN_BATCH, Math.min(batchN, cPool.length));
  const startI=cPool.length ? (s.scanIdx % cPool.length) : 0;
  const cBatch=[];
  for(let i=0;i<Math.min(batchN,cPool.length);i++) cBatch.push(cPool[(startI+i)%cPool.length]);
  s.scanIdx=cPool.length ? (startI+cBatch.length)%cPool.length : 0;

  const tasks=[...cOpen, ...cBatch, ...tdTasks];

  for(const [market,sym] of tasks){
    let r;
    try{ r=await analyze(market,sym); }catch(e){ errCount++; if(errSample.length<8) errSample.push(sym+" → "+String((e&&e.message)||e).slice(0,90)); continue; }
    // 1) quản lý lệnh đang mở của mã này
    for(const pos of s.positions.filter(p=>p.sym===sym)){
      await managePosition(s,pos,r,events);
    }
    // 2) tín hiệu mới -> mở lệnh
    const key=market+":"+sym, prev=s.lastSig[key];
    const isSignal=(r.cls==="buy"||r.cls==="vgt"||r.cls==="short");
    const already=s.positions.some(p=>p.sym===sym);
    // lọc theo "vua" BTC cho alt crypto
    let regimeOK=true;
    if(market==="crypto" && sym!=="BTCUSDT" && btcRegime){
      if(r.cls==="buy"||r.cls==="vgt") regimeOK=(btcRegime==="UP");
      else if(r.cls==="short") regimeOK=(btcRegime==="DOWN");
    }
    // vgt chỉ vào khi BTC chắc chắn UP (kể cả khi btcRegime===null do lỗi fetch)
    if(r.cls==="vgt" && btcRegime!=="UP") regimeOK=false;
    // v3: vgt còn phải có hội tụ đáy xác nhận (yếu tố duy nhất thật sự dương trong dữ liệu)
    const vgtNeedHoiTu=(s.cfg&&s.cfg.vgtHoiTu!=null)?!!s.cfg.vgtHoiTu:CFG.VGT_NEED_HOITU;
    if(r.cls==="vgt" && vgtNeedHoiTu && !(r.div&&r.div.hoiTu)) regimeOK=false;
    // Tín hiệu bị tắt qua /config?sigoff=... -> không vào lệnh, ghi shadow log để vẫn đánh giá được
    const sigOff=(s.cfg&&Array.isArray(s.cfg.sigOff))?s.cfg.sigOff:[];
    if(isSignal && regimeOK && sigOff.includes(r.cls) && prev!==r.cls && !already){
      if(!Array.isArray(s.shadow)) s.shadow=[];
      s.shadow.unshift({sym,mkt:market,cls:r.cls,price:r.price,at:Date.now()});
      if(s.shadow.length>200) s.shadow.length=200;
      regimeOK=false;
    }
    if(!paused && isSignal && regimeOK && prev!==r.cls && !already && s.positions.length<CFG.MAX_OPEN){
      const ord=buildOrder(s,r);
      if(ord.margin>=1 && ord.margin<=s.balance){
        const feeIn=ord.qtyTotal*ord.entry*fee;
        const rr=Math.abs(ord.tp2-ord.entry)/Math.abs(ord.entry-ord.sl);
        // Tính điểm kỹ thuật khi mở lệnh
        const ws=calcWinScore(r,btcRegime,rr);
        ord.winScore=ws.score; ord.winFactors=ws.factors;
        s.balance-=ord.margin+feeIn; ord.fees=feeIn; s.positions.push(ord);
        const distToTP1=+(Math.abs(ord.tp1-ord.entry)/ord.entry*100).toFixed(1);
        const distToTP2=+(Math.abs(ord.tp2-ord.entry)/ord.entry*100).toFixed(1);
        const distToSL=+(Math.abs(ord.sl-ord.entry)/ord.entry*100).toFixed(1);
        const scoreBar=ws.score>=70?"🟢":ws.score>=50?"🟡":"🔴";
        events.push(`🆕 <b>MỞ ${ord.side.toUpperCase()}</b> ${sym} ${ord.lev}x\nVào ${fmt(ord.entry)} · SL ${fmt(ord.sl)} (-${distToSL}%) · TP1 ${fmt(ord.tp1)} (+${distToTP1}%) · TP2 ${fmt(ord.tp2)} (+${distToTP2}%)\nKý quỹ ${money(ord.margin)} · RR 1:${rr.toFixed(1)} · ${SIG_LABEL[r.cls]}\n${scoreBar} Điểm kỹ thuật: <b>${ws.score}%</b> · ${ws.factors.join(", ")}`);
      }
    }
    s.lastSig[key]=r.cls;
    if(market!=="crypto") await new Promise(res=>setTimeout(res,500)); // giãn nhịp Twelve Data (forex + CK)
  }

  s.cryptoSrc=CRYPTO_SRC;
  s.lastScan={scanned:tasks.length, errors:errCount, at:Date.now(), src:(CRYPTO_SOURCES[CRYPTO_SRC]||{}).name||null, btc:btcRegime, btcErr, errSample, paused, usOpen, td:tdTasks.length, tdCallsToday:s.tdCalls, tdCapDay:CFG.TD_DAILY_CAP, tdNewScan:tdBatch.length>0};
  await saveState(env,s);
  if(tasks.length && errCount/tasks.length>0.5){ await tg(`⚠️ <b>Cảnh báo dữ liệu</b>: ${errCount}/${tasks.length} mã quét lỗi.\n${btcErr?("BTC: "+btcErr+"\n"):""}${errSample.slice(0,4).join("\n")}`); }
  if(events.length){
    const eq=equity(s);
    const head=`📡 <b>Andrew Le Scanner</b> · ${new Date().toLocaleString("vi-VN",{timeZone:"Asia/Ho_Chi_Minh"})}\nEquity: <b>${money(eq)}$</b> · Khả dụng ${money(s.balance)}$ · Lệnh mở ${s.positions.length}\n────────\n`;
    await tg(head+events.join("\n"));
  }
  return {events:events.length, equity:equity(s), open:s.positions.length, scanned:tasks.length, errors:errCount, btcErr, errSample, batch:cBatch.length+tdBatch.length, crypto:cBatch.length, td:tdTasks.length, usOpen, btc:btcRegime, paused};
}

// ====== HTTP ENDPOINTS (xem trạng thái / test) ======
async function handleHTTP(req,env){
  const url=new URL(req.url);
  if(url.pathname==="/run"){ const res=await runScan(env); return json(res); }
  if(url.pathname==="/status"){
    const s=await loadState(env);
    const posWithDist=s.positions.map(pos=>{
      const p=pos.last||pos.entry, d=pos.side==="long"?1:-1;
      const toTP1=pos.tp1Hit?null:+(Math.abs(pos.tp1-p)/p*100).toFixed(2);
      const toTP2=+(Math.abs(pos.tp2-p)/p*100).toFixed(2);
      const toSL=+(Math.abs(pos.sl-p)/p*100).toFixed(2);
      const pnlPct=+(d*(p-pos.entry)/pos.entry*100).toFixed(2);
      return {...pos, dist:{toTP1,toTP2,toSL,pnlPct}};
    });
    return json({equity:equity(s),balance:s.balance,start:s.start,cfg:getCfg(s),lastScan:s.lastScan||null,positions:posWithDist,history:s.history.slice(0,500),shadow:(s.shadow||[]).slice(0,200)});
  }
  if(url.pathname==="/config"){ const s=await loadState(env); if(!s.cfg)s.cfg={}; const risk=url.searchParams.get("risk"),mm=url.searchParams.get("marginMax"),pa=url.searchParams.get("pause"),fp=url.searchParams.get("feePct"),so=url.searchParams.get("sigoff"); if(risk!=null&&!isNaN(+risk))s.cfg.riskPct=Math.max(0.1,Math.min(50,+risk)); if(mm!=null&&!isNaN(+mm))s.cfg.marginMax=Math.max(1,Math.round(+mm)); if(pa!=null)s.cfg.paused=(pa==="1"||pa==="true"); if(fp!=null&&!isNaN(+fp))s.cfg.feePct=Math.max(0,Math.min(1,+fp)); if(so!=null)s.cfg.sigOff=so.split(",").map(x=>x.trim()).filter(x=>["buy","vgt","short"].includes(x));
    // v3: bật/tắt nhanh các tham số mới mà không cần deploy lại
    const ee=url.searchParams.get("earlyExit"), t1=url.searchParams.get("tp1R"), vh=url.searchParams.get("vgtHoiTu"), st=url.searchParams.get("stockOn");
    if(ee!=null)s.cfg.earlyExit=(ee==="1"||ee==="true");
    if(t1!=null&&!isNaN(+t1))s.cfg.tp1R=Math.max(0.5,Math.min(5,+t1));
    if(vh!=null)s.cfg.vgtHoiTu=(vh==="1"||vh==="true");
    if(st!=null)s.cfg.stockOn=(st==="1"||st==="true");
    const tr=url.searchParams.get("trailR"), tf=url.searchParams.get("tp1Frac");
    if(tr!=null&&!isNaN(+tr))s.cfg.trailR=Math.max(0.3,Math.min(5,+tr));
    if(tf!=null&&!isNaN(+tf))s.cfg.tp1Frac=Math.max(0.1,Math.min(0.9,+tf));
    // v5: marginPct (% equity) — đặt giá trị này sẽ vô hiệu hoá marginMax tuyệt đối
    const mp=url.searchParams.get("marginPct");
    if(mp!=null&&!isNaN(+mp)){ s.cfg.marginPct=Math.max(0.1,Math.min(50,+mp)); delete s.cfg.marginMax; }
    await saveState(env,s); return json({ok:true,cfg:getCfg(s)}); }
  if(url.pathname==="/close"){ const id=url.searchParams.get("id"); const s=await loadState(env); const pos=s.positions.find(p=>String(p.id)===String(id)); if(!pos) return json({ok:false,msg:"không tìm thấy lệnh"}); let price=pos.last; try{ if(pos.market==="crypto"){const k=await klinesCrypto(pos.sym,"1h",2);price=k[k.length-1].c;} else {const k=await klinesTwelve(pos.sym,"1h",2);price=k[k.length-1].c;} }catch(e){} const d=pos.side==="long"?1:-1; const pnl=pnlClose(pos,price,false); const rest=d*(price-pos.entry)*pos.qtyLeft; const netApprox=pnl-((pos.fees||0)+feeFrac(s)*pos.qtyLeft*price); closeIt(s,pos,"ĐÓNG TAY",price,pnl,pos.margin,rest,feeFrac(s)); await saveState(env,s); await tg(`✋ <b>ĐÓNG TAY</b> ${pos.sym} ${pos.side.toUpperCase()} @ ${fmt(price)} · ${money(netApprox)}`); return json({ok:true,sym:pos.sym,exit:price,pnl:+netApprox.toFixed(2)}); }
  if(url.pathname==="/check"){ const sym=url.searchParams.get("sym")||"BTCUSDT"; const market=url.searchParams.get("market")||(CFG.STOCK.includes(sym.toUpperCase())?"stock":(sym.includes("/")?"forex":"crypto")); try{ const r=await analyze(market,sym); const s=await loadState(env); const prev=s.lastSig[market+":"+sym]; const already=s.positions.some(p=>p.sym===sym); const actionable=(r.cls==="buy"||r.cls==="vgt"||r.cls==="short"); return json({sym,market,phanLoai:r.cls,nhan:SIG_LABEL[r.cls]||r.cls,H4:r.f4s,H1:r.f1s,sideway:r.sideway,phanKyDinh:!!(r.div&&r.div.phanKy),hoiTuDay:!!(r.div&&r.div.hoiTu),gia:r.price,tinHieuTruoc:prev||null,dangCoLenh:already,conSlot:s.positions.length<CFG.MAX_OPEN,seMoLenh:actionable&&prev!==r.cls&&!already}); }catch(e){ return json({sym,loi:String((e&&e.message)||e)}); } }
  if(url.pathname==="/reset"){ await saveState(env,{balance:CFG.START_BALANCE,start:CFG.START_BALANCE,positions:[],history:[],lastSig:{},scanIdx:0}); return json({ok:true,msg:"đã reset tài khoản"}); }
  if(url.pathname==="/ping"){ await tg("✅ Bot Andrew Le Scanner đang hoạt động."); return json({ok:true}); }
  // v5: tra ký hiệu thật trên sàn trước khi thêm coin vào danh mục.
  // Dùng khi một mã báo "bybit rỗng | okx rỗng" — nghĩa là ký hiệu sai, không phải sàn hỏng.
  // v6: xuất nến H1 thô để backtest ngoài worker.
  // Chỉ xuất H1 — backtest tự gộp 4 nến H1 thành 1 nến H4, nhờ vậy hai khung
  // luôn khớp nhau tuyệt đối (không lệch do sàn trả mốc thời gian khác nhau).
  // /dump?syms=BTCUSDT,ETHUSDT&n=5000   -> n tối đa 5000 nến H1 (~208 ngày)
  if(url.pathname==="/dump"){
    const syms=(url.searchParams.get("syms")||"").toUpperCase().split(",").map(x=>x.trim()).filter(Boolean);
    const n=Math.max(200,Math.min(5000,+(url.searchParams.get("n")||2000)));
    if(!syms.length) return json({ok:false,msg:"thiếu ?syms=BTCUSDT,ETHUSDT"});
    if(syms.length*Math.ceil(n/1000)>40) return json({ok:false,msg:"quá nhiều: syms × ceil(n/1000) phải ≤ 40"});
    const data={}, errs={};
    for(const sym of syms){
      try{ data[sym]=await dumpH1(sym,n); }
      catch(e){ errs[sym]=String((e&&e.message)||e).slice(0,140); }
    }
    return json({ok:true,interval:"1h",fields:["t","h","l","c"],n,syms:syms.length,data,errs,at:Date.now()});
  }
  if(url.pathname==="/sym"){
    const q=(url.searchParams.get("q")||"").toUpperCase().trim();
    if(!q) return json({ok:false,msg:"thiếu ?q= (vd /sym?q=TON)"});
    const out={q,bybit:[],okx:[]};
    try{
      const r=await fetch("https://api.bybit.com/v5/market/instruments-info?category=spot&limit=1000");
      const j=await r.json();
      const list=(j&&j.result&&Array.isArray(j.result.list))?j.result.list:[];
      out.bybit=list.map(x=>x.symbol).filter(s=>s&&s.indexOf(q)>=0).slice(0,25);
    }catch(e){ out.bybitErr=String((e&&e.message)||e).slice(0,120); }
    try{
      const r=await fetch("https://www.okx.com/api/v5/public/instruments?instType=SPOT");
      const j=await r.json();
      const list=(j&&Array.isArray(j.data))?j.data:[];
      out.okx=list.map(x=>x.instId).filter(s=>s&&s.indexOf(q)>=0).slice(0,25);
    }catch(e){ out.okxErr=String((e&&e.message)||e).slice(0,120); }
    out.ghiChu="Bot gọi Bybit trước, rồi OKX (tự đổi XXXUSDT -> XXX-USDT), rồi Binance. Mã phải có trên ít nhất một sàn.";
    return json(out);
  }
  if(url.pathname==="/deposit"){ const amt=Math.abs(+(url.searchParams.get("amt")||0)); if(!amt) return json({ok:false,msg:"thiếu số tiền"}); const s=await loadState(env); s.balance+=amt; s.start=(s.start||0)+amt; await saveState(env,s); return json({ok:true,balance:s.balance,start:s.start}); }
  if(url.pathname==="/withdraw"){ const amt=Math.abs(+(url.searchParams.get("amt")||0)); if(!amt) return json({ok:false,msg:"thiếu số tiền"}); const s=await loadState(env); if(amt>s.balance) return json({ok:false,msg:"vượt quá số dư khả dụng"}); s.balance-=amt; s.start=Math.max(0,(s.start||0)-amt); await saveState(env,s); return json({ok:true,balance:s.balance,start:s.start}); }
  return new Response("Andrew Le Scanner bot. Endpoints: /run /status /reset /ping /deposit /withdraw /config /check /close /sym /dump",{headers:{"content-type":"text/plain; charset=utf-8"}});
}
function json(o){return new Response(JSON.stringify(o,null,2),{headers:{"content-type":"application/json; charset=utf-8","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET, OPTIONS","Access-Control-Allow-Headers":"*"}});}

// ====== ENTRY ======
export default {
  async scheduled(event, env, ctx){ ctx.waitUntil(runScan(env)); },
  async fetch(req, env, ctx){ return handleHTTP(req,env); }
};