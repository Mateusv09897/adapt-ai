// Adapt Central Storage
// Mantém os logs locais como contingência e sincroniza somente dados estruturados com o backend.
(function(){
  const CENTRAL_HEALTH='/api/research-health';
  const CENTRAL_SESSION='/api/research-session';
  const CENTRAL_EVENTS='/api/research-events';
  const CENTRAL_ADMIN_SESSION='/api/research-admin-session';
  const CENTRAL_ADMIN='/api/research-admin';
  const ADMIN_TOKEN_KEY='adapt_research_admin_token';
  const LEGACY_ADMIN_KEY='adapt_research_admin_key';
  const PARTICIPANT_PAGE_SIZE=25;
  const SESSION_PAGE_SIZE=10;

  // Versões anteriores mantinham a senha administrativa no sessionStorage.
  // Remove qualquer resíduo assim que a nova camada é carregada.
  sessionStorage.removeItem(LEGACY_ADMIN_KEY);

  const originalStartSession=startSession;
  const originalOpenResearchDashboard=openResearchDashboard;
  const originalOpenParticipantDetails=openParticipantDetails;
  const originalExecuteDeletion=executeDeletion;
  const localExportResearchCsv=window.exportResearchCsv;
  const localExportResearchJson=window.exportResearchJson;
  const localExportTestJson=window.exportTestJson;

  let centralConfigured=false;
  let syncing=false;
  let syncTimer=null;
  let participantPage=1;
  let activeParticipantCode=null;
  let participantSessionPage=1;

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
      if(!item.sync_status){item.sync_status=item.participant_code?'pending':'local_only';changed=true;}
    }
    if(changed)writeLogs(storageKey,logs);
    return logs;
  }

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

  async function openAdminSession(forcePrompt=false){
    let token=!forcePrompt?sessionStorage.getItem(ADMIN_TOKEN_KEY):null;
    if(token)return token;

    const credential=window.prompt('Digite a senha administrativa do Adapt Research. Ela não é o código TESTE-MATEUS.');
    if(!credential)return null;

    const response=await fetch(CENTRAL_ADMIN_SESSION,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({credential})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok){
      const suffix=response.status===429&&data.retry_after?` Tente novamente em cerca de ${Math.ceil(data.retry_after/60)} min.`:'';
      throw new Error((data.error||'Não foi possível autenticar o pesquisador.')+suffix);
    }
    if(!data.token)throw new Error('O servidor não retornou uma sessão administrativa válida.');
    sessionStorage.setItem(ADMIN_TOKEN_KEY,data.token);
    return data.token;
  }

  async function adminRequest(action,payload={},forcePrompt=false){
    const token=await openAdminSession(forcePrompt);
    if(!token)throw new Error('Acesso administrativo cancelado.');
    const response=await fetch(CENTRAL_ADMIN,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify({action,...payload})
    });
    const data=await response.json().catch(()=>({}));
    if(response.status===401){
      sessionStorage.removeItem(ADMIN_TOKEN_KEY);
      if(!forcePrompt)return adminRequest(action,payload,true);
    }
    if(!response.ok)throw new Error(data.error||'Falha no acesso ao banco central.');
    return data;
  }

  window.adaptResearchAdminRequest=adminRequest;
  window.lockAdaptResearchAdmin=function(){
    sessionStorage.removeItem(ADMIN_TOKEN_KEY);
    showResearchStatus('Sessão administrativa encerrada neste navegador.');
  };

  async function fetchCentralEvents(isTest=false){
    const data=await adminRequest(isTest?'list-tests':'list-research');
    return Array.isArray(data.events)?data.events:[];
  }

  function renderDashboardSummary(data){
    const metrics=data?.metrics||{};
    setText('metric-participants',Number(metrics.participants)||0);
    setText('metric-sessions',Number(metrics.sessions)||0);
    setText('metric-mediations',Number(metrics.mediations)||0);
    setText('metric-return-rate',`${Number(metrics.return_rate)||0}%`);
    setText('metric-help-level',Number(metrics.avg_help)?Number(metrics.avg_help).toFixed(1):'0');
    setText('metric-duration',formatDuration(Number(metrics.avg_duration)||0));

    const barriers={};
    for(const item of data?.barriers||[])barriers[item.module||'Outro']=Number(item.count)||0;
    renderBarChart('barrier-chart',barriers,'Nenhuma barreira registrada ainda.');

    const distribution=data?.help_distribution||{};
    renderBarChart('help-chart',{
      '1 mediação':Number(distribution.one_mediation)||0,
      '2 pistas':Number(distribution.two_hints)||0,
      '3+ pistas':Number(distribution.three_plus_hints)||0
    },'Ainda não há sessões com mediação.');
  }

  function paginationMarkup(id,pagination,loaderName){
    if(!pagination)return'';
    const page=Number(pagination.page)||1;
    const pages=Number(pagination.pages)||1;
    const total=Number(pagination.total)||0;
    return `<div id="${id}" class="participant-actions" style="justify-content:center;align-items:center;margin-top:14px"><button class="secondary-button" type="button" onclick="${loaderName}(${Math.max(1,page-1)})" ${pagination.has_previous?'':'disabled'}>← Anterior</button><span style="font-size:.9rem;color:#6b7b8e;font-weight:700">Página ${page} de ${pages} · ${total} total</span><button class="secondary-button" type="button" onclick="${loaderName}(${page+1})" ${pagination.has_next?'':'disabled'}>Próxima →</button></div>`;
  }

  function renderCentralParticipantPage(data){
    const list=document.getElementById('participant-list');
    if(!list)return;
    const participants=Array.isArray(data?.participants)?data.participants:[];
    const pagination=data?.pagination||{page:1,pages:1,total:participants.length};

    if(!participants.length){
      list.innerHTML='<p class="empty-state">Nenhum participante real foi registrado no banco central.</p>'+paginationMarkup('participant-pagination',pagination,'loadResearchParticipantPage');
      return;
    }

    list.innerHTML=participants.map(p=>`<div class="participant-row"><div class="participant-main"><strong>${escapeHtml(p.participant_code)}</strong><span>${Number(p.sessions)||0} sessão(ões) · ${Number(p.events)||0} evento(s) · última atividade: ${escapeHtml(formatDateTime(p.last_activity))}</span></div><div class="participant-actions"><button class="secondary-button" type="button" data-code="${escapeHtml(p.participant_code)}" onclick="openParticipantDetails(this.dataset.code)">Ver dados</button><button class="danger-button" type="button" data-code="${escapeHtml(p.participant_code)}" onclick="requestParticipantDeletion(this.dataset.code)">Excluir dados</button></div></div>`).join('')+paginationMarkup('participant-pagination',pagination,'loadResearchParticipantPage');
  }

  async function loadParticipantPage(page=1){
    if(!centralConfigured)return;
    participantPage=Math.max(1,Number(page)||1);
    const data=await adminRequest('list-participants',{page:participantPage,limit:PARTICIPANT_PAGE_SIZE});
    if(data?.pagination&&participantPage>Number(data.pagination.pages||1)){
      participantPage=Math.max(1,Number(data.pagination.pages)||1);
      return loadParticipantPage(participantPage);
    }
    renderCentralParticipantPage(data);
  }
  window.loadResearchParticipantPage=async function(page){
    try{
      setStorageStatus('Carregando participantes…','syncing');
      await loadParticipantPage(page);
      setStorageStatus('Painel paginado usando dados do banco central','success');
    }catch(error){
      showResearchStatus(error.message,'error');
      setStorageStatus('Falha ao carregar participantes do banco central','warning');
    }
  };

  function renderParticipantSessions(data){
    const code=data?.participant_code||activeParticipantCode||'';
    const sessions=Array.isArray(data?.sessions)?data.sessions:[];
    const pagination=data?.pagination||{page:1,pages:1,total:sessions.length};
    setText('participant-details-title',`Participante ${code}`);
    setText('participant-details-summary',`${Number(pagination.total)||0} sessão(ões) e ${Number(data?.total_events)||0} evento(s) no banco central.`);

    const container=document.getElementById('participant-session-list');
    if(!container)return;
    if(!sessions.length){
      container.innerHTML='<p class="empty-state">Nenhuma sessão encontrada para este código.</p>'+paginationMarkup('participant-session-pagination',pagination,'loadResearchSessionPage');
    }else{
      container.innerHTML=sessions.map(item=>{
        const modules=Array.isArray(item.modules)&&item.modules.length?item.modules.join(', '):'sem módulo';
        const meta=[
          formatDateTime(item.started_at),
          `${Number(item.event_count)||0} eventos`,
          modules,
          Number(item.max_help_level)?`ajuda nível ${Number(item.max_help_level)}`:'sem mediação',
          item.returned_to_activity?'retornou à atividade':'sem retorno registrado',
          item.duration_seconds!=null?`duração ${formatDuration(item.duration_seconds)}`:null
        ].filter(Boolean).join(' · ');
        return `<div class="session-row"><div><strong>Sessão ${escapeHtml(String(item.session_id||'').slice(0,8))}</strong><small>${escapeHtml(meta)}</small></div><button class="danger-button" type="button" data-session="${escapeHtml(item.session_id)}" data-code="${escapeHtml(code)}" onclick="requestSessionDeletion(this.dataset.session,this.dataset.code)">Excluir sessão</button></div>`;
      }).join('')+paginationMarkup('participant-session-pagination',pagination,'loadResearchSessionPage');
    }

    const deleteAll=document.getElementById('delete-participant-from-details');
    if(deleteAll){deleteAll.dataset.code=code;deleteAll.onclick=()=>requestParticipantDeletion(deleteAll.dataset.code);}
  }

  async function loadParticipantSessions(page=1){
    if(!centralConfigured||!activeParticipantCode)return;
    participantSessionPage=Math.max(1,Number(page)||1);
    const data=await adminRequest('participant-sessions',{participant_code:activeParticipantCode,page:participantSessionPage,limit:SESSION_PAGE_SIZE});
    if(data?.pagination&&participantSessionPage>Number(data.pagination.pages||1)){
      participantSessionPage=Math.max(1,Number(data.pagination.pages)||1);
      return loadParticipantSessions(participantSessionPage);
    }
    renderParticipantSessions(data);
  }

  window.loadResearchSessionPage=async function(page){
    try{await loadParticipantSessions(page);}
    catch(error){
      setText('participant-details-summary',error.message);
      const container=document.getElementById('participant-session-list');
      if(container)container.innerHTML='<p class="empty-state">Não foi possível carregar as sessões do banco central.</p>';
    }
  };

  openParticipantDetails=async function(code){
    if(!session.isTest)return;
    if(!centralConfigured){originalOpenParticipantDetails(code);return;}
    activeParticipantCode=code;
    participantSessionPage=1;
    setText('participant-details-title',`Participante ${code}`);
    setText('participant-details-summary','Carregando sessões do banco central…');
    const container=document.getElementById('participant-session-list');
    if(container)container.innerHTML='<p class="empty-state">Carregando…</p>';
    document.getElementById('participant-details-overlay').classList.remove('hidden');
    try{await loadParticipantSessions(1);}
    catch(error){
      setText('participant-details-summary',error.message);
      if(container)container.innerHTML='<p class="empty-state">Não foi possível carregar as sessões.</p>';
    }
  };

  async function refreshCentralDashboard(resetPage=false){
    if(!centralConfigured)return;
    try{
      if(resetPage)participantPage=1;
      setStorageStatus('Carregando indicadores agregados…','syncing');
      const summary=await adminRequest('dashboard-summary');
      renderDashboardSummary(summary);
      await loadParticipantPage(participantPage);
      setStorageStatus('Painel paginado usando dados do banco central','success');
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
    checkCentralHealth().then(ready=>{if(ready)refreshCentralDashboard(true);});
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

  function sessionRows(logs){
    const groups=new Map();
    for(const item of logs.filter(i=>!i.is_test&&i.session_id)){
      if(!groups.has(item.session_id))groups.set(item.session_id,[]);
      groups.get(item.session_id).push(item);
    }
    const rows=[];
    for(const [sessionId,events] of groups){
      events.sort((a,b)=>String(a.timestamp||'').localeCompare(String(b.timestamp||'')));
      const started=events.find(i=>i.event==='session_started');
      const ended=[...events].reverse().find(i=>i.event==='session_ended');
      const returned=[...events].reverse().find(i=>i.event==='return_to_activity');
      const barriers=events.filter(i=>i.event==='barrier_selected'&&i.module).map(i=>i.module);
      const uniqueBarriers=[...new Set(barriers)];
      const mediations=events.filter(i=>i.event==='mediation_generated');
      const hints=events.filter(i=>i.event==='additional_hint_requested');
      const voiceUses=events.filter(i=>i.event==='voice_started').length;
      const helpLevels=events.filter(i=>['mediation_generated','additional_hint_requested'].includes(i.event)).map(i=>Number(i.help_level)).filter(Number.isFinite);
      rows.push({
        participant_code:started?.participant_code||events[0]?.participant_code||'',
        session_id:sessionId,
        started_at:started?.timestamp||events[0]?.timestamp||'',
        ended_at:ended?.timestamp||'',
        duration_seconds:ended?.duration_seconds??returned?.duration_seconds??'',
        completed:ended?.completed??'',
        end_reason:ended?.reason||'',
        primary_module:mediations[0]?.module||events.find(i=>i.event==='voice_started')?.module||uniqueBarriers[0]||'',
        barriers:uniqueBarriers.join(' | '),
        mediations:mediations.length,
        additional_hints:hints.length,
        max_help_level:helpLevels.length?Math.max(...helpLevels):0,
        returned_to_activity:Boolean(returned),
        voice_uses:voiceUses,
        inactivity_warnings:events.filter(i=>i.event==='inactivity_warning').length
      });
    }
    return rows.sort((a,b)=>String(a.started_at).localeCompare(String(b.started_at)));
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

  window.exportResearchSessionsCsv=async function(){
    try{
      const logs=centralConfigured?await fetchCentralEvents(false):readLogs(RESEARCH_STORAGE_KEY).filter(i=>!i.is_test);
      const rows=sessionRows(logs);
      if(!rows.length){
        showResearchStatus('Nenhuma sessão real de pesquisa disponível. Sessões TESTE-MATEUS não são incluídas na exportação.');
        return;
      }
      const columns=['participant_code','session_id','started_at','ended_at','duration_seconds','completed','end_reason','primary_module','barriers','mediations','additional_hints','max_help_level','returned_to_activity','voice_uses','inactivity_warnings'];
      const csvRows=[columns.join(';')];
      for(const row of rows)csvRows.push(columns.map(key=>safeCsvCell(row[key])).join(';'));
      downloadBlob(new Blob(['\ufeff'+csvRows.join('\r\n')],{type:'text/csv;charset=utf-8'}),`adapt_sessoes_${new Date().toISOString().slice(0,10)}.csv`);
      showResearchStatus(`${rows.length} sessão(ões) exportada(s) para análise.`);
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
      await refreshCentralDashboard(false);

      if(deletion.type==='participant'&&activeParticipantCode===deletion.code){
        activeParticipantCode=null;
        closeParticipantDetails();
      }else if(deletion.type==='session'&&activeParticipantCode===deletion.code&&!document.getElementById('participant-details-overlay').classList.contains('hidden')){
        await loadParticipantSessions(participantSessionPage);
      }
    }catch(error){showResearchStatus(`Nada foi apagado: ${error.message}`,'error');}
  };

  window.addEventListener('online',()=>{checkCentralHealth().then(ready=>{if(ready)scheduleSync(100);});});
  document.addEventListener('DOMContentLoaded',()=>{
    ensureStorageStatus();
    checkCentralHealth().then(ready=>{if(ready)scheduleSync(300);});
  });

  setInterval(()=>{if(navigator.onLine)scheduleSync(0);},60000);
})();
