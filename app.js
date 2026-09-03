const apiUrl='/api/gemini';
const TEST_PARTICIPANT_CODE='TESTE-MATEUS';
const RESEARCH_STORAGE_KEY='adapt_research_logs';
const TEST_STORAGE_KEY='adapt_test_logs';
const IDLE_WARNING_MS=8*60*1000;
const IDLE_END_MS=2*60*1000;

const modules={
  simplify:{title:'O texto está difícil',symbol:'Aa',description:'Cole somente o trecho que está impedindo você de continuar.',inputId:'simplify-input',buttonId:'simplify-button',logName:'Simplificador'},
  context:{title:'Não entendo para que isso serve',symbol:'↗',description:'Informe o conceito e veja uma conexão concreta com a vida real ou o mundo do trabalho.',inputId:'context-input',buttonId:'context-button',logName:'ContextoVidaReal'},
  image:{title:'Não entendi a imagem',symbol:'◫',description:'Envie a representação visual que está impedindo você de avançar.',buttonId:'image-button',logName:'DescritorImagens'},
  starter:{title:'Não sei por onde começar',symbol:'1→',description:'Descreva o que foi pedido. O Adapt vai indicar apenas como destravar o início.',inputId:'starter-input',buttonId:'starter-button',logName:'PrimeiroPasso'},
  voice:{title:'Prefiro ouvir',symbol:'▶',description:'Cole o trecho que você prefere escutar.',inputId:'voice-input',logName:'LeitorVoz'}
};

let currentModule=null;
let selectedFile=null;
let currentResult='';
let helpLevel=0;
let session={id:null,participantCode:null,startedAt:null,isTest:false};
let speechSynthesisRef=window.speechSynthesis;
let interfaceFontStep=0;
let screenBeforeResearch='barrier-screen';
let idleWarningTimer=null;
let idleEndTimer=null;
let pendingDeletion=null;

function ensureTestModeBadge(){
  if(document.getElementById('test-mode-badge'))return;
  const actions=document.querySelector('.topbar-actions');
  if(!actions)return;
  const badge=document.createElement('span');
  badge.id='test-mode-badge';badge.textContent='🧪 Modo Teste';badge.className='test-mode-badge';badge.setAttribute('aria-live','polite');actions.prepend(badge);
}
function updateTestModeUI(){
  ensureTestModeBadge();
  const badge=document.getElementById('test-mode-badge');const dashboardButton=document.getElementById('research-dashboard-button');
  if(badge)badge.classList.toggle('hidden',!session.isTest);if(dashboardButton)dashboardButton.classList.toggle('hidden',!session.isTest);
  document.body.dataset.testMode=session.isTest?'true':'false';
}
function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  const screen=document.getElementById(id);if(screen)screen.classList.add('active');
  window.scrollTo({top:0,behavior:'smooth'});
  const hideEnd=['start-screen','complete-screen','research-screen'].includes(id);
  document.getElementById('end-session-button').classList.toggle('hidden',hideEnd);updateTestModeUI();
  if(id==='research-screen')clearIdleTimers();else if(session.id)scheduleIdleProtection();
}
function startSession(requireCode){
  const input=document.getElementById('participant-code');const code=input.value.trim().toUpperCase();
  if(requireCode&&!code){input.focus();input.setAttribute('aria-invalid','true');return;}
  input.removeAttribute('aria-invalid');const isTest=code===TEST_PARTICIPANT_CODE;
  session={id:crypto.randomUUID(),participantCode:code||null,startedAt:new Date().toISOString(),isTest};
  saveEvent('session_started',{with_code:Boolean(code),mode:isTest?'test':'standard'});showScreen('barrier-screen');
}
function selectModule(name){
  currentModule=name;helpLevel=0;currentResult='';const cfg=modules[name];
  document.getElementById('module-title').textContent=cfg.title;document.getElementById('module-description').textContent=cfg.description;document.getElementById('module-symbol').textContent=cfg.symbol;
  document.querySelectorAll('.module-panel').forEach(p=>p.classList.add('hidden'));document.getElementById(`panel-${name}`).classList.remove('hidden');document.getElementById('result-card').classList.add('hidden');hideStatus();
  saveEvent('barrier_selected',{module:cfg.logName});showScreen('help-screen');
}
function goToBarrierScreen(){if(!session.id){showScreen('start-screen');return;}stopText();showScreen('barrier-screen');}

