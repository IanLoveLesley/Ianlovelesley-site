"use strict";
const finite = value => typeof value === "number" && Number.isFinite(value);
const own = (object,key) => Object.prototype.hasOwnProperty.call(object,key);
const fail = message => { throw new Error(message); };

function selectionLimit(question) {
  return question.selection?.mode === "multiple" ? question.selection.maxSelections ?? 2 : 1;
}

function selectedOptions(question,answer) {
  const ids = typeof answer === "string" ? [answer] : Array.isArray(answer) ? answer : null;
  if (!ids || !ids.length || ids.length > selectionLimit(question)) fail("请选择规定数量的选项："+question.id);
  if (ids.some(id => typeof id !== "string") || new Set(ids).size !== ids.length) fail("选项无效或重复："+question.id);
  const options = question.options.filter(option => ids.includes(option.id));
  if (options.length !== ids.length) fail("选项不属于题目："+question.id);
  return options;
}

function hasAnswer(question,answer) {
  try { selectedOptions(question,answer); return true; } catch { return false; }
}

function validateCollection(collection) {
  if (!collection || !/^[a-z][a-z0-9-]*$/.test(collection.id)) fail("专辑 ID 无效。");
  if (!collection.title || !collection.label) fail("专辑需要标题和编号。");
  if (collection.purchaseUnit !== "collection") fail("付费单位必须为专辑。");
  if (!["open","provider"].includes(collection.access?.mode)) fail("专辑访问模式无效。");
  if (collection.priceMinor != null && (!Number.isInteger(collection.priceMinor) || collection.priceMinor < 0)) fail("专辑价格须为非负整数分。");
  return collection;
}

function validateQuiz(quiz) {
  if (!quiz || quiz.schemaVersion !== 1) fail("测评配置需要 schemaVersion: 1。");
  if (!/^[a-z][a-z0-9-]*$/.test(quiz.id) || !quiz.collectionId) fail("测评需要稳定的 ID 和所属专辑。");
  if (!Number.isInteger(quiz.revision) || quiz.revision < 1 || !quiz.title) fail("测评标题或内容版本无效。");
  if (!Array.isArray(quiz.axes) || quiz.axes.length < 3 || quiz.axes.length > 8) fail("支持3—8个维度。");
  const axisIds = quiz.axes.map(axis => axis.id);
  if (new Set(axisIds).size !== axisIds.length || quiz.axes.some(axis => !axis.label || !axis.short || !axis.low || !axis.high)) fail("维度定义不完整或重复。");
  if (quiz.axes.some(axis => axis.matchWeight != null && (!finite(axis.matchWeight) || axis.matchWeight <= 0))) fail("维度匹配权重须为正数。");
  if (!Array.isArray(quiz.questions) || quiz.questions.length < 1 || quiz.questions.length > 100) fail("题目数量须为1—100。");
  const questionIds = new Set();
  for (const question of quiz.questions) {
    if (!question.id || questionIds.has(question.id) || !question.prompt) fail("题目ID重复或题干为空。");
    questionIds.add(question.id);
    if (!axisIds.includes(question.primaryAxis)) fail("题目的主维度不存在。");
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 8) fail("每题需要2—8个选项。");
    if (question.selection && !["single","multiple"].includes(question.selection.mode)) fail("题目选择方式无效。");
    const limit = selectionLimit(question);
    if (!Number.isInteger(limit) || limit < 1 || limit > question.options.length || (question.selection?.mode === "multiple" && limit < 2)) fail("题目可选数量无效。");
    const optionIds = new Set();
    const keys = Object.keys(question.weights || {});
    if (!keys.includes(question.primaryAxis)) fail("题目缺少主维度权重。");
    for (const key of keys) if (!axisIds.includes(key) || !finite(question.weights[key]) || question.weights[key] <= 0) fail("题目维度或权重无效。");
    for (const option of question.options) {
      if (!option.id || optionIds.has(option.id) || !option.text) fail("选项ID重复或文本为空。");
      optionIds.add(option.id);
      if (Object.keys(option.scores || {}).sort().join("|") !== keys.slice().sort().join("|")) fail("选项的计分维度不完整。");
      for (const score of Object.values(option.scores)) if (!finite(score)) fail("选项分数必须是有限数字。");
    }
  }
  if (!Array.isArray(quiz.outcomes) || quiz.outcomes.length < 2) fail("每项测评至少需要两个结果。");
  const outcomeIds = new Set();
  for (const outcome of quiz.outcomes) {
    if (!outcome.id || outcomeIds.has(outcome.id) || !outcome.name || !outcome.summary) fail("结果内容不完整或ID重复。");
    outcomeIds.add(outcome.id);
    if (!outcome.referenceAnswers && !outcome.referenceProfile) fail("结果需要参考答卷或参考轮廓。");
    if (outcome.referenceProfile) for (const id of axisIds) if (!finite(outcome.referenceProfile[id]) || outcome.referenceProfile[id] < 0 || outcome.referenceProfile[id] > 100) fail("参考轮廓须为0—100。");
  }
  const matching = quiz.scoring || {};
  const shape = matching.shapeWeight ?? .7;
  const level = matching.levelWeight ?? .3;
  if (!finite(shape) || !finite(level) || shape < 0 || level < 0 || Math.abs(shape+level-1) > 1e-9) fail("轮廓匹配权重须非负且合计为1。");
  if (matching.coResultGap != null && (!finite(matching.coResultGap) || matching.coResultGap < 0)) fail("联合结果阈值无效。");
  return quiz;
}

function createQuizModel(definition) {
  validateQuiz(definition);
  const ids = definition.axes.map(axis => axis.id);
  const ranges = Object.fromEntries(ids.map(id => [id,{min:0,max:0,primaryCount:0}]));
  for (const question of definition.questions) {
    ranges[question.primaryAxis].primaryCount++;
    for (const [id,weight] of Object.entries(question.weights)) {
      const scores = question.options.map(option => option.scores[id]);
      ranges[id].min += Math.min(...scores)*weight;
      ranges[id].max += Math.max(...scores)*weight;
    }
  }
  for (const id of ids) if (ranges[id].max-ranges[id].min <= 1e-10) fail("维度没有可区分的答案："+id);
  const model = {definition,ids,ranges,questionIds:new Set(definition.questions.map(question => question.id)),prototypes:[]};
  model.prototypes = definition.outcomes.map(outcome => ({
    id:outcome.id,
    scores:outcome.referenceAnswers ? profileFromAnswers(model,outcome.referenceAnswers).exactScores : {...outcome.referenceProfile}
  }));
  return model;
}

function profileFromAnswers(model,answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) fail("需要按题目ID提供答案。");
  const missing = model.definition.questions.filter(question => !own(answers,question.id));
  if (missing.length) fail("请先完成全部题目。");
  if (Object.keys(answers).some(id => !model.questionIds.has(id))) fail("答案中有未知题目。");
  const rawScores = Object.fromEntries(model.ids.map(id => [id,0]));
  const evidence = model.definition.questions.map(question => {
    const options = selectedOptions(question,answers[question.id]);
    const contributions = {}, meanScores = {};
    for (const [id,weight] of Object.entries(question.weights)) {
      meanScores[id] = options.reduce((sum,option) => sum+option.scores[id],0)/options.length;
      contributions[id] = weight*meanScores[id];
      rawScores[id] += contributions[id];
    }
    return {questionId:question.id,optionId:options[0].id,optionIds:options.map(option=>option.id),selectionCount:options.length,prompt:question.prompt,answer:options.map(option=>option.text).join(" / "),focus:question.focus || "生活片段",primaryAxis:question.primaryAxis,meanScores,contributions};
  });
  const exactScores = Object.fromEntries(model.ids.map(id => {
    const range = model.ranges[id];
    return [id,Math.max(0,Math.min(100,100*(rawScores[id]-range.min)/(range.max-range.min)))];
  }));
  return {rawScores,exactScores,evidence};
}

