"""Offline rolling benchmark on a pinned CC0 openfootball checkout.

No website state, current ratings, odds or post-match features are used.
Date-only results enter training two calendar days later. This is a historical
simulation on a current archive, NOT proof of point-in-time source availability.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import random
import subprocess

LEAGUES = ['en.1', 'de.1', 'es.1', 'it.1', 'fr.1']
SEASONS = ['2020-21', '2021-22', '2022-23', '2023-24', '2024-25']
VALIDATE = dt.date(2022, 7, 1).toordinal()
TEST = dt.date(2024, 7, 1).toordinal()
GRID = [(h, p, r) for h in [120, 240, 365] for p in [5, 15, 30] for r in [0, -.05, -.1]]


def load(root):
    rows, manifest, seen = [], [], set()
    for season in SEASONS:
        for league in LEAGUES:
            path = root / season / (league + '.json')
            raw = path.read_bytes()
            manifest.append({'path': str(path.relative_to(root)), 'sha256': hashlib.sha256(raw).hexdigest()})
            matches=json.loads(raw)['matches']
            manifest[-1]['scheduled']=len(matches)
            manifest[-1]['missingFinal']=sum(not isinstance(m.get('score',{}).get('ft'),list) for m in matches)
            for m in matches:
                score = m.get('score', {}).get('ft')
                if not isinstance(score, list) or len(score) != 2:
                    continue
                if any(type(x) is not int or x < 0 for x in score):
                    raise ValueError('Invalid final score')
                day = dt.date.fromisoformat(m['date']).toordinal()
                key = (league, day, m['team1'], m['team2'])
                if key in seen:
                    raise ValueError('Duplicate fixture: ' + str(key))
                seen.add(key)
                rows.append(dict(league=league, day=day, home=m['team1'], away=m['team2'], hs=score[0], as_=score[1], season=season))
    return sorted(rows, key=lambda r: (r['day'], r['league'], r['home'])), manifest


def distribution(lh, la, rho):
    hp, ap = [math.exp(-lh)], [math.exp(-la)]
    for k in range(1, 16):
        hp.append(hp[-1] * lh / k)
        ap.append(ap[-1] * la / k)
    cells = []
    for i in range(16):
        for j in range(16):
            tau = 1 - lh*la*rho if (i,j)==(0,0) else 1+lh*rho if (i,j)==(0,1) else 1+la*rho if (i,j)==(1,0) else 1-rho if (i,j)==(1,1) else 1
            if tau <= 0:
                raise ValueError('Invalid Dixon-Coles probability')
            cells.append((hp[i]*ap[j]*tau, i, j))
    mass = sum(c[0] for c in cells)
    return sorted([(p/mass, i, j) for p,i,j in cells], key=lambda c: (-c[0],c[1],c[2]))


def measure(row, lh, la, rho):
    cells = distribution(lh, la, rho)
    actual = (row['hs'], row['as_'])
    prob = next((p for p,i,j in cells if (i,j)==actual), 0)
    rank = next((k for k,(_,i,j) in enumerate(cells) if (i,j)==actual), 999)
    return {'loss': -math.log(max(1e-15,prob)), 'top1': int(rank<1), 'top3': int(rank<3), 'top5': int(rank<5)}


def forecasts(rows, half_life, prior):
    """All observations used for a prediction have day <= prediction day - 2."""
    league, teams, queue, cursor = {}, {}, [], 0
    def decayed(table, key, day, width):
        if key not in table:
            table[key] = [day] + [0.] * width
        item = table[key]
        factor = 2 ** (-(day-item[0])/half_life)
        return [day] + [x*factor for x in item[1:]]
    for row in rows:
        day, lg = row['day'], row['league']
        while cursor < len(queue) and queue[cursor]['day'] <= day-2:
            old=queue[cursor];cursor+=1
            olg=old['league']; observed=old['day']+2
            z=decayed(league,olg,observed,3)
            z[1]+=old['hs'];z[2]+=old['as_'];z[3]+=1;league[olg]=z
            for name,gf,ga in [(old['home'],old['hs'],old['as_']),(old['away'],old['as_'],old['hs'])]:
                key=(olg,name);z=decayed(teams,key,observed,3)
                z[1]+=gf;z[2]+=ga;z[3]+=1;teams[key]=z
        z=decayed(league,lg,day,3)
        bh=(z[1]+20*1.45)/(z[3]+20);ba=(z[2]+20*1.15)/(z[3]+20);avg=(bh+ba)/2
        h=decayed(teams,(lg,row['home']),day,3);a=decayed(teams,(lg,row['away']),day,3)
        rate=lambda v,k:(v[k]+prior*avg)/(v[3]+prior)/avg
        lh=bh*(rate(h,1)*rate(a,2))**.75
        la=ba*(rate(a,1)*rate(h,2))**.75
        yield row, max(.15,min(5.,lh)), max(.15,min(5.,la)), bh, ba
        queue.append(row)


def summary(items):
    n=len(items)
    return {'n':n, **{k:sum(x[k] for x in items)/n if n else None for k in ['loss','top1','top3','top5']}}


def paired_ci(rows):
    # Resample whole calendar weeks, preserving within-week match dependence.
    blocks={}
    for r in rows:
        blocks.setdefault(r['day']//7,[]).append(r)
    keys=sorted(blocks);rng=random.Random(20261030);out=[]
    for _ in range(2000):
        sample=[r for k in rng.choices(keys,k=len(keys)) for r in blocks[k]]
        out.append((sum(r['candidate']['top1']-r['baseline']['top1'] for r in sample)/len(sample),
                    sum(r['candidate']['loss']-r['baseline']['loss'] for r in sample)/len(sample)))
    return {name:[sorted(x[i] for x in out)[49],sorted(x[i] for x in out)[1949]] for i,name in enumerate(['top1Delta95','lossDelta95'])}


def run(root):
    rows,manifest=load(root)
    validation=[]
    for half,prior in sorted(set((h,p) for h,p,_ in GRID)):
        totals={rho:[] for rho in [0,-.05,-.1]}
        for row,lh,la,_,_ in forecasts(rows,half,prior):
            if VALIDATE<=row['day']<TEST:
                for rho in totals: totals[rho].append(measure(row,lh,la,rho))
        for rho,items in totals.items():validation.append({'halfLife':half,'priorMatches':prior,'rho':rho,'validation':summary(items)})
    selected=min(validation,key=lambda x:x['validation']['loss'])
    records=[]
    for row,lh,la,bh,ba in forecasts(rows,selected['halfLife'],selected['priorMatches']):
        if row['day']>=TEST:
            records.append({**row,'lh':lh,'la':la,'rho':selected['rho'],
                            'baseline':measure(row,bh,ba,0),'candidate':measure(row,lh,la,selected['rho'])})
    def compare(sub):
        b=summary([x['baseline'] for x in sub]);c=summary([x['candidate'] for x in sub])
        return {'leagueOnlyPoisson':b,'teamShrinkageDC':c,'pairedWeeklyBootstrap':paired_ci(sub)}
    return {'source':'https://github.com/openfootball/football.json','sourceRevision':subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
            'license':'CC0-1.0','manifest':manifest,'method':'rolling date-blocked, 2-day result embargo; 2022-24 validation only; 2024-25 holdout',
            'limitations':['Current corrected archive, not original point-in-time vintages.','Independent simple models, not a replay or comparison of the FIFA26 production engine.','No xG, player or odds data in this experiment.','Archive is incomplete: missing final scores are excluded and counted by file in manifest.','Holdout is now inspected; future changes require a new confirmation period.'],
            'totalRows':len(rows),'selectedOnValidation':selected,'validationGrid':validation,
            'test':compare(records),'byLeague':{lg:compare([x for x in records if x['league']==lg]) for lg in LEAGUES},'predictions':records}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('data_root',type=Path);parser.add_argument('output',type=Path);args=parser.parse_args()
    report=run(args.data_root)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k in ['totalRows','selectedOnValidation','test','byLeague']},indent=2))
