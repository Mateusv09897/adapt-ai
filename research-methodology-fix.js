// Integridade metodológica da camada de pesquisa do Adapt.
// Este script é carregado depois de app.js e central-storage.js.
(function(){
  const ADMIN_SESSION_KEY='adapt_research_admin_key';
  let serviceReturnDurationSeconds=null;

  function serviceDurationSeconds(){
    if(!session?.startedAt)return null;
    const started=new Date(session.startedAt).getTime();
    if(!Number.isFinite(started))return null;
    return Math.max(0,Math.round((Date.now()-started)/1000));
  }

  // 1) Pistas progressivas: corrige o nível enviado ao modelo e oferece contexto da
  // mediação anterior para reduzir repetição e tornar o andaime realmente progressivo.
  const originalBuildPrompt=buildPrompt;
  buildPrompt=function(type,input,moreHelp=false){
    const prompt=originalBuildPrompt(type,input,moreHelp);
    if(!moreHelp)return prompt;

    const nextLevel=Math.max(2,(Number(helpLevel)||1)+1);
    const previous=String(currentResult||'').trim().slice(0,3000);
    let adjusted=prompt.replace(/Esta é a pista de nível\s+\d+\./i,`Esta é a pista de nível ${nextLevel}.`);
    adjusted+=`\n\nRegra de progressão: não repita a pista anterior. Avance apenas um nível de especificidade, mantendo o estudante responsável pelo raciocínio.`;
    if(previous)adjusted+=`\n\nMediação anterior, apenas para evitar repetição:\n${previous}`;
    return adjusted;
  };

  // Impede cliques concorrentes em "Ainda preciso de uma pista". Sem esse bloqueio,
  // respostas assíncronas podiam registrar o mesmo help_level final em várias pistas.
  let hintRequestInFlight=false;
  requestMoreHelp=async function(){
    if(hintRequestInFlight||!currentModule||currentModule==='voice')return;
    const button=document.getElementById('more-help-button');
    const previousLabel=button?.textContent||'Ainda preciso de uma pista';
    hintRequestInFlight=true;
    if(button){button.disabled=true;button.textContent='Gerando próxima pista...';}
    try{
      await requestMediation(currentModule,true);
    }finally{
      hintRequestInFlight=false;
      if(button){
        button.disabled=false;
        button.textContent=helpLevel>=2?'Ainda preciso de outra pista':previousLabel;
      }
    }
  };

  // 2) Duração de atendimento: encerra a medição quando o estudante declara que já
  // consegue voltar à atividade, em vez de incluir o tempo parado na tela de conclusão.
  const centralStartSession=startSession;
  startSession=function(requireCode){
    serviceReturnDurationSeconds=null;
    return centralStartSession(requireCode);
  };

  markReturnToActivity=function(){
    serviceReturnDurationSeconds=serviceDurationSeconds();
    saveEvent('return_to_activity',{
      module:modules[currentModule]?.logName||currentModule,
      help_level:helpLevel,
      duration_seconds:serviceReturnDurationSeconds
    });
    stopText();
    showScreen('complete-screen');
  };

  finishSession=function(completed=true,reason='manual'){
    if(session.id){
      const liveDuration=serviceDurationSeconds();
      const duration=(reason==='returned_to_activity'&&Number.isFinite(serviceReturnDurationSeconds))
        ?serviceReturnDurationSeconds
        :liveDuration;
      saveEvent('session_ended',{completed,reason,duration_seconds:duration});
    }
    clearIdleTimers();
    hideIdleOverlay();
    clearWorkingData();
    serviceReturnDurationSeconds=null;
    session={id:null,participantCode:null,startedAt:null,isTest:false};
    document.getElementById('participant-code').value='';
    updateTestModeUI();
    showScreen('start-screen');
  };

  // 3) Leitor de voz: passa a ter um desfecho explícito de retorno à atividade.
  // Assim, o módulo deixa de gerar apenas eventos de reprodução sem registrar se a
  // barreira foi superada.
  const originalPlayVoiceText=playVoiceText;
  playVoiceText=function(){
    const text=document.getElementById('voice-input')?.value.trim();
    originalPlayVoiceText();
    if(text)document.getElementById('voice-return-question')?.classList.remove('hidden');
  };

  window.markVoiceReturnToActivity=function(){
    if(!session.id)return;
    serviceReturnDurationSeconds=serviceDurationSeconds();
    saveEvent('return_to_activity',{
      module:'LeitorVoz',
      help_level:0,
      duration_seconds:serviceReturnDurationSeconds
    });
    stopText();
    showScreen('complete-screen');
  };

  const originalSelectModule=selectModule;
  selectModule=function(name){
    const result=originalSelectModule(name);
    document.getElementById('voice-return-question')?.classList.add('hidden');
    return result;
  };

  const originalClearWorkingData=clearWorkingData;
  clearWorkingData=function(){
    originalClearWorkingData();
    document.getElementById('voice-return-question')?.classList.add('hidden');
  };

  function installVoiceReturnQuestion(){
    if(document.getElementById('voice-return-question'))return;
    const panel=document.getElementById('panel-voice');
    if(!panel)return;
    const box=document.createElement('div');
    box.id='voice-return-question';
    box.className='return-question hidden';
    box.style.marginTop='20px';
    box.innerHTML='<strong>Ouvir este trecho ajudou você a continuar?</strong><p>Se a barreira foi superada, volte para sua atividade.</p><div class="return-actions"><button class="success-button" type="button" onclick="markVoiceReturnToActivity()">Sim, consigo continuar</button></div>';
    panel.appendChild(box);
  }

  // 4) Exportação analítica: mantém o CSV de eventos e acrescenta um CSV com uma
  // linha por sessão, que é mais adequado para análise estatística posterior.
  function safeCsvCell(value){
    if(value===undefined||value===null)return'';
    let str=String(value);
    if(/^[=+\-@]/.test(str))str="'"+str;
    if(/[;"\r\n]/.test(str))str='"'+str.replace(/"/g,'""')+'"';
    return str;
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
      const helpLevels=events
        .filter(i=>['mediation_generated','additional_hint_requested'].includes(i.event))
        .map(i=>Number(i.help_level))
        .filter(Number.isFinite);
      const primaryModule=mediations[0]?.module||events.find(i=>i.event==='voice_started')?.module||uniqueBarriers[0]||'';
      const duration=ended?.duration_seconds??returned?.duration_seconds??'';

      rows.push({
        participant_code:started?.participant_code||events[0]?.participant_code||'',
        session_id:sessionId,
        started_at:started?.timestamp||events[0]?.timestamp||'',
        ended_at:ended?.timestamp||'',
        duration_seconds:duration,
        completed:ended?.completed??'',
        end_reason:ended?.reason||'',
        primary_module:primaryModule,
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

  async function getAdminKey(forcePrompt=false){
    let key=!forcePrompt?sessionStorage.getItem(ADMIN_SESSION_KEY):null;
    if(!key){
      key=window.prompt('Digite a senha administrativa do Adapt Research.');
      if(key)sessionStorage.setItem(ADMIN_SESSION_KEY,key);
    }
    return key||null;
  }

  async function centralResearchEvents(forcePrompt=false){
    const key=await getAdminKey(forcePrompt);
    if(!key)throw new Error('Acesso administrativo cancelado.');
    const response=await fetch('/api/research-admin',{
      method:'POST',
      headers:{'Content-Type':'application/json','x-research-admin-key':key},
      body:JSON.stringify({action:'list-research'})
    });
    const data=await response.json();
    if(response.status===401&&!forcePrompt){
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      return centralResearchEvents(true);
    }
    if(!response.ok)throw new Error(data.error||'Não foi possível carregar os dados centrais.');
    return Array.isArray(data.events)?data.events:[];
  }

  async function researchEventsForSessionExport(){
    let health=null;
    try{
      const response=await fetch('/api/research-health',{cache:'no-store'});
      health=await response.json();
      if(!response.ok)health=null;
    }catch(error){
      console.warn('Banco central indisponível; exportação de sessões usando contingência local:',error);
    }

    // Se o banco está operacional, ele é a fonte autoritativa. Erros de credencial
    // não devem provocar uma exportação local silenciosamente incompleta.
    if(health?.configured&&health.database_reachable!==false)return centralResearchEvents();
    return readLogs(RESEARCH_STORAGE_KEY).filter(i=>!i.is_test);
  }

  window.exportResearchSessionsCsv=async function(){
    try{
      const rows=sessionRows(await researchEventsForSessionExport());
      const columns=['participant_code','session_id','started_at','ended_at','duration_seconds','completed','end_reason','primary_module','barriers','mediations','additional_hints','max_help_level','returned_to_activity','voice_uses','inactivity_warnings'];
      const csvRows=[columns.join(';')];
      for(const row of rows)csvRows.push(columns.map(key=>safeCsvCell(row[key])).join(';'));
      const blob=new Blob(['\ufeff'+csvRows.join('\r\n')],{type:'text/csv;charset=utf-8'});
      downloadBlob(blob,`adapt_sessoes_${new Date().toISOString().slice(0,10)}.csv`);
      if(typeof showResearchStatus==='function')showResearchStatus(`${rows.length} sessão(ões) exportada(s) para análise.`);
    }catch(error){
      if(typeof showResearchStatus==='function')showResearchStatus(error.message,'error');
    }
  };

  function installSessionExportButton(){
    if(document.getElementById('export-sessions-csv'))return;
    const actions=document.querySelector('#research-screen .export-actions');
    if(!actions)return;
    const button=document.createElement('button');
    button.id='export-sessions-csv';
    button.className='secondary-button';
    button.type='button';
    button.textContent='Sessões (.csv)';
    button.addEventListener('click',()=>window.exportResearchSessionsCsv());
    actions.insertBefore(button,actions.children[1]||null);
  }

  function refreshResearchCopy(){
    const header=document.querySelector('#research-screen .research-header p');
    if(header)header.textContent='Indicadores descritivos dos logs de pesquisa. Quando o banco central está disponível, o painel usa os dados sincronizados. Sessões de teste não entram nas métricas.';
    const management=document.querySelector('#research-screen .management-note');
    if(management)management.textContent='As exclusões confirmadas são aplicadas primeiro ao banco central e depois a este dispositivo, evitando divergência entre as cópias.';
    const exportEyebrow=document.querySelector('#research-screen .export-card .eyebrow');
    if(exportEyebrow)exportEyebrow.textContent='Dados de pesquisa';
  }

  installVoiceReturnQuestion();
  installSessionExportButton();
  refreshResearchCopy();
})();