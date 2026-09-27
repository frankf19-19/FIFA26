"""自動調參 v1 —— 每週在帳本上重新驗證模型的四個核心參數,只有在嚴格閘門全過時才更新 tune.json。
   參數:half(衰減半衰期,天)、xgw(xG 權重)、shr(向聯賽均值收縮)、xik(先發陣容係數)
   閘門(全部要過才寫入):
     1. 保留區間(最近 120 天)Brier 比現行改善 ≥ 0.0015
     2. 切 5 段各自評,新參數在 ≥ 4 段勝出
     3. bootstrap 200 次重抽,改善機率 ≥ 85%
   任何一關沒過 → 維持現行,並把證據寫進 tune.json 的 log。"""
import json,math,collections,datetime,random,glob,sys
from math import exp,log,lgamma
det={}
for f in glob.glob('details-*.json'): det.update(json.load(open(f)))
m=json.load(open('matches.json'))
R=[(k,v) for k,v in m.items() if v.get('hs') is not None and k in det and det[k].get('ts') and det[k].get('pl')]
R.sort(key=lambda x:x[1]['d'])
def dt(s): return datetime.date.fromisoformat(s)
END=dt(R[-1][1]['d']); HOLD=END-datetime.timedelta(days=120)
SC=0.321; SOT=8; G,A=7,8; PRIOR=0.12; K=6
try: CUR=json.load(open('tune.json'))
except Exception: CUR={}
cur={'half':CUR.get('half',120),'xgw':CUR.get('xgw',0.7),'shr':CUR.get('shr',0.75),'xik':CUR.get('xik',0.30),'hk':CUR.get('hk',1.5)}   # v3:主場加碼也自動調
def pll(l,k): return -l+k*log(max(l,1e-9))-lgamma(k+1)
def build(half):
    hist=collections.defaultdict(list); lgh=collections.defaultdict(list); xib=collections.defaultdict(list)
    pw=collections.defaultdict(float); pv=collections.defaultdict(float)
    rows=[]
    for k,v in R:
        d=dt(v['d']); lg=v['lg']; kh=lg+'|'+str(v['hid']); ka=lg+'|'+str(v['aid'])
        ts=det[k]['ts']; pl=det[k]['pl']; Hh,Ha,L=hist[kh],hist[ka],lgh[lg]
        def strength(side):
            vals=[(pv[p[0]]+PRIOR*K)/(pw[p[0]]+K) for p in pl[side] if p[1]==1]
            return sum(sorted(vals,reverse=True)[:11]) if len(vals)>=8 else None
        sh_,sa_=strength(0),strength(1)
        if len(Hh)>=8 and len(Ha)>=8 and len(L)>=40 and sh_ and sa_ and len(xib[kh])>=5 and len(xib[ka])>=5:
            wt=lambda x: math.exp(-math.log(2)*(d-x[0]).days/half)
            wl=[wt(x) for x in L]; sw=sum(wl)
            lgf=sum(w*(x[1]+x[2]) for w,x in zip(wl,L))/sw/2; lha=sum(w*(x[1]-x[2]) for w,x in zip(wl,L))/sw/2
            def agg(H,f):
                w=[wt(x) for x in H]; s=sum(w); return sum(a*f(x) for a,x in zip(w,H))/s
            def side_(H): return (agg(H,lambda x:x[1]),agg(H,lambda x:x[2]),agg(H,lambda x:x[3]),agg(H,lambda x:x[4]))
            bh=sum(xib[kh][-12:])/len(xib[kh][-12:]); ba=sum(xib[ka][-12:])/len(xib[ka][-12:])
            rows.append((v,side_(Hh),side_(Ha),lgf,lha, sh_/bh if bh>0 else 1, sa_/ba if ba>0 else 1, d))
        for side,key in ((0,kh),(1,ka)):
            s=strength(side)
            if s: xib[key].append(s)
            for p in pl[side]:
                if p[1]!=1 and not p[3]: continue
                pw[p[0]]+=1; pv[p[0]]+=((p[G] or 0)+0.7*(p[A] or 0))
        # v2:射正缺漏(雙 0)不能當 0(與 calib v31 同一修正)
        s0,s1=(ts[0][SOT] or 0),(ts[1][SOT] or 0)
        if s0+s1==0: s0,s1=v['hs']/SC,v['as']/SC
        hist[kh].append((d,v['hs'],v['as'],s0,s1))
        hist[ka].append((d,v['as'],v['hs'],s1,s0))
        lgh[lg].append((d,v['hs'],v['as']))
    return rows
