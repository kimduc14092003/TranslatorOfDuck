# Cost, prefetch-waste and latency model behind docs/PLAN.md (sections 6.3, 6.4, 10).
# Every parameter is a planning assumption (gia dinh) unless noted; replace them with measured values.
# Run: python3 docs/cost_model.py  (standard library only, ~1 minute)
import random, statistics, math

# ---------------- 1) waste simulation under the FINAL prefetch policy ----------------
b_src, bw_dn, bw_up, b_a, ttfb = 0.6, 20, 5, 0.128, 0.15      # plan s6.2 network values
def t_enter_asr(x): return ttfb + x*b_src/bw_dn + x*b_a/bw_up  # download+upload of x s window
DUR = [(8,.15),(15,.25),(30,.25),(45,.15),(60,.12),(90,.08)]  # clip-length mix (tech review)
P_NOSPEECH = 0.15        # share of clips without speech (dance/music/scenery)
S_IN = 0.70              # speech share inside speech clips -> overall s ~ 0.6
def pick():
    x, acc = random.random(), 0
    for v, p in DUR:
        acc += p
        if x <= acc: return v
    return DUR[-1][0]
def dwell(T, qs, qp):
    r = random.random()
    if r < qs: return random.uniform(0.5, 3.0)
    if r < qs + qp: return random.uniform(3.0, max(3.5, 0.6*T))
    return T*random.uniform(1.0, 1.8)

def sim(qs, qp, WIN=20.0, LEAD=20.0, GATE=3.0, MINCH=10.0, FIRST=1.0, OVL=1.0,
        prefetch=True, whole=True, n=200000, seed=1):
    random.seed(seed)
    hist = [5.0]*10; ewma = 0.5
    proc = charged = charged_nomin = watched = 0.0
    calls = speech_min = 0.0
    for _ in range(n):
        T = pick(); d = dwell(T, qs, qp); watched += d
        speech = random.random() >= P_NOSPEECH
        if prefetch:
            w0 = min(T, max(6.0, min(15.0, 2*statistics.median(hist) + 4)))
        else:
            w0 = min(T, 8.0)                       # cold active item: 6-8 s
        if prefetch and whole and T <= 60 and ewma >= 0.6:
            p, cov, k = T, T, 1
        else:
            p, cov, k = w0, w0, 1
            while cov < T:
                t_req = max(GATE, cov - LEAD)
                if t_req >= d: break
                size = min(WIN, T - cov)
                if d <= t_req + t_enter_asr(size): break   # swiped before window reached ASR
                p += size + OVL; cov += size; k += 1
        proc += p
        if speech:
            calls += k; speech_min += p*S_IN/60
            if d >= FIRST:
                charged += max(MINCH, d); charged_nomin += d
        hist = hist[1:] + [d]
        ewma = 0.8*ewma + 0.2*min(1.0, d/T)
    return dict(w=proc/charged, w_nomin=proc/charged_nomin, w_watched=proc/watched,
                m=speech_min/calls, calls_per_speech_clip=calls/(n*(1-P_NOSPEECH)))

PROFILES = {"luot nhanh 45/35/20": (.45,.35), "pha tron 35/35/30": (.35,.35), "xem lau 20/30/50": (.20,.30)}
print("== w = giay xu ly / giay tinh phi (min 10 s/video) ==")
W = {}
for name,(qs,qp) in PROFILES.items():
    r20 = sim(qs,qp); r30 = sim(qs,qp,WIN=30.0); rtrial = sim(qs,qp,prefetch=False)
    W[name] = r20
    print(f"{name}: WIN20 w={r20['w']:.2f} (w_nomin={r20['w_nomin']:.2f}, w_watched={r20['w_watched']:.2f}, m={r20['m']:.3f})"
          f" | WIN30 w={r30['w']:.2f} m={r30['m']:.3f} | trial(no prefetch) w={rtrial['w']:.2f} m={rtrial['m']:.3f}")
# no-gate variant (remainder immediately) for comparison
r = sim(.45,.35,GATE=0.0); print(f"skip-heavy without 3s gate: w={r['w']:.2f}")
r = sim(.45,.35,MINCH=5.0); print(f"skip-heavy min charge 5 s: w={r['w']:.2f}")
r = sim(.35,.35,MINCH=5.0); print(f"mixed min charge 5 s: w={r['w']:.2f}")
M_TYP = W["pha tron 35/35/30"]["m"]
W_TYP = W["pha tron 35/35/30"]["w"]
print(f"chosen: w_typ={W_TYP:.2f}, m_typ={M_TYP:.3f}")

