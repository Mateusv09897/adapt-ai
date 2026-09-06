// Evita solicitações concorrentes de pistas, preservando a sequência 2, 3, 4...
(function(){
  let hintRequestInFlight=false;

  requestMoreHelp=async function(){
    if(hintRequestInFlight||!currentModule||currentModule==='voice')return;

    const button=document.getElementById('more-help-button');
    const previousLabel=button?.textContent||'Ainda preciso de uma pista';
    hintRequestInFlight=true;
    if(button){
      button.disabled=true;
      button.textContent='Gerando próxima pista...';
    }

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
})();