// ═══════════════════════════════════════════════════════════════
//  Aurora script.js
// ═══════════════════════════════════════════════════════════════

const API = 'http://localhost:8000';

let history  = [];
let moodPool = [];
let curIdx   = 0;
let curMood  = 'neutral';
let gSocket  = null;
let gActive  = false;
let jCache   = null; // null=needs fetch, []=genuinely empty

const audio = document.getElementById('audio-player');

// ═══════════════════════════════════════════════════════════════
//  PARTICLE BACKGROUND
// ═══════════════════════════════════════════════════════════════
(function(){
    const canvas = document.getElementById('bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const COLORS = {
        happy:   [251,191,36],
        sad:     [129,140,248],
        angry:   [248,113,113],
        neutral: [148,163,184],
    };

    let target  = COLORS.neutral;
    let current = [...COLORS.neutral];
    let W, H;

    function resize(){ W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
    window.addEventListener('resize', resize); resize();

    window.setParticleMood = (mood) => { target = COLORS[mood] || COLORS.neutral; };

    const N = 48;
    const pts = Array.from({length:N}, () => ({
        x: Math.random(), y: Math.random(),
        vx: (Math.random()-.5)*.00025,
        vy: (Math.random()-.5)*.00025,
        r:  Math.random()*.0038 + .0008,
        a:  Math.random()*.35 + .08,
        ph: Math.random()*Math.PI*2,
        ps: Math.random()*.018 + .004,
    }));

    function lerp(a,b,t){ return a+(b-a)*t; }

    function draw(){
        requestAnimationFrame(draw);
        ctx.clearRect(0,0,W,H);
        current = current.map((v,i) => lerp(v, target[i], .016));
        const [r,g,b] = current.map(Math.round);

        pts.forEach(p => {
            p.ph += p.ps;
            p.x  += p.vx; p.y += p.vy;
            if(p.x<0)p.x=1; if(p.x>1)p.x=0;
            if(p.y<0)p.y=1; if(p.y>1)p.y=0;
            const rad = (p.r + Math.sin(p.ph)*.0015) * Math.min(W,H);
            const a   = p.a * (.55 + .45*Math.sin(p.ph));
            const g2  = ctx.createRadialGradient(p.x*W,p.y*H,0,p.x*W,p.y*H,rad*4);
            g2.addColorStop(0, `rgba(${r},${g},${b},${a*.45})`);
            g2.addColorStop(1, `rgba(${r},${g},${b},0)`);
            ctx.beginPath(); ctx.arc(p.x*W,p.y*H,rad*4,0,Math.PI*2);
            ctx.fillStyle=g2; ctx.fill();
            ctx.beginPath(); ctx.arc(p.x*W,p.y*H,rad*.7,0,Math.PI*2);
            ctx.fillStyle=`rgba(${r},${g},${b},${a})`; ctx.fill();
        });

        // Connections
        for(let i=0;i<pts.length;i++){
            for(let j=i+1;j<pts.length;j++){
                const dx=(pts[i].x-pts[j].x)*W, dy=(pts[i].y-pts[j].y)*H;
                const d=Math.sqrt(dx*dx+dy*dy);
                if(d<110){
                    ctx.beginPath();
                    ctx.moveTo(pts[i].x*W,pts[i].y*H);
                    ctx.lineTo(pts[j].x*W,pts[j].y*H);
                    ctx.strokeStyle=`rgba(${r},${g},${b},${.07*(1-d/110)})`;
                    ctx.lineWidth=.8; ctx.stroke();
                }
            }
        }
    }
    draw();
})();

// ═══════════════════════════════════════════════════════════════
//  CHAT
// ═══════════════════════════════════════════════════════════════
async function sendMessage(){
    const inp  = document.getElementById('user-input');
    const box  = document.getElementById('chat-box');
    const text = inp.value.trim();
    if(!text) return;
    appendMsg('user', text);
    inp.value=''; inp.style.height='auto';
    history.push({role:'user',content:text});

    const tid=`t${Date.now()}`;
    box.innerHTML+=`<div class="msg" id="${tid}"><div class="av av-a">A</div><div class="bubble"><div class="typing"><div class="td"></div><div class="td"></div><div class="td"></div></div></div></div>`;
    box.scrollTop=box.scrollHeight;

    try{
        const res  = await fetch(`${API}/chat`,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({text,history:history.slice(-8),datetime:new Date().toISOString()})});
        const data = await res.json();
        document.getElementById(tid)?.remove();
        appendMsg('aurora', data.response);
        history.push({role:'assistant',content:data.response,emotion:data.mood});

        const sc    = data.debug?.scores||{};
        const scTxt = Object.entries(sc).map(([k,v])=>`${k}:${(v*100).toFixed(0)}%`).join(' ');
        const dbg   = document.createElement('div');
        dbg.className='dbg';
        dbg.innerHTML=`🔍 <b>${data.mood}</b> · ${(data.confidence*100).toFixed(1)}% · ${data.debug?.method||'?'} · hf:${data.debug?.hf_label||'n/a'}<br>${scTxt}`;
        box.appendChild(dbg);

        if(typeof applyMoodToUI==='function') applyMoodToUI(data.mood, data.confidence);
        if(data.mood!==curMood) await loadPool(data.mood);
        if(data.audio_url){
            const idx=moodPool.findIndex(t=>t.url===data.audio_url);
            if(idx>=0) curIdx=idx;
            playUrl(data.audio_url, data.track_name, true);
        }
        if(data.trigger_breathing) setTimeout(()=>startBreath(data.mood),900);
        box.scrollTop=box.scrollHeight;
        jCache=null; // null = needs refresh
    }catch(err){
        document.getElementById(tid)?.remove();
        appendMsg('aurora',"Can't reach the server — is main.py running?");
        console.error(err);
    }
}