function buildPrompt(type,input,moreHelp=false){
  const base=`Você é o Adapt, uma ferramenta de mediação pedagógica. Sua função é remover uma barreira de compreensão sem realizar a atividade pelo estudante. Não entregue a resposta final de exercícios, não produza trabalhos prontos e não substitua o raciocínio do aluno. Use linguagem clara, objetiva e respeitosa. A mediação deve ser curta, adequada para um totem compartilhado em sala de aula. Termine orientando o estudante a voltar para a própria atividade.`;
  const extra=moreHelp?` O estudante já recebeu uma mediação e ainda precisa de ajuda. Ofereça uma pista adicional, um pouco mais específica, mas continue sem resolver a atividade. Esta é a pista de nível ${helpLevel}.`:' ';
  if(type==='simplify')return `${base}${extra}\n\nTarefa: reescreva o trecho em linguagem mais acessível sem perder o rigor conceitual. Explique no máximo 3 termos difíceis que sejam essenciais. Não acrescente conteúdo desnecessário.\n\nTrecho: ${input}`;
  if(type==='context')return `${base}${extra}\n\nTarefa: conecte o conceito a 1 ou 2 situações concretas da vida real, da formação técnica ou do mundo do trabalho. Explique a relação, não apenas dê exemplos soltos.\n\nConceito: ${input}`;
  if(type==='starter')return `${base}${extra}\n\nTarefa: ajude o estudante a identificar o que a atividade pede, decomponha mentalmente o problema e indique somente o próximo passo útil para ele começar. Não crie um plano longo, cronograma, checklist permanente ou resposta pronta.\n\nAtividade: ${input}`;
  return `${base}${extra}\n\nTarefa: descreva pedagogicamente a imagem. Diga primeiro o que aparece, depois onde o estudante deve olhar e por fim qual relação importante ele deve perceber. Não responda uma questão associada à imagem. Se houver texto legível, use-o apenas como contexto.`;
}
async function requestMediation(type,moreHelp=false){
  hideStatus();let input='';let parts=[];
  if(type==='image'){
    if(!selectedFile){showStatus('Selecione uma imagem antes de continuar.','error');return;}
    const imagePart=await fileToGenerativePart(selectedFile);parts=[{text:buildPrompt(type,'',moreHelp)},imagePart];input='Imagem enviada';
  }else{
    const cfg=modules[type];input=document.getElementById(cfg.inputId).value.trim();
    if(!input){showStatus('Preencha o campo para que o Adapt possa ajudar.','error');return;}
    parts=[{text:buildPrompt(type,input,moreHelp)}];
  }
  if(moreHelp)helpLevel+=1;else helpLevel=1;setLoading(true);
  try{
    const text=await callGemini(parts);currentResult=text;document.getElementById('result-output').innerHTML=formatAIResponse(text);document.getElementById('result-card').classList.remove('hidden');
    document.getElementById('more-help-button').textContent=helpLevel>=2?'Ainda preciso de outra pista':'Ainda preciso de uma pista';
    saveEvent(moreHelp?'additional_hint_requested':'mediation_generated',{module:modules[type].logName,help_level:helpLevel,input_length:type==='image'?null:input.length});
    if(window.MathJax)MathJax.typesetPromise([document.getElementById('result-output')]);document.getElementById('result-card').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){console.error(error);showStatus('Não foi possível gerar a mediação agora. Tente novamente.','error');}finally{setLoading(false);}
}
function requestMoreHelp(){if(currentModule&&currentModule!=='voice')requestMediation(currentModule,true);}
function markReturnToActivity(){saveEvent('return_to_activity',{module:modules[currentModule]?.logName||currentModule,help_level:helpLevel});stopText();showScreen('complete-screen');}
function finishSession(completed=true,reason='manual'){
  if(session.id){const started=new Date(session.startedAt).getTime();saveEvent('session_ended',{completed,reason,duration_seconds:Number.isFinite(started)?Math.max(0,Math.round((Date.now()-started)/1000)):null});}
  clearIdleTimers();hideIdleOverlay();clearWorkingData();session={id:null,participantCode:null,startedAt:null,isTest:false};document.getElementById('participant-code').value='';updateTestModeUI();showScreen('start-screen');
}
function prepareNextStudent(){finishSession(true,'returned_to_activity');}
function clearWorkingData(){
  document.querySelectorAll('textarea').forEach(t=>t.value='');document.getElementById('result-output').innerHTML='';document.getElementById('result-card').classList.add('hidden');selectedFile=null;currentResult='';currentModule=null;helpLevel=0;
  const preview=document.getElementById('image-preview');preview.src='';preview.classList.add('hidden');document.getElementById('image-placeholder').classList.remove('hidden');document.getElementById('image-input').value='';stopText();hideStatus();
}
function handleFileSelect(event){
  selectedFile=event.target.files?.[0]||null;const preview=document.getElementById('image-preview');const placeholder=document.getElementById('image-placeholder');
  if(!selectedFile){preview.classList.add('hidden');placeholder.classList.remove('hidden');return;}
  const reader=new FileReader();reader.onload=e=>{preview.src=e.target.result;preview.classList.remove('hidden');placeholder.classList.add('hidden');};reader.readAsDataURL(selectedFile);
}
function fileToGenerativePart(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onloadend=()=>resolve({inlineData:{mimeType:file.type,data:reader.result.split(',')[1]}});reader.onerror=reject;reader.readAsDataURL(file);});}
async function callGemini(parts){
  const response=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}]})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Erro na API');
  return data.text||data.result||data.candidates?.[0]?.content?.parts?.[0]?.text||'';
}
function formatAIResponse(text){
  const safe=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');const styled=safe.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/(?<!\*)\*(?!\s)(.*?)(?<!\s)\*(?!\*)/g,'<em>$1</em>');
  const lines=styled.trim().split('\n');let html='',ul=false,ol=false;const closeLists=()=>{if(ul){html+='</ul>';ul=false}if(ol){html+='</ol>';ol=false}};
  for(const line of lines){const t=line.trim();if(!t)continue;if(t.startsWith('#')){closeLists();html+=`<h3>${t.replace(/#+\s*/,'')}</h3>`;continue}if(/^[-*]\s/.test(t)){if(!ul){if(ol){html+='</ol>';ol=false}html+='<ul>';ul=true}html+=`<li>${t.replace(/^[-*]\s/,'')}</li>`;continue}if(/^\d+\.\s/.test(t)){if(!ol){if(ul){html+='</ul>';ul=false}html+='<ol>';ol=true}html+=`<li>${t.replace(/^\d+\.\s/,'')}</li>`;continue}closeLists();html+=`<p>${t}</p>`}closeLists();return html;
}
function playVoiceText(){const text=document.getElementById('voice-input').value.trim();if(!text){showStatus('Cole ou digite um texto para ouvir.','error');return;}saveEvent('voice_started',{module:'LeitorVoz',input_length:text.length});speak(text);}
function narrateResult(){if(currentResult){saveEvent('mediation_narrated',{module:modules[currentModule]?.logName||currentModule});speak(currentResult)}}
function speak(text){stopText();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='pt-BR';utterance.rate=1;speechSynthesisRef.speak(utterance)}
function stopText(){if(speechSynthesisRef)speechSynthesisRef.cancel()}
function setLoading(isLoading){const id=modules[currentModule]?.buttonId;if(!id)return;const button=document.getElementById(id);button.disabled=isLoading;button.classList.toggle('loading',isLoading);}
function showStatus(message,type='info'){const el=document.getElementById('status-message');el.textContent=message;el.className=`status-message ${type}`;el.classList.remove('hidden')}
function hideStatus(){document.getElementById('status-message').classList.add('hidden')}
function changeInterfaceFont(direction){interfaceFontStep=Math.max(-2,Math.min(4,interfaceFontStep+direction));document.documentElement.style.fontSize=`${16+interfaceFontStep}px`}

