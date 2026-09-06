// Adapt Central Storage
// Mantém os logs locais como contingência e sincroniza somente dados estruturados com o backend.
(function(){
  const CENTRAL_HEALTH='/api/research-health';
  const CENTRAL_SESSION='/api/research-session';
  const CENTRAL_EVENTS='/api/research-events';
  const CENTRAL_ADMIN='/api/research-admin';
  const ADMIN_SESSION_KEY='adapt_research_admin_key';
  const STORAGE_KEYS=[RESEARCH_STORAGE_KEY,TEST_STORAGE_KEY];

  const originalStartSession=startSession;
  const originalOpenResearchDashboard=openResearchDashboard;
  const originalExecuteDeletion=executeDeletion;
  const localExportResearchCsv=window.exportResearchCsv;
  const localExportResearchJson=window.exportResearchJson;
  const localExportTestJson=window.exportTestJson;

  let centralConfigured=false;
  let centralStatus='checking';
  let syncing=false;
  let syncTimer=null;

  function ensureStorageStatus(){
    if(document.getElementById('central-storage-status'))return;
    const header=document.querySelector('.research-header > div');
    if(!header)return;
    const badge=document.createElement('div');
    badge.id='central-storage-status';
    badge.style.marginTop='12px';
    badge.style.display='inline-flex';
    badge.style.alignItems='center';
    badge.style.gap='8px';
    badge.style.padding='8px 12px';
    badge.style.borderRadius='999px';
    badge.style.fontSize='.84rem';
    badge.style.fontWeight='800';
    badge.style.background='#eef5fb';
    badge.style.color='#2f6690';
    header.appendChild(badge);
  }

  function setStorageStatus(label,state='info'){
    centralStatus=state;
    ensureStorageStatus();
    const el=document.getElementById('central-storage-status');
    if(!el)return;
    const icons={success:'☁️',syncing:'↻',warning:'⚠️',info:'○'};
    el.textContent=`${icons[state]||icons.info} ${label}`;
    if(state==='success'){el.style.background='#e7f6ef';el.style.color='#276c4d';}
    else if(state==='warning'){el.style.background='#fff4df';el.style.color='#8b5a12';}
    else{el.style.background='#eef5fb';el.style.color='#2f6690';}
  }

  async function checkCentralHealth(){
    try{
      const response=await fetch(CENTRAL_HEALTH,{cache:'no-store'});
      const data=await response.json();
      centralConfigured=Boolean(response.ok&&data.configured);
      if(centralConfigured)setStorageStatus('Banco central conectado','success');
      else setStorageStatus('Modo local — banco ainda não configurado','warning');
      return centralConfigured;
    }catch{
      centralConfigured=false;
      setStorageStatus('Modo local — sem conexão com o banco','warning');
      return false;
    }
  }

  function normalizeStoredLogs(storageKey){
    const logs=readLogs(storageKey);
    let changed=false;
    for(const item of logs){
      if(!item.event_id){item.event_id=crypto.randomUUID();changed=true;}
      if(!item.sync_status){
        item.sync_status=item.participant_code?'pending':'local_only';
        changed=true;
      }
    }
    if(changed)writeLogs(storageKey,logs);
    return logs;
  }

  // Substitui apenas a persistência do evento. A estrutura analítica existente continua a mesma.
  saveEvent=function(event,data={}){
    if(!session.id)return null;
    const storageKey=session.isTest?TEST_STORAGE_KEY:RESEARCH_STORAGE_KEY;
    const logs=readLogs(storageKey);
    const item={
      event_id:crypto.randomUUID(),
      event,
      timestamp:new Date().toISOString(),
      session_id:session.id,
      participant_code:session.participantCode,
      is_test:Boolean(session.isTest),
      sync_status:session.participantCode?'pending':'local_only',
      ...data
    };
    logs.push(item);
    writeLogs(storageKey,logs);
    if(item.sync_status==='pending')scheduleSync(80);
    return item;
  };

  startSession=function(requireCode){
    originalStartSession(requireCode);
    if(session.id&&session.participantCode)scheduleSync(80);
  };

  function scheduleSync(delay=400){
    if(syncTimer)clearTimeout(syncTimer);
    syncTimer=setTimeout(syncAllPendingLogs,delay);
  }

  async function requestSyncToken(sessionId,participantCode){
    const response=await fetch(CENTRAL_SESSION,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session_id:sessionId,participant_code:participantCode})
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Não foi possível abrir uma sessão de sincronização.');
    return data.token;
  }

  async function sendEventBatch(token,events){
    const response=await fetch(CENTRAL_EVENTS,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify({events})
    });
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'Não foi possível sincronizar os eventos.');
    return data;
  }

  function markEventsSynced(storageKey,eventIds){
    const ids=new Set(eventIds);
    const logs=readLogs(storageKey);
    let changed=false;
    for(const item of logs){
      if(ids.has(item.event_id)){
        item.sync_status='synced';
        item.synced_at=new Date().toISOString();
        changed=true;
      }
    }
    if(changed)writeLogs(storageKey,logs);
  }

  async function syncStorageKey(storageKey){
    const logs=normalizeStoredLogs(storageKey);
    const pending=logs.filter(i=>i.sync_status!=='synced'&&i.sync_status!=='local_only'&&i.participant_code&&i.session_id);
    if(!pending.length)return 0;

    const groups=new Map();
    for(const item of pending){
      const key=`${item.session_id}|${item.participant_code}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push(item);
    }

    let total=0;
    for(const items of groups.values()){
      const first=items[0];
      const token=await requestSyncToken(first.session_id,first.participant_code);
      for(let i=0;i<items.length;i+=100){
        const batch=items.slice(i,i+100);
        await sendEventBatch(token,batch);
        markEventsSynced(storageKey,batch.map(x=>x.event_id));
        total+=batch.length;
      }
    }
    return total;
  }

  async function syncAllPendingLogs(){
    if(syncing||!navigator.onLine)return;
    syncing=true;
    try{
      if(!centralConfigured){
        const ready=await checkCentralHealth();
        if(!ready)return;
      }
      setStorageStatus('Sincronizando dados estruturados…','syncing');
      const researchCount=await syncStorageKey(RESEARCH_STORAGE_KEY);
      const testCount=await syncStorageKey(TEST_STORAGE_KEY);
      const total=researchCount+testCount;
      setStorageStatus(total?`${total} evento(s) sincronizado(s)`:'Banco central conectado','success');
    }catch(error){
      console.warn('Sincronização central adiada:',error);
      setStorageStatus('Dados preservados localmente — sincronização pendente','warning');
    }finally{
      syncing=false;
    }
  }

  function getAdminKey(forcePrompt=false){
    let key=!forcePrompt?sessionStorage.getItem(ADMIN_SESSION_KEY):null;
    if(!key){
      key=window.prompt('Digite a senha administrativa do Adapt Research. Ela não é o código TESTE-MATEUS.');
      if(key)sessionStorage.setItem(ADMIN_SESSION_KEY,key);
    }
    return key||null;
  }

  async function adminRequest(action,payload={},forcePrompt=false){
    const key=getAdminKey(forcePrompt);
    if(!key)throw new Error('Acesso administrativo cancelado.');
    const response=await fetch(CENTRAL_ADMIN,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-research-admin-key':key},
      body:JSON.stringify({action,...payload})
    });
    const data=await response.json();
    if(response.status===401){
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      if(!forcePrompt)return adminRequest(action,payload,true);
    }
    if(!response.ok)throw new Error(data.error||'Falha no acesso ao banco central.');
    return data;
  }

  async function fetchCentralEvents(isTest=false){
    const data=await adminRequest(isTest?'list-tests':'list-research');
    return Array.isArray(data.events)?data.events:[];
  }

  function renderDashboardFromLogs(logs){
    const researchLogs=logs.filter(item=>!item.is_test);
    const sessionsStarted=researchLogs.filter(i=>i.event==='session_started');
    const sessionIds=new Set(sessionsStarted.map(i=>i.session_id).filter(Boolean));
    const participants=new Set(sessionsStarted.map(i=>i.participant_code).filter(Boolean));
    const mediations=researchLogs.filter(i=>i.event==='mediation_generated');
    const mediatedSessions=new Set(mediations.map(i=>i.session_id).filter(Boolean));
    const returnedSessions=new Set(researchLogs.filter(i=>i.event==='return_to_activity').map(i=>i.session_id).filter(Boolean));
    const returnCount=[...mediatedSessions].filter(id=>returnedSessions.has(id)).length;
    const returnRate=mediatedSessions.size?Math.round(returnCount/mediatedSessions.size*100):0;
    const maxHelpBySession={};
    researchLogs.filter(i=>['mediation_generated','additional_hint_requested'].includes(i.event)&&i.session_id).forEach(i=>{
      const level=Number(i.help_level)||0;
      maxHelpBySession[i.session_id]=Math.max(maxHelpBySession[i.session_id]||0,level);
    });
    const helpValues=Object.values(maxHelpBySession);
    const avgHelp=helpValues.length?helpValues.reduce((a,b)=>a+b,0)/helpValues.length:0;
    const durations=researchLogs.filter(i=>i.event==='session_ended'&&Number.isFinite(Number(i.duration_seconds))).map(i=>Number(i.duration_seconds));
    const avgDuration=durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:0;

    setText('metric-participants',participants.size);
    setText('metric-sessions',sessionIds.size);
    setText('metric-mediations',mediations.length);
    setText('metric-return-rate',`${returnRate}%`);
    setText('metric-help-level',avgHelp?avgHelp.toFixed(1):'0');
    setText('metric-duration',formatDuration(avgDuration));

    const barriers={};
    researchLogs.filter(i=>i.event==='barrier_selected').forEach(i=>{const name=i.module||'Outro';barriers[name]=(barriers[name]||0)+1;});
    renderBarChart('barrier-chart',barriers,'Nenhuma barreira registrada ainda.');
    const helpDist={'1 mediação':0,'2 pistas':0,'3+ pistas':0};
    helpValues.forEach(level=>{if(level<=1)helpDist['1 mediação']++;else if(level===2)helpDist['2 pistas']++;else helpDist['3+ pistas']++;});
    renderBarChart('help-chart',helpDist,'Ainda não há sessões com mediação.');
    renderParticipantManagement(researchLogs);
  }

  async function refreshCentralDashboard(){
    if(!centralConfigured)return;
    try{
      setStorageStatus('Carregando dados do banco central…','syncing');
      const events=await fetchCentralEvents(false);
      renderDashboardFromLogs(events);
      setStorageStatus('Painel usando dados do banco central','success');
    }catch(error){
      if(error.message==='Acesso administrativo cancelado.'){
        setStorageStatus('Painel local — acesso central não informado','warning');
        return;
      }
      showResearchStatus(error.message,'error');
      setStorageStatus('Painel local — falha ao carregar banco central','warning');
    }
  }

  openResearchDashboard=function(){
    originalOpenResearchDashboard();
    checkCentralHealth().then(ready=>{if(ready)refreshCentralDashboard();});
  };

  function safeCsvCell(value){
    if(value===undefined||value===null)return'';
    let str=String(value);
    if(/^[=+\-@]/.test(str))str="'"+str;
    if(/[;"\r\n]/.test(str))str='"'+str.replace(/"/g,'""')+'"';
    return str;
  }

  function downloadCsvFromLogs(logs){
    const columns=['event','timestamp','session_id','participant_code','is_test','module','help_level','input_length','with_code','mode','completed','reason','duration_seconds'];
    const rows=[columns.join(';')];
    for(const item of logs)rows.push(columns.map(key=>safeCsvCell(item[key])).join(';'));
    downloadBlob(new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}),`adapt_pesquisa_${new Date().toISOString().slice(0,10)}.csv`);
  }

  window.exportResearchCsv=async function(){
    if(!centralConfigured){localExportResearchCsv();return;}
    try{downloadCsvFromLogs(await fetchCentralEvents(false));}
    catch(error){showResearchStatus(error.message,'error');}
  };

  window.exportResearchJson=async function(){
    if(!centralConfigured){localExportResearchJson();return;}
    try{
      const logs=await fetchCentralEvents(false);
      downloadBlob(new Blob([JSON.stringify(logs,null,2)],{type:'application/json;charset=utf-8'}),`adapt_pesquisa_${new Date().toISOString().slice(0,10)}.json`);
    }catch(error){showResearchStatus(error.message,'error');}
  };

  window.exportTestJson=async function(){
    if(!centralConfigured){localExportTestJson();return;}
    try{
      const logs=await fetchCentralEvents(true);
      downloadBlob(new Blob([JSON.stringify(logs,null,2)],{type:'application/json;charset=utf-8'}),`adapt_testes_${new Date().toISOString().slice(0,10)}.json`);
    }catch(error){showResearchStatus(error.message,'error');}
  };

  executeDeletion=async function(){
    if(!centralConfigured){originalExecuteDeletion();return;}
    if(!pendingDeletion)return;
    const input=document.getElementById('delete-confirm-input').value.trim().toUpperCase();
    if(input!==String(pendingDeletion.expected).toUpperCase())return;

    const deletion={...pendingDeletion};
    try{
      if(deletion.type==='participant')await adminRequest('delete-participant',{participant_code:deletion.code});
      else if(deletion.type==='session')await adminRequest('delete-session',{participant_code:deletion.code,session_id:deletion.sessionId});
      else if(deletion.type==='tests')await adminRequest('clear-tests');
      originalExecuteDeletion();
      showResearchStatus('Exclusão concluída no banco central e neste dispositivo.');
      await refreshCentralDashboard();
    }catch(error){
      showResearchStatus(`Nada foi apagado: ${error.message}`,'error');
    }
  };

  window.addEventListener('online',()=>{checkCentralHealth().then(ready=>{if(ready)scheduleSync(100);});});
  document.addEventListener('DOMContentLoaded',()=>{
    ensureStorageStatus();
    checkCentralHealth().then(ready=>{if(ready)scheduleSync(300);});
  });

  // Também tenta sincronizar periodicamente para recuperar quedas breves de conexão.
  setInterval(()=>{if(navigator.onLine)scheduleSync(0);},60000);
})();
