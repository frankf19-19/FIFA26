"""自動調參 v1 —— 每週在帳本上重新驗證模型的四個核心參數,只有在嚴格閘門全過時才更新 tune.json。
   參數:half(衰減半衰期,天)、xgw(xG 權重)、shr(向聯賽均值收縮)、xik(先發陣容係數)
   閘門(全部要過才寫入):
     1. 保留區間(最近 120 天)Brier 比現行改善 ≥ 0.0015
     2. 切 5 段各自評,新參數在 ≥ 4 段勝出
     3. bootstrap 200 次重抽,改善機率 ≥ 85%
   任何一關沒過 → 維持現行,並把證據寫進 tune.json 的 log。"""
import json,math,collections,datetime,random,glob,sys
from temporal_selection import choose_on_training
from math import exp,log,lgamma
det={}
for f in glob.glob('details-*.json'): det.update(json.load(open(f)))
m=json.load(open('matches.json'))
R=[(k,v) for k,v in m.items() if v.get('hs') is not None and k in det and det[k].get('ts') and det[k].get('pl')]
R.sort(key=lambda x:x[1]['d'])
def dt(s): return datetime.date.fromisoformat(s)
END=dt(R[-1][1]['d']); HOLD=END-datetime.timedelta(days=120)
TRAIN_END=HOLD-datetime.timedelta(days=2)
SC=0.321; SOT=8; G,A=7,8; PRIOR=0.12; K=6
try: CUR=json.load(open('tune.json'))
except Exception: CUR={}
cur={'half':CUR.get('half',120),'xgw':CUR.get('xgw',0.7),'shr':CUR.get('shr',0.75),'xik':CUR.get('xik',0.30),'hk':CUR.get('hk',1.5)}   # v3:主場加碼也自動調
def pll(l,k): return -l+k*log(max(l,1e-9))-lgamma(k+1)
def build(half):
    hist=collections.defaultdict(list); lgh=collections.defaultdict(list); xib=collections.defaultdict(list)
    pw=collections.defaultdict(float); pv=collections.defaultdict(float)
    rows=[]
    def strength(pl,side):
        vals=[(pv[p[0]]+PRIOR*K)/(pw[p[0]]+K) for p in pl[side] if p[1]==1]
        return sum(sorted(vals,reverse=True)[:11]) if len(vals)>=8 else None
    def observe(k,v,d):
        ts=det[k]['ts']; pl=det[k]['pl']; lg=v['lg']; kh=lg+'|'+str(v['hid']); ka=lg+'|'+str(v['aid'])
        for side,key in ((0,kh),(1,ka)):
            s=strength(pl,side)
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
    pending=collections.deque()
    for k,v in R:
        d=dt(v['d'])
        while pending and pending[0][2]<=d-datetime.timedelta(days=2):
            observe(*pending.popleft())
        lg=v['lg']; kh=lg+'|'+str(v['hid']); ka=lg+'|'+str(v['aid'])
        ts=det[k]['ts']; pl=det[k]['pl']; Hh,Ha,L=hist[kh],hist[ka],lgh[lg]
        sh_,sa_=strength(pl,0),strength(pl,1)
        if len(Hh)>=8 and len(Ha)>=8 and len(L)>=40 and sh_ and sa_ and len(xib[kh])>=5 and len(xib[ka])>=5:
            wt=lambda x: math.exp(-math.log(2)*(d-x[0]).days/half)
            wl=[wt(x) for x in L]; sw=sum(wl)
            lgf=sum(w*(x[1]+x[2]) for w,x in zip(wl,L))/sw/2; lha=sum(w*(x[1]-x[2]) for w,x in zip(wl,L))/sw/2
            def agg(H,f):
                w=[wt(x) for x in H]; s=sum(w); return sum(a*f(x) for a,x in zip(w,H))/s
            def side_(H): return (agg(H,lambda x:x[1]),agg(H,lambda x:x[2]),agg(H,lambda x:x[3]),agg(H,lambda x:x[4]))
            bh=sum(xib[kh][-12:])/len(xib[kh][-12:]); ba=sum(xib[ka][-12:])/len(xib[ka][-12:])
            rows.append((v,side_(Hh),side_(Ha),lgf,lha, sh_/bh if bh>0 else 1, sa_/ba if ba>0 else 1, d))
        pending.append((k,v,d))
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
    hold=[x for x in b if x[0]>HOLD]; tune=[x for x in b if x[0]<=TRAIN_END and x[0]>HOLD-datetime.timedelta(days=540)]
    return b,hold,tune
b_cur,hold_cur,tune_cur=evaluate(cur)
base_hold=sum(x[1] for x in hold_cur)/len(hold_cur)
log_.append(f"現行 {cur} 保留區間 Brier {base_hold:.4f}(n={len(hold_cur)})")
# v5:格點外推 —— 上次選到的 half=150、shr=0.85 都在格點邊界,外推回測(3,751 場保留)Brier 持續改善、5 段全勝
grid={'half':[120,150,180,210],'xgw':[0.5,0.6,0.7],'shr':[0.85,0.95,1.05,1.15],'xik':[0.2,0.3],'hk':[1.0,1.5,2.0]}
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
    if changed: raise RuntimeError('本輪核心參數已通過保留測試；不在同一保留區再升級比分規則')
    L=lam_rows(rows_for(best['half']),best['xgw'],best['shr'],best['xik'],best.get('hk',1.5))
    HO=[x for x in L if x[0]>HOLD]
    TR=[x for x in L if HOLD-datetime.timedelta(days=540)<x[0]<=TRAIN_END]
    sel_cur={'sw':CUR.get('sw',0.10),'dm':CUR.get('dm',1.3)}
    def sc(p,S): return [(1 if pick(M,p['sw'],p['dm'])==a else 0, 1 if _dir(*pick(M,p['sw'],p['dm']))==_dir(*a) else 0) for d,M,a in S]
    base=sc(sel_cur,HO); be=sum(x[0] for x in base)/len(base); bh=sum(x[1] for x in base)/len(base)
    cand=[]
    for sw in [0.0,0.05,0.10,0.15,0.20]:
        for dm in [1.0,1.1,1.2,1.3,1.4,99]:   # v7:正確比分優先 → 加入 1.0/1.1
            p={'sw':sw,'dm':dm}
            if p==sel_cur: continue
            cand.append(p)
    pb=choose_on_training([sel_cur]+cand,TR,TRAIN_END,lambda p,S:[x[0] for x in sc(p,S)])
    rb=sc(pb,HO); ex=sum(x[0] for x in rb)/len(rb); hh=sum(x[1] for x in rb)/len(rb)
    log_.append(f"比分規則(候選僅由訓練區選出):現行 {sel_cur} 全中 {be:.1%} 方向 {bh:.1%};最佳 {pb} 全中 {ex:.1%} 方向 {hh:.1%}")
    sel_best=dict(sel_cur); sel_changed=False
    # v7:Frank 11/1 決定「正確比分優先」—— 不再因方向命中下降而擋下(仍記錄在 log)
    if ex-be>=0.004:
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
    else: log_.append("比分規則:全中改善不足 → 維持")
    best.update(sel_best); changed=changed or sel_changed
    # v6:Top-3 高比分門檻 t3h 也自動調(目標 = Top-3 命中率):預期總進球 ≥ t3h 時,第三格換成看好方向內 ≥4 球的最高格
    def top3(M,lam,sw,t3h):
        H=sum(q for k,q in M.items() if k[0]>k[1]); D=sum(q for k,q in M.items() if k[0]==k[1]); A=sum(q for k,q in M.items() if k[0]<k[1])
        pk='H' if H>=D and H>=A else ('A' if A>=D and A>=H else 'D')
        W={k:q*(1+sw*(k[0]+k[1])) for k,q in M.items()}
        same=sorted([k for k in W if _dir(*k)==pk],key=W.get,reverse=True)
        if pk=='D': return same[:3]
        bd=max([k for k in W if k[0]==k[1]],key=W.get); t=same[:2]+[bd]
        if lam>=t3h:
            hc=[k for k in same if sum(k)>=4 and k not in t[:2]]
            if hc: t=t[:2]+[hc[0]]
        return t
    LH=[(d,M,a,sum(k[0]*q for k,q in M.items())/sum(M.values())+sum(k[1]*q for k,q in M.items())/sum(M.values())) for d,M,a in HO]
    t3_cur=CUR.get('t3h',3.2)
    LH_T=[(d,M,a,sum(k[0]*q for k,q in M.items())/sum(M.values())+sum(k[1]*q for k,q in M.items())/sum(M.values())) for d,M,a in TR]
    def t3s(th,S): return [1 if a in top3(M,lam,sel_cur['sw'],th) else 0 for d,M,a,lam in S]
    b3=t3s(t3_cur,LH); bt=sum(b3)/len(b3); c3=[]
    for th in [2.8,3.0,3.2,3.4,3.6,99]:
        if th==t3_cur: continue
        c3.append(th)
    bth=choose_on_training([t3_cur]+c3,LH_T,TRAIN_END,lambda th,S:t3s(th,S))
    br=t3s(bth,LH); bx=sum(br)/len(br)
    log_.append(f"Top-3 高比分門檻(訓練選參、現行 sw):現行 {t3_cur} Top-3 {bt:.1%};最佳 {bth} {bx:.1%}")
    best['t3h']=t3_cur
    if not sel_changed and bx-bt>=0.004:
        n=len(LH); seg=n//5; nl=sum(1 for i in range(5) if sum(br[i*seg:(i+1)*seg] if i<4 else br[4*seg:])>=sum(b3[i*seg:(i+1)*seg] if i<4 else b3[4*seg:]))
        random.seed(6); w=0; pr=list(zip(b3,br))
        for _ in range(300):
            S=[random.choice(pr) for _ in range(n)]
            if sum(y for x,y in S)>sum(x for x,y in S): w+=1
        if nl>=4 and w/300>=0.85: best['t3h']=bth; changed=True; log_.append(f"Top-3 門檻三關全過(段 {nl}/5、bootstrap {w/300:.0%})→ 更新")
        else: log_.append(f"Top-3 門檻未全過(段 {nl}/5、bootstrap {w/300:.0%})→ 維持")
    else: log_.append("Top-3 門檻:改善不足 → 維持")
except Exception as e:
    log_.append("比分規則調參失敗:"+str(e)); best.setdefault('sw',CUR.get('sw',0.10)); best.setdefault('dm',CUR.get('dm',1.3)); best.setdefault('t3h',CUR.get('t3h',3.2))

# ===== v7:對手強度校正混合權重 adw(前端 e225 / calib v34)=====
#   每個聯賽用時間衰減 Poisson 同時解出各隊攻擊/防守(依對手強弱互相校正,250 天半衰期、先驗 3 場、只用賽前資料),
#   與核心 λ 以對數混合。候選 0 / 0.3 / 0.5,只用訓練區挑選,保留區過三關(Brier ≥0.0015、5 段 ≥4 勝、bootstrap ≥85%)才換。
try:
    import numpy as np
    def adj_map(xgw,HALF=250,PRI=3.0):
        by=collections.defaultdict(list)
        for k,v in sorted(m.items(),key=lambda x:x[1].get('d') or ''):
            if v.get('hs') is None or not v.get('d') or not v.get('lg'): continue
            s=v.get('sot'); ok=bool(s) and ((s[0] or 0)+(s[1] or 0))>0
            sh=(s[0] or 0) if ok else v['hs']/SC; sa=(s[1] or 0) if ok else v['as']/SC
            by[v['lg']].append((dt(v['d']),str(v['hid']),str(v['aid']),(1-xgw)*v['hs']+xgw*sh*SC,(1-xgw)*v['as']+xgw*sa*SC,id(v)))
        out={}
        for lg,Mx in by.items():
            teams=sorted({x[1] for x in Mx}|{x[2] for x in Mx}); ix={t:i for i,t in enumerate(teams)}; T=len(teams)
            D=np.array([(x[0]-Mx[0][0]).days for x in Mx]); H=np.array([ix[x[1]] for x in Mx]); Aw=np.array([ix[x[2]] for x in Mx])
            YH=np.array([x[3] for x in Mx]); YA=np.array([x[4] for x in Mx]); att=np.zeros(T); de=np.zeros(T); last=None; cur_=None
            for q,x in enumerate(Mx):
                d=D[q]
                if last!=d:
                    past=D<d
                    if past.sum()>=30:
                        w=np.exp(-math.log(2)*(d-D[past])/HALF); h=H[past]; a_=Aw[past]; yh=YH[past]; ya=YA[past]
                        mu=math.log((w*(yh+ya)).sum()/w.sum()/2); hm=math.log((w*yh).sum()/max(1e-9,(w*ya).sum()))/2
                        for it in range(25):
                            num=np.bincount(h,w*yh,T)+np.bincount(a_,w*ya,T); den=np.bincount(h,w*np.exp(mu+hm+de[a_]),T)+np.bincount(a_,w*np.exp(mu-hm+de[h]),T)
                            att=np.log((num+PRI)/(den+PRI))
                            num=np.bincount(a_,w*yh,T)+np.bincount(h,w*ya,T); den=np.bincount(a_,w*np.exp(mu+hm+att[h]),T)+np.bincount(h,w*np.exp(mu-hm+att[a_]),T)
                            de=np.log((num+PRI)/(den+PRI))
                        cur_=(mu,hm)
                    else: cur_=None
                    last=d
                if cur_ is not None:
                    i,j=ix[x[1]],ix[x[2]]; out[x[5]]=(cur_[0],cur_[1],float(att[i]+de[j]),float(att[j]+de[i]))
        return out
    AJ=adj_map(best['xgw'])
    def brier_adj(rows,p,adw):
        res=[]
        for v,(gfh,gah,sfh,sah),(gfa,gaa,sfa,saa),lgf,lha,rh,ra,d in rows:
            xgw,shr,xik,hk=p['xgw'],p['shr'],p['xik'],p.get('hk',1.5)
            afh=(1-xgw)*gfh+xgw*sfh*SC; adh=(1-xgw)*gah+xgw*sah*SC; afa=(1-xgw)*gfa+xgw*sfa*SC; ada=(1-xgw)*gaa+xgw*saa*SC
            HK=(hk+0.5) if str(v.get('lg','')).startswith('uefa') else hk
            lh=max(.15,lgf*exp(shr*(log(max(afh,.05)/lgf)+log(max(ada,.05)/lgf)))+lha*HK/2)
            la=max(.15,lgf*exp(shr*(log(max(afa,.05)/lgf)+log(max(adh,.05)/lgf)))-lha*HK/2)
            z=AJ.get(id(v))
            if z and adw>0:
                alh=exp(z[0]+z[1]*HK+1.15*z[2]); ala=exp(z[0]-z[1]*HK+1.15*z[3])
                if .05<alh<6 and .05<ala<6: lh=exp((1-adw)*log(lh)+adw*log(alh)); la=exp((1-adw)*log(la)+adw*log(ala))
            ap=lambda x: max(-.18,min(.18,xik*log(max(.4,min(1.8,x)))))
            lh=max(.12,lh*exp(ap(rh))); la=max(.12,la*exp(ap(ra)))
            Hh=Dd=Aa=0
            for i in range(8):
                for j in range(8):
                    q=exp(pll(lh,i)+pll(la,j))
                    if i>j: Hh+=q
                    elif i==j: Dd+=q
                    else: Aa+=q
            t=Hh+Dd+Aa; P={'H':Hh/t,'D':Dd/t,'A':Aa/t}
            real='H' if v['hs']>v['as'] else ('A' if v['hs']<v['as'] else 'D')
            res.append((d,sum((P[k2]-(1 if k2==real else 0))**2 for k2 in 'HDA')))
        return res
    RW=rows_for(best['half']); adw_cur=CUR.get('adw',0.3)
    def split(b): return [x for x in b if x[0]>HOLD],[x for x in b if HOLD-datetime.timedelta(days=540)<x[0]<=TRAIN_END]
    BR={w:brier_adj(RW,best,w) for w in sorted({0.0,0.3,0.5,adw_cur})}
    trm={w:sum(x[1] for x in split(b)[1])/max(1,len(split(b)[1])) for w,b in BR.items()}
    wb=min(trm,key=trm.get); hc=split(BR[adw_cur])[0]; hn=split(BR[wb])[0]
    g=sum(x[1] for x in hc)/len(hc)-sum(x[1] for x in hn)/len(hn)
    log_.append(f"對手校正權重 adw:現行 {adw_cur} 保留 Brier {sum(x[1] for x in hc)/len(hc):.4f};訓練區最佳 {wb} 保留 {sum(x[1] for x in hn)/len(hn):.4f}")
    best['adw']=adw_cur
    if wb!=adw_cur and g>=0.0015:
        n=len(hc); seg=n//5; sw_=sum(1 for i in range(5) if sum(x[1] for x in (hn[i*seg:(i+1)*seg] if i<4 else hn[4*seg:]))<sum(x[1] for x in (hc[i*seg:(i+1)*seg] if i<4 else hc[4*seg:])))
        random.seed(7); wn=0; pr=list(zip([x[1] for x in hc],[x[1] for x in hn]))
        for _ in range(200):
            S=[random.choice(pr) for _ in range(n)]
            if sum(y for x,y in S)<sum(x for x,y in S): wn+=1
        if sw_>=4 and wn/200>=0.85: best['adw']=wb; changed=True; log_.append(f"adw 三關全過(段 {sw_}/5、bootstrap {wn/200:.0%})→ 更新為 {wb}")
        else: log_.append(f"adw 未全過(段 {sw_}/5、bootstrap {wn/200:.0%})→ 維持")
    else: log_.append("adw:改善不足 → 維持")
except Exception as e:
    log_.append("adw 調參失敗:"+str(e)); best.setdefault('adw',CUR.get('adw',0.3))

# ===== v8:市場強弱混合權重 mkw(前端 e226)=====
#   用網站自己鎖定的實戰預測(cloud-pred.json):混合前 λ(lh0/la0,舊紀錄即 lh/la)+ 賽前賠率 + 賽果。
#   目標 = 主比分全中(同網站挑法:sw/dm)。候選 0~1;前 70% 時間挑選、後 30% 驗證:全中 +0.4 點、4 段不輸、bootstrap ≥85% 才換。
try:
    import numpy as np
    from math import factorial as _fac
    cp=json.load(open('cloud-pred.json')).get('sc',{})
    LG=[s for s in cp.values() if isinstance(s,dict) and s.get('pred') and s.get('hs') is not None and not s.get('void') and s.get('odds')
        and (s['pred'].get('lh0') or s['pred'].get('lh'))]
    LG.sort(key=lambda s:s.get('fzT') or s.get('t') or 0)
    Kc=9; facv=np.array([_fac(k) for k in range(Kc)],float); I_,J_=np.meshgrid(np.arange(Kc),np.arange(Kc),indexing='ij')
    def g_(lh,la,rho):
        g=np.outer(np.exp(-lh)*lh**np.arange(Kc)/facv,np.exp(-la)*la**np.arange(Kc)/facv)
        g[0,0]*=max(.01,1-lh*la*rho); g[0,1]*=max(.01,1+lh*rho); g[1,0]*=max(.01,1+la*rho); g[1,1]*=max(.01,1-rho); return g/g.sum()
    def mfit(T,o):
        ts=o['h']+o['d']+o['a']; tgt=(o['h']-o['a'])/ts; lo,hi=-T*.95,T*.95
        for _ in range(36):
            mid=(lo+hi)/2; g=g_((T+mid)/2,(T-mid)/2,0)
            if g[I_>J_].sum()-g[I_<J_].sum()<tgt: lo=mid
            else: hi=mid
        return max(.1,(T+mid)/2),max(.1,(T-mid)/2)
    swc,dmc=best.get('sw',0.10),best.get('dm',1.1)
    def pk(g):
        p=[g[I_>J_].sum(),g[I_==J_].sum(),g[I_<J_].sum()]; k=int(np.argmax(p)); W=g*(1+swc*(I_+J_)); M=[I_>J_,I_==J_,I_<J_][k]
        b=np.unravel_index(np.argmax(np.where(M,W,-1)),W.shape)
        if k!=1:
            bd=np.unravel_index(np.argmax(np.where(I_==J_,W,-1)),W.shape)
            if W[bd]>=dmc*W[b]: return bd
        return b
    PRE=[]
    for s in LG:
        P=s['pred']; lh=P.get('lh0') or P['lh']; la=P.get('la0') or P['la']; o=s['odds']
        if not (o.get('h') and o.get('d') and o.get('a')): continue
        PRE.append((lh,la,mfit(lh+la,o),P.get('rho') or 0,s['hs'],s['as']))
    def hits(w,S):
        out=[]
        for lh,la,(mh,ma),rho,h,a in S:
            bh=exp((1-w)*log(lh)+w*log(mh)); ba=exp((1-w)*log(la)+w*log(ma)); i,j=pk(g_(bh,ba,rho)); out.append(1 if (int(i)==h and int(j)==a) else 0)
        return out
    mk_cur=CUR.get('mkw',0.7); best['mkw']=mk_cur
    if len(PRE)>=300:
        cut=int(len(PRE)*0.7); TRn,HOn=PRE[:cut],PRE[cut:]
        cands=[0.0,0.3,0.5,0.7,0.9,1.0]
        trs={w:sum(hits(w,TRn))/len(TRn) for w in cands}; wb=max(trs,key=lambda w:(trs[w],-abs(w-mk_cur)))
        hc=hits(mk_cur,HOn); hn=hits(wb,HOn); ec=sum(hc)/len(hc); en=sum(hn)/len(hn)
        log_.append(f"市場權重 mkw(實戰 {len(PRE)} 場):現行 {mk_cur} 驗證全中 {ec:.1%};訓練最佳 {wb} 驗證 {en:.1%}")
        if wb!=mk_cur and en-ec>=0.004:
            n=len(hc); seg=n//4; nl=sum(1 for i in range(4) if sum(hn[i*seg:(i+1)*seg] if i<3 else hn[3*seg:])>=sum(hc[i*seg:(i+1)*seg] if i<3 else hc[3*seg:]))
            random.seed(8); wn=0; pr=list(zip(hc,hn))
            for _ in range(300):
                S=[random.choice(pr) for _ in range(n)]
                if sum(y for x,y in S)>sum(x for x,y in S): wn+=1
            if nl>=3 and wn/300>=0.85: best['mkw']=wb; changed=True; log_.append(f"mkw 過關(段 {nl}/4、bootstrap {wn/300:.0%})→ 更新為 {wb}")
            else: log_.append(f"mkw 未過關(段 {nl}/4、bootstrap {wn/300:.0%})→ 維持")
        else: log_.append("mkw:改善不足 → 維持")
    else: log_.append(f"mkw:實戰樣本 {len(PRE)} 場不足 300 → 維持")
except Exception as e:
    log_.append("mkw 調參失敗:"+str(e)); best.setdefault('mkw',CUR.get('mkw',0.7))

# ===== v9:市場總進球混合權重 mtw(前端 e227)=====
#   用實戰快照裡記錄的大小球盤(odds.ou=[線, 大球機率])+ 混合前 λ。目標 = 實際比分的對數損失(比分機率表準不準)。
#   e227 起才開始記錄盤口,累積滿 300 場才啟動;前 70% 挑選、後 30% 驗證:改善 ≥0.003、4 段 ≥3 勝、bootstrap ≥85% 才換。
try:
    OUR=[]
    for s in LG:
        o=s.get('odds') or {}; ou=o.get('ou'); P=s['pred']
        if not (ou and P.get('lh0') and P.get('la0') and o.get('h') and o.get('d') and o.get('a')): continue
        L=int(ou[0]); po=ou[1]; lo,hi=.3,7.
        for _ in range(40):
            mid=(lo+hi)/2; cdf=sum(exp(-mid)*mid**k/_fac(k) for k in range(L+1))
            if 1-cdf<po: lo=mid
            else: hi=mid
        OUR.append((P['lh0'],P['la0'],(lo+hi)/2,o,P.get('rho') or 0,min(s['hs'],Kc-1),min(s['as'],Kc-1)))
    mt_cur=CUR.get('mtw',0.7); best['mtw']=mt_cur; mkw_=best.get('mkw',0.7)
    def nll(w,S):
        out=[]
        for lh,la,Tm,o,rho,h,a in S:
            T0=lh+la; T1=exp((1-w)*log(T0)+w*log(Tm)); x,y=lh*T1/T0,la*T1/T0; mh,ma=mfit(T1,o)
            g=g_(exp((1-mkw_)*log(x)+mkw_*log(mh)),exp((1-mkw_)*log(y)+mkw_*log(ma)),rho); out.append(-log(max(1e-9,float(g[h,a]))))
        return out
    if len(OUR)>=300:
        cut=int(len(OUR)*0.7); A_,B_=OUR[:cut],OUR[cut:]
        trs={w:sum(nll(w,A_))/len(A_) for w in [0.0,0.3,0.5,0.7,1.0]}; wb=min(trs,key=trs.get)
        hc=nll(mt_cur,B_); hn=nll(wb,B_); gc=sum(hc)/len(hc)-sum(hn)/len(hn)
        log_.append(f"市場總進球權重 mtw(實戰 {len(OUR)} 場):現行 {mt_cur} 驗證對數損失 {sum(hc)/len(hc):.4f};訓練最佳 {wb} {sum(hn)/len(hn):.4f}")
        if wb!=mt_cur and gc>=0.003:
            n=len(hc); seg=n//4; nl=sum(1 for i in range(4) if sum(hn[i*seg:(i+1)*seg] if i<3 else hn[3*seg:])<sum(hc[i*seg:(i+1)*seg] if i<3 else hc[3*seg:]))
            random.seed(9); wn=0; pr=list(zip(hc,hn))
            for _ in range(300):
                S_=[random.choice(pr) for _ in range(n)]
                if sum(y for x,y in S_)<sum(x for x,y in S_): wn+=1
            if nl>=3 and wn/300>=0.85: best['mtw']=wb; changed=True; log_.append(f"mtw 過關(段 {nl}/4、bootstrap {wn/300:.0%})→ 更新為 {wb}")
            else: log_.append(f"mtw 未過關(段 {nl}/4、bootstrap {wn/300:.0%})→ 維持")
        else: log_.append("mtw:改善不足 → 維持")
    else: log_.append(f"mtw:有盤口紀錄的實戰樣本 {len(OUR)} 場,未滿 300 → 維持 {mt_cur}")
except Exception as e:
    log_.append("mtw 調參失敗:"+str(e)); best.setdefault('mtw',CUR.get('mtw',0.7))
out={**best,'updated':datetime.datetime.now(datetime.timezone.utc).isoformat()[:16]+'Z','changed':changed,'holdout_n':len(hold_cur),'brier_cur':round(base_hold,4),'brier_best':round(top[1],4),'log':log_,
     'history':(CUR.get('history') or [])[-11:]+[{'t':datetime.datetime.now(datetime.timezone.utc).isoformat()[:10],'changed':changed,'cur':round(base_hold,4),'best':round(top[1],4),'p':top[2]}]}
json.dump(out,open('tune.json','w'),ensure_ascii=False)
print("\n".join(log_)); print("→",{k:best.get(k) for k in ('half','xgw','shr','xik','hk','sw','dm','t3h','adw','mkw','mtw')},"changed" if changed else "unchanged")
