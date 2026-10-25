/* Orbit shared helpers. Mock mode (?mock=1) fakes the API for local design review. */
(function(){
var O=window.O={};
O.mock=/[?&]mock=1/.test(location.search);
O.$=function(s,r){return(r||document).querySelector(s)};
O.sleep=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
O.reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
O.esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
O.mark=function(px,cls){
  return '<svg class="mark '+(cls||'')+'" width="'+px+'" height="'+px+'" viewBox="-135 -135 270 270" aria-hidden="true" style="overflow:visible"><circle r="100" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="3.2"/><circle r="27" fill="#fff"/><circle cx="100" cy="0" r="13" fill="#0B84FE"/><circle cx="-47.1" cy="86.5" r="10" fill="#fff"/><circle cx="-62.6" cy="-77.9" r="16" fill="#0B84FE"/></svg>';
};
O.ago=function(iso){var s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);
  if(s<45)return'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';
  return new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'})};
var LC={joined:'#30d158',left:'#8e8e93',shared:'#0B84FE',proposed:'#ff9f0a',moved:'#ff9f0a',accepted:'#30d158',locked:'#30d158',declined:'#ff453a',countered:'#bf5af2',paused:'#8e8e93',resumed:'#30d158',expired:'#8e8e93'};
var TG={agent:'🤖 agent',student:'👤 student',system:'⚙ system'};
O.logItem=function(e,isNew){
  var li=document.createElement('li');if(isNew)li.className='new';
  li.style.setProperty('--c',LC[e.type]||'#0B84FE');
  var t=e.ts?O.ago(e.ts):'';
  li.innerHTML='<span class="dot"></span><div><div class="meta"><span class="ty">'+O.esc(e.type||'update')+'</span>'+(TG[e.kind]?'<span class="tg">'+TG[e.kind]+'</span>':'')+'<span class="tm" title="'+(e.ts?O.esc(new Date(e.ts).toLocaleString()):'')+'">'+O.esc(t)+'</span></div><div class="tx">'+O.esc(e.text)+'</div></div>';
  return li};
O.toast=function(msg){var t=document.getElementById('toast');if(!t)return;
  t.innerHTML='<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg><span></span>';
  t.lastChild.textContent=msg;t.classList.add('on');clearTimeout(O._t);O._t=setTimeout(function(){t.classList.remove('on')},2600)};
O.copy=function(text){
  if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(text).catch(function(){return fb()});
  return fb();
  function fb(){var a=document.createElement('textarea');a.value=text;a.style.cssText='position:fixed;opacity:0';document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(e){}a.remove()}};
O.api=function(path,opts){
  if(O.mock)return mockApi(path,opts||{});
  return fetch('/api'+path,Object.assign({cache:'no-store'},opts||{})).then(function(r){
    return r.json().catch(function(){return null}).then(function(j){
      if(!r.ok){var e=new Error((j&&j.error)||('HTTP '+r.status));e.status=r.status;throw e}return j})})};

/* ---------- mock (design review only) ---------- */
var M={n:0,log:[],plans:[]};
var STEPS=[
 {actor:'manav_cubbie',channel:'left',bubble:{side:'left',from:'cubbie',text:'You and Manas both have CSE 576, quiz Fri. Study Tue evening, or Thu?'},log:['agent','shared',"Manav's Cubbie found a shared course with Manas: CSE 576, quiz Fri."]},
 {actor:'manav',channel:'left',bubble:{side:'left',from:'student',text:'yes'},log:['student','shared','Manav asked his Cubbie to find a time with Manas.']},
 {actor:'manav_cubbie',channel:'agents',text:"Manav's Cubbie proposed Tue evening or Thu evening to Manas's Cubbie.",log:['agent','proposed',"Manav's Cubbie proposed CSE 576 study: Tue evening, Thu evening."]},
 {actor:'manas_cubbie',channel:'agents',text:"Manas's Cubbie received a proposal.",log:['agent','shared',"Manas's Cubbie picked up the proposal from the inbox."]},
 {actor:'manas_cubbie',channel:'agents',text:"Manas's Cubbie checked his calendar: Tue evening is busy. Moved to Thu evening.",log:['agent','moved',"Manas's Cubbie checked his calendar. Tue evening is busy. Moved to Thu evening (round 2)."]},
 {actor:'manas_cubbie',channel:'right',bubble:{side:'right',from:'cubbie',text:"Manav wants to study CSE 576 Thu 7 PM. You're free then. Lock it in?"},log:['agent','shared',"Manas's Cubbie asked Manas to confirm Thu 7:00 PM."]},
 {actor:'manas',channel:'right',bubble:{side:'right',from:'student',text:'yes'},log:['student','accepted','Manas said yes.']},
 {actor:'orbit',channel:'left',text:'Locked in: Study CSE 576 \u00B7 Thu Oct 29 \u00B7 7:00 PM',bubbles:[{side:'left',from:'cubbie',text:'Locked in: Study CSE 576 \u00B7 Thu Oct 29 \u00B7 7:00 PM\nAdded to your calendar.'},{side:'right',from:'cubbie',text:'Locked in: Study CSE 576 \u00B7 Thu Oct 29 \u00B7 7:00 PM\nAdded to your calendar.'}],plan:{},log:['system','accepted','Plan set: Study CSE 576 \u00B7 Thu Oct 29 \u00B7 7:00 PM']},
 {actor:'manav_cubbie',channel:'left',bubble:{side:'left',from:'cubbie',text:'Reya has a big day tomorrow. Want a short text to send her?'},log:['agent','shared',"Manav's Cubbie noticed Reya's big day and offered a check-in."]},
 {actor:'manav',channel:'left',text:'Big day tomorrow, you got this. coffee after? \u2615',bubbles:[{side:'left',from:'student',text:'yes'},{side:'left',from:'cubbie',text:'Big day tomorrow, you got this. coffee after? \u2615'}],note:'You send it, not the AI.',log:['agent','shared','Draft ready. Manav sends it himself, not the AI.']}
];
function mockApi(path,o){
  var d=250+Math.random()*250;
  return new Promise(function(res,rej){setTimeout(function(){
    if(path==='/stats')return res({students:128,circles:34,plans_locked:61,agent_moves:97,proposals:88,updated_at:new Date().toISOString()});
    if(path==='/demo/start'){M.n=0;M.log=[];M.plans=[];
      [['joined','Manav joined'],['joined','Manas joined'],['joined','Reya joined']].forEach(function(x,i){M.log.unshift({type:x[0],kind:'system',text:x[1],ts:new Date(Date.now()-9e4+i*1e3).toISOString()})});
      return res({demo_id:'mock',code:'DEMO42',view_v:'mock',steps_total:STEPS.length})}
    if(/^\/demo\/[^/]+\/step/.test(path)){var s=STEPS[M.n++];if(!s)return rej(new Error('done'));
      var le={type:s.log[1],kind:s.log[0],text:s.log[2],ts:new Date().toISOString()};M.log.unshift(le);
      if(s.plan)M.plans.push({kind:'study',course:'CSE 576',date:'Thu, Oct 29',time:'7:00 PM',status:'accepted',round:2,from_name:'Manav',to_names:['Manas']});
      return res({step:M.n,total:STEPS.length,actor:s.actor,channel:s.channel,text:s.text||(s.bubble&&s.bubble.text),bubble:s.bubble,bubbles:s.bubbles,note:s.note,log_entry:le,plan:s.plan,done:M.n>=STEPS.length})}
    if(/\/board/.test(path)){return res({name:'Demo · DEMO42',members:[{name:'Manav',busy:'busy',updated_at:new Date().toISOString()},{name:'Manas',busy:'packed',updated_at:new Date().toISOString()},{name:'Reya',busy:'busy',updated_at:new Date().toISOString()}],
      plans:M.plans.length?M.plans:[{kind:'study',course:'CSE 576',date:'Thu, Oct 29',time:'7:00 PM',status:'proposed',round:2,from_name:'Manav',to_names:['Manas']},{kind:'study',course:'CSE 543',date:'Mon, Oct 26',time:'2:00 PM',status:'expired',round:1,from_name:'Reya',to_names:['Manas','Manav']}],
      log:M.log.length?M.log.slice(0,60):STEPS.slice(0,7).reverse().map(function(x,i){return{type:x.log[1],kind:x.log[0],text:x.log[2],ts:new Date(Date.now()-i*36e5).toISOString()}}),stats:{proposals:2,locked:M.plans.length,agent_moves:1}})}
    rej(new Error('mock: no route '+path))},d)})}
})();