function appendMsg(role, text){
    const box=document.getElementById('chat-box');
    const d=document.createElement('div');
    d.className=`msg${role==='user'?' msg-u':''}`;
    d.innerHTML=`<div class="av${role==='aurora'?' av-a':''}">${role==='aurora'?'A':'U'}</div><div class="bubble">${esc(text)}</div>`;
    box.appendChild(d); box.scrollTop=box.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
//  AUDIO
// ═══════════════════════════════════════════════════════════════
function playUrl(url, rawName, autoplay=false){
    audio.src=url; audio.load();
    if(autoplay) audio.play().catch(()=>{});
    const parts  = (rawName||'').split(/\s*[-–]\s*/);
    const title  = parts[0]?.trim() || url.split('/').pop() || '—';
    const artist = parts.slice(1).join(' - ').trim();
    document.getElementById('t-title').textContent  = title;
    document.getElementById('t-artist').textContent = artist ? `— ${artist}` : 'Aurora Music';
    document.getElementById('t-emo').textContent    = {happy:'🌟',sad:'🌙',angry:'🔥',neutral:'🎵'}[curMood]||'🎵';
}

async function loadPool(mood){
    curMood=mood;
    try{
        const res=await fetch(`${API}/music/tracks/${mood}`);
        const d=await res.json();
        moodPool=d.tracks||[]; curIdx=0;
    }catch(e){ moodPool=[]; }
}

function nextTrack(){
    if(!moodPool.length) return;
    curIdx=(curIdx+1)%moodPool.length;
    const t=moodPool[curIdx]; playUrl(t.url,t.name,true); toast('▶▶  Next track');
}
function prevTrack(){
    if(!moodPool.length) return;
    curIdx=(curIdx-1+moodPool.length)%moodPool.length;
    const t=moodPool[curIdx]; playUrl(t.url,t.name,true); toast('◀◀  Prev track');
}
function togglePlay(){ if(!audio.src)return; audio.paused?audio.play():audio.pause(); }

function setVolume(v){
    audio.volume=Math.max(0,Math.min(1,v));
    const s=document.getElementById('vol-sl'); if(s)s.value=Math.round(v*100);
    const l=document.getElementById('vol-lbl'); if(l)l.textContent=`${Math.round(v*100)}%`;
}

function setPlayUI(playing){
    const btn=document.getElementById('ppbtn');
    const disc=document.getElementById('disc');
    const sw=document.getElementById('sw');
    if(btn)  btn.innerHTML=playing?'&#9646;&#9646;':'&#9654;';
    if(disc) disc.classList.toggle('spin',playing);
    if(sw)   sw.classList.toggle('live',playing);
}

function fmtT(s){ return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

function updateProg(){
    if(!audio.duration)return;
    const pct=(audio.currentTime/audio.duration)*100;
    const f=document.getElementById('pf'); if(f)f.style.width=`${pct}%`;
    const c=document.getElementById('pc'); if(c)c.textContent=fmtT(audio.currentTime);
}
function updateDur(){
    const d=document.getElementById('pd');
    if(d&&!isNaN(audio.duration)) d.textContent=fmtT(audio.duration);
}
function seekAudio(e){
    if(!audio.duration)return;
    const bar=document.getElementById('prog-bar');
    audio.currentTime=(e.offsetX/bar.offsetWidth)*audio.duration;
}

// ═══════════════════════════════════════════════════════════════
//  BREATHING
// ═══════════════════════════════════════════════════════════════
let bTmr=null;
const BSEQ=[{l:'Inhale',c:'inhale',d:4000},{l:'Hold',c:'hold',d:4000},{l:'Exhale',c:'exhale',d:6000}];
const BCYC=4;

function startBreath(mood){
    const ov=document.getElementById('breath-ov');
    document.getElementById('br-sub').textContent=
        mood==='angry'?"High intensity detected. Let's slow down together."
                      :"Aurora sensed something heavy. Take a breath with me.";
    const pp=document.getElementById('br-pips'); pp.innerHTML='';
    for(let i=0;i<BCYC;i++){const p=document.createElement('div');p.className='br-pip';p.id=`pip${i}`;pp.appendChild(p);}
    ov.classList.add('show'); runBreath(0,0);
}
function runBreath(cyc,step){
    if(cyc>=BCYC){stopBreath();return;}
    const c=document.getElementById('br-circ');
    const l=document.getElementById('br-lbl');
    const s=BSEQ[step];
    c.className=`br-circ ${s.c}`; l.textContent=s.l;
    bTmr=setTimeout(()=>{
        const ns=step+1;
        if(ns>=BSEQ.length){document.getElementById(`pip${cyc}`)?.classList.add('done');runBreath(cyc+1,0);}
        else runBreath(cyc,ns);
    },s.d);
}
function stopBreath(){
    clearTimeout(bTmr);
    document.getElementById('breath-ov').classList.remove('show');
    const c=document.getElementById('br-circ'); if(c)c.className='br-circ';
}

// ═══════════════════════════════════════════════════════════════
//  JOURNAL
// ═══════════════════════════════════════════════════════════════
async function loadJournal(){
    const list=document.getElementById('j-list');
    list.innerHTML='<div style="color:var(--t3);font-size:.7rem;padding:.4rem 0">Loading…</div>';
    try{
        const res=await fetch(`${API}/journal`);
        const d=await res.json();
        jCache=d.entries||[];
        renderJList(jCache);
    }catch{ list.innerHTML='<div style="color:#f87171;font-size:.7rem">Could not load journal.</div>'; }
}

function renderJList(entries){
    const list=document.getElementById('j-list');
    if(!entries.length){list.innerHTML='<div style="color:var(--t3);font-size:.7rem;padding:.4rem 0">No entries yet.</div>';return;}
    list.innerHTML='';
    [...entries].reverse().forEach(e=>{
        const dt=new Date(e.timestamp);
        const dtf=isNaN(dt)?e.timestamp:dt.toLocaleString();
        const d=document.createElement('div'); d.className='j-entry';
        d.innerHTML=`<div class="j-dot ${e.emotion}"></div>
        <div class="j-meta"><div class="j-txt">${esc(e.text)}</div>
        <div class="j-info">${dtf} · ${e.emotion} (${Math.round((e.confidence||0)*100)}%)${e.track?` · 🎵 ${esc(e.track)}`:''}
        </div></div><button class="j-del" onclick="delEntry('${e.id}',this)">✕</button>`;
        list.appendChild(d);
    });
}

async function addEntry(){
    const text=document.getElementById('j-txt').value.trim();
    const dt  =document.getElementById('j-dt').value;
    if(!text)return;
    const btn=document.querySelector('.j-add');
    btn.textContent='…'; btn.disabled=true;
    try{
        await fetch(`${API}/journal`,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({text,datetime:dt?new Date(dt).toISOString():undefined})});
        document.getElementById('j-txt').value='';
        jCache=null;
        await loadJournal();
    }catch{ alert('Could not add entry.'); }
    finally{ btn.textContent='+ Add'; btn.disabled=false; }
}

async function delEntry(id,btn){
    btn.textContent='…';
    try{ await fetch(`${API}/journal/${id}`,{method:'DELETE'}); jCache=null; await loadJournal(); }
    catch{ btn.textContent='✕'; }
}

// ═══════════════════════════════════════════════════════════════
//  HEATMAP — Fixed Logic
// ═══════════════════════════════════════════════════════════════
let hmY = new Date().getFullYear(), hmM = new Date().getMonth();
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const EMOTIONS = ['happy','sad','angry','neutral'];

async function renderHeatmap() {
    // Fetch fresh data from backend
    try {
        const res = await fetch(`${API}/journal`);
        const d = await res.json();
        jCache = d.entries || [];
        drawHeatmap();
    } catch (err) {
        console.error("Heatmap fetch failed:", err);
        jCache = [];
        drawHeatmap();
    }
}

function getDayData() {
    const map = {};
    if (!jCache || jCache.length === 0) return map;

    jCache.forEach(e => {
        const d = new Date(e.timestamp);
        if (isNaN(d)) return;

        // Use Local Time to match what the user sees
        const year = d.getFullYear();
        const month = d.getMonth(); 
        const day = d.getDate();

        if (year === hmY && month === hmM) {
            if (!map[day]) map[day] = { entries: [], counts: { happy: 0, sad: 0, angry: 0, neutral: 0 }, total: 0 };
            map[day].entries.push(e);
            map[day].counts[e.emotion] = (map[day].counts[e.emotion] || 0) + 1;
            map[day].total++;
        }
    });
    return map;
}

function drawHeatmap() {
    const hTitle = document.getElementById('hm-month');
    if (hTitle) hTitle.textContent = `${MONTHS[hmM]} ${hmY}`;
    
    const grid = document.getElementById('hm-grid');
    if (!grid) return;
    grid.innerHTML = ''; // Clear existing grid

    const dayData = getDayData();
    const firstDayIndex = new Date(hmY, hmM, 1).getDay();
    const daysInMonth = new Date(hmY, hmM + 1, 0).getDate();
    const today = new Date();

    // 1. Create Empty Spacers for the start of the month
    for (let i = 0; i < firstDayIndex; i++) {
        const spacer = document.createElement('div');
        spacer.style.aspectRatio = '1';
        grid.appendChild(spacer);
    }

    // 2. Create Day Cells
    for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div');
        cell.className = 'hm-cell';
        
        // Mark today
        if (today.getFullYear() === hmY && today.getMonth() === hmM && today.getDate() === d) {
            cell.classList.add('today');
        }

        const data = dayData[d];
        if (data && data.total > 0) {
            // Add colored segments
            EMOTIONS.forEach(emo => {
                const count = data.counts[emo] || 0;
                if (count > 0) {
                    const seg = document.createElement('div');
                    seg.className = `seg ${emo}`;
                    seg.style.flexGrow = String(count); // Proportional height
                    cell.appendChild(seg);
                }
            });

            // Tooltip
            const tip = document.createElement('div');
            tip.className = 'hm-tip';
            const breakdown = EMOTIONS.filter(e => data.counts[e]).map(e => `${e} x${data.counts[e]}`).join(' · ');
            tip.textContent = `${MONTHS_S[hmM]} ${d}: ${data.total} entries (${breakdown})`;
            cell.appendChild(tip);

            cell.onclick = () => openModal(d, data);
        }

        // Day Number Label
        const dn = document.createElement('div');
        dn.className = 'hm-dn';
        dn.textContent = d;
        cell.appendChild(dn);
        
        grid.appendChild(cell);
    }
}

