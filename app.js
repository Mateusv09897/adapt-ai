const apiUrl='/api/gemini';

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
let session={id:null,participantCode:null,startedAt:null};
let speechSynthesisRef=window.speechSynthesis;
let interfaceFontStep=0;

function showScreen(id){
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  window.scrollTo({top:0,behavior:'smooth'});
  document.getElementById('end-session-button').classList.toggle('hidden',id==='start-screen'||id==='complete-screen');
}

function startSession(requireCode){
  const input=document.getElementById('participant-code');
  const code=input.value.trim().toUpperCase();
  if(requireCode&&!code){
    input.focus();
    input.setAttribute('aria-invalid','true');
    return;
  }
  input.removeAttribute('aria-invalid');
  session={id:crypto.randomUUID(),participantCode:code||null,startedAt:new Date().toISOString()};
  saveEvent('session_started',{with_code:Boolean(code)});
  showScreen('barrier-screen');
}

function selectModule(name){
  currentModule=name;
  helpLevel=0;
  currentResult='';
  const cfg=modules[name];
  document.getElementById('module-title').textContent=cfg.title;
  document.getElementById('module-description').textContent=cfg.description;
  document.getElementById('module-symbol').textContent=cfg.symbol;
  document.querySelectorAll('.module-panel').forEach(p=>p.classList.add('hidden'));
  document.getElementById(`panel-${name}`).classList.remove('hidden');
  document.getElementById('result-card').classList.add('hidden');
  hideStatus();
  saveEvent('barrier_selected',{module:cfg.logName});
  showScreen('help-screen');
}

function goToBarrierScreen(){
  if(!session.id){showScreen('start-screen');return;}
  stopText();
  showScreen('barrier-screen');
}

function buildPrompt(type,input,moreHelp=false){
  const base=`Você é o Adapt, uma ferramenta de mediação pedagógica. Sua função é remover uma barreira de compreensão sem realizar a atividade pelo estudante. Não entregue a resposta final de exercícios, não produza trabalhos prontos e não substitua o raciocínio do aluno. Use linguagem clara, objetiva e respeitosa. A mediação deve ser curta, adequada para um totem compartilhado em sala de aula. Termine orientando o estudante a voltar para a própria atividade.`;
  const extra=moreHelp?` O estudante já recebeu uma mediação e ainda precisa de ajuda. Ofereça uma pista adicional, um pouco mais específica, mas continue sem resolver a atividade. Esta é a pista de nível ${helpLevel}.`:' ';
  if(type==='simplify')return `${base}${extra}\n\nTarefa: reescreva o trecho em linguagem mais acessível sem perder o rigor conceitual. Explique no máximo 3 termos difíceis que sejam essenciais. Não acrescente conteúdo desnecessário.\n\nTrecho: ${input}`;
  if(type==='context')return `${base}${extra}\n\nTarefa: conecte o conceito a 1 ou 2 situações concretas da vida real, da formação técnica ou do mundo do trabalho. Explique a relação, não apenas dê exemplos soltos.\n\nConceito: ${input}`;
  if(type==='starter')return `${base}${extra}\n\nTarefa: ajude o estudante a identificar o que a atividade pede, decomponha mentalmente o problema e indique somente o próximo passo útil para ele começar. Não crie um plano longo, cronograma, checklist permanente ou resposta pronta.\n\nAtividade: ${input}`;
  return `${base}${extra}\n\nTarefa: descreva pedagogicamente a imagem. Diga primeiro o que aparece, depois onde o estudante deve olhar e por fim qual relação importante ele deve perceber. Não responda uma questão associada à imagem. Se houver texto legível, use-o apenas como contexto.`;
}

async function requestMediation(type,moreHelp=false){
  hideStatus();
  let input='';
  let parts=[];
  if(type==='image'){
    if(!selectedFile){showStatus('Selecione uma imagem antes de continuar.','error');return;}
    const imagePart=await fileToGenerativePart(selectedFile);
    parts=[{text:buildPrompt(type,'',moreHelp)},imagePart];
    input='Imagem enviada';
  }else{
    const cfg=modules[type];
    input=document.getElementById(cfg.inputId).value.trim();
    if(!input){showStatus('Preencha o campo para que o Adapt possa ajudar.','error');return;}
    parts=[{text:buildPrompt(type,input,moreHelp)}];
  }

  if(moreHelp)helpLevel+=1; else helpLevel=1;
  setLoading(true);
  try{
    const text=await callGemini(parts);
    currentResult=text;
    document.getElementById('result-output').innerHTML=formatAIResponse(text);
    document.getElementById('result-card').classList.remove('hidden');
    document.getElementById('more-help-button').textContent=helpLevel>=2?'Ainda preciso de outra pista':'Ainda preciso de uma pista';
    saveEvent(moreHelp?'additional_hint_requested':'mediation_generated',{
      module:modules[type].logName,
      help_level:helpLevel,
      input_length:type==='image'?null:input.length
    });
    if(window.MathJax) MathJax.typesetPromise([document.getElementById('result-output')]);
    document.getElementById('result-card').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){
    console.error(error);
    showStatus('Não foi possível gerar a mediação agora. Tente novamente.','error');
  }finally{setLoading(false);}
}

