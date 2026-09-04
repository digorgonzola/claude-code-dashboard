import re, sys, json, glob, os

MARKETING = ["seamless","seamlessly","robust","powerful","cutting-edge","effortless","effortlessly",
    "world-class","next-generation","revolutionary","blazing","lightning-fast","elegant","delightful",
    "turnkey","best-in-class","state-of-the-art","game-changing","first-class","battle-tested",
    "enterprise-grade","supercharge","unlock","unleash","empower","empowers"]
BANNED = ["begin","begins","commence","commences","initiate","initiates","originate",
    "utilize","utilizes","utilizing","leverage","leverages","leveraging","facilitate","facilitates",
    "ensure","ensures","ensuring","prior to","subsequent to","obtain","obtains","acquire","acquires",
    "demonstrate","demonstrates","additionally","furthermore","moreover","comprehensive","comprehensively",
    "utilization","aforementioned","henceforth","therein","whilst","amongst","numerous","myriad","plethora",
    "in order to","a variety of","in the event that","due to the fact that","it is important to note"]
PHRASAL = ["spin up","spin down","reach out","dive into","dives into","diving into","kick off","kicks off",
    "roll out","rolls out","tear down","ramp up","circle back","drill down","spun up","reaching out"]
MODAL_HEDGE = ["it is important to note","it should be noted","it is worth noting","please note that",
    "as mentioned","as noted above"]
BE = r"(?:am|is|are|was|were|be|been|being)"
PP_IRREG = r"(?:done|made|sent|read|built|kept|held|set|put|run|written|shown|given|taken|found|got|gotten|seen|known|thrown|drawn)"

def strip_code(t):
    t = re.sub(r"```.*?```", " ", t, flags=re.S)
    t = re.sub(r"`[^`]*`", " ", t)
    return t

def sentences(text):
    out = []
    for line in text.split("\n"):
        s = line.strip()
        if not s: continue
        s = re.sub(r"^\s*#{1,6}\s*", "", s)
        s = re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", s)
        if not s: continue
        parts = re.split(r"(?<=[.!?:])\s+(?=[A-Z0-9\"'\-])", s)
        for p in parts:
            p = p.strip()
            if p: out.append(p)
    return out

def wc(s):
    return len([w for w in re.findall(r"[A-Za-z0-9][A-Za-z0-9'\-/]*", s)])

def count_ci(text, phrases):
    n = 0; hits = []
    low = text.lower()
    for ph in phrases:
        for m in re.finditer(r"(?<![a-z])" + re.escape(ph) + r"(?![a-z])", low):
            n += 1; hits.append(ph)
    return n, hits

def lint(text):
    raw = text
    text = strip_code(text)
    sents = sentences(text)
    words = sum(wc(s) for s in sents) or 1
    v = {}
    longs = [(wc(s), s) for s in sents if wc(s) > 20]
    v["long_sentence(>20w)"] = len(longs)
    v["semicolon"] = text.count(";")
    # `'s` is only a contraction after a pronoun/adverb (it's, that's); after a noun
    # it is a possessive (commit's, image's), which STE allows — so whitelist the base.
    v["contraction"] = (
        len(re.findall(r"\b\w+['’](?:t|re|ve|ll|d|m)\b", text))
        + len(re.findall(r"\b(?:it|that|there|here|what|who|he|she|let|this|where|how|one)['’]s\b", text, re.I))
    )
    v["passive_voice"] = len(re.findall(rf"\b{BE}\s+(?:\w+ed|{PP_IRREG})\b", text, re.I))
    v["ing_main_verb"] = len(re.findall(rf"\b{BE}\s+\w+ing\b", text, re.I))
    v["nominalization"] = len(re.findall(r"\b(?:perform(?:s|ed)?|conduct(?:s|ed)?|provide(?:s|d)?|carry out|carries out|make use of|makes use of)\b", text, re.I)) + len(re.findall(r"\b\w{4,}(?:tion|ment|ance|ence)\s+of\b", text, re.I))
    v["phrasal_verb"], _ = count_ci(text, PHRASAL)
    v["banned_word"], bh = count_ci(text, BANNED)
    v["marketing_adjective"], mh = count_ci(text, MARKETING)
    v["modal_hedge"], _ = count_ci(text, MODAL_HEDGE)
    paras = [p for p in re.split(r"\n\s*\n", raw) if p.strip()]
    v["long_paragraph(>6s)"] = sum(1 for p in paras if len(sentences(strip_code(p))) > 6)
    em = raw.count("—") + raw.count("–")
    total = sum(v.values())
    per100 = {k: round(x*100.0/words, 2) for k, x in v.items()}
    return {
        "words": words, "sentences": len(sents),
        "violations": v, "total": total,
        "total_per100w": round(total*100.0/words, 2),
        "em_dash(slop-marker)": em,
        "longest_sentence_words": (max(longs)[0] if longs else max((wc(s) for s in sents), default=0)),
        "sample_marketing": list(dict.fromkeys(mh))[:6],
        "sample_banned": list(dict.fromkeys(bh))[:6],
    }