function openModal(day, data){
    document.getElementById('modal-date').textContent=`${MONTHS[hmM]} ${day}, ${hmY}`;

    // Segmented bar
    const bar=document.getElementById('modal-segbar'); bar.innerHTML='';
    EMOTIONS.forEach(e=>{
        const count=data.counts[e]||0; if(!count)return;
        const seg=document.createElement('div');
        seg.className=`mseg ${e}`;
        seg.style.flexGrow=String(count);
        bar.appendChild(seg);
    });

    // Entries
    const list=document.getElementById('modal-entries'); list.innerHTML='';
    const MC={happy:'#fbbf24',sad:'#818cf8',angry:'#f87171',neutral:'#94a3b8'};
    [...data.entries].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp)).forEach(e=>{
        const dt=new Date(e.timestamp);
        const t=isNaN(dt)?'':dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
        const d=document.createElement('div'); d.className='modal-entry';
        d.innerHTML=`<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${MC[e.emotion]};margin-right:6px;vertical-align:middle;box-shadow:0 0 5px ${MC[e.emotion]}88"></span>${esc(e.text)}<div class="modal-entry-meta">${t} · ${e.emotion} · ${Math.round((e.confidence||0)*100)}%${e.track?` · 🎵 ${esc(e.track)}`:''}</div>`;
        list.appendChild(d);
    });

    document.getElementById('day-modal').classList.add('show');
}
function closeModal(){ document.getElementById('day-modal').classList.remove('show'); }

