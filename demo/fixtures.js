// Sample data for the live demo screens. Generic names, generated relative to
// the page load time; nothing here comes from a real deployment.
// Two tenants: "stable" (healthy, few issues, high volume) and "dev" (noisier,
// more issues, lower scores).
(function () {
const now = Date.now();
const iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const NAMES = ["gateway","web-frontend","auth-api","users-api","checkout-api","cart-api","payments-api","orders-api","catalog-api","search-api","inventory-api","pricing-api","shipping-api","billing-api","notifications","recommendations-api","reviews-api","media-api","profile-api","analytics-api","email-worker","report-worker","admin-api","settings-api"];
const CL = ["cluster-a","cluster-b"];
const sigTypes = ["resourcePressure","RequestErrorAnomaly","LogErrorAnomaly","podFailure"];
const RES = ["error rate back to baseline after rollback","memory pressure cleared after pod restart","p99 latency recovered once the cache warmed","connection pool exhaustion resolved by scaling","failing health check fixed by config revert"];
const isoWeek = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); const y0 = Date.UTC(t.getUTCFullYear(),0,1); return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0)/86400000+1)/7)).padStart(2,"0")}`; };
const wk = isoWeek(new Date(now));

const PROFILES = {
  stable: {
    bad: {"shipping-api":"2/3"},
    arms: {availability:0.995,errors:0.985,latency:0.99,saturation:1,traffic:0.96},
    open: [
      ["warning","shipping-api","shipping-api: request errors above baseline on POST /v2/labels",14,0,3],
      ["warning","orders-api","orders-api: p99 latency 410ms vs baseline 180ms over 5m",31,0,2],
    ],
    resolved: 5, weekly: [1,1,1,1,1,1,0,0], weeklyCrit: 0,
    noise: 8200, signal: 11400, issue: 142, unknown: 17400, snr: 99, coverage: 94, repeat: 6,
    mttd: 1.1*60000, mttr: 6*60000, resolution: 97, autoResolved: 96, precursorCov: 82, hits: 9, misses: 1, precision: 90,
    sig: {base:[6,160,70,90], jitter:[4,60,30,40]},
    precursors: [["catalog-api",.85],["search-api",.7]],
    llmTokens: 1380000, llmCalls: 540
  },
  dev: {
    bad: {"checkout-api":"2/3","search-api":"1/3","orders-api":"2/3","shipping-api":"2/3","reviews-api":"1/2","media-api":"2/3"},
    arms: {availability:0.96,errors:0.93,latency:0.94,saturation:0.97,traffic:0.91},
    open: [
      ["warning","checkout-api","checkout-api: correlated — request op-latency on GET /cart/items 4750.0ms (step); caller web-frontend: request anomaly 2 in 10m",0,0,2],
      ["critical","search-api","search-api: correlated — request latency 7125.0ms (step); caller gateway: request anomaly 5 in 10m",0,3,10],
      ["warning","orders-api","orders-api: correlated — log log-step 1 (step); request op-latency on GET /v3/orders/ 2305.0ms (step)",0,0,1],
      ["critical","users-api","latency: p99 677.5ms vs baseline 30.1ms over 60s; service served 58 requests in 60s window; sample: p99 678ms vs baseline 23ms (x29); slowest: GET /v1/users p99 746ms over 3 req",4,1,10],
      ["warning","shipping-api","shipping-api: request errors above baseline on POST /v2/labels",6,0,3],
      ["warning","media-api","media-api: memory above 90% for 10m",9,0,2],
    ],
    resolved: 22, weekly: [3,2,2,2,2,2,1,1], weeklyCrit: 2,
    noise: 14800, signal: 6900, issue: 388, unknown: 9100, snr: 90, coverage: 72, repeat: 29,
    mttd: 3.4*60000, mttr: 14*60000, resolution: 74, autoResolved: 78, precursorCov: 58, hits: 5, misses: 3, precision: 62,
    sig: {base:[26,520,300,330], jitter:[22,420,260,300]},
    precursors: [["web-frontend",1],["gateway",.95],["notifications",.9],["users-api",.9],["profile-api",.85],["recommendations-api",.8]],
    llmTokens: 2410000, llmCalls: 812
  }
};
const ORDER = ["dev","stable"], DEFAULT = "stable";

function build(T) {
  const P = PROFILES[T], ns = T;
  const apps = [], nodes = [];
  NAMES.forEach((n,i) => {
    const calledBy = i===0?[]:i<3?["gateway"]:i<8?["gateway","web-frontend"]:[NAMES[(i%6)+2],"gateway"];
    const calls = NAMES.filter((m,j)=>j>i && j<i+3 && j>2).slice(0,2);
    const down = P.bad[n], ready = !down;
    nodes.push({name:n,domain:"platform",tier:i<8?0:1,team:"Platform",description:n+" service.",application:n,appReady:ready,appStatus:ready?"Ready":"Degraded",
      perCluster:{[CL[0]]:{ready,cluster:CL[0],namespace:ns,components:down||"3/3",version:"v1.4.2"}},calls,calledBy,blastRadius:i<3?0.3+rnd()*0.2:rnd()*0.28});
    CL.slice(0,1).forEach(c => apps.push({cluster:c,namespace:ns,serviceName:n,application:n,ready,componentsReady:down||"3/3",version:"v1.4.2",
      components:[{kind:"Deployment",name:n,status:ready?"Ready":"Degraded"}],replicas:3,readyReplicas:ready?3:2,
      golden:{memPct:ready?48:91,p99Ms:ready?120:840,errPct:ready?0.2:5.1,reqPerSec:140}}));
  });
  for (let k=0;k<1;k++) apps.push({cluster:CL[0],namespace:ns,serviceName:"external-"+k,virtual:true,ready:true,componentsReady:"",components:[]});
  const edges=[]; nodes.forEach(n=>n.calls.forEach(t=>edges.push({source:n.name,target:t})));
  const graph = {tenant:T,noiseThreshold:0.1,incidentThreshold:0.25,nodes,edges};

  const history = Array.from({length:288},(_,i)=>{ const t = Math.floor(now/1000/300)*300-(287-i)*300; const b=P.sig.base,j=P.sig.jitter;
    return {t,reports:1,requests:900,resourcePressure:Math.round(b[0]+rnd()*j[0]),RequestErrorAnomaly:Math.round(b[1]+rnd()*j[1]),LogErrorAnomaly:Math.round(b[2]+rnd()*j[2]),podFailure:Math.round(b[3]+rnd()*j[3])}; });
  const sum = (k) => history.reduce((a,h)=>a+h[k],0);

  const mk = (id,sev,svc,text,ago,reopen,rel) => ({id,severity:sev,source:`app/${CL[0]}/${ns}/${svc}`,cluster:CL[0],namespace:ns,
    summary:text,tenant:T,firstSeen:iso(ago),lastSeen:iso(ago),status:"open",reopenCount:reopen,relatedEvents:Array.from({length:rel},(_,i)=>"ev-"+i),
    relatedEventDetails:Array.from({length:rel},(_,i)=>({id:"ev-"+i,source:"otlp",type:"RequestErrorAnomaly",severity:sev,message:"request anomaly",timestamp:iso(ago)})),relatedEventsTotal:rel});
  const base = T==="dev" ? 1041 : 2041;
  const issues = P.open.map((o,i)=>mk("ISS-"+(base+i),o[0],o[1],o[2],o[3],o[4],o[5]));
  for (let k=0;k<P.resolved;k++) { const svc = NAMES[3+k%9]; issues.push({...mk("ISS-"+(base-1-k),k%7===0&&T==="dev"?"critical":"warning",svc,svc+": "+RES[k%5],60*(5+k*(T==="dev"?3:7)),0,1),status:"resolved",resolution:{resolvedBy:"agent",resolvedAt:iso(60*(4+k*(T==="dev"?3:7))),rootCause:RES[k%5],fix:"applied automatically"}}); }

  const events = Array.from({length:60},(_,i)=>({id:T+"-ev-"+i,source:`app/${CL[0]}/${ns}/${NAMES[i%NAMES.length]}`,cluster:CL[0],namespace:ns,type:sigTypes[i%4],
    severity:T==="dev"?(i%7===0?"critical":i%3===0?"warning":"info"):(i%19===0?"warning":"info"),
    message:["Error rate above baseline","p99 latency above baseline","Pod restarted","Memory above 90%"][i%4],timestamp:iso(i*(T==="dev"?2:5)+1),service:NAMES[i%NAMES.length],tenant:T,
    classification:["signal","noise","issue","unknown"][i%4],raw:{cluster:CL[0],namespace:ns}}));

  const A = P.arms;
  const health = {tenant:T,score:Math.round(100*(A.availability+A.errors+A.latency+A.saturation)/4),scored:24,dark:0,arms:A,
    worst:Object.keys(P.bad).slice(0,1).map(s=>({service:s,tier:0,score:70,arms:A,reasons:["not ready "+P.bad[s]]})),
    services:NAMES.map(n=>({service:n,tier:0,score:P.bad[n]?70:96,arms:A})),at:iso(0)};
  const analytics = {baselines:NAMES.slice(2,10).map((n,i)=>({tenant:T,cluster:CL[0],service:n,incidentCount:6,weeklyIssueCounts:{[wk]:P.weekly[i]},weeklySeverity:{[wk]:{critical:i===1||i===3?(P.weeklyCrit>0?1:0):0}}})),generatedAt:iso(0),
    precursorMatches:P.precursors.map(([service,confidence])=>({eventId:"e-"+service,service,tenant:T,cluster:CL[0],matchedSteps:3,totalSteps:3,confidence,liveSignalTypes:["RequestErrorAnomaly"],hasPattern:true,activeIssue:true,activeIncident:true}))};
  const openN = P.open.length;
  const stats = {
    events:{noise:P.noise,signal:P.signal,issue:P.issue,unknown:P.unknown,drift:0},
    issues:{opened:openN+P.resolved,reopened:2,resolved:P.resolved,openNow:openN},incidents:{opened:openN+P.resolved,reopened:2,resolved:P.resolved,openNow:openN},
    llmTokens:P.llmTokens,llmCalls:P.llmCalls,mttdMs:P.mttd,mttrMs:P.mttr,snrPct:P.snr,coveragePct:P.coverage,serviceCoveragePct:100,
    services:24,servicesReporting:24,servicesDark:0,resolutionRatePct:P.resolution,sampledIssues:openN+P.resolved,sampledIncidents:openN+P.resolved,eventsPerIssue:82,repeatRatePct:P.repeat,
    autoResolvedPct:P.autoResolved,precursorCoveragePct:P.precursorCov,predictionHits:P.hits,predictionMisses:P.misses,predictionPrecisionPct:P.precision,predictionAvgLeadMs:P.mttd,
    signalsByType:{LogErrorAnomaly:sum("LogErrorAnomaly"),RequestErrorAnomaly:sum("RequestErrorAnomaly"),podFailure:sum("podFailure"),resourcePressure:sum("resourcePressure")},
    signalsHistory:history,health:{...health,services:undefined}
  };
  return {apps,graph,issues,events,health,analytics,stats};
}
const D = {}; ORDER.forEach(t => { D[t] = build(t); });

const allEvents = [].concat(D.dev.events.slice(0,15), D.stable.events.slice(0,15));
const tenantStats = {}; ORDER.forEach(t => { tenantStats[t] = D[t].stats; });
const unix = (secAgo) => Math.floor(now / 1000) - secAgo;
const frame = (count, secAgo) => ({count, lastAt: iso(secAgo / 60)});
const sessions = [];
CL.forEach((cluster, ci) => ORDER.forEach((tenant) => sessions.push({
  cluster, tenant, agentVersion: "v3.2.29", connectedAt: iso(60 * (30 + ci * 7)),
  capabilities: ["red_metrics","log_metrics","use_metrics","topology"],
  frames: {red_metrics: frame(812, 20), log_metrics: frame(640, 25), use_metrics: frame(905, 15), app_delta: frame(1200, 8), snapshot: frame(6, 300), topology_snapshot: frame(3, 2400)},
  sensors: {
    otlp: [{lastSeen: unix(12 + ci * 5), families: [{family:"red",dataPoints:84200},{family:"log",dataPoints:21300},{family:"use",pods:48}]}],
    sensors: [1,2,3].map(n => ({node:"node-"+n,version:"v3.2.29",connected:true,lastSeen:unix(6+n),ackRttMicros:2400+n*600,heapBytes:(52+n*5)*1048576,goroutines:70+n*9,sendErrors:0,roles:[]}))
  }
})));
const status = {
  running:true,
  worldState:{lastUpdated:iso(0),summary:"",totalEvents:52000,activeIssues:D.dev.issues.concat(D.stable.issues).filter(i=>i.status==="open").length},
  config:{model:"gemini-2.5-pro",baseURL:"managed",guardrailEnabled:true,guardrailModel:"fast-guard-1",rcaModel:"reasoner-1",chatModel:"chat-1",decisionModel:"decide-1",embeddingModel:"embed-1",
    voiceEnabled:true,voiceModel:"voice-1",reflectionEnabled:true,eventRetentionMinutes:1440,a2aEnabled:true,a2aPort:8084,
    otelTracing:{enabled:true,endpoint:"otel-collector:4317",protocol:"grpc",samplePercent:10},
    llmCircuitBreaker:{enabled:true,failureThreshold:5,cooldownSeconds:30},eventStorage:{queueBufferSize:10000,recentEventsMax:500},
    remoteAgents:[{name:"ticketing"}],mcpServers:[{name:"docs"}]},
  serverVersion:{version:"v3.3.31"},
  llmStats:{calls:1352,agentCalls:312,promptTokens:3200000,completionTokens:490000,totalTokens:3690000,voiceSessions:14,voiceInputTokens:128000,voiceOutputTokens:92000},
  llmBudget:{limit:5000000,tokensToday:3690000,remaining:1310000,guardrailReserve:200000,byTenant:{dev:2410000,stable:1380000},tenantCaps:{}},
  limits:{cap:5000000,spent:3690000,tenants:{
    dev:{spent:2410000,cap:3000000,kinds:{agent:{cap:400000,spent:318000},rca:{cap:300000,spent:121000},reflection:{cap:250000,spent:164000},guardrail:{spent:96000},decision:{spent:58000}}},
    stable:{spent:1380000,cap:3000000,kinds:{agent:{cap:400000,spent:171000},rca:{cap:300000,spent:44000},reflection:{cap:250000,spent:93000},guardrail:{spent:61000},decision:{spent:30000}}}}},
  voiceQuota:{limit:250000,tokensToday:41000,usersToday:2,byTenant:{dev:12000,stable:29000},tenantCaps:{"*":125000}},
  notify:{name:"alerts",channels:[{name:"on-call",type:"chat",minSeverity:"critical"},{name:"team",type:"email",minSeverity:"warning"}]},
  classifierStats:{enabled:true,noise:23000,signal:18300,unknown:26700,embeddingCalls:68000},
  guardrailStats:{enabled:true,infraPassed:11271,noiseDropped:23000,k8sBypassed:1840},
  guardrailCacheStats:{enabled:true,hits:9400,misses:2100},
  semanticCacheStats:{enabled:true,hits:5200,misses:1900},
  ragStats:{enabled:true,collectionSize:620,retrievals:3300,hits:2750},
  queue:{total:52000,dedupAbsorbed:14800,quarantineTotal:120,quarantineDedupAbsorbed:40},
  clusterAgentStats:{enabled:true,activeSessions:CL.length,namespaceCount:ORDER.length,sessions:sessions},
  gossip:{self:"core-0",peers:["core-1","core-2"],eventsSent:128000,eventsReceived:127400,eventsInserted:41200,outboxDropped:0},
  reflexRules:{enabled:true,active:14,hits:3820},
  rsi:{enabled:true,mode:"autonomous",interval:"30m"},
  retention:{leader:true,sweeps:412},
  tenantStats:{tenants:tenantStats},
  events:{recent:allEvents}
};
ORDER.forEach(t => { const e = tenantStats[t]; e.mttdP90Ms = PROFILES[t].mttd * 2.2; e.llmPromptTokens = Math.round(e.llmTokens * 0.87); e.llmCompletionTokens = Math.round(e.llmTokens * 0.13); e.llmTokenRatio = 6.7;
  e.llmRatioToday = {completionTokens: 52000, ratio: 6.4}; e.llmRatio7d = {completionTokens: 310000, ratio: 6.9, calls: 4200}; });

// Memory built by the reflection loop: patterns, facts, recent changes and a
// mind map per tenant, plus two cells shared by every tenant.
const memItems = [];
const cell = (id, kind, title, content, tags, confidence, agoMin, links) => memItems.push({id, kind, title, subject: title, content, tags, confidence, status: "active", updatedAt: iso(agoMin), links: (links || []).map(l => ({toId: l[0], relation: l[1]}))});
ORDER.forEach(t => {
  const tag = "tenant/" + t, dev = t === "dev";
  cell("mental-map-status-" + t, "mindmap", t + " status", dev ? "Degraded: 6 not ready, repeat rate is 29%. Reliability is the short ring." : "Healthy: 1 not ready, nothing repeating. All four rings are closed.", [tag, "status"], 0.9, 3);
  cell("pat-" + t + "-1", "pattern", "checkout latency follows payments cache misses", "When the payments cache hit rate drops below 80%, checkout p99 rises within 10 minutes. Seen " + (dev ? 7 : 3) + " times.", [tag, "service/checkout-api", "service/payments-api"], dev ? 0.78 : 0.9, 40, [["fact-" + t + "-1", "explains"]]);
  cell("pat-" + t + "-2", "pattern", "search errors after catalog deploys", "A catalog-api rollout is followed by search-api request errors for 5 to 8 minutes while the index reloads.", [tag, "service/search-api", "service/catalog-api"], dev ? 0.72 : 0.85, 95, [["chg-" + t + "-1", "caused-by"]]);
  cell("pat-" + t + "-3", "pattern", "memory pressure precedes media-api restarts", "Memory above 90% for 10 minutes on media-api ends in an OOM restart about 80% of the time.", [tag, "service/media-api"], 0.8, 160);
  cell("fact-" + t + "-1", "fact", "payments-api depends on a shared cache", "payments-api reads card tokens from a shared cache; a cold cache doubles its latency.", [tag, "service/payments-api"], 0.92, 300, [["pat-" + t + "-1", "explains"]]);
  cell("fact-" + t + "-2", "fact", "gateway fans out to eight services", "Every request enters through gateway; an outage there is visible in all downstream services.", [tag, "service/gateway"], 0.95, 420);
  cell("fact-" + t + "-3", "fact", "auth-api tokens expire after 15 minutes", "Spikes of 401s every 15 minutes are token expiry, not an outage.", [tag, "service/auth-api"], 0.88, 520);
  cell("chg-" + t + "-1", "recent_change", "catalog-api v1.4.2 rolled out", "catalog-api moved to v1.4.2 on cluster-a; two replicas restarted.", [tag, "service/catalog-api"], 0.9, 70);
  cell("chg-" + t + "-2", "recent_change", "checkout-api memory limit raised", "Memory limit raised from 512Mi to 768Mi after repeated restarts.", [tag, "service/checkout-api"], 0.9, 210);
});
cell("shared-1", "fact", "business hours run 08:00 to 20:00 UTC", "Traffic doubles in business hours; baselines are computed per hour of day.", [], 0.95, 900);
cell("shared-2", "pattern", "Monday morning cold caches", "After weekend idle periods caches are cold for the first 20 minutes; latency alerts then are expected.", [], 0.85, 1300);
const memory = {total:memItems.length,totalsByKind:{fact:memItems.filter(i=>i.kind==="fact").length,pattern:memItems.filter(i=>i.kind==="pattern").length,recent_change:memItems.filter(i=>i.kind==="recent_change").length,mindmap:2},totalsByTenant:{dev:9,stable:9},items:memItems};
const memMetrics = {items:memItems.length,composition:{byKind:memory.totalsByKind,byStatus:{active:memItems.length},byTenant:{dev:9,stable:9},workingSet:12,hnsw:{memoryCellIndexSize:memItems.length,issueCollectionSize:52},mentalMaps:{dev:1,stable:1}}};

// Hourly LLM usage ring for the usage panel: one row per (hour, tenant, kind, model).
const KINDS = [["agent","gemini-2.5-pro",.30,.55],["rca","gemini-2.5-pro",.12,.2],["reflection","gemini-3.5-flash",.14,.3],["guardrail","gemini-2.5-flash",.24,.9],["decision","gemini-2.5-flash",.12,.7],["chat","gemini-2.5-flash",.05,.4],["embedding","embed-local",.03,1]];
function usage(hours) {
  const HOUR = 3600000, end = Math.floor(now / HOUR) * HOUR, from = end - (hours - 1) * HOUR, buckets = [];
  let sd = 11; const r = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let h = 0; h < hours; h++) {
    const start = from + h * HOUR, hod = new Date(start).getUTCHours(), day = 0.55 + 0.45 * Math.sin((hod - 6) / 24 * Math.PI * 2 + 1.2) ** 2;
    ORDER.forEach(t => { const volume = (t === "dev" ? 120000 : 70000) * day * (0.8 + r() * 0.4);
      KINDS.forEach(([kind, model, share, inShare]) => { const tok = volume * share * (0.7 + r() * 0.6), input = Math.round(tok * inShare), output = Math.round(tok * (1 - inShare)) + 40;
        const calls = Math.max(1, Math.round(tok / (kind === "embedding" ? 400 : 3200)));
        buckets.push({start, tenant: t, kind, model, calls, errors: r() > 0.96 ? 1 : 0, inputTokens: input, outputTokens: output, cachedTokens: Math.round(input * 0.35), thinkingTokens: model === "gemini-2.5-pro" ? Math.round(output * 0.4) : 0, durationMs: calls * (kind === "embedding" ? 60 : 1400)}); }); });
  }
  return {from, to: now, buckets, daily: []};
}

// The messenger: one conversation per workspace, people and Tria writing to each other, as sample data.
var ME = {id:"@demo:triage", name:"Demo"};
var PEOPLE = {tria:{id:"@tria:triage",name:"Tria"}, maya:{id:"@maya:triage",name:"Maya"}, jon:{id:"@jon:triage",name:"Jon"}};
function chatMsg(id, minAgo, who, body, o) {
  var w = who === "me" ? ME : who === "spot-dev" ? {id:"@spot-dev:triage",name:"dev spot"} : PEOPLE[who];
  return Object.assign({id:id, ts:now - minAgo*60000, type:"text", sender:w.id, name:w.name, mine:who==="me", tria:who==="tria", body:body}, o || {});
}
var ROOM_MSGS = {
  "ws-stable": [
    chatMsg("s1", 52, "tria", "shipping-api: request errors above baseline on POST /v2/labels", {kind:"issue_opened", severity:"warning"}),
    chatMsg("s2", 49, "maya", "Looking. A deploy went out at 10:40."),
    chatMsg("s3", 47, "me", "@tria is this related to the deploy?"),
    chatMsg("s4", 46, "tria", "Probably. Errors on POST /v2/labels began 3 minutes after shipping-api 4.2.0 rolled out, and orders-api p99 rose in the same window. I would compare against 4.1.9 before rolling back."),
    chatMsg("s5", 40, "maya", "Rolling back to 4.1.9."),
    chatMsg("s6", 31, "tria", "orders-api: p99 latency 410ms vs baseline 180ms over 5m", {kind:"issue_opened", severity:"warning"}),
    chatMsg("s7", 14, "tria", "shipping-api: request errors are back to baseline after the rollback to 4.1.9. I will keep watching it for the next hour.")
  ],
  "ws-dev": [
    chatMsg("d1", 95, "tria", "users-api: latency p99 677.5ms vs baseline 30.1ms over 60s", {kind:"issue_opened", severity:"critical"}),
    chatMsg("d2", 90, "jon", "Seeing it too. Pool exhaustion?"),
    chatMsg("d3", 88, "spot-dev", "Checked users-api: the database pool is at 100% since 09:12 and p99 follows it. I raised the pool limit from 20 to 40 and will watch the next 10 minutes."),
    chatMsg("d4", 70, "spot-dev", "p99 is back to 41ms. I am keeping the new limit and noted it on the issue."),
    chatMsg("d5", 66, "jon", "Thanks. Leave the limit for now."),
    chatMsg("d6", 8, "tria", "search-api: correlated, request latency 7125.0ms (step); caller gateway: request anomaly 5 in 10m", {kind:"issue_opened", severity:"critical"}),
    chatMsg("d7", 6, "spot-dev", "On it. Looking at the search-indexer pods first.")
  ]
};
var ROOMS = [
  {id:"ws-stable", kind:"workspace", workspace:"stable", name:"stable", unread:0, spot:{name:"stable spot", state:"up"}},
  {id:"ws-dev", kind:"workspace", workspace:"dev", name:"dev", unread:2, spot:{name:"dev spot", state:"up"}}
].map(function (r) { r.last = ROOM_MSGS[r.id][ROOM_MSGS[r.id].length - 1]; return r; });
var TRIA_PAST = [
  {role:"user", text:"What is open on stable?"},
  {role:"model", text:"Two issues: shipping-api request errors on POST /v2/labels (warning, 14 min) and orders-api p99 latency 410ms vs 180ms (warning, 31 min)."}
];

function tenantOf(u, fallback) { var t = u.searchParams.get("tenant"); return D[t] ? t : fallback; }
var all = (k) => [].concat(...ORDER.map(t => D[t][k]));
function get(url) {
  var u = new URL(url, location.href), p = u.pathname, t = tenantOf(u, DEFAULT), d = D[t];
  switch (p) {
    case "/v2/version": return {version:"v3.3.31"};
    case "/v2/auth/me": return {username:"demo",grants:"*:rwxivo",role:"admin",roles:{}};
    case "/v2/agent/tenants": return {tenants:ORDER.slice(),default:DEFAULT,details:ORDER.map(k=>({id:k,events:PROFILES[k].noise+PROFILES[k].signal+PROFILES[k].issue+PROFILES[k].unknown,incidents:PROFILES[k].open.length,issues:PROFILES[k].open.length,coveragePct:PROFILES[k].coverage}))};
    case "/v2/agent/status": return status;
    case "/v2/agent/applications": return {applications: u.searchParams.get("tenant") ? d.apps : all("apps").slice(0, 25)};
    case "/v2/agent/graph": return d.graph;
    case "/v2/agent/analytics": return u.searchParams.get("tenant") ? d.analytics : {generatedAt:d.analytics.generatedAt,baselines:all("analytics").flatMap(a=>a.baselines),precursorMatches:all("analytics").flatMap(a=>a.precursorMatches)};
    case "/v2/agent/issues": case "/v2/agent/incidents": { var li = u.searchParams.get("tenant") ? d.issues : all("issues"); return {issues:li,incidents:li}; }
    case "/v2/agent/events/recent": return {events: u.searchParams.get("tenant") ? d.events : allEvents};
    case "/v2/usage": return usage(Math.max(1, parseInt(u.searchParams.get("hours") || "24", 10)));
    case "/v2/agent/awareness/memory": return {items: memItems};
    case "/v2/agents/pending": return {pending:[{cluster:"cluster-c",fingerprint:"9f2c:41ab:77d0:e318",tenants:["dev"],firstSeen:iso(18)}]};
    case "/v2/agents": return {agents:CL.map((c,i)=>({cluster:c,fingerprint:["3a7e:c1d9:0b52:88f4","51cd:e07a:92b6:14c3"][i],tenants:ORDER.slice(),approvedAt:iso(60*24*(20+i*9)),notAfter:iso(-60*24*300),approvedBy:"admin"}))};
    case "/v2/memory/summary": return memory;
    case "/v2/memory/metrics": return memMetrics;
    case "/v2/landing": return {version:"v3.3.31"};
    case "/v2/categories": return {categories:[]};
    case "/v2/auth/providers": return {providers:[]};
  }
  if (p === "/v2/messenger/rooms") return {me:ME.id, name:ME.name, tria:PEOPLE.tria.id, reactions:["ok","noted","working on it","fixed","blocked"], rooms:ROOMS};
  if (p === "/v2/messenger/me") return {id:ME.id, name:ME.name, avatar:""};
  if (p === "/v2/messenger/people") return {people:[PEOPLE.maya, PEOPLE.jon]};
  if (p === "/v2/messenger/tria/history") return {turns:[], next:""};
  var gm = p.match(/^\/v2\/agent\/issues\/([^/]+)\/graph$/);
  if (gm) {
    var gi = all("issues").find(function (i) { return i.id === decodeURIComponent(gm[1]); });
    if (!gi) return null;
    var gs = gi.source.split("/").pop();
    var node = function (layer, nodeType, message) { return {layer:layer, nodeType:nodeType, message:message, severity:gi.severity}; };
    return {service:gs, windowFrom:gi.firstSeen, windowTo:iso(0),
      nodes:[node("blast_radius","affected","gateway"), node("blast_radius","affected","web-frontend"), node("blast_radius","affected","orders-api"),
        node("app_status","status",gs+" ready 2/3"),
        node("causal_chain","root","deploy rolled out"), node("causal_chain","symptom","error rate above baseline"), node("causal_chain","symptom","p99 latency above baseline"), node("causal_chain","recovery","pods restarted")],
      historical:[{when:iso(60*24*9), summary:"similar episode, resolved by restart"}, {when:iso(60*24*21), summary:"similar episode, resolved by rollback"}],
      appStatus:gs+" deployment ready 2/3 resources: 3 pods, 1 restarting",
      blastGraph:"blast_radius_score: 0.42\nAffected downstream (3 services): gateway, web-frontend, orders-api",
      similarIssues:"### past issue 1\nsimilarity: 0.82\n### past issue 2\nsimilarity: 0.71"};
  }
  var mm = p.match(/^\/v2\/messenger\/rooms\/([^/]+)\/messages$/);
  if (mm) { var rid = decodeURIComponent(mm[1]); return ROOM_MSGS[rid] ? {me:ME.id, messages:ROOM_MSGS[rid], reactions:[], before:"", members:{}, avatars:{}, canWrite:true, receipts:{}, pinned:[]} : null; }
  var m = p.match(/^\/v2\/tenants\/([^/]+)\/(health|situation|ledger|goals)$/);
  if (m) { var tt = D[m[1]] ? m[1] : DEFAULT; return m[2]==="health" ? D[tt].health : m[2]==="goals" ? {tenant:tt} : m[2]==="situation" ? {tenant:tt,builtAt:iso(0),services:[]} : {rows:[]}; }
  return null;
}
const W = D[DEFAULT];
window.TriageDemo = { chatPast: TRIA_PAST, get: get, tenant: DEFAULT, status: status, issues: W.issues, health: W.health, arms: PROFILES[DEFAULT].arms, names: NAMES };
})();
