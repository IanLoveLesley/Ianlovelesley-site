const root=new URL("../../",import.meta.url);
async function get(relative,type="json"){
 const response=await fetch(new URL(relative,root));
 if(!response.ok)throw new Error("Site resource could not load");
 return type==="json"?response.json():response.text();
}
try{
 const catalog=await get("data/catalog.json");
 const [collections,quizzes,archive]=await Promise.all([
  Promise.all(catalog.collections.map(file=>get(file))),
  Promise.all(catalog.quizzes.map(file=>get(file))),
  get(catalog.bundledArt.archive,"text")
 ]);
 const match=archive.match(/<script id="suite-data" type="application\/json">([\s\S]*?)<\/script>/);
 if(!match)throw new Error("Bundled art is missing");
 const previous=JSON.parse(match[1]).quizzes.find(quiz=>quiz.id===catalog.bundledArt.quizId);
 const painting=quizzes.find(quiz=>quiz.id===catalog.bundledArt.quizId);
 for(const id of catalog.bundledArt.ids){
  const image=previous.outcomes.find(item=>item.id===id)?.image?.src;
  const current=painting?.outcomes.find(item=>item.id===id);
  if(current){if(!image?.startsWith("data:image/"))throw new Error("Bundled image is missing");current.image.src=image;}
 }
 if(painting?.cover?.image==="assets/art/jalais-hill.jpg")painting.cover.image=previous.outcomes.find(item=>item.id==="jalais_hill").image.src;
 document.getElementById("suite-data").textContent=JSON.stringify({schemaVersion:1,collections,quizzes});
 const runtime=new URL("./runtime.mjs",import.meta.url);runtime.searchParams.set("v",catalog.build);await import(runtime.href);
}catch(error){
 document.querySelectorAll("[data-view]").forEach(section=>section.hidden=true);
 const message=document.getElementById("fatal-error");message.textContent="新版测评暂时没能完整打开，请刷新或稍后重新打开。";message.hidden=false;
 console.error("Portrait suite failed to load.",error);
}
