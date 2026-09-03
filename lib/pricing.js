// Model pricing ($ per 1M tokens) and cost estimation from Claude Code token usage.
//
// Rates are Anthropic first-party API list prices. Cache economics follow the
// published prompt-caching model: a cache *write* costs 1.25x the input rate
// (5-minute TTL) and a cache *read* costs 0.1x the input rate. We can't tell a
// 5m write from a 1h write from usage alone, so we price every cache write at
// the 5m rate — this under-counts 1h writes slightly but is the honest floor.
//
// A session's cost is the sum of every assistant turn's usage priced at that
// turn's own model, so a session that switched models mid-way is costed correctly.

const PRICING = {
  // id                      inMTok  outMTok
  'claude-fable-5-1':       [10.0, 50.0],
  'claude-fable-5':         [10.0, 50.0],
  'claude-mythos-5-1':      [10.0, 50.0],
  'claude-opus-5':          [5.0, 25.0],
  'claude-opus-4-8':        [5.0, 25.0],
  'claude-opus-4-7':        [5.0, 25.0],
  'claude-opus-4-6':        [5.0, 25.0],
  'claude-opus-4-5':        [5.0, 25.0],
  'claude-sonnet-5':        [2.0, 10.0],
  'claude-sonnet-4-6':      [3.0, 15.0],
  'claude-sonnet-4-5':      [3.0, 15.0],
  'claude-haiku-4-5':       [1.0, 5.0],
};

// Fallback by family when an exact id isn't in the table (e.g. a dated snapshot).
function ratesFor(model) {
  if (!model) return [5.0, 25.0]; // assume Opus-tier if unknown
  if (PRICING[model]) return PRICING[model];
  const m = model.toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return [10.0, 50.0];
  if (m.includes('opus')) return [5.0, 25.0];
  if (m.includes('haiku')) return [1.0, 5.0];
  if (m.includes('sonnet')) return m.includes('4-6') || m.includes('4-5') ? [3.0, 15.0] : [2.0, 10.0];
  return [5.0, 25.0];
}

const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

// Cost of a single usage object (one assistant API turn) in dollars.
export function costOfUsage(usage, model) {
  if (!usage) return 0;
  const [inRate, outRate] = ratesFor(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const perTok = (n, rate) => (n / 1_000_000) * rate;
  return (
    perTok(input, inRate) +
    perTok(output, outRate) +
    perTok(cacheWrite, inRate * CACHE_WRITE_MULT) +
    perTok(cacheRead, inRate * CACHE_READ_MULT)
  );
}

// Short, friendly model label for the UI.
export function modelLabel(model) {
  if (!model) return '—';
  return model
    .replace(/^claude-/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2')
    .replace(/-(\d)$/, ' $1')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace('Opus', 'Opus')
    .replace(/\bFable\b/, 'Fable');
}

export { ratesFor };
