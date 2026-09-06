// Compatibilidade do CSV com Excel em pt-BR.
// O separador de listas mais comum nesse locale é ponto e vírgula.
(function(){
  function safeExcelCell(value){
    if(value===undefined||value===null)return '';
    let str=String(value);
    // Evita que conteúdo vindo de códigos/campos seja interpretado como fórmula pelo Excel.
    if(/^[=+\-@]/.test(str))str="'"+str;
    if(/[;"\r\n]/.test(str))str='"'+str.replace(/"/g,'""')+'"';
    return str;
  }

  window.exportResearchCsv=function(){
    const logs=readLogs(RESEARCH_STORAGE_KEY);
    const columns=['event','timestamp','session_id','participant_code','is_test','module','help_level','input_length','with_code','mode','completed','reason','duration_seconds'];
    const delimiter=';';
    const lineBreak='\r\n';
    const rows=[columns.join(delimiter)];

    for(const item of logs){
      rows.push(columns.map(key=>safeExcelCell(item[key])).join(delimiter));
    }

    const csv='\ufeff'+rows.join(lineBreak);
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    downloadBlob(blob,`adapt_pesquisa_${new Date().toISOString().slice(0,10)}.csv`);
  };

  // A camada de armazenamento central é carregada depois do app e desta correção,
  // para poder preservar o funcionamento local e substituir apenas sincronização,
  // exportação e exclusão quando o banco estiver configurado.
  const centralScript=document.createElement('script');
  centralScript.src='central-storage.js';
  centralScript.defer=true;
  document.body.appendChild(centralScript);
})();