# ---------------- 2) unit cost ----------------
FX = 27000.0      # VND/USD cost side (VCB ban ra ~26.490 + phi the 2-3%)
ALPHA = 1.6       # processed(ky) <= ALPHA * quota
C_INFRA = 0.10
ASR = {"groq_turbo": 0.04/60, "soniox": 0.10/60, "alibaba_sg": 0.000035*60, "elevenlabs": 0.22/60}
LLM = {"g25fl": (0.10,0.40), "haiku55": (0.10,0.50), "g31fl": (0.25,1.50), "sonnet55": (2.0,10.0)}
STACKS = {"S1": ("groq_turbo","g25fl"), "S2": ("soniox","g25fl"), "S3": ("alibaba_sg","g25fl"),
          "S4": ("alibaba_sg","haiku55"), "S5": ("alibaba_sg","g31fl"), "S6": ("elevenlabs","sonnet55")}
def tok(P, m, r=300, cond=0.6, Pc=800):
    c = r/12.0
    I = P/m + r*1.0 + c*15 + cond*(Pc + 120)/m
    O = r*1.2*1.5 + c*8 + cond*75/m
    return I, O
def L(llm, I, O): pi, po = LLM[llm]; return (I*pi + O*po)/1e6
def u(st, s, P, m, r, cond, retry, v=1.0):
    a, l = STACKS[st]; I, O = tok(P, m, r, cond); return (v*ASR[a] + s*L(l, I, O))*(1+retry)
M_WORST = M_TYP/S_IN*1.0   # all audio speech
TYP = dict(s=0.6, P=2000, m=M_TYP, r=300, cond=0.6, retry=0.02)
OPT = dict(s=0.6, P=500,  m=M_TYP, r=300, cond=0.6, retry=0.02)   # + prompt caching, VAD v=0.66
WST = dict(s=1.0, P=2000, m=M_WORST, r=450, cond=0.8, retry=0.03)
I_t, O_t = tok(2000, M_TYP); I_o, O_o = tok(500, M_TYP); I_w, O_w = tok(2000, M_WORST, 450, 0.8)
print(f"tokens per speech-min: typ I={I_t:.0f} O={O_t:.0f} | opt I={I_o:.0f} | worst I={I_w:.0f} O={O_w:.0f} (m_worst={M_WORST:.3f})")
res = {}
for st in STACKS:
    ut = u(st, **TYP); uo = u(st, v=0.66, **OPT); uw = u(st, **WST)
    cm_t = W_TYP*ut; cm_o = W_TYP*uo
    res[st] = (ut, uo, uw, cm_t, cm_o)
    a, l = STACKS[st]
    users = [30*mm*cm_t + C_INFRA for mm in (15,60,180)]
    print(f"{st}: u_typ={ut:.5f} u_opt={uo:.5f} u_worst={uw:.5f} c_min typ={cm_t:.5f} opt={cm_o:.5f} "
          f"ASR share={ASR[a]/(ut/(1+TYP['retry'])):.0%} user/thang 15/60/180={[round(x,2) for x in users]}")

# ---------------- 3) plans ----------------
def margins(st, vnd, Q, infra=C_INFRA):
    ut, uo, uw, cm_t, cm_o = res[st]; R = vnd/FX
    typ = Q*cm_t + infra; worst = ALPHA*Q*uw + infra
    return 1-typ/R, 1-worst/R
def qmax(st, vnd, typ_m=0.40, worst_m=0.20, infra=C_INFRA):
    ut, uo, uw, cm_t, cm_o = res[st]; R = vnd/FX
    q1 = (R*(1-typ_m) - infra)/cm_t; q2 = (R*(1-worst_m) - infra)/(ALPHA*uw)
    return min(q1, q2), q1, q2
print("\n== Q_max (typ>=40% & worst>=20%) ==")
for vnd in (79000,149000,299000):
    print(vnd, {st: tuple(round(x) for x in qmax(st, vnd)) for st in ("S1","S2","S3","S4","S5")})
