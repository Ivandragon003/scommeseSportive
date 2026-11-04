// Experimental only. Venue means already encode the home advantage; no extra multiplier.
const {PoissonXgModel}=require('../../dist/models/core/PoissonXgModel');
const SHRINK=8;
function fit(rows){const sums={};let sh=0,sa=0,goals=0,n=0;const add=(id,k,v)=>{sums[id]??={hf:0,ha:0,af:0,aa:0,hn:0,an:0};sums[id][k]+=v};
for(const r of rows){if(r.hx==null||r.ax==null||!Number.isFinite(Number(r.hx))||!Number.isFinite(Number(r.ax))||Number(r.hx)<0||Number(r.ax)<0)continue;const h=Number(r.hx),a=Number(r.ax);sh+=h;sa+=a;goals+=Number(r.hg)+Number(r.ag);n++;add(r.home,'hf',h);add(r.home,'ha',a);add(r.home,'hn',1);add(r.away,'af',a);add(r.away,'aa',h);add(r.away,'an',1)}
if(!n||!sh||!sa)return null;const mh=sh/n,ma=sa/n,scale=goals/(sh+sa);const rate=(value,count,prior)=>((value/prior)+SHRINK)/(count+SHRINK);const rates={};for(const [id,v] of Object.entries(sums)){rates[id]={homeAttack:rate(v.hf,v.hn,mh),homeConcede:rate(v.ha,v.hn,ma),awayAttack:rate(v.af,v.an,ma),awayConcede:rate(v.aa,v.an,mh)}};return {mh,ma,scale,rates}}
function probability(params,home,away){if(!params)return null;const h=params.rates[home]||{},a=params.rates[away]||{};const clamp=x=>Math.max(.15,Math.min(5,x));const lh=clamp(params.mh*(h.homeAttack??1)*(a.awayConcede??1)*params.scale),la=clamp(params.ma*(a.awayAttack??1)*(h.homeConcede??1)*params.scale);const p=new PoissonXgModel({leagueXG:1,homeAdv:1,levelScale:1,attackRate:{h:lh,a:la},defRate:{h:1,a:1}});return p.computeGoalProbabilities('h','a').over25}
module.exports={fit,probability,SHRINK};