function profileDistance(model,user,reference) {
  for (const vector of [user,reference]) for (const id of model.ids) if (!finite(vector[id]) || vector[id] < 0 || vector[id] > 100) fail("维度分数须为0—100。");
  const axes = model.definition.axes;
  const weightSum = axes.reduce((sum,axis) => sum+(axis.matchWeight ?? 1),0);
  const mean = vector => axes.reduce((sum,axis) => sum+(axis.matchWeight ?? 1)*vector[axis.id],0)/weightSum;
  const userMean = mean(user), referenceMean = mean(reference);
  const level = Math.sqrt(axes.reduce((sum,axis) => sum+(axis.matchWeight ?? 1)*(user[axis.id]-reference[axis.id])**2,0)/weightSum);
  const shape = Math.sqrt(axes.reduce((sum,axis) => sum+(axis.matchWeight ?? 1)*((user[axis.id]-userMean)-(reference[axis.id]-referenceMean))**2,0)/weightSum);
  const settings = model.definition.scoring || {};
  return {distance:(settings.shapeWeight ?? .7)*shape+(settings.levelWeight ?? .3)*level,shapeDistance:shape,levelDistance:level};
}

function scoreDimensionProfile(model,answers) {
  const profile = profileFromAnswers(model,answers);
  const ranking = model.prototypes.map(prototype => ({id:prototype.id,...profileDistance(model,profile.exactScores,prototype.scores)}))
    .sort((a,b) => a.distance-b.distance || a.id.localeCompare(b.id));
  const settings = model.definition.scoring || {};
  const gap = ranking[1].distance-ranking[0].distance;
  const joint = gap <= (settings.coResultGap ?? 3);
  const mean = model.ids.reduce((sum,id) => sum+profile.exactScores[id],0)/model.ids.length;
  const spread = Math.sqrt(model.ids.reduce((sum,id) => sum+(profile.exactScores[id]-mean)**2,0)/model.ids.length);
  return {
    quizId:model.definition.id,revision:model.definition.revision,
    primaryId:ranking[0].id,secondaryId:joint ? ranking[1].id : null,mode:joint ? "joint" : "single",
    axes:profile.exactScores,rawScores:profile.rawScores,evidence:profile.evidence,ranking,distanceGap:gap,
    balanced:spread < (settings.balancedSpread ?? 8),distant:ranking[0].distance > (settings.distantDistance ?? 20)
  };
}

function profileInsights(model,report) {
  const axes=model.definition.axes;
  const strongest=axes.slice().sort((a,b)=>Math.abs(report.axes[b.id]-50)-Math.abs(report.axes[a.id]-50)).filter(axis=>Math.abs(report.axes[axis.id]-50)>=12).slice(0,2);
  const tendencies=strongest.length ? strongest.map(axis=>axis.reading?.[report.axes[axis.id]>=50?"high":"low"] || "在“"+axis.label+"”上，你更靠近“"+(report.axes[axis.id]>=50?axis.high:axis.low)+"”这一端。") : ["这次你在几个方向之间都留了余地。与其给自己定一个很强的类型，不如先看看下面哪些生活片段更像你。"];
  const reference=model.prototypes.find(item=>item.id===report.primaryId);
  const differences=axes.slice().sort((a,b)=>Math.abs(report.axes[b.id]-reference.scores[b.id])-Math.abs(report.axes[a.id]-reference.scores[a.id])).filter(axis=>Math.abs(report.axes[axis.id]-reference.scores[axis.id])>=15).slice(0,2).map(axis=>({axisId:axis.id,direction:report.axes[axis.id]>reference.scores[axis.id]?"high":"low",text:"在“"+axis.label+"”上，你比这一参考更靠近“"+(report.axes[axis.id]>reference.scores[axis.id]?axis.high:axis.low)+"”。"}));
  return {tendencies,differences};
}

class QuizRegistry {
  constructor() {
    this.collections = new Map();
    this.models = new Map();
    this.strategies = new Map([["dimension-profile",scoreDimensionProfile]]);
    this.listeners = new Set();
  }
  registerCollection(definition) {
    validateCollection(definition);
    if (this.collections.has(definition.id)) fail("专辑ID重复："+definition.id);
    this.collections.set(definition.id,definition);
    this.emit();
    return this;
  }
  registerScoringStrategy(id,score) {
    if (!id || typeof score !== "function" || this.strategies.has(id)) fail("计分扩展无效或重复。");
    this.strategies.set(id,score);
    return this;
  }
  registerQuiz(definition) {
    if (this.models.has(definition.id)) fail("测评ID重复："+definition.id);
    if (!this.collections.has(definition.collectionId)) fail("所属专辑不存在："+definition.collectionId);
    const strategy = definition.scoring?.strategy || "dimension-profile";
    if (!this.strategies.has(strategy)) fail("计分策略尚未注册："+strategy);
    this.models.set(definition.id,createQuizModel(definition));
    this.emit();
    return this;
  }
  getQuiz(id) { return this.models.get(id)?.definition || null; }
  getModel(id) { return this.models.get(id) || null; }
  getCollection(id) { return this.collections.get(id) || null; }
  listCollections() { return [...this.collections.values()].sort((a,b) => (a.order ?? 0)-(b.order ?? 0) || a.id.localeCompare(b.id)); }
  listQuizzes(collectionId) { return [...this.models.values()].map(model => model.definition).filter(quiz => !collectionId || quiz.collectionId === collectionId).sort((a,b) => (a.order ?? 0)-(b.order ?? 0) || a.id.localeCompare(b.id)); }
  score(id,answers) {
    const model = this.models.get(id);
    if (!model) fail("测评不存在："+id);
    const scorer = this.strategies.get(model.definition.scoring?.strategy || "dimension-profile");
    const report = scorer(model,answers);
    if (!report || !model.definition.outcomes.some(outcome => outcome.id === report.primaryId)) fail("计分扩展返回了无效结果。");
    return report;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() { this.listeners.forEach(listener => listener()); }
}



class SuiteStore {
  constructor(registry,adapter) {
    this.registry = registry;
    this.adapter = adapter;
    this.storageAvailable = true;
    this.state = {version:1,nickname:"",quizzes:{},recentQuizId:null};
    try { this.restore(adapter.read()); } catch { this.storageAvailable = false; }
  }
  emptyAttempt(quiz) {
    let seed = Math.floor(Math.random()*4294967295);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) seed = crypto.getRandomValues(new Uint32Array(1))[0];
    return {revision:quiz.revision,answers:{},index:0,seed,completedAt:null};
  }
  restore(raw) {
    if (!raw || raw.version !== 1 || !raw.quizzes || typeof raw.quizzes !== "object") return;
    this.state.nickname = Array.from(typeof raw.nickname === "string" ? raw.nickname : "").slice(0,16).join("");
    for (const quiz of this.registry.listQuizzes()) {
      const saved = raw.quizzes[quiz.id];
      if (!saved || saved.revision !== quiz.revision || !saved.answers || typeof saved.answers !== "object") continue;
      const attempt = this.emptyAttempt(quiz);
      for (const question of quiz.questions) {
        if (hasAnswer(question,saved.answers[question.id])) {
          const options=selectedOptions(question,saved.answers[question.id]);
          attempt.answers[question.id] = selectionLimit(question)>1 ? options.map(option=>option.id) : options[0].id;
        }
      }
      if (Number.isInteger(saved.index) && saved.index >= 0 && saved.index < quiz.questions.length) attempt.index = saved.index;
      if (Number.isInteger(saved.seed) && saved.seed >= 0) attempt.seed = saved.seed >>> 0;
      if (typeof saved.completedAt === "string" && quiz.questions.every(question=>hasAnswer(question,attempt.answers[question.id]))) attempt.completedAt = saved.completedAt;
      this.state.quizzes[quiz.id] = attempt;
    }
    if (this.registry.getQuiz(raw.recentQuizId)) this.state.recentQuizId = raw.recentQuizId;
  }
  persist() {
    try { this.adapter.write(this.snapshot()); this.storageAvailable = true; } catch { this.storageAvailable = false; }
  }
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  attempt(id) {
    const quiz = this.registry.getQuiz(id);
    if (!quiz) throw new Error("未知测评："+id);
    if (!this.state.quizzes[id] || this.state.quizzes[id].revision !== quiz.revision) this.state.quizzes[id] = this.emptyAttempt(quiz);
    return this.state.quizzes[id];
  }
  progress(id) {
    const quiz = this.registry.getQuiz(id), attempt = this.attempt(id);
    const answered = quiz.questions.filter(question=>hasAnswer(question,attempt.answers[question.id])).length;
    const firstMissing = quiz.questions.findIndex(question=>!hasAnswer(question,attempt.answers[question.id]));
    return {answered,total:quiz.questions.length,complete:answered===quiz.questions.length,firstMissing:firstMissing < 0 ? 0 : firstMissing};
  }
  answer(id,questionId,value) {
    const quiz = this.registry.getQuiz(id), question = quiz.questions.find(question=>question.id===questionId);
    if (!question) throw new Error("答案不属于这道题。");
    const attempt = this.attempt(id);
    if (Array.isArray(value) && !value.length && selectionLimit(question)>1) delete attempt.answers[questionId];
    else {
      const options=selectedOptions(question,value);
      attempt.answers[questionId] = selectionLimit(question)>1 ? options.map(option=>option.id) : options[0].id;
    }
    this.state.recentQuizId = id;
    if (this.progress(id).complete) attempt.completedAt ||= new Date().toISOString();
    else attempt.completedAt=null;
    this.persist();
  }
  setIndex(id,index) {
    const quiz = this.registry.getQuiz(id);
    if (!Number.isInteger(index) || index < 0 || index >= quiz.questions.length) throw new Error("题目位置无效。");
    this.attempt(id).index = index;
    this.persist();
  }
  resetQuiz(id) {
    this.state.quizzes[id] = this.emptyAttempt(this.registry.getQuiz(id));
    this.persist();
  }
  setNickname(name) {
    this.state.nickname = Array.from(String(name)).slice(0,16).join("");
    this.persist();
    return this.state.nickname;
  }
  importLegacyDirector(raw) {
    const quiz = this.registry.getQuiz("director");
    if (!quiz || quiz.revision !== 1 || this.progress("director").answered || raw?.version !== "0.3" || !raw.answers) return false;
    const attempt = this.attempt("director");
    for (const question of quiz.questions) if (question.options.some(option=>option.id===raw.answers[question.id])) attempt.answers[question.id] = raw.answers[question.id];
    if (Number.isInteger(raw.index) && raw.index >= 0 && raw.index < quiz.questions.length) attempt.index = raw.index;
    if (this.progress("director").complete) attempt.completedAt = new Date().toISOString();
    this.persist();
    return this.progress("director").answered > 0;
  }
  orderedOptions(quiz,question) {
    if (quiz.shuffleOptions === false) return question.options.slice();
    let seed = this.attempt(quiz.id).seed;
    for (const char of question.id) seed = Math.imul(seed^char.charCodeAt(0),16777619) >>> 0;
    const options = question.options.slice();
    for (let i=options.length-1;i>0;i--) {
      seed = (Math.imul(seed,1664525)+1013904223) >>> 0;
      const j = seed%(i+1);
      [options[i],options[j]] = [options[j],options[i]];
    }
    return options;
  }
}