function hmNav(dir){
    hmM+=dir;
    if(hmM>11){hmM=0;hmY++;} if(hmM<0){hmM=11;hmY--;}
    drawHeatmap();
}

// ═══════════════════════════════════════════════════════════════
//  GESTURE
// ═══════════════════════════════════════════════════════════════
function toggleGesture(){ gActive?stopGesture():startGesture(); }

function startGesture(){
    gActive=true;
    const btn=document.getElementById('g-btn');
    if(btn){btn.textContent='■  Stop Gesture Control';btn.classList.add('on');}
    gSocket=new WebSocket(`ws://localhost:8000/ws/gesture`);
    gSocket.onopen=()=>toast('Gesture control active ✋');
    gSocket.onmessage=(e)=>{
        const msg=JSON.parse(e.data);
        if(msg.type==='frame'){
            const img=document.getElementById('camera-feed');
            if(img){img.src=`data:image/jpeg;base64,${msg.data}`;img.style.display='block';}
            const ph=document.getElementById('cam-ph');if(ph)ph.style.display='none';
            return;
        }
        if(msg.type==='gesture')handleGesture(msg);
    };
    gSocket.onclose=()=>{if(gActive)stopGesture();};
    gSocket.onerror=(e)=>{console.error('[WS]',e);stopGesture();};
}

