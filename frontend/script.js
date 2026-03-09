// ═══════════════════════════════════════════════════════════════
//  Aurora script.js - Master Corrected Version
// ═══════════════════════════════════════════════════════════════

const API = 'http://localhost:8000';

// GLOBAL CONSTANTS - Must stay at the top to prevent ReferenceErrors
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_S = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const EMOTIONS = ['happy','sad','angry','neutral'];

let history  = [];
let moodPool = [];
let curIdx   = 0;
let curMood  = 'neutral';
let gSocket  = null;
let gActive  = false;
let jCache   = null; 

let hmY = new Date().getFullYear(), hmM = new Date().getMonth();
const audio = document.getElementById('audio-player');

// ═══════════════════════════════════════════════════════════════
//  PARTICLE BACKGROUND (Fixed IndexSizeError)
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

            // FIX: Radial Gradient Radius must be > 0
            const rad = Math.max(0.1, (p.r + Math.sin(p.ph)*.0015) * Math.min(W,H));
            const glowRad = Math.max(0.1, rad * 4);
            const a   = p.a * (.55 + .45*Math.sin(p.ph));
            
            try {
                const g2 = ctx.createRadialGradient(p.x*W,p.y*H,0,p.x*W,p.y*H,glowRad);
                g2.addColorStop(0, `rgba(${r},${g},${b},${a*.45})`);
                g2.addColorStop(1, `rgba(${r},${g},${b},0)`);
                ctx.beginPath(); ctx.arc(p.x*W,p.y*H,glowRad,0,Math.PI*2);
                ctx.fillStyle=g2; ctx.fill();
            } catch(e) {}

            ctx.beginPath(); ctx.arc(p.x*W,p.y*H,rad*.7,0,Math.PI*2);
            ctx.fillStyle=`rgba(${r},${g},${b},${a})`; ctx.fill();
        });

        for(let i=0;i<pts.length;i++){
            for(let j=i+1;j<pts.length;j++){
                const dx=(pts[i].x-pts[j].x)*W, dy=(pts[i].y-pts[j].y)*H;
                const d=Math.sqrt(dx*dx+dy*dy);
                if(d<110){
                    ctx.beginPath(); ctx.moveTo(pts[i].x*W,pts[i].y*H); ctx.lineTo(pts[j].x*W,pts[j].y*H);
                    ctx.strokeStyle=`rgba(${r},${g},${b},${.07*(1-d/110)})`;
                    ctx.lineWidth=.8; ctx.stroke();
                }
            }
        }
    }
    draw();
})();

