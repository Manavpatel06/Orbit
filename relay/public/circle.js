/* Live circle board. Accepts ?c=CODE (public board), ?c=CODE&v=VIEWKEY, or legacy #k=KEY.
   Polls /board every 2 s with ?since= so only new log lines travel. ?mock=1 fakes every state for design review
   (add &state=notpublic|unknown|ratelimit|lost|badkey to see an error screen). */
(function(){
var $=function(s){return document.querySelector(s)};
var q=new URLSearchParams(location.search);
var code=(q.get('c')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
var v=q.get('v')||'';
var k=new URLSearchParams(location.hash.replace(/^#/,'')).get('k')||'';
var MS=q.get('state')||'';
if(O.mock&&!code){code='DEMO42';v='mock'}
var CODE_OK=/^[A-HJ-NP-Z2-9]{6}$/;
var POLL=2000,SLOW=10000;
var GREEN='#30d158',BLUE='#0B84FE',AMBER='#ff9f0a',VIOLET='#bf5af2',RED='#ff453a',PINK='#ff375f',GREY='#8e8e93',MUSIC='#64d2ff';
var TYPE_C={proposed:AMBER,moved:AMBER,countered:VIOLET,rescheduled:VIOLET,accepted:GREEN,locked:GREEN,cheered:PINK,declined:RED,expired:GREY,joined:GREY,shared:BLUE,left:GREY,paused:GREY,resumed:GREEN,jam:MUSIC,now_playing:MUSIC,playing:MUSIC};
var TL={now_playing:'Now playing',playing:'Now playing',jam:'Jam nudge'};
var NOTE='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';
var EXT='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
var TG={agent:'🤖 agent',student:'👤 student',system:'⚙ system'};
var BUSY={light:['green','Light week'],busy:['amber','Busy'],packed:['red','Packed']};
var AV=[['#0B84FE','#0a4fa8'],['#5e5ce6','#32308f'],['#bf5af2','#6b2d8c'],['#30d158','#146b2c'],['#ff9f0a','#8a5200'],['#ff375f','#8c1d36']];
var R=34; /* orbit ring radius in % of the orbit box */
function isMusic(e){return e.type==='jam'||e.type==='now_playing'||e.type==='playing'||!!e.music||/\bjam\b|🎧/i.test(e.text||'')}

var state={members:[],plans:[],log:[],seen:{},since:'',fails:0,first:true,nodes:{},pos:{},planKeys:{},name:'',loaded:false,notPublic:false};
var queue=[],busy=false,timer=null,tick=0,countdown=null;

function cap(s){s=String(s||'');return s.charAt(0).toUpperCase()+s.slice(1)}
function fd(d){var m=/^(\d{4})-(\d\d)-(\d\d)$/.exec(d||'');if(!m)return d||'';return new Date(+m[1],+m[2]-1,+m[3]).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})}
function ft(t){var m=/^(\d\d):(\d\d)$/.exec(t||'');if(!m)return t||'';var h=+m[1];return (h%12||12)+':'+m[2]+' '+(h<12?'AM':'PM')}
function keyOf(e){return e.id||((e.ts||'')+'|'+e.text)}
function pkey(p){return p.id||((p.course||'')+'|'+(p.from_name||'')+'|'+(p.date||'')+'|'+(p.time||''))}
function pstat(p){
  var s=String(p.status||'').toLowerCase();
  if(/lock|accept|confirm/.test(s))return{key:'locked',label:'Locked in',color:GREEN};
  if(/resched/.test(s)||p.rescheduled||p.change==='rescheduled')return{key:'resched',label:'Rescheduled',color:VIOLET};
  if(/expir/.test(s))return{key:'expired',label:'Expired',color:GREY};
  if(/declin|no_shared|none/.test(s))return{key:'none',label:'No shared time',color:RED};
  return{key:'open',label:'Negotiating · round '+(p.round||1),color:BLUE}}

/* ---------- error screens ---------- */
function formHTML(){return '<form id="cf" novalidate><input class="codein" id="ci" maxlength="6" placeholder="ABC234" autocomplete="off" spellcheck="false" aria-label="Circle code"><button class="btn pri lg" type="submit">Watch live</button></form><p class="hint" id="ch" role="alert"></p>'}
function bindForm(){var f=$('#cf');if(!f)return;var i=$('#ci');
  i.addEventListener('input',function(){i.value=i.value.toUpperCase().replace(/[^A-Z0-9]/g,'');i.classList.remove('bad');$('#ch').textContent=''});
  f.addEventListener('submit',function(e){e.preventDefault();var c=i.value;
    if(!CODE_OK.test(c)){i.classList.add('bad');$('#ch').textContent='Codes have 6 characters, A to Z and 2 to 9. O, 0, I and 1 are never used.';i.focus();return}
    location.href='/circle?c='+c});
  if(code&&$('#ci'))i.value=code.slice(0,6)}
function showState(html){
  $('#board').hidden=true;$('#bar').hidden=true;var s=$('#state');s.innerHTML=html;s.hidden=false;bindForm();
}
function showNoCode(){showState('<h2>Watch a circle live</h2><p>Enter the 6-character code from a circle. Anyone with the code sees its names, plans and agent log. Free times and courses stay private.</p>'+formHTML());$('#ci')&&$('#ci').focus()}
function showNotPublic(){
  state.notPublic=true;
  showState('<h2>This circle isn’t public yet</h2><p>Only a member can make it watchable. They text Cubbie <b>“make my circle watchable”</b> and the board goes live here.</p><p>Watchable means anyone with the code sees names, plans and the agent log. It never shows free times or courses.</p><div class="ac"><a class="btn" href="/#watch">How watchable circles work</a></div>'+formHTML()+'<p class="hint" style="color:var(--mu);margin-top:18px">This page checks again every 10 seconds.</p>')}
function showUnknown(){state.notPublic=false;showState('<h2>No circle has the code '+O.esc(code)+'</h2><p>Check for typos. Codes are six characters, and O, 0, I and 1 are never used.</p>'+formHTML())}
function showBadKey(){state.notPublic=false;showState('<h2>This link isn’t valid</h2><p>The view link may be old or copied wrong. Ask the circle’s owner for a fresh link, or enter the circle code.</p>'+formHTML())}

/* ---------- header and banners ---------- */
function setLive(kind,text){var el=$('#lives');el.className='lives '+(kind||'');$('#ltxt').textContent=text}
function ageText(){if(!state.loaded)return;setLive('',"Live · updated "+(state.lastOk?O.ago(state.lastOk):'just now'))}
function banner(text,ms){var b=$('#banner');b.textContent=text;b.hidden=false;clearTimeout(banner._t);if(ms)banner._t=setTimeout(function(){b.hidden=true},ms)}
function lostBanner(kind,wait){
  var sec=Math.ceil(wait/1000),what=kind==='ratelimit'?'Too many requests from this network.':'Connection lost.';
  setLive('warn','Reconnecting');
  clearInterval(countdown);
  function tickTxt(){var b=$('#banner');b.hidden=false;b.textContent=what+' Retrying in '+sec+' s…';sec--;if(sec<0)clearInterval(countdown)}
  tickTxt();countdown=setInterval(tickTxt,1000)}

/* ---------- orbit ---------- */
function placeNodes(){
  var ms=state.members,n=ms.length,pos={},seen={};
  var nodesEl=$('#nodes');
  ms.forEach(function(m,i){
    var ang=(-90+i*360/Math.max(1,n))*Math.PI/180,x=50+R*Math.cos(ang),y=50+R*Math.sin(ang);
    pos[m.name]={x:x,y:y};seen[m.name]=1;
    var nd=state.nodes[m.name];
    if(!nd){var el=document.createElement('div');el.className='node';el.innerHTML='<span class="av"></span><div class="who"><span class="nm"></span><span class="chip grey"><i></i></span><span class="np" hidden><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span><span class="ntx"></span></span><span class="cheer"></span></div>';nodesEl.appendChild(el);nd=state.nodes[m.name]={el:el}}
    var c=AV[i%AV.length];nd.el.style.setProperty('--c1',c[0]);nd.el.style.setProperty('--c2',c[1]);
    nd.el.style.setProperty('--x',x+'%');nd.el.style.setProperty('--y',y+'%');
    nd.el.querySelector('.av').textContent=String(m.name||'?').charAt(0).toUpperCase();
    nd.el.querySelector('.nm').textContent=m.name;
    var bz=BUSY[m.busy];var chip=nd.el.querySelector('.chip');
    chip.className='chip '+(bz?bz[0]:'grey');
    chip.innerHTML='<i></i>'+O.esc(bz?bz[1]:'No signal');
    var ch=m.cheers||0;nd.el.querySelector('.cheer').innerHTML=ch?'<b>'+ch+'</b> cheer'+(ch===1?'':'s')+' this week':'No cheers this week';
    setNP(nd.el.querySelector('.np'),m.now_playing&&Date.parse(m.now_playing.until)>Date.now()?m.now_playing:null);
  });
  Object.keys(state.nodes).forEach(function(name){if(!seen[name]){state.nodes[name].el.remove();delete state.nodes[name]}});
  state.pos=pos}
/* now playing: shown while `until` is ahead, fades out when it passes or the member clears it */
function setNP(el,np){
  if(np){el.hidden=false;el.classList.remove('gone');el.dataset.until=np.until;
    el.querySelector('.ntx').textContent=np.artist+(np.track?' · '+np.track:'');return}
  if(el.hidden||el.classList.contains('gone'))return;
  el.classList.add('gone');setTimeout(function(){if(el.classList.contains('gone'))el.hidden=true},900)}
function npTick(){var now=Date.now();
  Object.keys(state.nodes).forEach(function(n){var el=state.nodes[n].el.querySelector('.np');
    if(el&&!el.hidden&&Date.parse(el.dataset.until)<=now)setNP(el,null)})}
setInterval(npTick,1000);
function drawChords(){
  var g=$('#chords'),out='';
  state.plans.forEach(function(p){var s=pstat(p);if(s.key==='expired'||s.key==='none')return;
    var a=state.pos[p.from_name];if(!a)return;
    (p.to_names||[]).forEach(function(t){var b=state.pos[t];if(!b)return;
      out+='<line class="chord '+(s.key==='locked'?'locked':s.key==='resched'?'move':'open')+'" x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"/>'})});
  g.innerHTML=out}
function parties(e){
  var from=e.from||e.from_name,to=e.to||e.to_name;
  if(Array.isArray(to))to=to[0];
  if(from&&to)return[from,to];
  var names=state.members.map(function(m){return m.name}).filter(Boolean);
  var hits=names.map(function(n){return{n:n,i:(e.text||'').indexOf(n)}}).filter(function(x){return x.i>=0}).sort(function(a,b){return a.i-b.i}).map(function(x){return x.n});
  return[hits[0]||null,hits[1]||null]}
function hit(name){var nd=state.nodes[name];if(!nd)return;nd.el.classList.add('hit');setTimeout(function(){nd.el.classList.remove('hit')},900)}
function fly(a,b,label,color,toName,music){return new Promise(function(res){
  var p=document.createElement('div');p.className='packet'+(music?' music':'');p.style.setProperty('--pc',color);
  p.innerHTML=(music?'<span class="nt" aria-hidden="true">'+NOTE+'</span>':'<span class="pk"></span>')+'<span class="lb"></span>';p.querySelector('.lb').textContent=label;
  $('#packets').appendChild(p);
  var mx=(a.x+b.x)/2,my=(a.y+b.y)/2,dx=mx-50,dy=my-50,L=Math.hypot(dx,dy)||1,cx=mx+dx/L*12,cy=my+dy/L*12;
  var D=1500,t0=performance.now();
  function step(t){var u=Math.min(1,(t-t0)/D),e=u<.5?2*u*u:1-Math.pow(-2*u+2,2)/2;
    var x=(1-e)*(1-e)*a.x+2*(1-e)*e*cx+e*e*b.x,y=(1-e)*(1-e)*a.y+2*(1-e)*e*cy+e*e*b.y;
    p.style.left=x+'%';p.style.top=y+'%';
    p.style.opacity=u<.08?u/.08:u>.92?(1-u)/.08:1;
    if(u<1)requestAnimationFrame(step);else{p.remove();if(toName)hit(toName);res()}}
  requestAnimationFrame(step)})}
state.center={x:50,y:50};
function play(e){
  var pr=parties(e),music=isMusic(e),color=music?MUSIC:(TYPE_C[e.type]||BLUE),label=e.label||TL[e.type]||cap(e.type||'update');
  if(O.reduced){
    [pr[0],pr[1]].forEach(function(n){if(n)hit(n)});banner(e.text,2400);return O.sleep(1800)}
  var a=pr[0]&&state.pos[pr[0]],b=pr[1]&&state.pos[pr[1]];
  if(a&&b)return fly(a,b,label,color,pr[1],music).then(function(){return O.sleep(300)});
  if(b)return fly(state.center,b,label,color,pr[1],music).then(function(){return O.sleep(300)});
  if(a)return fly(a,state.center,label,color,null,music).then(function(){return O.sleep(300)});
  banner(e.text,2400);return O.sleep(1400)}
function drain(){
  if(busy)return;busy=true;
  (function next(){
    var e=queue.shift();if(!e){busy=false;return}
    play(e).then(next,function(){busy=false});
  })()}
function enqueue(list){if(!list.length)return;queue=queue.concat(list).slice(-4);drain()}

/* ---------- plans and log ---------- */
function playlistHTML(pl){
  var name=O.esc(pl.name||'Playlist'),ok=/^https:\/\/open\.spotify\.com\//.test(pl.url||'');
  return '<div class="pl">'+NOTE+(ok?'<a href="'+O.esc(pl.url)+'" target="_blank" rel="noopener">'+name+EXT+'</a>':'<span>'+name+'</span>')+'</div>'}
function planHTML(p,openFirst){
  var s=pstat(p),names=(p.to_names||[]).join(', ');
  var when=[fd(p.date),ft(p.time)].filter(Boolean).join(' · ');
  var reasons=p.reasons||[];
  var move=s.key==='resched'?'<div class="move">Calendar changed. Moved to a new time, and everyone has to confirm again.</div>':(p.change==='moved'&&p.moved_by_name?'<div class="move">Moved by '+O.esc(p.moved_by_name)+' after a busy check</div>':'');
  var place=p.place||(s.key==='open'&&p.places&&p.places.length?'Pick a place: '+p.places.join(' or '):'');
  return '<div class="plan'+(state.planKeys[pkey(p)]&&state.planKeys[pkey(p)]!==s.key?' fresh':'')+'" style="--pc:'+s.color+'">'+
    '<div class="t"><b>'+O.esc(p.kind==='jam'?'🎸 Jam session':((p.kind==='study'?'Study ':'')+(p.course||'Plan')))+'</b><span class="ctag" style="--cb:'+s.color+';--cc:'+s.color+'"><i></i>'+O.esc(s.label)+'</span></div>'+
    '<div class="who">'+O.esc(p.from_name||'')+(names?' with '+O.esc(names):'')+'</div>'+
    (when||place?'<div class="when">'+O.esc(when)+(place?' <em>· '+O.esc(place)+'</em>':'')+'</div>':'')+
    (p.playlist&&p.playlist.url?playlistHTML(p.playlist):'')+
    move+
    (reasons.length?'<details'+(openFirst?' open':'')+'><summary>Why this time</summary><ul class="why">'+reasons.map(function(r){return'<li>'+O.esc(r)+'</li>'}).join('')+'</ul></details>':'')+
    '</div>'}
function renderPlans(){
  var ps=state.plans,active=false;
  $('#pn').textContent=ps.length?ps.length+' in the last 14 days':'';
  $('#plans').innerHTML=ps.map(function(p){var s=pstat(p);var open=!active&&(s.key==='open'||s.key==='resched');if(open)active=true;return planHTML(p,open)}).join('')||'<p class="empty">No plans yet. Once a Cubbie proposes a time, it shows up here.</p>';
  state.planKeys={};ps.forEach(function(p){state.planKeys[pkey(p)]=pstat(p).key});
}
function logHTML(e,isNew){
  var c=TYPE_C[e.type]||BLUE;
  return '<li class="'+(isNew?'in':'')+'" style="--c:'+c+'"><span class="dt"></span><div class="ev"><b>'+O.esc(TL[e.type]||cap(e.type||'update'))+'</b>'+(TG[e.kind]?'<span class="tg">'+TG[e.kind]+'</span>':'')+'</div><span class="tm" data-ts="'+O.esc(e.ts||'')+'">'+O.esc(e.ts?O.ago(e.ts):'')+'</span><div class="tx">'+O.esc(e.text)+'</div></li>'}
function renderLog(fresh){
  var lg=state.log;
  $('#log').innerHTML=lg.map(function(e){return logHTML(e,fresh.indexOf(e)>=0)}).join('');
  $('#le').hidden=lg.length>0;$('#ln').textContent=lg.length?lg.length+' entries':''}

/* ---------- apply a board payload ---------- */
function apply(b){
  var firstLoad=state.first;
  $('#state').hidden=true;$('#board').hidden=false;$('#bar').hidden=false;state.notPublic=false;
  state.name=b.name||'Circle';document.title=state.name+' · Orbit board';
  $('#title').textContent=state.name;
  $('#code').innerHTML=code.split('').map(function(ch){return '<b>'+O.esc(ch)+'</b>'}).join('');
  state.members=(b.members||[]).map(function(m){return typeof m==='string'?{name:m}:m});
  state.plans=b.plans||[];
  var incoming=(b.log||[]).filter(function(e){var key=keyOf(e);if(state.seen[key])return false;state.seen[key]=1;return true});
  state.log=incoming.concat(state.log).slice(0,120);
  if(b.log&&b.log.length){var nw=b.log[0];state.since=nw.id||nw.ts||state.since}
  state.lastOk=new Date().toISOString();state.loaded=true;state.fails=0;
  placeNodes();drawChords();renderPlans();renderLog(incoming);
  setLive('',"Live · updated just now");
  var sb=$('#banner');if(sb.textContent.indexOf('Retrying')>=0||sb.textContent.indexOf('Too many')>=0){sb.hidden=true}
  clearInterval(countdown);
  state.first=false;
  if(!firstLoad)enqueue(incoming.slice().reverse())}

/* ---------- polling ---------- */
function classify(e){var m=String((e&&e.message)||'');
  if(e&&e.status===404&&/not_public/i.test(m))return'notpublic';
  if(e&&e.status===404)return'unknown';
  if(e&&e.status===429)return'ratelimit';
  if(e&&(e.status===401||e.status===403))return'badkey';
  return'lost'}
function fetchBoard(){
  if(O.mock)return mockBoard(state.since);
  var p=new URLSearchParams();if(v)p.set('v',v);if(state.since)p.set('since',state.since);
  var h={};if(k)h.Authorization='Bearer '+k;
  return O.api('/circles/'+encodeURIComponent(code)+'/board'+(p.toString()?'?'+p:''),{headers:h})}
function schedule(ms){clearTimeout(timer);timer=setTimeout(poll,ms)}
function poll(){
  if(document.hidden){schedule(POLL);return}
  tick++;
  fetchBoard().then(function(b){apply(b);schedule(POLL)},function(e){
    var kind=classify(e);
    if(kind==='notpublic'){showNotPublic();schedule(SLOW);return}
    if(kind==='unknown'){showUnknown();schedule(SLOW);return}
    if(kind==='badkey'){showBadKey();return}
    state.fails++;
    var wait=kind==='ratelimit'?Math.max(10000,POLL*Math.pow(2,state.fails)):Math.min(30000,POLL*Math.pow(2,state.fails));
    if(state.loaded){lostBanner(kind,wait)}else{showState('<h2>Can’t reach Orbit right now</h2><p>The board keeps retrying in '+Math.ceil(wait/1000)+' seconds. Your circle is safe.</p>')}
    schedule(wait)})}
document.addEventListener('visibilitychange',function(){if(!document.hidden)schedule(0)});
setInterval(ageText,15000);

/* ---------- start ---------- */
if(!code)showNoCode();
else schedule(0);

/* ---------- mock data (design review only) ---------- */
var M={n:0,log:[],plans:[],members:[]};
var SEED_PLANS=[
 {id:'p1',kind:'study',course:'CSE 576',from_name:'Manav',to_names:['Manas','Reya'],date:'2026-10-29',time:'19:00',place:'Hayden Library, 2nd floor',playlist:{name:'lofi beats',url:'https://open.spotify.com/playlist/37i9dQZF1DWWQRwui0ExPn'},status:'open',round:2,reasons:['before CSE 576 quiz Fri','free for Manav, Manas and Reya','Tue evening busy for Manas','matches Manas’s preferred evenings']},
 {id:'p2',kind:'study',course:'CSE 543',from_name:'Reya',to_names:['Mansi'],date:'2026-10-27',time:'14:00',place:'Zoom',status:'locked',round:1,reasons:['before the 543 project check-in','both free after lunch']},
 {id:'p3',kind:'study',course:'CSE 575',from_name:'Manas',to_names:['Manav'],date:'2026-10-26',time:'09:00',status:'expired',round:1,reasons:[]}
];
var SCRIPT=[
 {e:{type:'proposed',kind:'agent',from:'Manav',to:'Manas',text:'Manav’s Cubbie proposed CSE 576 study to Manas: Tue evening, Thu evening.',label:'Proposed'}},
 {e:{type:'moved',kind:'agent',from:'Manas',to:'Manav',text:'Manas’s Cubbie checked the calendar. Tue evening is busy, so it moved to Thu evening.',label:'Busy, moved to Thu'},plan:{round:2,status:'open'}},
 {e:{type:'cheered',kind:'student',from:'Reya',to:'Manas',text:'Reya checked on Manas before the quiz.',label:'Cheered'},cheer:'Manas'},
 {e:{type:'countered',kind:'agent',from:'Mansi',to:'Reya',text:'Mansi’s Cubbie countered: Thu evening is packed, Sat afternoon works.',label:'Countered'},plan:{round:3,status:'open'}},
 {e:{type:'rescheduled',kind:'agent',from:'Manas',to:'Manav',text:'Manas’s Cubbie found a new conflict. Proposed Sat afternoon instead.',label:'Rescheduled'},plan:{status:'rescheduled',date:'2026-10-31',time:'15:00',round:2}},
 {e:{type:'accepted',kind:'student',from:'Manas',to:'Manav',text:'Manas said yes. Locked in: Study CSE 576 · Sat Oct 31 · 3:00 PM.',label:'Locked in'},plan:{status:'locked'}},
 {e:{type:'shared',kind:'agent',from:'Reya',to:'Mansi',text:'Reya’s Cubbie noticed a big day tomorrow and offered a check-in.',label:'Check-in ready'}},
 {e:{type:'cheered',kind:'student',from:'Mansi',to:'Reya',text:'Mansi checked on Reya before the big day.',label:'Cheered'},cheer:'Reya'},
 {e:{type:'now_playing',kind:'agent',from:'Manav',text:'Manav’s Cubbie shared what he’s playing 🎧',label:'Now playing',music:true},np:{artist:'Arctic Monkeys',track:'Do I Wanna Know?'}},
 {e:{type:'jam',kind:'agent',from:'Manav',to:'Manas',text:'Manav is playing Arctic Monkeys right now, one of your favorites. You’re both free this evening. Jam session?',label:'Jam nudge',music:true}},
 {e:{type:'proposed',kind:'agent',from:'Manas',to:'Manav',text:'Manas said yes. Proposed a jam session tonight at 7:00 PM, at Manav’s place.',label:'Jam proposed',music:true},newPlan:{id:'pj',kind:'jam',from_name:'Manas',to_names:['Manav'],date:'2026-10-25',time:'19:00',place:'Manav’s place',status:'open',round:1,reasons:['Manav is playing an artist you like','both free this evening'],playlist:{name:'Indie’s Top 50',url:'https://open.spotify.com/playlist/37i9dQZF1DX2Nc3B70tvx0'}}},
 {e:{type:'accepted',kind:'student',from:'Manav',to:'Manas',text:'Manav said yes. Locked in: Jam session · today · 7:00 PM',label:'Locked in'},planId:'pj',plan:{status:'locked'}}
];
function mockBoard(since){
  tick++;
  if(!M.members.length){
    M.members=[{name:'Manav',busy:'busy',cheers:2},{name:'Manas',busy:'packed',cheers:1},{name:'Reya',busy:'light',cheers:3},{name:'Mansi',busy:'busy',cheers:0}];
    M.plans=SEED_PLANS.map(function(p){return Object.assign({},p)});
    M.log=[{id:'m0',type:'joined',kind:'system',text:'Manav joined',ts:new Date(Date.now()-6e5).toISOString()},{id:'m1',type:'joined',kind:'system',text:'Manas joined',ts:new Date(Date.now()-5e5).toISOString()}];
    M.n=1;M.nextScript=0;
  }
  if(MS==='notpublic'){var e1=new Error('not_public');e1.status=404;return Promise.reject(e1)}
  if(MS==='unknown'){var e2=new Error('not_found');e2.status=404;return Promise.reject(e2)}
  if(MS==='ratelimit'){var e3=new Error('rate_limited');e3.status=429;return Promise.reject(e3)}
  if(MS==='badkey'){var e4=new Error('invalid_key');e4.status=403;return Promise.reject(e4)}
  if(MS==='lost'&&tick%12>=8){return new Promise(function(_,rej){setTimeout(function(){rej(new Error('Failed to fetch'))},250)})}
  /* advance the script every other poll so events arrive every ~4 s */
  if(tick%2===0){
    var fromM=M.members[1+tick%(M.members.length-1)].name;var step=M.nextScript<SCRIPT.length?SCRIPT[M.nextScript]:{e:{type:'cheered',kind:'student',from:fromM,to:M.members[0].name,text:fromM+' checked on '+M.members[0].name+'.',label:'Cheered'},cheer:fromM};
    M.nextScript++;
    var ev=Object.assign({id:'m'+(++M.n),ts:new Date().toISOString()},step.e);
    M.log.unshift(ev);
    if(step.plan){var pl=(step.planId?M.plans.find(function(p){return p.id===step.planId}):M.plans.find(function(p){return p.from_name===(step.e.from)}))||M.plans[0];Object.assign(pl,step.plan)}
    if(step.newPlan)M.plans.unshift(Object.assign({},step.newPlan));
    if(step.np)M.members[0].now_playing={artist:step.np.artist,track:step.np.track,until:new Date(Date.now()+(MS==='fade'?24e3:18e5)).toISOString()};
    if(step.cheer){M.members.forEach(function(m){if(m.name===step.cheer)m.cheers=(m.cheers||0)+1})}
  }
  var newLog=M.log;
  if(since){var sn=+(since.replace('m','')||0);newLog=M.log.filter(function(e){return +(e.id.replace('m',''))>sn})}
  return Promise.resolve({name:'CSE 576 study crew',members:M.members.map(function(m){return Object.assign({},m)}),plans:M.plans.map(function(p){return Object.assign({},p)}),log:newLog,stats:{proposals:M.plans.length,locked:M.plans.filter(function(p){return p.status==='locked'}).length,agent_moves:2}})}

})();