print("add-on 49k:", {st: tuple(round(x) for x in qmax(st, 49000, infra=0)) for st in ("S2","S3","S4")})
for quotas in ((300,600,1200),(350,700,1400),(300,650,1300)):
    print("\nquotas", quotas)
    for (vnd,Q) in zip((79000,149000,299000), quotas):
        print(f"  {vnd}/{Q}:", " ".join(f"{st} {margins(st,vnd,Q)[0]:.0%}/{margins(st,vnd,Q)[1]:.0%}" for st in ("S1","S2","S3","S4","S5")))
    for (vnd,Q) in ((49000,200),(49000,180)):
        print(f"  addon {vnd}/{Q}:", " ".join(f"{st} {margins(st,vnd,Q,0)[0]:.0%}/{margins(st,vnd,Q,0)[1]:.0%}" for st in ("S2","S3","S4","S5")))
# price needed to keep 450/900/1800 on S4 with typ>=40% & worst>=20%
for Q in (450,900,1800):
    ut, uo, uw, cm_t, cm_o = res["S4"]
    p1 = (Q*cm_t + C_INFRA)/(1-0.40)*FX; p2 = (ALPHA*Q*uw + C_INFRA)/(1-0.20)*FX
    print(f"S4 price for {Q} min: {max(p1,p2):.0f} VND (typ {p1:.0f}, worst {p2:.0f})")

# ---------------- 4) trial, break-even ----------------
rt = sim(.35,.35,prefetch=False)
ut4 = res["S4"][0]; cm_trial = rt['w']*u("S4", s=0.6, P=2000, m=rt['m'], r=300, cond=0.6, retry=0.02)
for mins in (60,120): print(f"trial {mins} min S4 cost ${mins*cm_trial:.2f}; worst ${ALPHA*mins*res['S4'][2]:.2f}")
for conv in (0.03,0.05,0.10): print(f"  conv {conv:.0%}: per payer (60 min) ${60*cm_trial/conv:.1f}")
for vnd, Q in ((149000,700),(149000,650)):
    R = vnd/FX; cost = 0.7*Q*res["S4"][3] + C_INFRA; gp = R - cost
    print(f"GP/payer {vnd}/{Q} @70% use S4: R={R:.2f} cost={cost:.2f} GP={gp:.2f}")
    for fixed in (40.0, 440.0): print(f"   fixed ${fixed:.0f}/thang -> hoa von {math.ceil(fixed/gp)} nguoi tra tien")

# ---------------- 5) latency (cold first video), W0 = 8 s ----------------
W0, rtt = 8, 0.04
st = {"sw+offscreen (chua am)": 0.35, "L1": 0.01, "tai W0": ttfb + W0*b_src/bw_dn, "moov Range": 0.19,
      "remux": 0.10, "upload": W0*b_a/bw_up + rtt/2, "asr": 0.60, "aligner": 0.20, "seg": 0.02,
      "mt_first": 0.5 + 30/150, "push": 0.05}
for k_, v_ in st.items(): print(f"  {k_}: {v_:.2f}")
base = sum(v for k_,v in st.items() if k_ not in ("sw+offscreen (chua am)","moov Range"))
print(f"warm+faststart: {base:.2f} (no aligner {base-0.2:.2f}); cold not warmed + moov: {base+0.35+0.19:.2f}")
pre = st["upload"]+st["asr"]+st["aligner"]+st["seg"]+st["mt_first"]+st["push"]
print(f"pre-downloaded landing: {pre:.2f} (no aligner {pre-0.2:.2f})")
w0n1 = 12; mt = 0.5 + (w0n1*0.6/60*740)/150
pw0 = ttfb + w0n1*b_src/bw_dn + 0.1 + w0n1*b_a/bw_up + rtt/2 + 0.6 + 0.2 + 0.02 + mt + 0.05
print(f"P_W0 server for N1 (12 s): {pw0:.2f}")
for dn, up in ((20,5),(5,1),(3,0.5)):
    print(f"net {dn}/{up}: download {ttfb+W0*b_src/dn:.2f} upload AAC {W0*b_a/up+0.02:.2f} Opus24 {W0*0.024/up+0.02:.2f}")
for rz in (5,6,8): print(f"r_zh={rz}: shorten@17={max(0,1-17/(rz*3.5)):.0%} @20={max(0,1-20/(rz*3.5)):.0%}")