function mountPortraitSuite() {
  const bundled = JSON.parse(document.getElementById("suite-data").textContent);
  const registry = new QuizRegistry();
  bundled.collections.forEach(collection=>registry.registerCollection(collection));
  bundled.quizzes.forEach(quiz=>registry.registerQuiz(quiz));
  const storageKey = "everyday-portraits.v2";
  const store = new SuiteStore(registry,{
    read:()=>JSON.parse(localStorage.getItem(storageKey)||"null"),
    write:snapshot=>localStorage.setItem(storageKey,JSON.stringify(snapshot))
  });
  let hasPreviousEdition=false;
  try {
    const previous=JSON.parse(localStorage.getItem("everyday-portraits.v1")||"null");
    hasPreviousEdition=Boolean(previous && Object.values(previous.quizzes||{}).some(attempt=>Object.keys(attempt.answers||{}).length));
    if(!store.state.nickname && previous?.nickname) store.setNickname(previous.nickname);
  } catch {}
  const $ = id=>document.getElementById(id);
  const el = (tag,className,text)=>{
    const node=document.createElement(tag);
    if (className) node.className=className;
    if (text!==undefined) node.textContent=text;
    return node;
  };
  const outcome = (quiz,id)=>quiz.outcomes.find(item=>item.id===id);
  let activeQuiz = null, activeReport = null, comparisonId = null, resetQuizId = null, toastTimer = null;
  let archiveCollectionId = registry.listCollections()[0]?.id || "";
  const defaultAccess = {
    async getEntitlement(collectionId) { return {allowed:registry.getCollection(collectionId)?.access.mode==="open",collectionId}; },
    async startCheckout() { throw new Error("本专辑尚未接入收款服务。"); }
  };
  let accessProvider = defaultAccess;
  function notify(text) {
    clearTimeout(toastTimer);
    $("toast").textContent=text; $("toast").hidden=false;
    toastTimer=setTimeout(()=>{$("toast").hidden=true;},4200);
  }
  function updateGlobalState() {
    const quizzes=registry.listQuizzes(), completed=quizzes.filter(quiz=>store.progress(quiz.id).complete).length;
    $("nav-count").hidden=completed===0;
    $("nav-count").textContent=String(completed);
    $("storage-note").textContent=store.storageAvailable ? "记录仅保存在当前浏览器" : "当前浏览器无法保存记录，请先保存结果图片";
  }
  function link(text,hash,className) {
    const node=el("a",className,text); node.href=hash; return node;
  }
  function showView(view,focus=true) {
    document.querySelectorAll("[data-view]").forEach(section=>{section.hidden=section.dataset.view!==view;});
    document.body.dataset.screen=view;
    $("nav-home").setAttribute("aria-current",["home","intro","quiz"].includes(view)?"page":"false");
    $("nav-archive").setAttribute("aria-current",view==="archive"?"page":"false");
    updateGlobalState();
    if (focus) {
      window.scrollTo({top:0,left:0,behavior:"instant"});
      const heading=$(view==="home"?"home-heading":view==="intro"?"intro-heading":view==="quiz"?"question-prompt":view==="result"?"result-heading":view==="archive"?"archive-heading":"missing-heading");
      heading.focus({preventScroll:true});
    }
  }
  function go(hash,replace=false) {
    if (location.hash!==hash) history[replace?"replaceState":"pushState"](null,"",hash);
    renderRoute();
  }
  function decorateCover(container,quiz,preferredOutcome) {
    container.replaceChildren();
    container.dataset.kind=quiz.kind||"standard";
    const image=preferredOutcome?.image?.src || quiz.cover?.image;
    if (image) {
      const img=el("img"); img.src=image; img.alt=preferredOutcome?.image?.alt || quiz.shortTitle+"画面"; img.loading="lazy"; container.append(img); return;
    }
    const piece=el("div","mini-piece "+(quiz.kind==="literature"?"piece-book":quiz.kind==="painting"?"piece-painting":"piece-film"));
    piece.append(el("span","mini-label",quiz.kind==="literature"?"LITERARY HOME":quiz.kind==="painting"?"A PAINTED LIFE":"A LIFE IN FILM"));
    piece.append(el("div",quiz.kind==="literature"?"book-window":quiz.kind==="painting"?"painting-window":"film-window"));
    const title=el("span","mini-title");
    (quiz.kind==="literature"?["一页文字","也有故乡"]:quiz.kind==="painting"?["一点颜色","慢慢像你"]:["一段日子","自有镜头"]).forEach((line,index)=>{if(index)title.append(el("br"));title.append(document.createTextNode(line));});
    piece.append(title);container.append(piece);
  }
  function progressLabel(quiz) {
    const progress=store.progress(quiz.id);
    return progress.complete?"已收录":progress.answered?"已答 "+progress.answered+" / "+progress.total:"还没开始";
  }
  function quizCard(quiz) {
    const progress=store.progress(quiz.id);
    const card=el("article","quiz-card"); card.dataset.quizId=quiz.id;
    const art=el("div","card-art");decorateCover(art,quiz);art.setAttribute("aria-hidden","true");
    const copy=el("div","quiz-card-copy");
    copy.append(el("p","card-kicker",quiz.ui?.eyebrow||"给日常的另一种读法"),el("h3","",quiz.title),el("p","quiz-card-description",quiz.subtitle));
    copy.append(el("p","card-facts",quiz.questions.length+"道生活情境 · "+quiz.outcomes.length+"种气质 · 约"+quiz.estimatedMinutes+"分钟"));
    const bottom=el("div","card-bottom");
    bottom.append(link(progress.complete?"查看档案 ↗":progress.answered?"继续作答 →":"开始测评 →",progress.complete?"#/result/"+quiz.id:"#/test/"+quiz.id,"card-link"));
    bottom.append(el("span","card-status"+(progress.complete?" is-complete":""),progressLabel(quiz)));
    copy.append(bottom);card.append(art,copy);return card;
  }
  function renderHome(collectionId) {
    const collections=registry.listCollections().filter(collection=>!collectionId||collection.id===collectionId);
    if(!collections.length){showView("missing");return;}
    const quizzes=collections.flatMap(collection=>registry.listQuizzes(collection.id));
    const complete=quizzes.filter(quiz=>store.progress(quiz.id).complete).length;
    $("home-eyebrow").textContent=collections.length===1?collections[0].label+" · "+collections[0].title:"生活的不同侧面 · 测评专辑";
    $("home-description").textContent=collections.length===1?(collections[0].subtitle||"")+" "+collections[0].description:"从日常的不同选择里，发现自己与关系的更多侧面。每份专辑独立成档，想从哪里开始都可以。";
    const durations=quizzes.map(quiz=>quiz.estimatedMinutes||5),minMinutes=Math.min(...durations),maxMinutes=Math.max(...durations);
    $("home-facts").replaceChildren(el("span","",quizzes.length+"项独立测评"),el("span","","每项约"+minMinutes+(minMinutes===maxMinutes?"":"—"+maxMinutes)+"分钟"),el("span","","各自成档"));
    $("home-progress").hidden=!complete;
    $("home-progress").textContent="你已经收好 "+complete+" / "+quizzes.length+" 份侧写，下一页慢慢来。";
    $("edition-note").hidden=!hasPreviousEdition;
    $("collection-list").replaceChildren(...collections.map(collection=>{
      const block=el("section","collection-block");block.dataset.collectionId=collection.id;
      const head=el("div","collection-head"), left=el("div");
      left.append(el("p","collection-kicker",collection.label+" / 生活的一面"),el("h2","collection-title",collection.title),el("p","collection-desc",collection.description));
      const access=el("span","collection-access",collection.access.mode==="open"?"当前开放体验":collection.priceMinor==null?"按专辑解锁":"整辑 ¥"+(collection.priceMinor/100).toFixed(2));
      head.append(left,access);
      const cards=el("div","quiz-cards");cards.append(...registry.listQuizzes(collection.id).map(quizCard));
      block.append(head,cards);return block;
    }));
    document.title="生活侧写｜"+collections.map(collection=>collection.label+" "+collection.title).join(" · ");
    showView("home");
  }
  function renderIntro(quiz) {
    activeQuiz=quiz;
    const collection=registry.getCollection(quiz.collectionId), progress=store.progress(quiz.id);
    $("intro-eyebrow").textContent=collection.label+" · "+collection.title+" / "+quiz.shortTitle;
    $("intro-heading").textContent=quiz.title;
    $("intro-description").textContent=quiz.description;
    $("intro-facts").replaceChildren(el("span","",quiz.questions.length+"道生活情境"),el("span","",quiz.axes.length+"个偏好维度"),el("span","","约"+quiz.estimatedMinutes+"分钟"));
    $("intro-start-label").textContent=progress.complete?"查看本项档案":progress.answered?"继续第 "+(progress.firstMissing+1)+" 题":"开始这项测评";
    $("intro-restart").hidden=!progress.answered;
    $("intro-progress").textContent=progress.complete?"这份侧写已经收好，随时可以回看。":progress.answered?"已经记下 "+progress.answered+" / "+progress.total+" 个回答。":"进度会自动保存在当前浏览器，随时可以回来。";
    decorateCover($("intro-art"),quiz);
    $("intro-outcomes").replaceChildren(...quiz.outcomes.map(item=>el("li","",item.name)));
    $("intro-axes").textContent=quiz.axes.map(axis=>axis.label).join("、")+"。每个方向都有自己的位置，不分高低好坏。";
    $("intro-note").textContent=quiz.measurementNote;
    $("intro-answer-mode").textContent=quiz.questions.filter(question=>selectionLimit(question)>1).length+"道题可选1—2项，其余题目选1项。多选题可再次点选取消。";
    if(collection.access.mode==="provider"){
      $("intro-start-label").textContent="查看本专辑权限";
      accessProvider.getEntitlement(quiz.collectionId).then(entitlement=>{
        if(activeQuiz?.id!==quiz.id||document.body.dataset.screen!=="intro")return;
        if(!entitlement?.allowed){
          $("intro-start-label").textContent="解锁 "+collection.label+" 整辑"+(collection.priceMinor==null?"":" · ¥"+(collection.priceMinor/100).toFixed(2));
          $("intro-progress").textContent="按专辑解锁，包含本专辑的"+registry.listQuizzes(collection.id).length+"项测评。";
        }else $("intro-start-label").textContent=progress.complete?"查看本项档案":progress.answered?"继续第 "+(progress.firstMissing+1)+" 题":"开始这项测评";
      }).catch(()=>{if(activeQuiz?.id===quiz.id)$("intro-progress").textContent="暂时未能确认专辑权限，请稍后再试。";});
    }
    document.title=quiz.shortTitle+"｜生活侧写";
    showView("intro");
  }
  function updateQuestionState() {
    const quiz=activeQuiz, attempt=store.attempt(quiz.id), question=quiz.questions[attempt.index], progress=store.progress(quiz.id);
    $("answered-count").textContent="已选 "+progress.answered+" / "+progress.total;
    $("quiz-progress").max=progress.total;$("quiz-progress").value=progress.answered;
    $("quiz-progress").setAttribute("aria-valuetext","已答"+progress.answered+"题，共"+progress.total+"题");
    $("next-button").disabled=!hasAnswer(question,attempt.answers[question.id]);
    const count=hasAnswer(question,attempt.answers[question.id])?selectedOptions(question,attempt.answers[question.id]).length:0;
    $("question-selection-count").textContent=selectionLimit(question)>1?"已选 "+count+" / "+selectionLimit(question)+" 项":"单选";
    $("return-result").hidden=!progress.complete;
    $("answer-options").querySelectorAll(".answer-choice").forEach(label=>label.classList.toggle("is-selected",label.querySelector("input").checked));
    updateGlobalState();
  }
  function renderQuestion(quiz) {
    activeQuiz=quiz;
    const attempt=store.attempt(quiz.id), question=quiz.questions[attempt.index];
    $("quiz-short-title").textContent=quiz.shortTitle;
    $("question-unit").textContent=quiz.ui?.questionUnit||"题目";
    $("question-number").textContent=String(attempt.index+1).padStart(2,"0");
    $("question-total").textContent=" / "+quiz.questions.length;
    $("question-category").textContent=quiz.ui?.questionKicker||"日常生活 · 慢慢作答";
    $("question-prompt").textContent=question.prompt;
    const multiple=selectionLimit(question)>1;
    $("question-instruction").textContent=multiple?"选1—"+selectionLimit(question)+"项平时会有的反应；两项都像就都选，再点一次可以取消。":"选最接近平时反应的一项。";
    $("answer-options").setAttribute("aria-describedby","question-instruction question-selection-count");
    $("previous-button").disabled=attempt.index===0;
    $("next-label").textContent=attempt.index===quiz.questions.length-1?"看看我的结果":"下一题";
    $("answer-options").replaceChildren(el("legend","sr-only","选择你的回答"),...store.orderedOptions(quiz,question).map((option,index)=>{
      const label=el("label","answer-choice"), input=el("input","choice-radio");
      input.type=multiple?"checkbox":"radio";input.id=quiz.id+"-"+option.id;input.value=option.id;input.name=quiz.id+"-"+question.id;
      input.checked=hasAnswer(question,attempt.answers[question.id])&&selectedOptions(question,attempt.answers[question.id]).some(selected=>selected.id===option.id);label.htmlFor=input.id;
      input.addEventListener("change",()=>{
        const checked=[...$("answer-options").querySelectorAll("input:checked")].map(node=>node.value);
        if(checked.length>selectionLimit(question)){input.checked=false;notify("这道题最多选"+selectionLimit(question)+"项，先取消一项再换。 ");updateQuestionState();return;}
        store.answer(quiz.id,question.id,multiple?checked:option.id);activeReport=null;updateQuestionState();
      });
      label.append(input,el("span","choice-text",option.text),el("span","choice-letter",String.fromCharCode(65+index)));
      return label;
    }));
    updateQuestionState();
    document.title=quiz.shortTitle+" · "+(attempt.index+1)+"/"+quiz.questions.length+"｜生活侧写";
    showView("quiz");
  }
  function appendNames(container,items) {
    container.replaceChildren();
    items.forEach((item,index)=>{if(index)container.append(el("span","director-join","×"));container.append(el("span","",item.name));});
    container.setAttribute("aria-label",items.map(item=>item.name).join("与"));
  }
  function reportEvidence(quiz,report) {
    const result=[];
    const sorted=quiz.axes.slice().sort((a,b)=>Math.abs(report.axes[b.id]-50)-Math.abs(report.axes[a.id]-50));
    for(const axis of sorted){
      if(result.length>=3)break;
      const direction=report.axes[axis.id]>=50?1:-1;
      const candidates=report.evidence.filter(item=>item.primaryAxis===axis.id).map(item=>{
        const question=quiz.questions.find(q=>q.id===item.questionId), scores=question.options.map(option=>option.scores[axis.id]);
        const selected=item.meanScores[axis.id];
        const min=Math.min(...scores),max=Math.max(...scores);
        return {item,strength:max===min?0:direction*(selected-(min+max)/2)/(max-min)};
      }).sort((a,b)=>b.strength-a.strength||a.item.questionId.localeCompare(b.item.questionId));
      if(candidates[0])result.push(candidates[0].item);
    }
    return result;
  }
  function renderResult(quiz) {
    if(!store.progress(quiz.id).complete){go("#/test/"+quiz.id,true);return;}
    activeQuiz=quiz;activeReport=registry.score(quiz.id,store.attempt(quiz.id).answers);comparisonId=activeReport.primaryId;
    const items=[outcome(quiz,activeReport.primaryId),...(activeReport.secondaryId?[outcome(quiz,activeReport.secondaryId)]:[])], main=items[0];
    $("result-eyebrow").textContent=registry.getCollection(quiz.collectionId).label+" · "+quiz.shortTitle+" / 已收录";
    $("result-heading").textContent=items.length===2?(quiz.ui?.jointHeading||"两种气质，都与你合拍"):(quiz.ui?.singleHeading||"与你合拍的气质");
    $("result-note").textContent=(items.length===2?"你的轮廓同时接近这两种气质，两个方向都值得留下。":"在本项的"+quiz.outcomes.length+"种参考气质里，你的作答与这一种更接近。")+(activeReport.balanced?" 这次的维度起伏较小，整体偏好比较均衡。":"");
    if(activeReport.distant) $("result-note").textContent="这次作答没有特别贴近某一种固定原型。下面是相对接近的方向，你自己的轮廓和差别同样值得看。";
    const insights=profileInsights(registry.getModel(quiz.id),activeReport);
    $("personal-tendencies").replaceChildren(...insights.tendencies.map(text=>el("p","",text)));
    $("personal-differences").replaceChildren(...insights.differences.map(item=>el("p","",item.text)));
    $("personal-differences-panel").hidden=!insights.differences.length;
    $("personal-reference-name").textContent=main.name;
    appendNames($("outcome-title"),items);
    $("poster-kicker").textContent=quiz.kind==="film"?"A LIFE IN FILM":quiz.kind==="literature"?"A PLACE BETWEEN THE PAGES":quiz.kind==="painting"?"A PORTRAIT IN COLOUR":"YOUR EVERYDAY PORTRAIT";
    $("outcome-style").replaceChildren(...items.map(item=>el("span","",item.style)));
    $("outcome-subtitle").textContent=main.title||"";
    $("outcome-quote").textContent=main.quote?"“"+main.quote+"”":"";
    $("result-art").hidden=Boolean(main.image);$("result-art").dataset.kind=quiz.kind;
    $("result-art").dataset.tone=main.id;$("result-picture").hidden=!main.image;
    $("result-poster").classList.toggle("has-image",Boolean(main.image));
    if(main.image){$("result-image").src=main.image.src;$("result-image").alt=main.image.alt;$("result-image-caption").textContent=main.image.credit+" · 公版开放图像";}
    $("story-heading").textContent=quiz.ui?.storyHeading||"这份气质，从生活里来";
    const paragraphs=[];
    items.forEach((item,index)=>{
      if(items.length===2)paragraphs.push(el("span","report-director-label",item.name+" · "+item.style));
      paragraphs.push(el("p","",item.summary));
      if(index>0&&item.image){const figure=el("figure","inline-art"),img=el("img");img.src=item.image.src;img.alt=item.image.alt;img.loading="lazy";figure.append(img,el("figcaption","",item.image.credit));paragraphs.push(figure);}
    });
    $("report-copy").replaceChildren(...paragraphs);
    $("work-references").replaceChildren(el("span","","气质参考："),...items.flatMap(item=>(item.references||[]).map(reference=>el("span","",reference.title+(reference.by?" · "+reference.by:"")))));
    $("next-scene-heading").textContent=quiz.ui?.nextHeading||"给日常留一小步";
    $("next-scene").textContent=main.nextStep||"";
    $("radar-heading").textContent="你的"+quiz.axes.length+"维轮廓";
    $("reference-select").replaceChildren(...quiz.outcomes.map(item=>{const option=el("option","",item.name+" · "+item.style);option.value=item.id;return option;}));
    $("reference-select").value=comparisonId;
    $("axis-values").replaceChildren(...quiz.axes.map(axis=>{
      const group=el("div","axis-value"),dt=el("dt","axis-value-head"),dd=el("dd","axis-ends");
      dt.append(el("span","",axis.label),el("span","axis-score",String(Math.round(activeReport.axes[axis.id]))));dd.append(el("span","",axis.low),el("span","",axis.high));group.append(dt,dd);return group;
    }));
    $("evidence-heading").textContent=quiz.ui?.evidenceHeading||"从你实际选择的片段里";
    $("evidence-list").replaceChildren(...reportEvidence(quiz,activeReport).map(item=>{const li=el("li");li.append(el("small","",item.focus),el("blockquote","",item.answer));return li;}));
    $("result-fineprint").textContent="这份档案是一次文化气质联想。分数表示本次作答中的偏好，不代表能力高低，也不会限制你可以成为谁。";
    $("result-method-note").textContent=quiz.measurementNote+" 结果中的短句与说明为本项目原创，不是作者、导演或画家的原话。";
    const sources=[...new Map(items.flatMap(item=>item.sources||[]).map(source=>[source.url,source])).values()];
    $("result-sources").replaceChildren(...sources.map(source=>{const li=el("li"),a=el("a","",source.title);a.href=source.url;a.target="_blank";a.rel="noopener noreferrer";li.append(a);return li;}));
    const others=registry.listQuizzes(quiz.collectionId).filter(item=>item.id!==quiz.id);
    const next=el("div","next-quiz-links");
    next.append(...others.map(item=>link((store.progress(item.id).complete?"回看：":"再看看：")+item.shortTitle,store.progress(item.id).complete?"#/result/"+item.id:"#/test/"+item.id,"")));
    $("next-quiz-panel").replaceChildren(el("h3","","这一份收好了，还可以翻翻别的。"),next);
    document.title=items.map(item=>item.name).join(" × ")+"｜"+quiz.shortTitle+" · 生活侧写";
    showView("result");drawRadar();
  }
  function drawRadar() {
    if(!activeReport||document.body.dataset.screen!=="result")return;
    const quiz=activeQuiz, svg=$("result-radar"),width=svg.getBoundingClientRect().width;
    if(width<1)return;
    const height=Math.min(width,370),cx=width/2,cy=height/2,radius=Math.max(38,Math.min((width-100)/2,(height-74)/2));
    const point=(i,value,extra=0)=>{const angle=-Math.PI/2+i*Math.PI*2/quiz.axes.length,r=radius*value/100+extra;return [cx+Math.cos(angle)*r,cy+Math.sin(angle)*r];};
    const svgEl=(tag,attrs,text)=>{const node=document.createElementNS("http://www.w3.org/2000/svg",tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,String(v)));if(text!==undefined)node.textContent=text;return node;};
    const points=scores=>quiz.axes.map((axis,i)=>point(i,scores[axis.id]).join(",")).join(" ");
    svg.setAttribute("viewBox","0 0 "+width+" "+height);svg.setAttribute("height",String(height));
    const reference=registry.getModel(quiz.id).prototypes.find(item=>item.id===comparisonId);
    $("radar-grid").replaceChildren();$("radar-labels").replaceChildren();$("radar-dots").replaceChildren();
    [25,50,75,100].forEach(value=>{$("radar-grid").append(svgEl("polygon",{points:quiz.axes.map((axis,i)=>point(i,value).join(",")).join(" "),fill:"none",stroke:"#d3d6c8","stroke-width":1}));if(value===50||value===100){const p=point(0,value);$("radar-grid").append(svgEl("text",{x:p[0]+5,y:p[1]+4,class:"scale-label"},String(value)));}});
    quiz.axes.forEach((axis,i)=>{
      const edge=point(i,100),label=point(i,100,23),cos=Math.cos(-Math.PI/2+i*Math.PI*2/quiz.axes.length);
      $("radar-grid").append(svgEl("line",{x1:cx,y1:cy,x2:edge[0],y2:edge[1],stroke:"#d3d6c8","stroke-width":1}));
      $("radar-labels").append(svgEl("text",{x:label[0],y:label[1]+4,"text-anchor":Math.abs(cos)<.01?"middle":cos>0?"start":"end","data-axis-label":axis.id},axis.short));
      const dot=point(i,activeReport.axes[axis.id]);$("radar-dots").append(svgEl("circle",{cx:dot[0],cy:dot[1],r:3,fill:"#a24e37"}));
    });
    Object.entries({points:points(activeReport.axes),fill:"#a24e37","fill-opacity":.13,stroke:"#a24e37","stroke-width":2,"stroke-linejoin":"round"}).forEach(([k,v])=>$("radar-user").setAttribute(k,String(v)));
    Object.entries({points:points(reference.scores),fill:"#577369","fill-opacity":.04,stroke:"#577369","stroke-width":2,"stroke-dasharray":"5 4","stroke-linejoin":"round"}).forEach(([k,v])=>$("radar-reference").setAttribute(k,String(v)));
    $("reference-legend").textContent=outcome(quiz,comparisonId).name+"参考";
    $("radar-description").textContent="各维度范围0到100。你的作答："+quiz.axes.map(axis=>axis.label+Math.round(activeReport.axes[axis.id])).join("，")+"。虚线对比："+outcome(quiz,comparisonId).name+"。";
  }
  function archiveCard(quiz) {
    const progress=store.progress(quiz.id),card=el("article","archive-card"+(progress.complete?"":" is-empty"));card.dataset.quizId=quiz.id;
    let report=null,items=[];
    if(progress.complete){report=registry.score(quiz.id,store.attempt(quiz.id).answers);items=[outcome(quiz,report.primaryId),...(report.secondaryId?[outcome(quiz,report.secondaryId)]:[])];}
    const art=el("div","card-art");decorateCover(art,quiz,items[0]);art.setAttribute("aria-hidden","true");
    const copy=el("div","archive-card-copy");copy.append(el("span","archive-card-label",quiz.shortTitle+" / "+progressLabel(quiz)));
    const heading=el("h2");if(items.length)appendNames(heading,items);else heading.textContent=quiz.subtitle;copy.append(heading);
    copy.append(el("p","",items.length?items.map(item=>item.style).join(" / "):"这一页还在等你来填，选最像平时的自己就好。"));
    const bottom=el("div","card-bottom");bottom.append(link(progress.complete?"打开这份档案 ↗":progress.answered?"继续作答 →":"从这一项开始 →",progress.complete?"#/result/"+quiz.id:"#/test/"+quiz.id,"card-link"));copy.append(bottom);card.append(art,copy);return card;
  }
  function renderArchive() {
    const collections=registry.listCollections();
    if(!registry.getCollection(archiveCollectionId))archiveCollectionId=collections[0]?.id||"";
    const quizzes=registry.listQuizzes(archiveCollectionId),complete=quizzes.filter(quiz=>store.progress(quiz.id).complete).length;
    $("archive-count").textContent=registry.getCollection(archiveCollectionId).label+" · "+complete+" / "+quizzes.length+" 份侧写已收好";
    $("archive-nickname").value=store.state.nickname;
    $("archive-empty").hidden=complete>0;
    $("archive-filter").hidden=collections.length<2;
    $("archive-collection-select").replaceChildren(...collections.map(collection=>{const option=el("option","",collection.label+" · "+collection.title);option.value=collection.id;return option;}));
    $("archive-collection-select").value=archiveCollectionId;
    $("archive-cards").replaceChildren(...quizzes.map(archiveCard));
    $("save-archive").disabled=complete===0;
    $("save-archive").textContent=complete?"保存 "+registry.getCollection(archiveCollectionId).label+" 总档案 ↓":"完成一项后，可保存总档案";
    document.title="我的侧写档案｜生活侧写";showView("archive");
  }
  function renderRoute() {
    const parts=location.hash.replace(/^#\/?/,"").split("/").filter(Boolean),page=parts[0]||"home",id=parts[1];
    activeReport=null;
    if(page==="home"){renderHome();return;}
    if(page==="collection"){renderHome(id);return;}
    if(page==="archive"){renderArchive();return;}
    const quiz=registry.getQuiz(id);
    if(!quiz){showView("missing");return;}
    if(page==="test"){renderIntro(quiz);return;}
    if(page==="question"){renderQuestion(quiz);return;}
    if(page==="result"){renderResult(quiz);return;}
    showView("missing");
  }
  async function startQuiz() {
    const quiz=activeQuiz;
    $("intro-start").disabled=true;
    try {
      const entitlement=await accessProvider.getEntitlement(quiz.collectionId);
      if(!entitlement?.allowed){await accessProvider.startCheckout({collectionId:quiz.collectionId,returnUrl:location.href});return;}
      const progress=store.progress(quiz.id);
      if(progress.complete)go("#/result/"+quiz.id);
      else{store.setIndex(quiz.id,progress.firstMissing);go("#/question/"+quiz.id);}
    } catch(error){notify(error.message||"暂时未能打开这份专辑，请稍后再试。");}
    finally{$("intro-start").disabled=false;}
  }
  function askRestart(id) {
    resetQuizId=id;
    $("restart-description").textContent="这会清除“"+registry.getQuiz(id).shortTitle+"”的本次答案，其他测评的记录会保留。想留下结果，可以先保存图片。";
    if(typeof $("restart-dialog").showModal==="function")$("restart-dialog").showModal();
    else if(confirm($("restart-description").textContent)){store.resetQuiz(id);go("#/question/"+id);}
  }
  $("browse-quizzes").addEventListener("click",()=>$("collection-list").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"instant":"smooth",block:"start"}));
  $("intro-start").addEventListener("click",startQuiz);
  $("intro-restart").addEventListener("click",()=>askRestart(activeQuiz.id));
  $("quiz-exit").addEventListener("click",()=>go("#/test/"+activeQuiz.id));
  $("previous-button").addEventListener("click",()=>{const attempt=store.attempt(activeQuiz.id);if(attempt.index>0){store.setIndex(activeQuiz.id,attempt.index-1);renderQuestion(activeQuiz);}});
  $("next-button").addEventListener("click",()=>{const quiz=activeQuiz,attempt=store.attempt(quiz.id),q=quiz.questions[attempt.index];if(!hasAnswer(q,attempt.answers[q.id]))return;if(attempt.index===quiz.questions.length-1)go("#/result/"+quiz.id);else{store.setIndex(quiz.id,attempt.index+1);renderQuestion(quiz);}});
  $("return-result").addEventListener("click",()=>go("#/result/"+activeQuiz.id));
  $("review-answers").addEventListener("click",()=>{store.setIndex(activeQuiz.id,0);go("#/question/"+activeQuiz.id);});
  $("result-restart").addEventListener("click",()=>askRestart(activeQuiz.id));
  $("cancel-restart").addEventListener("click",()=>$("restart-dialog").close());
  $("confirm-restart").addEventListener("click",()=>{$("restart-dialog").close();store.resetQuiz(resetQuizId);go("#/question/"+resetQuizId);});
  $("reference-select").addEventListener("change",event=>{comparisonId=event.target.value;drawRadar();});
  $("archive-nickname").addEventListener("input",event=>{const name=store.setNickname(event.target.value);if(event.target.value!==name)event.target.value=name;updateGlobalState();});
  $("archive-collection-select").addEventListener("change",event=>{archiveCollectionId=event.target.value;renderArchive();});
  $("share-quiz").addEventListener("click",async()=>{
    if(!/^https?:$/.test(location.protocol)){notify("发布成网址后，就可以复制本项链接。");return;}
    const url=location.origin+location.pathname+"#/test/"+activeQuiz.id;
    try{await navigator.clipboard.writeText(url);notify("本项测评链接已复制，可以发给朋友。");}
    catch{notify("可以复制浏览器里的网址，发给朋友打开。");}
  });
  document.addEventListener("click",event=>{
    const anchor=event.target.closest("a[href^='#/']");
    if(!anchor||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();go(anchor.getAttribute("href"));
  });
  addEventListener("popstate",()=>renderRoute());addEventListener("hashchange",()=>renderRoute());
  if(typeof ResizeObserver==="function")new ResizeObserver(drawRadar).observe($("result-radar"));else addEventListener("resize",drawRadar);
  registry.subscribe(()=>renderRoute());
  window.PortraitSuite=Object.freeze({
    registerCollection:definition=>registry.registerCollection(definition),
    registerQuiz:definition=>registry.registerQuiz(definition),
    registerScoringStrategy:(id,scorer)=>registry.registerScoringStrategy(id,scorer),
    listCollections:()=>registry.listCollections(),
    listQuizzes:collectionId=>registry.listQuizzes(collectionId),
    getQuiz:id=>registry.getQuiz(id),
    scoreQuiz:(id,answers)=>registry.score(id,answers),
    getProgress:id=>store.progress(id),
    setAccessProvider:provider=>{if(typeof provider?.getEntitlement!=="function"||typeof provider?.startCheckout!=="function")throw new Error("专辑权限服务需要 getEntitlement 和 startCheckout。");accessProvider=provider;},
    version:"2.0"
  });
    function wrapText(ctx,text,x,y,width,lineHeight,maxLines=10) {
    const lines=[];let line="";
    for(const char of Array.from(String(text))){
      if(char==="\n"){lines.push(line);line="";continue;}
      if(line&&ctx.measureText(line+char).width>width){lines.push(line);line=char;}else line+=char;
    }
    if(line)lines.push(line);
    const shown=lines.slice(0,maxLines);
    if(lines.length>maxLines&&shown.length){let last=shown[shown.length-1];while(last&&ctx.measureText(last+"…").width>width)last=Array.from(last).slice(0,-1).join("");shown[shown.length-1]=last+"…";}
    shown.forEach((item,index)=>ctx.fillText(item,x,y+index*lineHeight));
    return y+shown.length*lineHeight;
  }
  function loadImage(src) {
    return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("作品图像未能载入。"));image.src=src;});
  }
  function fitImage(ctx,image,x,y,width,height) {
    const scale=Math.min(width/image.width,height/image.height),w=image.width*scale,h=image.height*scale;
    ctx.drawImage(image,x+(width-w)/2,y+(height-h)/2,w,h);
  }
  function canvasBase(width,height,label) {
    const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext("2d");if(!ctx)throw new Error("当前浏览器暂时无法生成图片。");
    ctx.fillStyle="#f4f0e8";ctx.fillRect(0,0,width,height);
    ctx.strokeStyle="#cbd0bf";ctx.lineWidth=2;ctx.strokeRect(45,45,width-90,height-90);
    ctx.fillStyle="#3e4c38";ctx.font='29px "Microsoft YaHei",sans-serif';ctx.fillText("生活侧写",88,110);
    ctx.fillStyle="#858b78";ctx.font='16px "Microsoft YaHei",sans-serif';ctx.fillText("EVERYDAY PORTRAITS",89,143);
    ctx.textAlign="right";ctx.font='19px "Microsoft YaHei",sans-serif';ctx.fillText(label,width-88,110);ctx.textAlign="left";
    ctx.strokeStyle="#cbd0bf";ctx.beginPath();ctx.moveTo(88,178);ctx.lineTo(width-88,178);ctx.stroke();
    return {canvas,ctx};
  }
  function canvasFooter(ctx,canvas) {
    const y=canvas.height-135;
    ctx.strokeStyle="#cbd0bf";ctx.beginPath();ctx.moveTo(88,y);ctx.lineTo(canvas.width-88,y);ctx.stroke();
    ctx.font='19px "Microsoft YaHei",sans-serif';ctx.fillStyle="#858b78";
    ctx.fillText("生活侧写 · 原创娱乐测评 · 结果仅供自我探索",90,y+44);
    ctx.font='15px "Microsoft YaHei",sans-serif';ctx.fillText("文化气质联想，不是能力评分或心理诊断。",90,y+75);
  }
  function canvasRadar(ctx,quiz,report,cx,cy,radius) {
    const model=registry.getModel(quiz.id),reference=model.prototypes.find(item=>item.id===report.primaryId);
    const point=(i,value,extra=0)=>{const angle=-Math.PI/2+i*Math.PI*2/quiz.axes.length,r=radius*value/100+extra;return [cx+Math.cos(angle)*r,cy+Math.sin(angle)*r];};
    const polygon=scores=>{ctx.beginPath();quiz.axes.forEach((axis,i)=>{const p=point(i,scores[axis.id]);if(i)ctx.lineTo(...p);else ctx.moveTo(...p);});ctx.closePath();};
    ctx.lineWidth=2;ctx.strokeStyle="#d1d6c5";
    [25,50,75,100].forEach(value=>{polygon(Object.fromEntries(quiz.axes.map(axis=>[axis.id,value])));ctx.stroke();});
    quiz.axes.forEach((axis,i)=>{
      const edge=point(i,100),label=point(i,100,43),cos=Math.cos(-Math.PI/2+i*Math.PI*2/quiz.axes.length);
      ctx.strokeStyle="#d1d6c5";ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(...edge);ctx.stroke();
      ctx.fillStyle="#495642";ctx.font='25px "Microsoft YaHei",sans-serif';ctx.textAlign=Math.abs(cos)<.01?"center":cos>0?"left":"right";ctx.fillText(axis.short+" "+Math.round(report.axes[axis.id]),label[0],label[1]+8);
    });
    ctx.textAlign="left";ctx.save();ctx.strokeStyle="#577369";ctx.lineWidth=3;ctx.setLineDash([11,8]);polygon(reference.scores);ctx.stroke();ctx.restore();
    ctx.strokeStyle="#a24e37";ctx.fillStyle="#a24e371e";ctx.lineWidth=4;polygon(report.axes);ctx.fill();ctx.stroke();
    quiz.axes.forEach((axis,i)=>{const dot=point(i,report.axes[axis.id]);ctx.beginPath();ctx.arc(dot[0],dot[1],6,0,Math.PI*2);ctx.fillStyle="#a24e37";ctx.fill();});
  }
  async function downloadCanvas(canvas,filename) {
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
    if(!blob)throw new Error("当前浏览器未能生成图片，可以截图保存。");
    const url=URL.createObjectURL(blob),anchor=el("a");anchor.href=url;anchor.download=filename;document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    notify("档案图片已生成，请查看浏览器下载。");
  }
  async function exportReport() {
    if(!activeQuiz||!activeReport)return;
    const quiz=activeQuiz,report=activeReport,main=outcome(quiz,report.primaryId),items=[main,...(report.secondaryId?[outcome(quiz,report.secondaryId)]:[])];
    const collection=registry.getCollection(quiz.collectionId),name=store.state.nickname.trim();
    const button=$("save-report");button.disabled=true;$("save-report-label").textContent="正在生成档案…";
    try {
      if(document.fonts?.ready)await document.fonts.ready;
      const image=main.image?await loadImage(main.image.src):null;
      const height=1960+(items.length===2?150:0)+(image?400:0),{canvas,ctx}=canvasBase(1200,height,collection.label+" · "+quiz.shortTitle);
      let y=245;ctx.fillStyle="#a24e37";ctx.font='22px "Microsoft YaHei",sans-serif';ctx.fillText(name?name+"的"+(quiz.ui?.resultNoun||"生活侧写"):(quiz.ui?.resultNoun||"生活侧写"),88,y);
      y+=88;
      items.forEach((item,index)=>{if(index){ctx.fillStyle="#a24e37";ctx.font='34px Georgia,serif';ctx.fillText("×",92,y-22);y+=56;}ctx.fillStyle="#2e3a29";ctx.font='64px "Songti SC","SimSun",serif';y=wrapText(ctx,item.name,88,y,1020,78,2);});
      ctx.fillStyle="#6a785f";ctx.font='26px "Microsoft YaHei",sans-serif';y=wrapText(ctx,items.map(item=>item.style).join(" / "),90,y+5,1010,38,2);
      ctx.fillStyle="#56634c";ctx.font='26px "Songti SC","SimSun",serif';y=wrapText(ctx,"“"+(main.quote||main.title)+"”",90,y+23,1010,38,2);
      if(image){fitImage(ctx,image,110,y+10,980,330);y+=365;ctx.fillStyle="#858b78";ctx.font='17px "Microsoft YaHei",sans-serif';y=wrapText(ctx,main.image.credit,100,y,1000,25,2);}
      const cy=y+265;canvasRadar(ctx,quiz,report,600,cy,193);
      ctx.strokeStyle="#a24e37";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(285,cy+285);ctx.lineTo(327,cy+285);ctx.stroke();ctx.fillStyle="#6b775e";ctx.font='20px "Microsoft YaHei",sans-serif';ctx.fillText("你的作答",343,cy+292);
      ctx.save();ctx.setLineDash([10,7]);ctx.strokeStyle="#577369";ctx.beginPath();ctx.moveTo(620,cy+285);ctx.lineTo(662,cy+285);ctx.stroke();ctx.restore();ctx.fillText("作品气质参考",677,cy+292);
      let nextY=cy+355;const insights=profileInsights(registry.getModel(quiz.id),report);
      ctx.fillStyle="#a24e37";ctx.font='22px "Microsoft YaHei",sans-serif';ctx.fillText("你这次选出的自己",90,nextY);nextY+=42;
      ctx.fillStyle="#58664c";ctx.font='24px "Microsoft YaHei",sans-serif';
      for(const text of insights.tendencies)nextY=wrapText(ctx,text,90,nextY,1000,37,3)+12;
      if(insights.differences.length){ctx.fillStyle="#748068";ctx.font='21px "Microsoft YaHei",sans-serif';nextY=wrapText(ctx,"和参考相比："+insights.differences[0].text,90,nextY,1000,33,2)+12;}
      nextY+=28;ctx.fillStyle="#a24e37";ctx.font='22px "Microsoft YaHei",sans-serif';ctx.fillText(quiz.ui?.nextHeading||"给日常留一小步",90,nextY);
      ctx.fillStyle="#58664c";ctx.font='25px "Microsoft YaHei",sans-serif';wrapText(ctx,main.nextStep||"",90,nextY+46,1000,39,2);
      canvasFooter(ctx,canvas);
      await downloadCanvas(canvas,"生活侧写-"+quiz.shortTitle+"-"+main.name.replace(/[《》]/g,"")+".png");
    }catch(error){notify(error.message||"图片生成遇到问题，可以截图保存。");}
    finally{button.disabled=false;$("save-report-label").textContent="保存这份侧写";}
  }
  function drawArchiveMotif(ctx,quiz,x,y,width,height,image) {
    ctx.fillStyle=quiz.kind==="film"?"#dce3d4":quiz.kind==="literature"?"#e6ddc8":"#d7e2d7";ctx.fillRect(x,y,width,height);
    if(image){fitImage(ctx,image,x+10,y+10,width-20,height-20);return;}
    ctx.strokeStyle=quiz.kind==="literature"?"#928267":"#6b7f62";ctx.lineWidth=9;
    ctx.strokeRect(x+35,y+35,width-70,height-70);
    ctx.fillStyle=quiz.kind==="literature"?"#c0af8d":"#bcc6a6";ctx.fillRect(x+40,y+40,width-80,height-80);
    ctx.fillStyle=quiz.kind==="literature"?"#928267":"#6b7f62";ctx.fillRect(x+width/2-3,y+39,6,height-78);
  }
  async function exportArchive() {
    const collection=registry.getCollection(archiveCollectionId),quizzes=registry.listQuizzes(collection.id),completed=quizzes.filter(quiz=>store.progress(quiz.id).complete).length;
    if(!completed)return;
    const button=$("save-archive"),oldText=button.textContent;button.disabled=true;button.textContent="正在收好这份总档案…";
    try {
      if(document.fonts?.ready)await document.fonts.ready;
      const rows=await Promise.all(quizzes.map(async quiz=>{
        const progress=store.progress(quiz.id),report=progress.complete?registry.score(quiz.id,store.attempt(quiz.id).answers):null;
        const main=report?outcome(quiz,report.primaryId):null;
        const image=main?.image?await loadImage(main.image.src):null;
        return {quiz,progress,report,main,image};
      }));
      const {canvas,ctx}=canvasBase(1200,520+quizzes.length*350,collection.label+" · "+collection.title);
      const archiveName=store.state.nickname.trim();
      const archiveTitle=(archiveName?archiveName+"的":"我的")+"侧写档案";
      let titleSize=52;ctx.fillStyle="#2d3a28";ctx.font=titleSize+'px "Songti SC","SimSun",serif';
      while(ctx.measureText(archiveTitle).width>1024&&titleSize>30){titleSize-=2;ctx.font=titleSize+'px "Songti SC","SimSun",serif';}
      ctx.fillText(archiveTitle,88,270);
      ctx.fillStyle="#748068";ctx.font='23px "Microsoft YaHei",sans-serif';ctx.fillText(completed+" / "+quizzes.length+" 份侧写已收好 · 每一页都可以慢慢来",90,319);
      rows.forEach(({quiz,progress,report,main,image},index)=>{
        const top=370+index*350;
        drawArchiveMotif(ctx,quiz,90,top+10,220,280,image);
        ctx.fillStyle="#a24e37";ctx.font='20px "Microsoft YaHei",sans-serif';ctx.fillText(quiz.shortTitle+" / "+(progress.complete?"已收录":progress.answered?"已答 "+progress.answered+" / "+progress.total:"还没开始"),350,top+35);
        const items=report?[main,...(report.secondaryId?[outcome(quiz,report.secondaryId)]:[])]:[];
        ctx.fillStyle="#33422b";ctx.font='44px "Songti SC","SimSun",serif';
        let y=wrapText(ctx,items.length?items.map(item=>item.name).join(" × "):"这一页，留一点期待。",350,top+102,740,60,3);
        ctx.fillStyle="#6f7d63";ctx.font='24px "Microsoft YaHei",sans-serif';
        wrapText(ctx,items.length?items.map(item=>item.style).join(" / "):quiz.subtitle,352,y+18,738,36,2);
        if(index<rows.length-1){ctx.strokeStyle="#d2d7c8";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(90,top+324);ctx.lineTo(1110,top+324);ctx.stroke();}
      });
      canvasFooter(ctx,canvas);
      await downloadCanvas(canvas,"生活侧写-"+collection.label+"-"+(store.state.nickname.trim()||"我的档案")+".png");
    }catch(error){notify(error.message||"总档案暂时未能生成，可以先保存各项结果。");}
    finally{button.disabled=false;button.textContent=oldText;}
  }
  $("save-report").addEventListener("click",exportReport);
  $("save-archive").addEventListener("click",exportArchive);

  renderRoute();
}
try { mountPortraitSuite(); }
catch(error){document.querySelectorAll("[data-view]").forEach(section=>section.hidden=true);const message=document.getElementById("fatal-error");message.textContent="侧写档案未能完整载入，请刷新或重新打开。";message.hidden=false;console.error("Portrait suite failed to start.",error);}