def brier_rows(rows,xgw,shr,xik,hk=1.5):
    out=[]
    for v,(gfh,gah,sfh,sah),(gfa,gaa,sfa,saa),lgf,lha,rh,ra,d in rows:
        afh=(1-xgw)*gfh+xgw*sfh*SC; adh=(1-xgw)*gah+xgw*sah*SC
        afa=(1-xgw)*gfa+xgw*sfa*SC; ada=(1-xgw)*gaa+xgw*saa*SC
        HK=(hk+0.5) if str(v.get('lg','')).startswith('uefa') else hk   # v3:與前端 e214 相同的主場加碼
        lh=max(.15,lgf*exp(shr*(log(max(afh,.05)/lgf)+log(max(ada,.05)/lgf)))+lha*HK/2)
        la=max(.15,lgf*exp(shr*(log(max(afa,.05)/lgf)+log(max(adh,.05)/lgf)))-lha*HK/2)
        ap=lambda x: max(-.18,min(.18,xik*log(max(.4,min(1.8,x)))))
        lh=max(.12,lh*exp(ap(rh))); la=max(.12,la*exp(ap(ra)))
        H=D=Aa=0
        for i in range(8):
            for j in range(8):
                p=exp(pll(lh,i)+pll(la,j))
                if i>j:H+=p
                elif i==j:D+=p
                else:Aa+=p
        t=H+D+Aa;H/=t;D/=t;Aa/=t
        real='H' if v['hs']>v['as'] else ('A' if v['hs']<v['as'] else 'D');P={'H':H,'D':D,'A':Aa}
        out.append((d,sum((P[k2]-(1 if k2==real else 0))**2 for k2 in 'HDA')))
    return out
log_=[]; best=dict(cur); rows_cache={}
def rows_for(half):
    if half not in rows_cache: rows_cache[half]=build(half)
    return rows_cache[half]
def evaluate(params):
    rows=rows_for(params['half'])
    b=brier_rows(rows,params['xgw'],params['shr'],params['xik'],params.get('hk',1.5))
    hold=[x for x in b if x[0]>HOLD]; tune=[x for x in b if x[0]<=HOLD and x[0]>HOLD-datetime.timedelta(days=540)]
    return b,hold,tune
b_cur,hold_cur,tune_cur=evaluate(cur)
base_hold=sum(x[1] for x in hold_cur)/len(hold_cur)
log_.append(f"現行 {cur} 保留區間 Brier {base_hold:.4f}(n={len(hold_cur)})")
grid={'half':[90,120,150],'xgw':[0.6,0.7,0.8],'shr':[0.65,0.75,0.85],'xik':[0.2,0.3],'hk':[1.0,1.5,2.0]}
cands=[]
for h in grid['half']:
    for x in grid['xgw']:
        for s in grid['shr']:
            for k in grid['xik']:
              for hk in grid['hk']:
                p={'half':h,'xgw':x,'shr':s,'xik':k,'hk':hk}
                if p==cur: continue
                b,hold,tune=evaluate(p)
                cands.append((sum(x[1] for x in tune)/len(tune), sum(x[1] for x in hold)/len(hold), p))
cands.sort(key=lambda c:c[0])
top=cands[0]; log_.append(f"調參區間最佳 {top[2]} 調參 Brier {top[0]:.4f} 保留 {top[1]:.4f}")
gain=base_hold-top[1]
changed=False
if gain>=0.0015:
    seg_win=0
    b_new=evaluate(top[2])[0]
    allc=[x for x in b_cur if x[0]>HOLD-datetime.timedelta(days=540)]; alln=[x for x in b_new if x[0]>HOLD-datetime.timedelta(days=540)]
    n=min(len(allc),len(alln)); seg=n//5
    for i in range(5):
        a=allc[i*seg:(i+1)*seg] if i<4 else allc[4*seg:n]; bb=alln[i*seg:(i+1)*seg] if i<4 else alln[4*seg:n]
        if sum(x[1] for x in bb)/len(bb) < sum(x[1] for x in a)/len(a): seg_win+=1
    random.seed(3); wins=0
    pairs=list(zip([x[1] for x in allc],[x[1] for x in alln]))
    for _ in range(200):
        s=[random.choice(pairs) for _ in range(len(pairs))]
        if sum(x[1] for x in s)<sum(x[0] for x in s): wins+=1
    prob=wins/200
    log_.append(f"閘門:保留改善 {gain:.4f}(≥0.0015 ✓) 段勝 {seg_win}/5 bootstrap {prob:.0%}")
    if seg_win>=4 and prob>=0.85:
        best=top[2]; changed=True; log_.append("三關全過 → 更新參數")
    else: log_.append("未全過 → 維持現行")
else:
    log_.append(f"保留改善只有 {gain:.4f} < 0.0015 → 維持現行")

# ===== v4:比分挑選規則也自動調(目標 = 全中率,不是 Brier)=====
#   sw:主比分挑選的進球權重(機率 × (1+sw×總進球))   dm:大膽押和局門檻(和局格 ≥ dm × 看好方向最佳格;99 = 關閉)
#   閘門:保留區間全中率改善 ≥ 0.4 點、方向命中不得掉超過 0.3 點、時間 5 段至少 4 段不輸、bootstrap 改善機率 ≥ 85%
def lam_rows(rows,xgw,shr,xik,hk):
    out=[]
    for v,(gfh,gah,sfh,sah),(gfa,gaa,sfa,saa),lgf,lha,rh,ra,d in rows:
        afh=(1-xgw)*gfh+xgw*sfh*SC; adh=(1-xgw)*gah+xgw*sah*SC
        afa=(1-xgw)*gfa+xgw*sfa*SC; ada=(1-xgw)*gaa+xgw*saa*SC
        HK=(hk+0.5) if str(v.get('lg','')).startswith('uefa') else hk
        lh=max(.15,lgf*exp(shr*(log(max(afh,.05)/lgf)+log(max(ada,.05)/lgf)))+lha*HK/2)
        la=max(.15,lgf*exp(shr*(log(max(afa,.05)/lgf)+log(max(adh,.05)/lgf)))-lha*HK/2)
        ap=lambda x: max(-.18,min(.18,xik*log(max(.4,min(1.8,x)))))
        lh=max(.12,lh*exp(ap(rh))); la=max(.12,la*exp(ap(ra)))
        M={(i,j):exp(pll(lh,i)+pll(la,j)) for i in range(8) for j in range(8)}
        out.append((d,M,(min(v['hs'],7),min(v['as'],7))))
    return out