# --- comment extraction (for linting prose *inside* code files) ---

HASH_EXT = {".yml",".yaml",".toml",".sh",".bash",".zsh",".py",".rb",".pl",".tf",".conf",".cfg",".ini",".env"}
SLASH_EXT = {".ts",".tsx",".js",".jsx",".mjs",".cjs",".mts",".cts",".go",".rs",".java",".kt",
    ".c",".cc",".cpp",".h",".hpp",".css",".scss",".less",".swift",".php"}

def _line_comment(line, marker):
    # Return the comment text after `marker`, or None. Quote-aware so a `#`/`//`
    # inside a string is not a comment. Skips `://` so URLs do not false-trigger.
    inq = None; i = 0; n = len(line); m = len(marker)
    while i < n:
        ch = line[i]
        if inq:
            if ch == inq: inq = None
        elif ch in "\"'`":
            inq = ch
        elif line[i:i+m] == marker:
            if marker == "//" and i > 0 and line[i-1] == ":":
                i += 1; continue
            return line[i+m:].strip()
        i += 1
    return None

def extract_comments(text, ext, name=""):
    out = []
    base = os.path.basename(name).lower()
    is_hash = ext in HASH_EXT or base.startswith("dockerfile") or base == "makefile"
    is_slash = ext in SLASH_EXT
    if is_slash:
        for b in re.findall(r"/\*(.*?)\*/", text, re.S):
            out.append(re.sub(r"(?m)^\s*\*?\s?", "", b))
        text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    marker = "#" if is_hash else "//" if is_slash else None
    if marker:
        for line in text.split("\n"):
            if marker == "#" and line.lstrip().startswith("#!"):
                continue  # shebang, not prose
            c = _line_comment(line, marker)
            if c:
                out.append(re.sub(r"^#+\s?", "", c))  # strip extra leading # (banner comments)
    return "\n".join(out)

def summary(name, r):
    return (f"{os.path.basename(name):32} words={r['words']:4d} total={r['total']:3d} "
            f"per100w={r['total_per100w']:6.2f} em_dash={r['em_dash(slop-marker)']:2d}")

if __name__ == "__main__":
    argv = sys.argv[1:]
    comments = "--comments" in argv
    argv = [a for a in argv if a != "--comments"]
    files = argv
    if not files:
        print(json.dumps(lint(sys.stdin.read()), indent=2)); sys.exit(0)
    exp = []
    for f in files: exp += sorted(glob.glob(f)) if any(c in f for c in "*?[") else [f]
    for f in exp:
        with open(f) as fh: text = fh.read()
        if comments:
            text = extract_comments(text, os.path.splitext(f)[1].lower(), f)
        r = lint(text)
        print(summary(f, r))