function readLogs(storageKey){try{const parsed=JSON.parse(localStorage.getItem(storageKey)||'[]');return Array.isArray(parsed)?parsed:[];}catch{return[];}}
function writeLogs(storageKey,logs){localStorage.setItem(storageKey,JSON.stringify(Array.isArray(logs)?logs:[]));}
function saveEvent(event,data={}){
  if(!session.id)return;const storageKey=session.isTest?TEST_STORAGE_KEY:RESEARCH_STORAGE_KEY;const logs=readLogs(storageKey);
  logs.push({event,timestamp:new Date().toISOString(),session_id:session.id,participant_code:session.participantCode,is_test:Boolean(session.isTest),...data});writeLogs(storageKey,logs);
}
function exportJson(storageKey,filePrefix){const blob=new Blob([JSON.stringify(readLogs(storageKey),null,2)],{type:'application/json;charset=utf-8'});downloadBlob(blob,`${filePrefix}_${new Date().toISOString().slice(0,10)}.json`);}
function exportResearchJson(){exportJson(RESEARCH_STORAGE_KEY,'adapt_pesquisa')}
function exportTestJson(){exportJson(TEST_STORAGE_KEY,'adapt_testes')}
function exportResearchCsv(){
  const logs=readLogs(RESEARCH_STORAGE_KEY);const columns=['event','timestamp','session_id','participant_code','is_test','module','help_level','input_length','with_code','mode','completed','reason','duration_seconds'];const rows=[columns.join(',')];
  for(const item of logs)rows.push(columns.map(key=>csvCell(item[key])).join(','));const blob=new Blob(['\ufeff'+rows.join('\n')],{type:'text/csv;charset=utf-8'});downloadBlob(blob,`adapt_pesquisa_${new Date().toISOString().slice(0,10)}.csv`);
}
function csvCell(value){if(value===undefined||value===null)return'';const str=String(value);return /[",\n]/.test(str)?`"${str.replace(/"/g,'""')}"`:str;}
function downloadBlob(blob,fileName){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=fileName;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

function openResearchDashboard(){
  if(!session.isTest)return;const active=document.querySelector('.screen.active');if(active&&active.id!=='research-screen')screenBeforeResearch=active.id;renderResearchDashboard();showScreen('research-screen');
}
function closeResearchDashboard(){showScreen(screenBeforeResearch||'barrier-screen')}
function renderResearchDashboard(){
  const logs=readLogs(RESEARCH_STORAGE_KEY).filter(item=>!item.is_test);const sessionsStarted=logs.filter(i=>i.event==='session_started');const sessionIds=new Set(sessionsStarted.map(i=>i.session_id).filter(Boolean));const participants=new Set(sessionsStarted.map(i=>i.participant_code).filter(Boolean));
  const mediations=logs.filter(i=>i.event==='mediation_generated');const mediatedSessions=new Set(mediations.map(i=>i.session_id).filter(Boolean));const returnedSessions=new Set(logs.filter(i=>i.event==='return_to_activity').map(i=>i.session_id).filter(Boolean));const returnCount=[...mediatedSessions].filter(id=>returnedSessions.has(id)).length;const returnRate=mediatedSessions.size?Math.round(returnCount/mediatedSessions.size*100):0;
  const maxHelpBySession={};logs.filter(i=>['mediation_generated','additional_hint_requested'].includes(i.event)&&i.session_id).forEach(i=>{const level=Number(i.help_level)||0;maxHelpBySession[i.session_id]=Math.max(maxHelpBySession[i.session_id]||0,level);});const helpValues=Object.values(maxHelpBySession);const avgHelp=helpValues.length?helpValues.reduce((a,b)=>a+b,0)/helpValues.length:0;
  const durations=logs.filter(i=>i.event==='session_ended'&&Number.isFinite(Number(i.duration_seconds))).map(i=>Number(i.duration_seconds));const avgDuration=durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:0;
  setText('metric-participants',participants.size);setText('metric-sessions',sessionIds.size);setText('metric-mediations',mediations.length);setText('metric-return-rate',`${returnRate}%`);setText('metric-help-level',avgHelp?avgHelp.toFixed(1):'0');setText('metric-duration',formatDuration(avgDuration));
  const barriers={};logs.filter(i=>i.event==='barrier_selected').forEach(i=>{const name=i.module||'Outro';barriers[name]=(barriers[name]||0)+1;});renderBarChart('barrier-chart',barriers,'Nenhuma barreira registrada ainda.');
  const helpDist={'1 mediação':0,'2 pistas':0,'3+ pistas':0};helpValues.forEach(level=>{if(level<=1)helpDist['1 mediação']++;else if(level===2)helpDist['2 pistas']++;else helpDist['3+ pistas']++;});renderBarChart('help-chart',helpDist,'Ainda não há sessões com mediação.');
  renderParticipantManagement(logs);
}
function setText(id,value){const el=document.getElementById(id);if(el)el.textContent=value;}
function formatDuration(seconds){const total=Math.round(Number(seconds)||0);if(total<60)return`${total}s`;const min=Math.floor(total/60),sec=total%60;return`${min}min ${sec}s`;}
function formatDateTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?'Sem horário':date.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'});}
function renderBarChart(id,data,emptyText){
  const el=document.getElementById(id);if(!el)return;const entries=Object.entries(data).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);if(!entries.length){el.innerHTML=`<p class="empty-state">${emptyText}</p>`;return;}
  const max=Math.max(...entries.map(([,v])=>v));el.innerHTML=entries.map(([label,value])=>`<div class="bar-row"><div class="bar-meta"><span>${escapeHtml(label)}</span><strong>${value}</strong></div><div class="bar-track"><span style="width:${Math.max(5,value/max*100)}%"></span></div></div>`).join('');
}
function escapeHtml(value){return String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}

function renderParticipantManagement(logs=readLogs(RESEARCH_STORAGE_KEY).filter(item=>!item.is_test)){
  const list=document.getElementById('participant-list');if(!list)return;
  const grouped=new Map();
  for(const item of logs){
    const code=item.participant_code;if(!code)continue;
    if(!grouped.has(code))grouped.set(code,{code,events:0,sessions:new Set(),last:null});
    const entry=grouped.get(code);entry.events++;if(item.session_id)entry.sessions.add(item.session_id);if(item.timestamp&&(!entry.last||new Date(item.timestamp)>new Date(entry.last)))entry.last=item.timestamp;
  }
  const participants=[...grouped.values()].sort((a,b)=>a.code.localeCompare(b.code,'pt-BR'));
  if(!participants.length){list.innerHTML='<p class="empty-state">Nenhum participante com código foi registrado neste dispositivo.</p>';return;}
  list.innerHTML=participants.map(p=>`<div class="participant-row"><div class="participant-main"><strong>${escapeHtml(p.code)}</strong><span>${p.sessions.size} sessão(ões) · ${p.events} evento(s) · última atividade: ${escapeHtml(formatDateTime(p.last))}</span></div><div class="participant-actions"><button class="secondary-button" type="button" data-code="${escapeHtml(p.code)}" onclick="openParticipantDetails(this.dataset.code)">Ver dados</button><button class="danger-button" type="button" data-code="${escapeHtml(p.code)}" onclick="requestParticipantDeletion(this.dataset.code)">Excluir dados</button></div></div>`).join('');
}

function openParticipantDetails(code){
  if(!session.isTest)return;const logs=readLogs(RESEARCH_STORAGE_KEY).filter(i=>!i.is_test&&i.participant_code===code);const sessionsMap=new Map();
  for(const item of logs){const id=item.session_id||'sem-sessao';if(!sessionsMap.has(id))sessionsMap.set(id,[]);sessionsMap.get(id).push(item);}
  const sessions=[...sessionsMap.entries()].filter(([id])=>id!=='sem-sessao').sort((a,b)=>new Date(b[1][0]?.timestamp||0)-new Date(a[1][0]?.timestamp||0));
  setText('participant-details-title',`Participante ${code}`);setText('participant-details-summary',`${sessions.length} sessão(ões) e ${logs.length} evento(s) armazenados neste dispositivo.`);
  const container=document.getElementById('participant-session-list');
  if(!sessions.length)container.innerHTML='<p class="empty-state">Nenhuma sessão encontrada para este código.</p>';
  else container.innerHTML=sessions.map(([id,items])=>{
    const start=items.find(i=>i.event==='session_started')?.timestamp||items[0]?.timestamp;const end=items.find(i=>i.event==='session_ended');const modules=[...new Set(items.map(i=>i.module).filter(Boolean))];const maxHelp=Math.max(0,...items.map(i=>Number(i.help_level)||0));const returned=items.some(i=>i.event==='return_to_activity');
    const meta=[formatDateTime(start),`${items.length} eventos`,modules.length?modules.join(', '):'sem módulo',maxHelp?`ajuda nível ${maxHelp}`:'sem mediação',returned?'retornou à atividade':'sem retorno registrado',end?.duration_seconds!=null?`duração ${formatDuration(end.duration_seconds)}`:null].filter(Boolean).join(' · ');
    return `<div class="session-row"><div><strong>Sessão ${escapeHtml(id.slice(0,8))}</strong><small>${escapeHtml(meta)}</small></div><button class="danger-button" type="button" data-session="${escapeHtml(id)}" data-code="${escapeHtml(code)}" onclick="requestSessionDeletion(this.dataset.session,this.dataset.code)">Excluir sessão</button></div>`;
  }).join('');
  const deleteAll=document.getElementById('delete-participant-from-details');deleteAll.dataset.code=code;deleteAll.onclick=()=>requestParticipantDeletion(deleteAll.dataset.code);
  document.getElementById('participant-details-overlay').classList.remove('hidden');
}
function closeParticipantDetails(){document.getElementById('participant-details-overlay').classList.add('hidden');}

function requestParticipantDeletion(code){
  pendingDeletion={type:'participant',code,expected:code};closeParticipantDetails();openDeletionConfirmation(`Excluir todos os dados de ${code}?`,`Serão removidas todas as sessões e interações associadas ao código ${code}. Esta ação não poderá ser desfeita.`,code);
}
function requestSessionDeletion(sessionId,code){
  pendingDeletion={type:'session',sessionId,code,expected:code};closeParticipantDetails();openDeletionConfirmation(`Excluir esta sessão de ${code}?`,`Somente a sessão ${sessionId.slice(0,8)} e seus eventos serão removidos. Os outros registros de ${code} serão preservados.`,code);
}
function requestClearTestLogs(){
  pendingDeletion={type:'tests',expected:TEST_PARTICIPANT_CODE};openDeletionConfirmation('Apagar todos os dados de teste?','Todos os registros gerados no Modo Teste serão removidos. Os dados da pesquisa real não serão afetados.',TEST_PARTICIPANT_CODE);
}
function openDeletionConfirmation(title,message,expected){
  setText('delete-confirm-title',title);setText('delete-confirm-message',message);setText('delete-confirm-label',`Digite ${expected} para confirmar`);
  const input=document.getElementById('delete-confirm-input');input.value='';document.getElementById('delete-confirm-button').disabled=true;document.getElementById('delete-confirm-overlay').classList.remove('hidden');setTimeout(()=>input.focus(),50);
}
function validateDeletionConfirmation(){
  const input=document.getElementById('delete-confirm-input');const button=document.getElementById('delete-confirm-button');button.disabled=!pendingDeletion||input.value.trim().toUpperCase()!==String(pendingDeletion.expected).toUpperCase();
}
function cancelDeletion(){pendingDeletion=null;document.getElementById('delete-confirm-overlay').classList.add('hidden');document.getElementById('delete-confirm-input').value='';}
function executeDeletion(){
  if(!pendingDeletion)return;const input=document.getElementById('delete-confirm-input').value.trim().toUpperCase();if(input!==String(pendingDeletion.expected).toUpperCase())return;
  const deletion={...pendingDeletion};let deletedCount=0;
  if(deletion.type==='participant'){
    const logs=readLogs(RESEARCH_STORAGE_KEY);const remaining=logs.filter(i=>i.participant_code!==deletion.code);deletedCount=logs.length-remaining.length;writeLogs(RESEARCH_STORAGE_KEY,remaining);saveEvent('research_data_deleted',{scope:'participant',target_code:deletion.code,deleted_events:deletedCount});
  }else if(deletion.type==='session'){
    const logs=readLogs(RESEARCH_STORAGE_KEY);const remaining=logs.filter(i=>!(i.session_id===deletion.sessionId&&i.participant_code===deletion.code));deletedCount=logs.length-remaining.length;writeLogs(RESEARCH_STORAGE_KEY,remaining);saveEvent('research_data_deleted',{scope:'session',target_code:deletion.code,target_session:deletion.sessionId,deleted_events:deletedCount});
  }else if(deletion.type==='tests'){
    deletedCount=readLogs(TEST_STORAGE_KEY).length;localStorage.removeItem(TEST_STORAGE_KEY);
  }
  cancelDeletion();renderResearchDashboard();showResearchStatus(deletion.type==='tests'?`${deletedCount} registro(s) de teste foram apagados.`:`${deletedCount} registro(s) foram excluídos da pesquisa local.`);
}
function showResearchStatus(message,type='success'){
  const el=document.getElementById('research-status');if(!el)return;el.textContent=message;el.className=`research-status${type==='error'?' error':''}`;el.classList.remove('hidden');setTimeout(()=>el.classList.add('hidden'),5000);
}

function scheduleIdleProtection(){clearIdleTimers();if(!session.id||document.getElementById('research-screen').classList.contains('active'))return;idleWarningTimer=setTimeout(showIdleWarning,IDLE_WARNING_MS);}
function clearIdleTimers(){if(idleWarningTimer)clearTimeout(idleWarningTimer);if(idleEndTimer)clearTimeout(idleEndTimer);idleWarningTimer=null;idleEndTimer=null;}
function showIdleWarning(){if(!session.id)return;saveEvent('inactivity_warning');document.getElementById('idle-overlay').classList.remove('hidden');idleEndTimer=setTimeout(()=>finishSession(false,'inactivity_timeout'),IDLE_END_MS);}
function hideIdleOverlay(){document.getElementById('idle-overlay').classList.add('hidden')}
function continueIdleSession(){hideIdleOverlay();saveEvent('inactivity_session_continued');scheduleIdleProtection();}
function registerActivity(){if(!session.id)return;const overlay=document.getElementById('idle-overlay');if(overlay&&!overlay.classList.contains('hidden'))return;scheduleIdleProtection();}

// Atalhos do pesquisador: Ctrl+Alt+P abre o painel em Modo Teste; L exporta pesquisa; T exporta testes.
document.addEventListener('keydown',event=>{
  if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='p'){event.preventDefault();openResearchDashboard();}
  if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='l'){event.preventDefault();exportResearchJson();}
  if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='t'){event.preventDefault();exportTestJson();}
  if(event.key==='Escape'){stopText();if(!document.getElementById('delete-confirm-overlay').classList.contains('hidden'))cancelDeletion();else if(!document.getElementById('participant-details-overlay').classList.contains('hidden'))closeParticipantDetails();}
});
['pointerdown','touchstart','input'].forEach(type=>document.addEventListener(type,registerActivity,{passive:true}));
document.addEventListener('DOMContentLoaded',()=>{ensureTestModeBadge();updateTestModeUI();});