def _dir(i,j): return 'H' if i>j else ('D' if i==j else 'A')
def pick(M,sw,dm):
    H=sum(q for k,q in M.items() if k[0]>k[1]); D=sum(q for k,q in M.items() if k[0]==k[1]); A=sum(q for k,q in M.items() if k[0]<k[1])
    pk='H' if H>=D and H>=A else ('A' if A>=D and A>=H else 'D')
    W={k:q*(1+sw*(k[0]+k[1])) for k,q in M.items()}
    same=max([(k,q) for k,q in W.items() if _dir(*k)==pk],key=lambda x:x[1])
    if pk!='D':
        bd=max([(k,q) for k,q in W.items() if k[0]==k[1]],key=lambda x:x[1])
        if bd[1]>=dm*same[1]: return bd[0]
    return same[0]
try:
    L=lam_rows(rows_for(best['half']),best['xgw'],best['shr'],best['xik'],best.get('hk',1.5))
    HO=[x for x in L if x[0]>HOLD]
    sel_cur={'sw':CUR.get('sw',0.10),'dm':CUR.get('dm',1.3)}
    def sc(p,S): return [(1 if pick(M,p['sw'],p['dm'])==a else 0, 1 if _dir(*pick(M,p['sw'],p['dm']))==_dir(*a) else 0) for d,M,a in S]
    base=sc(sel_cur,HO); be=sum(x[0] for x in base)/len(base); bh=sum(x[1] for x in base)/len(base)
    cand=[]
    for sw in [0.0,0.05,0.10,0.15,0.20]:
        for dm in [1.2,1.3,1.4,99]:
            p={'sw':sw,'dm':dm}
            if p==sel_cur: continue
            r=sc(p,HO); cand.append((sum(x[0] for x in r)/len(r), sum(x[1] for x in r)/len(r), p, r))
    cand.sort(key=lambda c:-c[0]); ex,hh,pb,rb=cand[0]
    log_.append(f"比分規則:現行 {sel_cur} 全中 {be:.1%} 方向 {bh:.1%};最佳 {pb} 全中 {ex:.1%} 方向 {hh:.1%}")
    sel_best=dict(sel_cur); sel_changed=False
    if ex-be>=0.004 and bh-hh<=0.003:
        n=len(HO); seg=n//5; nl=0
        for i in range(5):
            a=base[i*seg:(i+1)*seg] if i<4 else base[4*seg:]; b=rb[i*seg:(i+1)*seg] if i<4 else rb[4*seg:]
            if sum(x[0] for x in b)>=sum(x[0] for x in a): nl+=1
        random.seed(5); w=0; pairs=list(zip(base,rb))
        for _ in range(300):
            S=[random.choice(pairs) for _ in range(n)]
            if sum(y[0] for x,y in S)>sum(x[0] for x,y in S): w+=1
        log_.append(f"比分規則閘門:全中 +{(ex-be)*100:.1f} 點、5 段不輸 {nl}/5、bootstrap {w/300:.0%}")
        if nl>=4 and w/300>=0.85: sel_best=pb; sel_changed=True; log_.append("比分規則三關全過 → 更新")
        else: log_.append("比分規則未全過 → 維持")
    else: log_.append("比分規則:改善不足或傷到方向命中 → 維持")
    best.update(sel_best); changed=changed or sel_changed
except Exception as e:
    log_.append("比分規則調參失敗:"+str(e)); best.setdefault('sw',CUR.get('sw',0.10)); best.setdefault('dm',CUR.get('dm',1.3))
out={**best,'updated':datetime.datetime.now(datetime.timezone.utc).isoformat()[:16]+'Z','changed':changed,'holdout_n':len(hold_cur),'brier_cur':round(base_hold,4),'brier_best':round(top[1],4),'log':log_,
     'history':(CUR.get('history') or [])[-11:]+[{'t':datetime.datetime.now(datetime.timezone.utc).isoformat()[:10],'changed':changed,'cur':round(base_hold,4),'best':round(top[1],4),'p':top[2]}]}
json.dump(out,open('tune.json','w'),ensure_ascii=False)
print("\n".join(log_)); print("→",{k:best.get(k) for k in ('half','xgw','shr','xik','hk','sw','dm')},"changed" if changed else "unchanged")