function stopGesture(){
    gActive=false;
    const btn=document.getElementById('g-btn');
    if(btn){btn.textContent='▶  Start Gesture Control';btn.classList.remove('on');}
    if(gSocket?.readyState===WebSocket.OPEN){gSocket.send(JSON.stringify({type:'stop'}));gSocket.close();}
    gSocket=null;
    const img=document.getElementById('camera-feed');if(img)img.style.display='none';
    const ph=document.getElementById('cam-ph');if(ph)ph.style.display='flex';
    toast('Gesture control stopped');
}

function handleGesture(msg){
    switch(msg.action){
        case 'toggle_play':togglePlay();break;
        case 'next':nextTrack();break;
        case 'prev':prevTrack();break;
        case 'volume':setVolume(msg.value);toast(`✋ Vol ${Math.round(msg.value*100)}%`);break;
    }
    logGesture(msg.action,msg.value);
}

// ═══════════════════════════════════════════════════════════════
//  TOAST + LOG
// ═══════════════════════════════════════════════════════════════
let toastTmr=null;
function toast(text){
    const el=document.getElementById('toast');if(!el)return;
    el.textContent=text; el.style.opacity='1';
    clearTimeout(toastTmr);
    toastTmr=setTimeout(()=>{el.style.opacity='0';},2500);
}

function logGesture(action,value){
    const log=document.getElementById('g-log');if(!log)return;
    const L={toggle_play:'⏯  Pinch → pause/play',next:'▶▶  Swipe right → next',prev:'◀◀  Swipe left → prev',
             volume:`🔊  Height → vol ${Math.round((value||0)*100)}%`};
    const item=document.createElement('div');item.className='gli';
    item.textContent=`${ts()}  ${L[action]||action}`;
    log.prepend(item);
    while(log.children.length>6)log.lastChild.remove();
}

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded',()=>{
    const sl=document.getElementById('vol-sl');
    if(sl) sl.addEventListener('input',()=>setVolume(sl.value/100));
    if(audio){
        audio.addEventListener('play',  ()=>setPlayUI(true));
        audio.addEventListener('pause', ()=>setPlayUI(false));
        audio.addEventListener('ended', ()=>nextTrack());
        audio.addEventListener('timeupdate',  updateProg);
        audio.addEventListener('loadedmetadata', updateDur);
    }
    document.getElementById('day-modal')?.addEventListener('click',e=>{
        if(e.target===document.getElementById('day-modal'))closeModal();
    });
});

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function ts(){ const d=new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }