"""Opponent-adjusted ridge Poisson fits; frozen protocol, later-season confirmation.

This is an independent research model. Never reads or writes FIFA26 ledgers.
"""
import os
os.environ.setdefault('OPENBLAS_NUM_THREADS','1')
os.environ.setdefault('OMP_NUM_THREADS','1')
import argparse
import datetime as dt
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import numpy as np

spec=importlib.util.spec_from_file_location('baseline',Path(__file__).with_name('external-score-benchmark.py'))
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
FAMILIES=['dc','nb0.1','nb0.25','pace0.25']


def fit(rows, cutoff, ridge):
    if any(r['day']>cutoff-2 for r in rows):
        raise ValueError('Training outcome inside observation embargo')
    teams=sorted({r[t] for r in rows for t in ['home','away']});index={t:i for i,t in enumerate(teams)}
    n=len(rows);d=2+2*len(teams)
    X=np.zeros((2*n,d));y=np.zeros(2*n);weights=np.zeros(2*n)
    for k,r in enumerate(rows):
        for side in [0,1]:
            j=2*k+side;team=r['home' if side==0 else 'away'];opp=r['away' if side==0 else 'home']
            X[j,0]=1;X[j,1]=int(side==0);X[j,2+index[team]]=1;X[j,2+len(teams)+index[opp]]=1
            y[j]=r['hs' if side==0 else 'as_'];weights[j]=2**(-(cutoff-r['day'])/365)
    beta=np.zeros(d);beta[0]=math.log(1.25);penalty=np.array([1e-6,1e-6]+[ridge]*(d-2))
    def objective(b):
        eta=X@b
        if np.max(eta)>20:return float('inf')
        return float(np.sum(weights*(np.exp(eta)-y*eta))+.5*np.sum(penalty*b*b))
    for iteration in range(60):
        eta=X@beta;mu=np.exp(eta)
        grad=X.T@(weights*(mu-y))+penalty*beta
        hess=X.T@((weights*mu)[:,None]*X)+np.diag(penalty)
        step=np.linalg.solve(hess,grad);scale=1.;old=objective(beta)
        while scale>1e-8 and objective(beta-scale*step)>old:
            scale*=.5
        beta-=scale*step
        if np.max(np.abs(grad))<1e-5 or np.max(np.abs(scale*step))<1e-8:
            return {'index':index,'beta':beta,'iterations':iteration+1,'trainN':n,'cutoff':cutoff}
    raise RuntimeError('Poisson optimization failed to converge')


def predict(model, home, away):
    idx=model['index'];b=model['beta'];n=len(idx)
    def rate(t,o,h):
        attack=b[2+idx[t]] if t in idx else 0
        defense=b[2+n+idx[o]] if o in idx else 0
        return max(.15,min(5.,math.exp(b[0]+h*b[1]+attack+defense)))
    return rate(home,away,1),rate(away,home,0)


def marginal(lam, alpha=0):
    if alpha==0:
        p=[math.exp(-lam)]
        for k in range(1,16):p.append(p[-1]*lam/k)
    else:
        size=1/alpha;success=size/(size+lam);p=[success**size]
        for k in range(1,16):p.append(p[-1]*(k-1+size)/k*(1-success))
    return np.array(p)


def cells(lh,la,family):
    if family=='dc':
        mat=np.outer(marginal(lh),marginal(la));r=-.05
        mat[0,0]*=1-lh*la*r;mat[0,1]*=1+lh*r;mat[1,0]*=1+la*r;mat[1,1]*=1-r
    elif family.startswith('nb'):
        alpha=float(family[2:]);mat=np.outer(marginal(lh,alpha),marginal(la,alpha))
    elif family=='pace0.25':
        mat=sum(.5*np.outer(marginal(lh*s),marginal(la*s)) for s in [.75,1.25])
    else:raise ValueError('Unknown family')
    return mat/mat.sum()


def metrics(row,mat):
    ranking=np.argsort(-mat.ravel(),kind='stable');actual=row['hs']*16+row['as_']
    in_grid=row['hs']<16 and row['as_']<16
    rank=int(np.where(ranking==actual)[0][0]) if in_grid else 999
    return {'loss':-math.log(max(1e-15,float(mat[row['hs'],row['as_']]) if in_grid else 0)),
            'top1':int(rank<1),'top3':int(rank<3),'top5':int(rank<5)}


def run(root):
    base.SEASONS=['2020-21','2021-22','2022-23','2023-24','2024-25','2025-26']
    rows,manifest=base.load(root)
    start=dt.date(2022,7,1).toordinal();enddev=dt.date(2025,6,28).toordinal();test=dt.date(2025,7,1).toordinal()
    predictions={};fits=[]
    # All candidate forecasts depend only on past match results, regardless of
    # whether a row is later assigned to development or confirmation.
    for ridge in [2,10,30]:
        cache={};records=[]
        for row in rows:
            if row['day']<start:continue
            period=(row['day']//28)*28;key=(row['league'],period)
            if key not in cache:
                history=[r for r in rows if r['league']==row['league'] and r['day']<=period-2]
                model=fit(history,period,ridge);cache[key]=model
                fits.append({'ridge':ridge,'league':row['league'],'cutoff':period,'trainN':len(history),'iterations':model['iterations']})
            lh,la=predict(cache[key],row['home'],row['away'])
            records.append({'row':row,'lh':lh,'la':la,'metrics':{f:metrics(row,cells(lh,la,f)) for f in FAMILIES}})
        predictions[ridge]=records
    development=[]
    for ridge,records in predictions.items():
        for family in FAMILIES:
            subset=[r['metrics'][family] for r in records if r['row']['day']<=enddev]
            development.append({'ridge':ridge,'family':family,'development':base.summary(subset)})
    selected={'logLoss':min(development,key=lambda x:x['development']['loss']),
              'top1':min(development,key=lambda x:(-x['development']['top1'],x['development']['loss']))}
    prior={ (r['league'],r['day'],r['home'],r['away']):base.measure(r,lh,la,-.05)
           for r,lh,la,_,_ in base.forecasts(rows,365,5) if r['day']>=test }
    confirmation={};saved=[]
    for objective,choice in selected.items():
        paired=[]
        for record in predictions[choice['ridge']]:
            row=record['row']
            if row['day']<test:continue
            key=(row['league'],row['day'],row['home'],row['away'])
            paired.append({**row,'baseline':prior[key],'candidate':record['metrics'][choice['family']]})
            saved.append({'selection':objective,**row,'lh':record['lh'],'la':record['la'],'family':choice['family'],'metrics':record['metrics'][choice['family']]})
        def compare(sub):
            return {'baseline':base.summary([r['baseline'] for r in sub]),'candidate':base.summary([r['candidate'] for r in sub]),'weeklyPaired95':base.paired_ci(sub)}
        confirmation[objective]={'all':compare(paired),'byLeague':{l:compare([r for r in paired if r['league']==l]) for l in base.LEAGUES}}
    return {'protocol':json.loads(Path(__file__).resolve().parents[1].joinpath('research-results/distribution-study-protocol.json').read_text(encoding='utf-8')),
            'sourceRevision':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
            'manifest':manifest,'totalRows':len(rows),'developmentGrid':development,'selectedBeforeConfirmation':selected,
            'confirmation':confirmation,'fits':fits,'predictions':saved,
            'interpretation':'Independent retrospective study; no comparison to live FIFA26, no automatic promotion. Confirmation is now inspected.'}


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('output',type=Path);a=p.parse_args()
    report=run(a.root);a.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:report[k] for k in ['totalRows','selectedBeforeConfirmation','confirmation']},indent=2))