// ═══════════════════════════════════════════════════════════════
//  CHAT SYSTEM
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

        if(typeof applyMoodToUI==='function') applyMoodToUI(data.mood, data.confidence);
        if(data.mood!==curMood) await loadPool(data.mood);
        
        if(data.audio_url){
            const idx=moodPool.findIndex(t=>t.url===data.audio_url);
            if(idx>=0) curIdx=idx;
            playUrl(data.audio_url, data.track_name, true);
        }

        // Automatic trigger for Breathing Overlay
        if(data.trigger_breathing || data.mood === 'angry' || (data.mood === 'sad' && data.confidence > 0.8)){
            setTimeout(()=>startBreath(data.mood), 1200);
        }

        box.scrollTop=box.scrollHeight;
        jCache=null; 
    }catch(err){
        document.getElementById(tid)?.remove();
        appendMsg('aurora',"Aurora is currently offline.");
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
//  MUSIC PLAYER ENGINE
// ═══════════════════════════════════════════════════════════════
function playUrl(url, rawName, autoplay=false){
    audio.src=url; audio.load();
    if(autoplay) audio.play().catch(()=>{});
    const parts  = (rawName||'').split(/\s*[-–]\s*/);
    const title  = parts[0]?.trim() || url.split('/').pop() || '—';
    const artist = parts.slice(1).join(' - ').trim();
    document.getElementById('t-title').textContent  = title;
    document.getElementById('t-artist').textContent = artist ? `— ${artist}` : 'Aurora AI';
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
    playUrl(moodPool[curIdx].url, moodPool[curIdx].name, true);
}
function prevTrack(){
    if(!moodPool.length) return;
    curIdx=(curIdx-1+moodPool.length)%moodPool.length;
    playUrl(moodPool[curIdx].url, moodPool[curIdx].name, true);
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
function fmtT(s){ return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

// ═══════════════════════════════════════════════════════════════
//  BREATHING LOGIC
// ═══════════════════════════════════════════════════════════════
let bTmr=null;
function startBreath(mood){
    const ov=document.getElementById('breath-ov');
    if(!ov) return;
    document.getElementById('br-sub').textContent= mood==='angry' ? "Heart rate stabilization active." : "Deep breathing session.";
    const pp=document.getElementById('br-pips'); pp.innerHTML='';
    for(let i=0;i<4;i++){const p=document.createElement('div');p.className='br-pip';p.id=`pip${i}`;pp.appendChild(p);}
    ov.classList.add('show'); runBreath(0,0);
}
function runBreath(cyc,step){
    if(cyc>=4 || !document.getElementById('breath-ov').classList.contains('show')){stopBreath();return;}
    const BSEQ=[{l:'Inhale',c:'inhale',d:4000},{l:'Hold',c:'hold',d:4000},{l:'Exhale',c:'exhale',d:6000}];
    const s=BSEQ[step];
    document.getElementById('br-circ').className=`br-circ ${s.c}`; 
    document.getElementById('br-lbl').textContent=s.l;
    bTmr=setTimeout(()=>{
        const ns=step+1;
        if(ns>=BSEQ.length){document.getElementById(`pip${cyc}`)?.classList.add('done');runBreath(cyc+1,0);}
        else runBreath(cyc,ns);
    },s.d);
}
function stopBreath(){ clearTimeout(bTmr); document.getElementById('breath-ov').classList.remove('show'); }

// ═══════════════════════════════════════════════════════════════
//  JOURNAL & HEATMAP
// ═══════════════════════════════════════════════════════════════
async function loadJournal(){
    try{
        const res=await fetch(`${API}/journal`);
        const d=await res.json();
        jCache=d.entries||[];
        renderJList(jCache);
    }catch(e){ console.error("Journal load failed"); }
}

function renderJList(entries){
    const list=document.getElementById('j-list');
    list.innerHTML='';
    [...entries].reverse().forEach(e=>{
        const d=document.createElement('div'); d.className='j-entry';
        d.innerHTML=`<div class="j-dot ${e.emotion}"></div>
        <div class="j-meta"><div class="j-txt">${esc(e.text)}</div>
        <div class="j-info">${new Date(e.timestamp).toLocaleString()} · ${e.emotion}</div></div>
        <button class="j-del" onclick="delEntry('${e.id}',this)">✕</button>`;
        list.appendChild(d);
    });
}

async function renderHeatmap() {
    if(!jCache) {
        try {
            const res = await fetch(`${API}/journal`);
            const d = await res.json();
            jCache = d.entries || [];
        } catch (err) { jCache = []; }
    }
    drawHeatmap();
}

function drawHeatmap() {
    const hTitle = document.getElementById('hm-month');
    if (hTitle) hTitle.textContent = `${MONTHS[hmM]} ${hmY}`;
    const grid = document.getElementById('hm-grid');
    if (!grid) return;
    grid.innerHTML = '';

    const dayMap = {};
    (jCache || []).forEach(e => {
        const d = new Date(e.timestamp);
        if (d.getFullYear() === hmY && d.getMonth() === hmM) {
            const date = d.getDate();
            if (!dayMap[date]) dayMap[date] = { happy: 0, sad: 0, angry: 0, neutral: 0, total: 0 };
            dayMap[date][e.emotion]++;
            dayMap[date].total++;
        }
    });

    const firstDay = new Date(hmY, hmM, 1).getDay();
    const daysInMonth = new Date(hmY, hmM + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) grid.appendChild(document.createElement('div'));

    for (let d = 1; d <= daysInMonth; d++) {
        const cell = document.createElement('div');
        cell.className = 'hm-cell';
        
        const data = dayMap[d];
        if (data) {
            // THE HOVER TOOLTIP LOGIC
            // This creates a multi-line string that shows up when you hover
            cell.title = `Day ${d}: ${data.total} total messages\n` +
                         `😊 Happy: ${data.happy}\n` +
                         `😔 Sad: ${data.sad}\n` +
                         `🔥 Angry: ${data.angry}\n` +
                         `😐 Neutral: ${data.neutral}`;

            EMOTIONS.forEach(emo => {
                if (data[emo] > 0) {
                    const s = document.createElement('div');
                    s.className = `seg ${emo}`;
                    s.style.flexGrow = data[emo];
                    cell.appendChild(s);
                }
            });
            cell.addEventListener('click', () => openModal(d, data));
        } else {
            cell.title = `Day ${d}: No data`;
        }

        const dn = document.createElement('div'); 
        dn.className = 'hm-dn'; 
        dn.textContent = d;
        cell.appendChild(dn);
        grid.appendChild(cell);
    }
}

function hmNav(dir){ hmM+=dir; if(hmM>11){hmM=0;hmY++;} if(hmM<0){hmM=11;hmY--;} drawHeatmap(); }

// ═══════════════════════════════════════════════════════════════
//  GESTURE WEBSOCKET
// ═══════════════════════════════════════════════════════════════
function toggleGesture(){ gActive?stopGesture():startGesture(); }
function startGesture(){
    gActive=true;
    document.getElementById('g-btn').classList.add('on');
    gSocket=new WebSocket(`ws://localhost:8000/ws/gesture`);
    gSocket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    
    // Check for frame data from Python
    if (msg.type === 'frame') {
        const img = document.getElementById('camera-feed');
        const placeholder = document.getElementById('cam-ph');
        
        if (img) {
            img.src = `data:image/jpeg;base64,${msg.data}`;
            img.style.display = 'block'; // Force show
        }
        if (placeholder) {
            placeholder.style.display = 'none'; // Force hide the "Camera Inactive" text
        }
    }
    
    if (msg.type === 'gesture') {
        handleGesture(msg);
    }
};
}
function stopGesture(){ gActive=false; document.getElementById('g-btn').classList.remove('on'); gSocket?.close(); }
function handleGesture(msg){
    if(msg.action==='volume')      setVolume(msg.value);
    if(msg.action==='toggle_play') togglePlay();
    if(msg.action==='next')        { nextTrack(); toast('✌️ Next track'); }
    if(msg.action==='prev')        { prevTrack(); toast('👆 Prev track'); }
}

// ═══════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded',()=>{
    if(audio){
        audio.addEventListener('play',  ()=>setPlayUI(true));
        audio.addEventListener('pause', ()=>setPlayUI(false));
        audio.addEventListener('timeupdate', updateProg);
        audio.addEventListener('loadedmetadata', updateDur);
    }
    const sl=document.getElementById('vol-sl');
    if(sl) sl.addEventListener('input',()=>setVolume(sl.value/100));
});

function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }
function toast(t){ const e=document.getElementById('toast'); e.textContent=t; e.style.opacity=1; setTimeout(()=>e.style.opacity=0,2000); }