function requestMoreHelp(){
  if(!currentModule||currentModule==='voice')return;
  requestMediation(currentModule,true);
}

function markReturnToActivity(){
  saveEvent('return_to_activity',{module:modules[currentModule]?.logName||currentModule,help_level:helpLevel});
  stopText();
  showScreen('complete-screen');
}

function finishSession(completed=true){
  if(session.id){
    saveEvent('session_ended',{completed,duration_seconds:Math.round((Date.now()-new Date(session.startedAt).getTime())/1000)});
  }
  clearWorkingData();
  session={id:null,participantCode:null,startedAt:null};
  document.getElementById('participant-code').value='';
  showScreen('start-screen');
}

function prepareNextStudent(){finishSession(true);}

function clearWorkingData(){
  document.querySelectorAll('textarea').forEach(t=>t.value='');
  document.getElementById('result-output').innerHTML='';
  document.getElementById('result-card').classList.add('hidden');
  selectedFile=null;currentResult='';currentModule=null;helpLevel=0;
  const preview=document.getElementById('image-preview');
  preview.src='';preview.classList.add('hidden');
  document.getElementById('image-placeholder').classList.remove('hidden');
  document.getElementById('image-input').value='';
  stopText();hideStatus();
}

function handleFileSelect(event){
  selectedFile=event.target.files?.[0]||null;
  const preview=document.getElementById('image-preview');
  const placeholder=document.getElementById('image-placeholder');
  if(!selectedFile){preview.classList.add('hidden');placeholder.classList.remove('hidden');return;}
  const reader=new FileReader();
  reader.onload=e=>{preview.src=e.target.result;preview.classList.remove('hidden');placeholder.classList.add('hidden');};
  reader.readAsDataURL(selectedFile);
}

function fileToGenerativePart(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onloadend=()=>resolve({inlineData:{mimeType:file.type,data:reader.result.split(',')[1]}});
    reader.onerror=reject;
    reader.readAsDataURL(file);
  });
}

async function callGemini(parts){
  const response=await fetch(apiUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts}]})});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Erro na API');
  return data.text||data.result||data.candidates?.[0]?.content?.parts?.[0]?.text||'';
}

function formatAIResponse(text){
  const safe=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const styled=safe.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/(?<!\*)\*(?!\s)(.*?)(?<!\s)\*(?!\*)/g,'<em>$1</em>');
  const lines=styled.trim().split('\n');let html='';let ul=false;let ol=false;
  const closeLists=()=>{if(ul){html+='</ul>';ul=false}if(ol){html+='</ol>';ol=false}};
  for(const line of lines){const t=line.trim();if(!t)continue;if(t.startsWith('#')){closeLists();html+=`<h3>${t.replace(/#+\s*/,'')}</h3>`;continue}if(/^[-*]\s/.test(t)){if(!ul){if(ol){html+='</ol>';ol=false}html+='<ul>';ul=true}html+=`<li>${t.replace(/^[-*]\s/,'')}</li>`;continue}if(/^\d+\.\s/.test(t)){if(!ol){if(ul){html+='</ul>';ul=false}html+='<ol>';ol=true}html+=`<li>${t.replace(/^\d+\.\s/,'')}</li>`;continue}closeLists();html+=`<p>${t}</p>`}closeLists();return html;
}

function playVoiceText(){
  const text=document.getElementById('voice-input').value.trim();
  if(!text){showStatus('Cole ou digite um texto para ouvir.','error');return;}
  saveEvent('voice_started',{module:'LeitorVoz',input_length:text.length});
  speak(text);
}
function narrateResult(){if(currentResult){saveEvent('mediation_narrated',{module:modules[currentModule]?.logName||currentModule});speak(currentResult)}}
function speak(text){stopText();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='pt-BR';utterance.rate=1;speechSynthesisRef.speak(utterance)}
function stopText(){if(speechSynthesisRef)speechSynthesisRef.cancel()}

function setLoading(isLoading){
  const id=modules[currentModule]?.buttonId;if(!id)return;
  const button=document.getElementById(id);button.disabled=isLoading;button.classList.toggle('loading',isLoading);
}
function showStatus(message,type='info'){const el=document.getElementById('status-message');el.textContent=message;el.className=`status-message ${type}`;el.classList.remove('hidden')}
function hideStatus(){document.getElementById('status-message').classList.add('hidden')}
function changeInterfaceFont(direction){interfaceFontStep=Math.max(-2,Math.min(4,interfaceFontStep+direction));document.documentElement.style.fontSize=`${16+interfaceFontStep}px`}

function saveEvent(event,data={}){
  const logs=JSON.parse(localStorage.getItem('adapt_research_logs')||'[]');
  logs.push({event,timestamp:new Date().toISOString(),session_id:session.id,participant_code:session.participantCode,...data});
  localStorage.setItem('adapt_research_logs',JSON.stringify(logs));
}

// Atalho de pesquisa: Ctrl+Alt+L exporta os logs locais sem expor controle na interface do aluno.
document.addEventListener('keydown',event=>{
  if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='l'){
    const logs=localStorage.getItem('adapt_research_logs')||'[]';
    const blob=new Blob([logs],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`adapt_logs_${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(url);
  }
  if(event.key==='Escape')stopText();
});