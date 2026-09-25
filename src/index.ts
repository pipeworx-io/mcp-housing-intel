interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}


/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Housing Intel MCP — Meta-pack that chains FRED, BLS, ATTOM, and HUD APIs
 * into higher-level housing market workflows.
 *
 * BYO keys required:
 *   _fredKey  — FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html)
 *   _attomKey — ATTOM API key (https://api.gateway.attomdata.com)
 * Optional:
 *   _hudKey   — HUD API token (https://www.huduser.gov/portal/dataset/fmr-api.html)
 *
 * BLS public API requires no key.
 *
 * Tools:
 * - housing_market_snapshot:  macro market overview (FRED + BLS)
 * - housing_property_report:  full property analysis (ATTOM)
 * - housing_rental_analysis:  rental market analysis (ATTOM + HUD + BLS)
 * - housing_affordability_check: affordability metrics (FRED + HUD + BLS)
 * - housing_employment_outlook: labor market indicators (BLS)
 */

import { MSA_CBSA } from './msa-cbsa';

// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Housing Intel');
}

// ── API helpers ────────────────────────────────────────────────────────

// FRED's CF origin has sustained per-attempt flakiness (~55% measured by the
// fred pack, whose fredFetch retries 3x for exactly this reason). A single
// attempt here meant the snapshot's three parallel FRED subcalls routinely all
// hit the outer safe() 8s race and returned error shapes — which the gateway's
// response cache then replayed for the TTL, so one bad burst read as a
// persistently broken tool. Retries must fit inside that 8s budget: abort each
// attempt at 2.2s, back off 200/600ms — worst case ~7.4s.
const FRED_ATTEMPT_MS = 2200;
const FRED_RETRY_DELAYS_MS = [200, 600];
async function fredGet(apiKey: string, path: string, attempt = 1): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FRED_ATTEMPT_MS);
  let res: Response;
  try {
    res = await fetch(
      `https://api.stlouisfed.org/fred${path}&api_key=${apiKey}&file_type=json`,
      { signal: controller.signal },
    );
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (attempt <= FRED_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, FRED_RETRY_DELAYS_MS[attempt - 1]));
        return fredGet(apiKey, path, attempt + 1);
      }
      throw new Error(`upstream_down: FRED did not respond within ${FRED_ATTEMPT_MS}ms on any of ${attempt} attempts`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500 && attempt <= FRED_RETRY_DELAYS_MS.length) {
    await new Promise((r) => setTimeout(r, FRED_RETRY_DELAYS_MS[attempt - 1]));
    return fredGet(apiKey, path, attempt + 1);
  }
  if (!res.ok) throw await httpError(res, 'FRED error');
  return res.json();
}

// BLS gets the same treatment fredGet has, and for the same reason: the
// snapshot fires its BLS subcalls inside the outer safe() 8s race, so one slow
// or 5xx attempt loses the series for the whole TTL once the response cache
// replays it. This was a bare fetch with no timeout, no abort and no retry
// while the FRED helper six lines up had all three (fleet #159).
const BLS_ATTEMPT_MS = 2200;
const BLS_RETRY_DELAYS_MS = [200, 600];

/**
 * BLS answers a planned outage with HTTP 503 and an HTML maintenance page that
 * states the window. Surfacing a bare "BLS error: 503" throws that away, and
 * the snapshot then reports the series as `unavailable` — which reads as "no
 * data exists for this metro" rather than "the source is down until Sunday".
 * The window is the one thing a caller can actually act on.
 */
function blsOutageNote(bodyText: string): string | null {
  if (!/Temporarily Down for Maintenance|temporarily unavailable/i.test(bodyText)) return null;
  const window = bodyText
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    // Stop at "Eastern Time", not the first period — the window text is full of
    // abbreviations ("9:00 a.m."), so [^.]+ truncates it to a useless fragment.
    .match(/intermittently down from (.+?(?:Eastern|Pacific|Central|Mountain)\s+Time)/i);
  return window
    ? `BLS is down for scheduled maintenance — ${window[1].trim()}. This is an upstream outage, not missing data for this area.`
    : 'BLS is down for scheduled maintenance. This is an upstream outage, not missing data for this area.';
}

async function blsPost(
  seriesIds: string[],
  startYear: string,
  endYear: string,
  apiKey?: string,
  attempt = 1,
): Promise<{ status?: string; message?: string[] }> {
  const body: Record<string, unknown> = { seriesid: seriesIds, startyear: startYear, endyear: endYear };
  if (apiKey) body.registrationkey = apiKey;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), BLS_ATTEMPT_MS);
  let res: Response;
  try {
    res = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (attempt <= BLS_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, BLS_RETRY_DELAYS_MS[attempt - 1]));
        return blsPost(seriesIds, startYear, endYear, apiKey, attempt + 1);
      }
      throw new Error(`upstream_down: BLS did not respond within ${BLS_ATTEMPT_MS}ms on any of ${attempt} attempts`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500 && attempt <= BLS_RETRY_DELAYS_MS.length) {
    await new Promise((r) => setTimeout(r, BLS_RETRY_DELAYS_MS[attempt - 1]));
    return blsPost(seriesIds, startYear, endYear, apiKey, attempt + 1);
  }
  if (!res.ok) {
    const raw = await res.text();
    const outage = blsOutageNote(raw);
    if (outage) throw new Error(`upstream_down: ${outage}`);
    throw new Error(`BLS error: ${res.status}${raw ? ` — ${raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''}`);
  }
  // BLS signals quota exhaustion (and other request-level rejections) with
  // HTTP 200 + { status: 'REQUEST_NOT_PROCESSED', message: [...] } and no
  // Results.series — checking res.ok alone lets a throttled response sail
  // through as "success" with zero series, which is why this failure mode
  // was previously silent.
  const data = (await res.json()) as { status?: string; message?: string[] };
  if (data.status === 'REQUEST_NOT_PROCESSED') {
    throw new Error(`BLS request not processed: ${(data.message ?? []).join('; ') || 'no reason given'}`);
  }
  return data;
}

async function attomGet(apiKey: string, path: string) {
  const res = await pwFetch(`https://api.gateway.attomdata.com/propertyapi/v1.0.0${path}`, {
    headers: { accept: 'application/json', apikey: apiKey },
  });
  if (!res.ok) {
    const status = res.status;
    let hint = '';
    if (status === 404 || status === 400) {
      hint = ' — ATTOM could not match that address. Try a different format: use the city where the property is located (e.g., "Garden City, GA" instead of "Savannah, GA"), include the ZIP code, or verify the street address spelling.';
    }
    throw new Error(`ATTOM error (${status})${hint}`);
  }
  return res.json();
}

async function hudGet(token: string, path: string) {
  const res = await pwFetch(`https://www.huduser.gov/hudapi/public${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await httpError(res, 'HUD error');
  return res.json();
}

async function zillowGet<T = unknown>(supabaseUrl: string, supabaseKey: string, query: string): Promise<T> {
  const res = await pwFetch(`${supabaseUrl}/rest/v1/zillow_observations?${query}`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Zillow (${res.status}): ${text.slice(0, 120)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Pulls latest values for a single metro across every Zillow metric the
 * data-pipeline ingests. region_name in Zillow is the CBSA label (e.g.
 * "Denver, CO"), so we match case-insensitive substring against the metro
 * name the caller passed and resolve to the first metro-type hit. National
 * fallback (region_type=national) is used when no metro is requested.
 */
async function fetchZillowMarket(
  supabaseUrl: string,
  supabaseKey: string,
  metroName: string,
): Promise<{ region: { region_id: number; region_name: string } | null; metrics: Record<string, { observation_date: string; value: number | null }> } | null> {
  const isNational = !metroName.trim();
  const regionFilter = isNational
    ? 'region_type=eq.national'
    : `region_type=eq.metro&region_name=ilike.*${encodeURIComponent(metroName)}*`;

  // Find the matching region by pulling a few rows and picking the first id.
  const lookup = await zillowGet<Array<{ region_id: number; region_name: string }>>(
    supabaseUrl,
    supabaseKey,
    `${regionFilter}&select=region_id,region_name&limit=1`,
  );
  if (lookup.length === 0) return null;
  const region = lookup[0];

  // Fetch latest value per metric in parallel. Each query uses the
  // (metric, region_id, observation_date) PK index so it's an O(log n)
  // lookup — much faster than the previous strategy of pulling 500
  // recent rows and reducing client-side, which fell off the index when
  // filtering by region_id alone and timed out on the 700K-row table.
  const METRICS = ['zhvi', 'zori', 'sales_count', 'median_sale_price', 'inventory', 'new_listings'];
  const perMetric = await Promise.all(
    METRICS.map((metric) =>
      zillowGet<Array<{ metric: string; observation_date: string; value: number | null }>>(
        supabaseUrl,
        supabaseKey,
        `metric=eq.${metric}&region_id=eq.${region.region_id}&select=metric,observation_date,value&order=observation_date.desc&limit=1`,
      ),
    ),
  );
  const latest: Record<string, { observation_date: string; value: number | null }> = {};
  for (const rows of perMetric) {
    const row = rows[0];
    if (row) latest[row.metric] = { observation_date: row.observation_date, value: row.value };
  }
  return { region, metrics: latest };
}

// ── Metro CBSA lookup (FHFA HPI series: ATNHPIUS{CBSA}Q) ─────────────

const METRO_CBSA: Record<string, string> = {
  'atlanta': '12060', 'austin': '12420', 'baltimore': '12580', 'boston': '14460',
  'charlotte': '16740', 'chicago': '16980', 'cincinnati': '17140', 'cleveland': '17460',
  'columbus': '18140', 'dallas': '19100', 'denver': '19740', 'detroit': '19820',
  'houston': '26420', 'indianapolis': '26900', 'jacksonville': '27260',
  'kansas city': '28140', 'las vegas': '29820', 'los angeles': '31080',
  'memphis': '32820', 'miami': '33100', 'milwaukee': '33340', 'minneapolis': '33460',
  'nashville': '34980', 'new orleans': '35380', 'new york': '35620',
  'oklahoma city': '36420', 'orlando': '36740', 'philadelphia': '37980',
  'phoenix': '38060', 'pittsburgh': '38300', 'portland': '38900',
  'raleigh': '39580', 'richmond': '40060', 'riverside': '40140',
  'sacramento': '40900', 'salt lake city': '41620', 'san antonio': '41700',
  'san diego': '41740', 'san francisco': '41860', 'san jose': '41940',
  'savannah': '42340', 'seattle': '42660', 'st louis': '41180',
  'tampa': '45300', 'virginia beach': '47260', 'washington': '47900',
};

// ── Utility helpers ────────────────────────────────────────────────────

// ── Vintage disclosure (fleet #2002) ───────────────────────────────────
//
// Every series this pack serves is an OFFICIAL STATISTIC with its own
// publication cadence, so "latest" routinely means weeks or months ago. The
// observation date was always in the payload — a caller reading
// `case_shiller.current: 331.893` was simply never required to notice it, and
// nothing errored when they didn't. That is the failure shape #1999 fixed for
// PMMS (a correct number carrying a false implicature); these helpers are the
// same vocabulary, applied to the tools where the lag is largest.
//
// DISCLOSURE ONLY. Nothing below changes, extrapolates or nowcasts a value —
// a modelled number presented as a measurement is worse than the staleness it
// would paper over.
interface Vintage {
  component: string;
  observation_date: string;
  age_days: number;
  cadence: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "2026-06-01" → "June 2026". Fixed table, not Intl — deterministic on Workers. */
function monthYear(iso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const idx = Number(m[2]) - 1;
  return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${m[1]}` : iso;
}

/**
 * Normalise the two date shapes this pack receives to a full ISO day:
 * FRED/Supabase give YYYY-MM-DD, BLS gives YYYY-MM (extractBlsSeries).
 * Returns null for anything else so a malformed date drops out of the
 * disclosure rather than inventing an age.
 */
function isoDay(d: string | null | undefined): string | null {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = /^(\d{4})-(\d{1,2})$/.exec(d);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-01` : null;
}

function vintage(
  component: string,
  date: string | null | undefined,
  cadence: string,
  asOf: string,
): Vintage | null {
  const iso = isoDay(date);
  if (iso === null) return null;
  return { component, observation_date: iso, age_days: daysBetween(iso, asOf), cadence };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function currentYear(): string {
  return String(new Date().getFullYear());
}

function previousYear(): string {
  return String(new Date().getFullYear() - 1);
}

/**
 * Compute a simple trend label from the last 3+ numeric values.
 * Values should be in chronological order (oldest first).
 */
function trendLabel(values: number[]): 'rising' | 'falling' | 'stable' {
  if (values.length < 2) return 'stable';
  const recent = values.slice(-3);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const pctChange = ((last - first) / Math.abs(first || 1)) * 100;
  if (pctChange > 0.5) return 'rising';
  if (pctChange < -0.5) return 'falling';
  return 'stable';
}

/**
 * Extract the latest N observations from a FRED observations response.
 * Returns { date, value }[] in chronological order.
 */
function extractFredObs(data: unknown, count: number): { date: string; value: number }[] {
  const obs = ((data as Record<string, unknown>)?.observations as { date: string; value: string }[]) ?? [];
  const filtered = obs
    .filter((o) => o.value !== '.')
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .sort((a, b) => a.date.localeCompare(b.date)); // always chronological
  return filtered.slice(-count);
}

/**
 * Extract the latest data from a BLS series response.
 * BLS returns data newest-first; we reverse for chronological order.
 */
function extractBlsSeries(
  data: unknown,
  seriesId: string,
): { date: string; value: number }[] {
  const results = (data as Record<string, unknown>)?.Results as Record<string, unknown> | undefined;
  const seriesList = (results?.series as { seriesID: string; data: { year: string; period: string; periodName: string; value: string }[] }[]) ?? [];
  const series = seriesList.find((s) => s.seriesID === seriesId);
  if (!series) return [];
  return series.data
    .filter((d) => d.period !== 'M13') // skip annual averages
    .map((d) => ({
      date: `${d.year}-${d.period.replace('M', '')}`,
      value: parseFloat(d.value),
    }))
    .reverse(); // chronological order
}

// Per-subcall timeout. Compound tools fan out via Promise.all, which waits on
// the slowest branch — if any upstream goes sideways the whole compound stalls.
// 8s caps the wait; slower subcalls return their error shape. Same pattern as
// trade-intel's safe() after the 2026-05-13 Treasury upstream outage.
const TIMEOUT_MS = 8000;

/**
 * Safely run a promise, returning result or an error string. Times out after
 * 8s so a stuck upstream doesn't drag the whole compound tool's P95.
 */
async function safe<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`subcall timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    return { error: (err as Error).message ?? String(err) };
  }
}

function isError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v;
}

// ── Signal detection (inspired by Mike Simonsen's dashboard) ─────────

interface Signal {
  type: 'reversal' | 'unusual' | 'accelerating' | 'turn' | 'extreme';
  message: string;
}

function detectSignals(values: number[], label: string): Signal[] {
  const signals: Signal[] = [];
  if (values.length < 4) return signals;

  const recent = values.slice(-6);
  const current = recent[recent.length - 1];
  const prior = recent[recent.length - 2];
  const priorTrend = recent.slice(0, -1);

  // Calculate mean and std dev for the series
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  // Reversal detection: current direction differs from prior 3+ periods
  if (priorTrend.length >= 3) {
    const priorDeltas = priorTrend.slice(-3).map((v, i, a) => i > 0 ? v - a[i - 1] : 0).slice(1);
    const wasRising = priorDeltas.every(d => d > 0);
    const wasFalling = priorDeltas.every(d => d < 0);
    const currentDelta = current - prior;

    if (wasRising && currentDelta < 0) {
      signals.push({ type: 'reversal', message: `Reversal: ${label} downtick breaks recent advance` });
    }
    if (wasFalling && currentDelta > 0) {
      signals.push({ type: 'reversal', message: `Reversal: ${label} uptick breaks recent decline` });
    }
  }

  // Unusual move detection (> 1.5 std devs from mean change)
  if (stdDev > 0) {
    const change = Math.abs(current - prior);
    const meanChange = values.slice(1).reduce((a, v, i) => a + Math.abs(v - values[i]), 0) / (values.length - 1);
    const changeStdDev = Math.sqrt(values.slice(1).reduce((a, v, i) => a + (Math.abs(v - values[i]) - meanChange) ** 2, 0) / (values.length - 1));
    if (changeStdDev > 0 && change > meanChange + 1.5 * changeStdDev) {
      const direction = current > prior ? 'jump' : 'drop';
      const stdDevs = ((change - meanChange) / changeStdDev).toFixed(1);
      signals.push({ type: 'unusual', message: `Unusual ${direction} (${stdDevs} std devs) in ${label}` });
    }
  }

  // Accelerating: YoY change is increasing in magnitude
  if (values.length >= 13) {
    const yoyNow = current - values[values.length - 13];
    const yoyPrior = prior - values[values.length - 14];
    if (Math.abs(yoyNow) > Math.abs(yoyPrior) * 1.1) {
      signals.push({ type: 'accelerating', message: `${label} YoY change accelerating` });
    }
  }

  // Turn: period-over-period direction changed
  if (recent.length >= 3) {
    const prevDelta = recent[recent.length - 2] - recent[recent.length - 3];
    const currDelta = current - prior;
    if (prevDelta <= 0 && currDelta > 0) {
      signals.push({ type: 'turn', message: `${label} period change turned positive (was negative)` });
    }
    if (prevDelta >= 0 && currDelta < 0) {
      signals.push({ type: 'turn', message: `${label} period change turned negative (was positive)` });
    }
  }

  // Extreme: value > 2 std devs from mean
  if (stdDev > 0 && Math.abs(current - mean) > 2 * stdDev) {
    const direction = current > mean ? 'above' : 'below';
    signals.push({ type: 'extreme', message: `${label} at extreme level (${((current - mean) / stdDev).toFixed(1)} std devs ${direction} mean)` });
  }

  return signals;
}

function computeYoY(values: { date: string; value: number }[]): { value: number; change: number; pctChange: number } | null {
  if (values.length < 13) return null;
  const current = values[values.length - 1].value;
  const yearAgo = values[values.length - 13].value;
  return {
    value: current,
    change: current - yearAgo,
    pctChange: ((current - yearAgo) / Math.abs(yearAgo || 1)) * 100,
  };
}

// ── Tool definitions ───────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'case_shiller_metro_compare',
    description:
      'Compare Case-Shiller home price indices across multiple US metros in one call (the 20-city composite). For each metro returns latest level, 3-month change, 12-month change, all-time peak, drawdown from peak, and a softening flag. Output also ranks metros softest → strongest. Use for "which metros are softening", "Case-Shiller for [list of cities]", "compare housing prices in X, Y, Z" queries — picks the right per-metro FRED series IDs (DNXRSA, PHXRSA, TPXRSA, etc.) so callers don\'t have to. Available metros: Atlanta, Boston, Charlotte, Chicago, Cleveland, Dallas, Denver, Detroit, Las Vegas, Los Angeles, Miami, Minneapolis, New York, Phoenix, Portland, San Diego, San Francisco, Seattle, Tampa, Washington DC. NOT A CURRENT-MARKET READ: Case-Shiller is monthly, published on a roughly two-month lag, and each value is a three-month moving average — so the newest observation is typically 90-120 days old and describes a trailing quarter. The `freshness` block states the exact age of the call you made.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html). Platform key used if omitted.',
        },
        metros: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metro names, case-insensitive. Example: ["Denver", "Phoenix", "Tampa", "Charlotte"]. Pass any subset of the 20-city composite.',
        },
      },
      required: ['metros'],
    },
  },
  {
    name: 'housing_market_snapshot',
    description:
      'Get national housing market overview: mortgage rates, housing starts, Case-Shiller index, unemployment, construction employment. Optionally add metro-level prices (e.g., "Denver", "Atlanta"). For comparing Case-Shiller across multiple metros use case_shiller_metro_compare instead. THE COMPONENTS DO NOT SHARE A DATE — they are weekly, monthly and quarterly official statistics, each published on its own lag, so one call can span months of vintages. `freshness` states the span in days and names the oldest component; read it before comparing components against each other.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (https://fred.stlouisfed.org/docs/api/api_key.html)',
        },
        _blsKey: {
          type: 'string',
          description: 'BLS registration key (optional — raises the shared quota; https://data.bls.gov/registrationEngine/)',
        },
        metro_name: {
          type: 'string',
          description: 'Metro area name for metro-level FHFA HPI (e.g., "Denver", "Atlanta"). Supports top 50 US metros. National data is always included.',
        },
      },
      // _fredKey is gateway-injected; requiring it taught models to copy the
      // placeholder example value, which then OVERRODE the injected real key.
      required: [],
    },
  },
  {
    name: 'housing_property_report',
    description:
      'Analyze a property by address and zip code. Returns valuation estimate, sales history, tax assessment, and detailed characteristics.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _attomKey: {
          type: 'string',
          description: 'ATTOM API key (https://api.gateway.attomdata.com)',
        },
        address1: {
          type: 'string',
          description: 'Street address (e.g., "4529 Winona Court")',
        },
        address2: {
          type: 'string',
          description: 'City, state ZIP (e.g., "Denver, CO 80212")',
        },
      },
      required: ['_attomKey', 'address1', 'address2'],
    },
  },
  {
    name: 'housing_rental_analysis',
    description:
      'Evaluate rental investment potential by address and zip code. Returns estimated rent, fair market rents, and CPI rent trends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _attomKey: {
          type: 'string',
          description: 'ATTOM API key',
        },
        _hudKey: {
          type: 'string',
          description: 'HUD API token (optional — needed for fair market rents)',
        },
        _blsKey: {
          type: 'string',
          description: 'BLS registration key (optional — raises the shared quota; https://data.bls.gov/registrationEngine/)',
        },
        address1: {
          type: 'string',
          description: 'Street address (e.g., "4529 Winona Court")',
        },
        address2: {
          type: 'string',
          description: 'City, state ZIP (e.g., "Denver, CO 80212")',
        },
        state_code: {
          type: 'string',
          description: 'Two-letter state code for HUD FMR lookup (e.g., "CO")',
        },
      },
      required: ['_attomKey', 'address1', 'address2', 'state_code'],
    },
  },
  {
    name: 'housing_affordability_check',
    description:
      'Check housing affordability in a market. Returns mortgage rate, median price, monthly payment, required income, and HUD limits. Optionally specify metro (e.g., "Denver"). The inputs are official statistics on DIFFERENT cadences — a weekly mortgage rate against a quarterly median price — so the monthly payment is an illustrative ratio of published figures, not a live quote. `freshness` states the span and the age of each input.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key',
        },
        _hudKey: {
          type: 'string',
          description: 'HUD API token (optional — needed for income limits)',
        },
        _blsKey: {
          type: 'string',
          description: 'BLS registration key (optional — raises the shared quota; https://data.bls.gov/registrationEngine/)',
        },
        metro_name: {
          type: 'string',
          description: 'Metro name for metro-level FHFA HPI (e.g., "Denver", "Savannah"). Optional.',
        },
        state: {
          type: 'string',
          description: 'State name or two-letter code (e.g., "California" or "CA"). Resolved for you — pass this rather than state_code. Optional: without it you still get the national mortgage rate, median price and affordability math, just no HUD income limits.',
        },
        state_code: {
          type: 'string',
          description: 'Two-letter state code for HUD income limits (e.g., "CO"). `state` is preferred and accepts either form.',
        },
      },
      // state_code was required, so "how affordable is housing right now?" — a
      // question with no state in it — failed outright, even though the state is
      // only used for the HUD income-limits lookup and every other figure here is
      // national. Now optional, and `state` accepts a plain name. _fredKey is
      // gateway-injected — requiring it invited placeholder values that overrode
      // the real key.
      required: [],
    },
  },
  {
    name: 'housing_employment_outlook',
    description:
      'Assess labor market health for housing demand. Returns employment, construction jobs, residential building employment, unemployment rate, and job openings. All BLS monthly releases; each series carries its own `observation_date` and `cadence` (JOLTS runs an extra month behind CES/LAUS), and `freshness` states the span. `snapshot_date` is the call date, not the data date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (accepted for consistency but not used — BLS is free)',
        },
        _blsKey: {
          type: 'string',
          description: 'BLS registration key (optional — raises the shared quota; https://data.bls.gov/registrationEngine/)',
        },
      },
      required: [],
    },
  },
  {
    name: 'housing_signal_scan',
    description:
      'Scan 45+ housing indicators for anomalies and reversals. Flags unusual moves across rates, starts, sales, prices, wages, unemployment, and rent. Each signal carries its own `observation_date` and `cadence` — series here span weekly (mortgage rate) to quarterly (median sales price), and Case-Shiller is additionally a 3-month moving average, so "turned negative" does not mean "this month" for every series. `freshness` states the full span and the oldest component.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _fredKey: {
          type: 'string',
          description: 'FRED API key (gateway-injected; only needed outside the gateway)',
        },
        _blsKey: {
          type: 'string',
          description: 'BLS registration key (optional — raises the shared quota; https://data.bls.gov/registrationEngine/)',
        },
      },
      required: [],
    },
  },
  {
    name: 'housing_mortgage_history',
    description:
      'Freddie Mac Primary Mortgage Market Survey — the weekly US mortgage INTEREST rate (the annual percentage borrowers pay on a home loan, e.g. 6.5%), back to 1971. This is the borrowing cost paid by home buyers. Returns the latest snapshot, a time series for the requested window, and min/max/avg stats. Sourced from Freddie Mac directly (not FRED), ingested weekly by the Pipeworx data pipeline.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        window: {
          type: 'string',
          description: '1m | 3m | 6m | 1y | 5y | all (default 1y)',
        },
        as_of: {
          type: 'string',
          description: 'Optional YYYY-MM-DD — returns the rate for the closest observation on or before that date instead of the latest.',
        },
      },
      required: [],
    },
  },
  {
    name: 'housing_market_screen',
    description:
      'Rank US metros for rental cash flow in ONE call — the "which markets are best for a landlord" view. Returns metros sorted by gross rent yield = (Zillow median monthly rent × 12) ÷ Zillow typical home value. No per-metro orchestration and no API key. Use for "best/worst rental markets", "highest-yield metros", "where does rent go furthest vs. home prices". Tune with direction (top = highest yield / best cash flow, bottom = lowest), limit, and optional home-value bounds. rent_as_of and home_value_as_of are two independent Zillow queries and can land on different months; `freshness` says whether they matched this call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        direction: { type: 'string', description: 'top = highest gross yield (best cash flow), bottom = lowest. Default top.' },
        limit: { type: 'number', description: 'Metros to return (default 25, max 100).' },
        min_home_value: { type: 'number', description: 'Optional: only metros with typical home value ≥ this (USD).' },
        max_home_value: { type: 'number', description: 'Optional: only metros with typical home value ≤ this (USD).' },
      },
      required: [],
    },
  },
  {
    name: 'housing_metro_demand',
    description:
      'Demand + rent-durability signals for a shortlist of US metros in ONE call — population & 5-year growth, renter share, median household income, and unemployment, straight from Census ACS. Deterministic by metro (CBSA-keyed) — NO FRED series-ID guessing. Pass `metros` ("City, ST", e.g. the top results from housing_market_screen). This is the Stage-2 "is the demand real?" filter on a yield shortlist — high yield in a shrinking metro is a trap. No API key needed. HIGHEST-LAG SOURCE IN THIS PACK: figures are a Census ACS 5-YEAR rolling average (currently 2018-2022, released Dec 2023) — for structural demand, not a current-quarter read. `freshness` states the exact age.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        metros: { type: 'array', items: { type: 'string' }, description: 'Metro names to enrich, "City, ST" form, e.g. ["Lubbock, TX","Pittsburgh, PA"] — match the housing_market_screen output. Required.' },
        limit: { type: 'number', description: 'Max metros to enrich (default 25, max 100).' },
      },
      required: ['metros'],
    },
  },
];

// ── Tool implementations ───────────────────────────────────────────────

async function housingMarketSnapshot(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const blsKey = args._blsKey as string | undefined;
  const metroRaw = (args.metro_name as string) ?? '';
  const metroNorm = metroRaw.trim().toLowerCase();
  const cbsa = METRO_CBSA[metroNorm] ?? null;
  const metro = metroRaw || 'National';

  // Zillow is hosted in our own Supabase; the gateway injects creds when the
  // pack is configured with injectSupabase. If they're missing (e.g. running
  // the pack outside the gateway), we silently drop Zillow data from the
  // output rather than failing the whole call.
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  const zillowAvailable = Boolean(supabaseUrl && supabaseKey);

  // Fire all requests in parallel
  const [mortgage, houst, caseShiller, blsData, metroHpiData, zillowData] = await Promise.all([
    safe(fredGet(fredKey, '/series/observations?series_id=MORTGAGE30US&sort_order=desc&limit=4')),
    safe(fredGet(fredKey, '/series/observations?series_id=HOUST&sort_order=desc&limit=3')),
    safe(fredGet(fredKey, '/series/observations?series_id=CSUSHPISA&sort_order=desc&limit=3')),
    safe(
      blsPost(
        ['LNS14000000', 'CUUR0000SEHC', 'CES2000000001'],
        previousYear(),
        currentYear(),
        blsKey,
      ),
    ),
    cbsa
      ? safe(fredGet(fredKey, `/series/observations?series_id=ATNHPIUS${cbsa}Q&sort_order=desc&limit=20`))
      : Promise.resolve(null),
    zillowAvailable
      ? safe(fetchZillowMarket(supabaseUrl!, supabaseKey!, metroRaw))
      : Promise.resolve(null),
  ]);

  // Process FRED mortgage data
  let mortgageResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(mortgage)) {
    const obs = extractFredObs(mortgage, 4);
    if (obs.length > 0) {
      const values = obs.map((o) => o.value);
      mortgageResult = {
        // fleet #2002: this block used to carry NO date at all, so `current`
        // read as "today" with nothing in the payload to contradict it.
        observation_date: obs[obs.length - 1].date,
        current: values[values.length - 1],
        '4wk_ago': values[0],
        '4wk_ago_date': obs[0].date,
        trend: trendLabel(values),
        cadence: 'Weekly survey (Freddie Mac PMMS), published Thursdays.',
      };
    }
  } else {
    mortgageResult = mortgage;
  }

  // Process FRED housing starts
  let housingStartsResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(houst)) {
    const obs = extractFredObs(houst, 3);
    if (obs.length > 0) {
      housingStartsResult = {
        observation_date: obs[obs.length - 1].date,
        current: obs[obs.length - 1].value,
        unit: 'thousands',
        '3mo_trend': obs.map((o) => ({ date: o.date, value: o.value })),
        cadence: 'Monthly (Census), released about three weeks after the month it covers.',
      };
    }
  } else {
    housingStartsResult = houst;
  }

  // Process FRED Case-Shiller
  let caseShillerResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(caseShiller)) {
    const obs = extractFredObs(caseShiller, 3);
    if (obs.length > 0) {
      caseShillerResult = {
        observation_date: obs[obs.length - 1].date,
        current: obs[obs.length - 1].value,
        '3mo_trend': obs.map((o) => ({ date: o.date, value: o.value })),
        cadence: 'Monthly, published on the last Tuesday of each month covering closings about two months earlier.',
        smoothing: 'Each value is a THREE-MONTH MOVING AVERAGE of repeat sales, so it is a trailing window rather than a point-in-time price.',
      };
    }
  } else {
    caseShillerResult = caseShiller;
  }

  // Process BLS data
  let unemploymentResult: Record<string, unknown> = { error: 'unavailable' };
  let ownersEquivRentResult: Record<string, unknown> = { error: 'unavailable' };
  let constructionEmpResult: Record<string, unknown> = { error: 'unavailable' };

  if (!isError(blsData)) {
    const unemployment = extractBlsSeries(blsData, 'LNS14000000');
    if (unemployment.length > 0) {
      const vals = unemployment.map((d) => d.value);
      unemploymentResult = {
        observation_date: unemployment[unemployment.length - 1].date,
        current: vals[vals.length - 1],
        trend: unemployment.slice(-6).map((d) => ({ date: d.date, value: d.value })),
        cadence: 'Monthly (BLS), released in the first week of the following month.',
      };
    }

    const ownersRent = extractBlsSeries(blsData, 'CUUR0000SEHC');
    if (ownersRent.length > 0) {
      const vals = ownersRent.map((d) => d.value);
      ownersEquivRentResult = {
        observation_date: ownersRent[ownersRent.length - 1].date,
        current: vals[vals.length - 1],
        trend: ownersRent.slice(-6).map((d) => ({ date: d.date, value: d.value })),
        cadence: 'Monthly (BLS CPI), released mid-month for the prior month.',
      };
    }

    const constructionEmp = extractBlsSeries(blsData, 'CES2000000001');
    if (constructionEmp.length > 0) {
      const vals = constructionEmp.map((d) => d.value);
      constructionEmpResult = {
        observation_date: constructionEmp[constructionEmp.length - 1].date,
        current: vals[vals.length - 1],
        unit: 'thousands',
        trend: constructionEmp.slice(-6).map((d) => ({ date: d.date, value: d.value })),
        cadence: 'Monthly (BLS CES), released in the first week of the following month.',
      };
    }
  } else {
    unemploymentResult = blsData;
    ownersEquivRentResult = blsData;
    constructionEmpResult = blsData;
  }

  // Process FHFA metro HPI (if requested)
  let metroHpiResult: Record<string, unknown> | null = null;
  if (cbsa && metroHpiData && !isError(metroHpiData)) {
    const obs = extractFredObs(metroHpiData, 20);
    if (obs.length > 0) {
      const values = obs.map((o) => o.value);
      const current = values[values.length - 1];
      // FHFA is quarterly — YoY is 4 quarters back
      let yoyResult: { change: number; pctChange: number } | null = null;
      if (obs.length >= 5) {
        const yearAgo = values[values.length - 5];
        const change = current - yearAgo;
        yoyResult = { change: Math.round(change * 100) / 100, pctChange: Math.round((change / Math.abs(yearAgo || 1)) * 10000) / 100 };
      }
      metroHpiResult = {
        series: `ATNHPIUS${cbsa}Q`,
        metro: metro,
        observation_date: obs[obs.length - 1].date,
        cadence: 'QUARTERLY (FHFA), released about two months after the quarter ends — the slowest series in this response.',
        current,
        trend: trendLabel(values.slice(-6)),
        recent_data: obs.slice(-8).map((o) => ({ date: o.date, value: o.value })),
        yoy: yoyResult,
      };
    }
  } else if (metroRaw && !cbsa) {
    metroHpiResult = { error: `Metro "${metroRaw}" not found in CBSA lookup. Supported metros include: ${Object.keys(METRO_CBSA).slice(0, 10).join(', ')}, and more.` };
  } else if (isError(metroHpiData)) {
    metroHpiResult = metroHpiData;
  }

  // Shape Zillow data into the response. If Zillow was unavailable (no
  // Supabase creds, region not found, or fetch error), omit cleanly.
  let zillowResult: Record<string, unknown> | null = null;
  if (zillowData && !isError(zillowData) && zillowData) {
    const z = zillowData as Awaited<ReturnType<typeof fetchZillowMarket>>;
    if (z?.region) {
      const m = z.metrics;
      zillowResult = {
        scope: metroRaw ? 'metro' : 'national',
        region: z.region.region_name,
        home_value_index: m.zhvi ? { date: m.zhvi.observation_date, value: m.zhvi.value, note: 'ZHVI — Zillow Home Value Index, smoothed seasonally-adjusted mid-tier all-homes (USD)' } : null,
        rent_index: m.zori ? { date: m.zori.observation_date, value: m.zori.value, note: 'ZORI — Zillow Observed Rent Index (USD/month)' } : null,
        median_sale_price: m.median_sale_price ? { date: m.median_sale_price.observation_date, value: m.median_sale_price.value, note: 'Median sale price, weekly (USD)' } : null,
        sales_count: m.sales_count ? { date: m.sales_count.observation_date, value: m.sales_count.value, note: 'Monthly sales count' } : null,
        inventory: m.inventory ? { date: m.inventory.observation_date, value: m.inventory.value, note: 'For-sale inventory, smoothed monthly' } : null,
        new_listings: m.new_listings ? { date: m.new_listings.observation_date, value: m.new_listings.value, note: 'Monthly new listings' } : null,
      };
    } else if (zillowAvailable && metroRaw) {
      zillowResult = { error: `Zillow has no metro region matching "${metroRaw}".` };
    }
  } else if (isError(zillowData)) {
    zillowResult = zillowData;
  }

  // ── Time disclosure for the COMPOSITE (fleet #2002) ──────────────────
  //
  // `note` below explains GEOGRAPHY and always did. It said nothing about
  // TIME, and this tool is the worse case precisely because it is a composite:
  // a caller reading six "current" values side by side will compare them, and
  // cross-series comparison across a multi-month vintage spread is exactly the
  // reasoning the word "snapshot" invites. Every date was already in the
  // payload; none of them was in the caller's words, and `snapshot_date` —
  // today — sat at the top reinforcing the wrong reading.
  //
  // Vintages are read back off the shaped results rather than threaded through
  // separately, so a component can never report a date here that differs from
  // the one beside its own number.
  const asOfIso = today();
  const dateOf = (o: unknown): string | null => {
    const d = (o as Record<string, unknown> | null)?.observation_date;
    return typeof d === 'string' ? d : null;
  };
  const zillowMetricDate = (key: string): string | null => {
    const m = (zillowResult as Record<string, unknown> | null)?.[key] as Record<string, unknown> | undefined;
    return typeof m?.date === 'string' ? m.date : null;
  };
  const vintages = [
    vintage('mortgage_rate (Freddie Mac PMMS, 30-year fixed)', dateOf(mortgageResult), 'weekly', asOfIso),
    vintage('housing_starts (Census)', dateOf(housingStartsResult), 'monthly', asOfIso),
    vintage('case_shiller (S&P CoreLogic national, 3-month moving average)', dateOf(caseShillerResult), 'monthly', asOfIso),
    vintage('unemployment (BLS)', dateOf(unemploymentResult), 'monthly', asOfIso),
    vintage('owners_equiv_rent (BLS CPI)', dateOf(ownersEquivRentResult), 'monthly', asOfIso),
    vintage('construction_employment (BLS CES)', dateOf(constructionEmpResult), 'monthly', asOfIso),
    vintage('metro_hpi (FHFA)', dateOf(metroHpiResult), 'quarterly', asOfIso),
    vintage('zillow.home_value_index (ZHVI)', zillowMetricDate('home_value_index'), 'monthly', asOfIso),
    vintage('zillow.rent_index (ZORI)', zillowMetricDate('rent_index'), 'monthly', asOfIso),
    vintage('zillow.median_sale_price', zillowMetricDate('median_sale_price'), 'weekly', asOfIso),
    vintage('zillow.sales_count', zillowMetricDate('sales_count'), 'monthly', asOfIso),
    vintage('zillow.inventory', zillowMetricDate('inventory'), 'monthly', asOfIso),
    vintage('zillow.new_listings', zillowMetricDate('new_listings'), 'monthly', asOfIso),
  ]
    .filter((v): v is Vintage => v !== null)
    .sort((a, b) => a.observation_date.localeCompare(b.observation_date));

  // A component that errored (BLS quota, upstream down) contributes no date.
  // Say so, or the span silently narrows and reads healthier than it is.
  const undatedComponents = ([
    ['mortgage_rate', mortgageResult],
    ['housing_starts', housingStartsResult],
    ['case_shiller', caseShillerResult],
    ['unemployment', unemploymentResult],
    ['owners_equiv_rent', ownersEquivRentResult],
    ['construction_employment', constructionEmpResult],
  ] as [string, unknown][])
    .filter(([, r]) => dateOf(r) === null)
    .map(([name]) => name);

  const oldest = vintages[0] ?? null;
  const newest = vintages[vintages.length - 1] ?? null;
  const spanDays = oldest && newest ? daysBetween(oldest.observation_date, newest.observation_date) : null;

  const freshnessStatement = oldest === null || newest === null
    ? 'No component returned a usable observation date, so the age of this snapshot cannot be stated.'
    : [
        `These figures are NOT all from the same date. The observations span ${spanDays} day${spanDays === 1 ? '' : 's'},`
          + ` from ${oldest.component} — observed ${oldest.observation_date}, ${oldest.age_days} days ago, published ${oldest.cadence} —`
          + ` to ${newest.component}, observed ${newest.observation_date} (${newest.age_days} days ago).`,
        `The oldest number here describes ${monthYear(oldest.observation_date)}, not today.`,
        'Each series is current for its own publication cadence: official statistics publish on a lag, so nothing here is stale in the sense of being wrong.'
          + ' What is unsafe is reading them as one moment — comparing a weekly series against a quarterly one across this spread will attribute to "now" a move that happened months apart.',
        `snapshot_date (${asOfIso}) is the date of THIS CALL, not the date of the data.`,
        undatedComponents.length > 0
          ? `Not counted in that span because they returned no observation: ${undatedComponents.join(', ')}.`
          : null,
      ].filter(Boolean).join(' ');

  return {
    snapshot_date: today(),
    metro,
    note: 'Mortgage rate, housing starts, Case-Shiller, unemployment, OER, and construction employment are national. metro_hpi is metro-specific (FHFA). zillow is metro- or national-scoped depending on metro_name. For how OLD each of these is — they do not share a date — read `freshness`.',
    freshness: {
      as_of: asOfIso,
      span_days: spanDays,
      oldest_component: oldest?.component ?? null,
      oldest_observation_date: oldest?.observation_date ?? null,
      oldest_age_days: oldest?.age_days ?? null,
      newest_component: newest?.component ?? null,
      newest_observation_date: newest?.observation_date ?? null,
      components: vintages,
      components_without_a_date: undatedComponents,
      statement: freshnessStatement,
    },
    mortgage_rate: { scope: 'national', ...mortgageResult as object },
    housing_starts: { scope: 'national', ...housingStartsResult as object },
    case_shiller: { scope: 'national', ...caseShillerResult as object },
    unemployment: { scope: 'national', ...unemploymentResult as object },
    owners_equiv_rent: { scope: 'national', ...ownersEquivRentResult as object },
    construction_employment: { scope: 'national', ...constructionEmpResult as object },
    metro_hpi: metroHpiResult,
    zillow: zillowResult,
  };
}

async function housingPropertyReport(args: Record<string, unknown>) {
  const attomKey = args._attomKey as string;
  if (!attomKey) throw new Error('ATTOM API key required (_attomKey).');
  const address1 = args.address1 as string;
  const address2 = args.address2 as string;
  const addrParams = `?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;

  const [detail, avm, sales, assessment] = await Promise.all([
    safe(attomGet(attomKey, `/property/detail${addrParams}`)),
    safe(attomGet(attomKey, `/attomavm/detail${addrParams}`)),
    safe(attomGet(attomKey, `/saleshistory/expandedhistory${addrParams}`)),
    safe(attomGet(attomKey, `/assessment/detail${addrParams}`)),
  ]);

  // Flatten property details
  let propertyResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(detail)) {
    const prop = ((detail as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const building = (prop.building as Record<string, unknown>) ?? {};
    const size = (building.size as Record<string, unknown>) ?? {};
    const rooms = (building.rooms as Record<string, unknown>) ?? {};
    const lot = (prop.lot as Record<string, unknown>) ?? {};
    const summary = (prop.summary as Record<string, unknown>) ?? {};
    propertyResult = {
      beds: rooms.beds ?? rooms.bathstotal ?? null,
      baths: rooms.bathstotal ?? null,
      sqft: size.universalsize ?? size.livingsize ?? null,
      yearBuilt: summary.yearbuilt ?? null,
      lotSqft: lot.lotsize2 ?? lot.lotsize1 ?? null,
    };
  } else {
    propertyResult = detail;
  }

  // Flatten AVM
  let valuationResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(avm)) {
    const prop = ((avm as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const avmData = (prop.avm as Record<string, unknown>) ?? {};
    const amount = (avmData.amount as Record<string, unknown>) ?? {};
    valuationResult = {
      avm: amount.value ?? null,
      low: amount.low ?? null,
      high: amount.high ?? null,
      confidence: avmData.condition ?? avmData.confidence ?? null,
    };
  } else {
    valuationResult = avm;
  }

  // Flatten sales history
  let salesResult: unknown[] | Record<string, unknown> = { error: 'unavailable' };
  if (!isError(sales)) {
    const props = ((sales as Record<string, unknown>)?.property as Record<string, unknown>[]) ?? [];
    const saleList: { date: string | null; amount: number | null; type: string | null }[] = [];
    for (const prop of props) {
      const saleHistory = (prop.saleHistory as Record<string, unknown>[]) ??
        ((prop.sale as Record<string, unknown>)?.saleHistory as Record<string, unknown>[]) ?? [];
      for (const s of saleHistory) {
        const amount = (s.amount as Record<string, unknown>) ?? {};
        const saleAmt = (amount.saleAmt ?? amount.saleamt ?? amount.saleprice ?? amount.salePrice ?? null) as number | null;
        const transType = (amount.saleTransType ?? '') as string;
        saleList.push({
          date: (s.saleTransDate ?? s.saleSearchDate ?? s.saleDate ?? s.date ?? null) as string | null,
          amount: saleAmt,
          type: transType || null,
        });
      }
    }
    salesResult = saleList;
  } else {
    salesResult = sales;
  }

  // Flatten assessment
  let assessmentResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(assessment)) {
    const prop = ((assessment as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const assessed = (prop.assessment as Record<string, unknown>) ?? {};
    const assessedVal = (assessed.assessed as Record<string, unknown>) ?? {};
    const market = (assessed.market as Record<string, unknown>) ?? {};
    const tax = (assessed.tax as Record<string, unknown>) ?? {};
    assessmentResult = {
      assessed: assessedVal.assdttlvalue ?? null,
      market: market.mktttlvalue ?? null,
      taxAmount: tax.taxamt ?? null,
    };
  } else {
    assessmentResult = assessment;
  }

  return {
    address: `${address1}, ${address2}`,
    property: propertyResult,
    valuation: valuationResult,
    sales_history: salesResult,
    assessment: assessmentResult,
  };
}

async function housingRentalAnalysis(args: Record<string, unknown>) {
  const attomKey = args._attomKey as string;
  if (!attomKey) throw new Error('ATTOM API key required (_attomKey).');
  const hudKey = args._hudKey as string | undefined;
  const blsKey = args._blsKey as string | undefined;
  const address1 = args.address1 as string;
  const address2 = args.address2 as string;
  const stateCode = args.state_code as string;
  const addrParams = `?address1=${encodeURIComponent(address1)}&address2=${encodeURIComponent(address2)}`;

  // Build parallel requests
  const promises: Promise<unknown>[] = [
    safe(attomGet(attomKey, `/valuation/rentalavm${addrParams}`)),
    hudKey
      ? safe(hudGet(hudKey, `/fmr/statedata/${encodeURIComponent(stateCode)}`))
      : Promise.resolve(null),
    safe(blsPost(['CUUR0000SEHA'], '2024', currentYear(), blsKey)),
  ];

  const [rentalAvm, fmrData, blsRent] = await Promise.all(promises);

  // Flatten rental AVM
  let propertyRentResult: Record<string, unknown> = { error: 'unavailable' };
  if (!isError(rentalAvm)) {
    const prop = ((rentalAvm as Record<string, unknown>)?.property as Record<string, unknown>[])
      ?.[0] ?? {};
    const rental = (prop.rentalAVM ?? prop.rentalavm ?? prop.avm ?? {}) as Record<string, unknown>;
    const amount = (rental.amount ?? rental) as Record<string, unknown>;
    const monthly = (amount.value ?? amount.rent ?? null) as number | null;
    // Attempt to compute yield — needs AVM value which we don't have here
    propertyRentResult = {
      monthly: monthly,
      annual_yield: null, // would need property value to compute
    };
  } else {
    propertyRentResult = rentalAvm as Record<string, unknown>;
  }

  // Flatten HUD FMR — response structure for /fmr/statedata/{state}:
  // { "state":"CO", "data": { "data": { "year":"2026", "metroareas":[...], "counties":[...] } } }
  let fmrResult: Record<string, unknown> | null = null;
  if (fmrData && !isError(fmrData)) {
    const raw = fmrData as Record<string, unknown>;

    // Extract FMR area from a single record
    function extractFmr(rec: Record<string, unknown>): Record<string, unknown> {
      const basic = (rec.basicdata as Record<string, unknown>) ?? {};
      return {
        area_name: rec.area_name ?? rec.areaname ?? rec.metro_name ?? rec.county_name ?? null,
        efficiency: rec.efficiency ?? rec.Efficiency ?? basic.efficiency ?? basic.Efficiency ?? null,
        '1br': rec['One-Bedroom'] ?? rec.one_bedroom ?? rec.One_Bedroom ?? basic['One-Bedroom'] ?? null,
        '2br': rec['Two-Bedroom'] ?? rec.two_bedroom ?? rec.Two_Bedroom ?? basic['Two-Bedroom'] ?? null,
        '3br': rec['Three-Bedroom'] ?? rec.three_bedroom ?? rec.Three_Bedroom ?? basic['Three-Bedroom'] ?? null,
        '4br': rec['Four-Bedroom'] ?? rec.four_bedroom ?? rec.Four_Bedroom ?? basic['Four-Bedroom'] ?? null,
      };
    }

    // Dig into the nested structure: data.data.metroareas / data.data.counties
    let innerData: Record<string, unknown> | null = null;
    if (raw.data && typeof raw.data === 'object') {
      const d1 = raw.data as Record<string, unknown>;
      if (d1.data && typeof d1.data === 'object' && !Array.isArray(d1.data)) {
        innerData = d1.data as Record<string, unknown>;
      } else {
        innerData = d1;
      }
    }

    if (innerData) {
      const metroareas = (innerData.metroareas as Record<string, unknown>[]) ?? [];
      const counties = (innerData.counties as Record<string, unknown>[]) ?? [];
      const allAreas = [...metroareas, ...counties];

      if (allAreas.length > 0) {
        // Return first few areas as a summary; if there are many, limit to 10
        const fmrAreas = allAreas.slice(0, 10).map(extractFmr);
        fmrResult = {
          year: innerData.year ?? null,
          state: stateCode,
          areas: fmrAreas,
          total_areas: allAreas.length,
        };
      } else {
        // Maybe the data itself has FMR fields directly
        fmrResult = extractFmr(innerData);
      }
    } else if (Array.isArray(raw)) {
      // Direct array response
      if (raw.length > 0) {
        fmrResult = extractFmr(raw[0] as Record<string, unknown>);
      }
    } else {
      // Try treating raw as a single FMR record
      fmrResult = extractFmr(raw);
    }
  } else if (isError(fmrData)) {
    fmrResult = fmrData;
  }

  // Flatten BLS rent CPI
  let rentCpiResult: { date: string; value: number }[] | Record<string, unknown> = {
    error: 'unavailable',
  };
  if (!isError(blsRent)) {
    const series = extractBlsSeries(blsRent, 'CUUR0000SEHA');
    if (series.length > 0) {
      rentCpiResult = series.slice(-12);
    }
  } else {
    rentCpiResult = blsRent as Record<string, unknown>;
  }

  return {
    property_rent_estimate: propertyRentResult,
    area_fair_market_rent: fmrResult,
    rent_cpi_trend: rentCpiResult,
  };
}

const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'puerto rico': 'PR',
};

/** Accept "California", "california" or "CA" — agents supply whichever the question used. */
function resolveStateCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v) return null;
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return STATE_CODES[v.toLowerCase()] ?? null;
}

async function housingAffordabilityCheck(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const hudKey = args._hudKey as string | undefined;
  const blsKey = args._blsKey as string | undefined;
  const stateCode = resolveStateCode(args.state_code ?? args.state);
  const metroRaw = (args.metro_name as string) ?? '';
  const metroNorm = metroRaw.trim().toLowerCase();
  const cbsa = METRO_CBSA[metroNorm] ?? null;

  // Fire requests in parallel
  const promises: Promise<unknown>[] = [
    safe(fredGet(fredKey, '/series/observations?series_id=MORTGAGE30US&sort_order=desc&limit=1')),
    safe(fredGet(fredKey, '/series/observations?series_id=CSUSHPISA&sort_order=desc&limit=1')),
    safe(fredGet(fredKey, '/series/observations?series_id=MSPUS&sort_order=desc&limit=1')),
    hudKey && stateCode
      ? safe(hudGet(hudKey, `/il/statedata/${encodeURIComponent(stateCode)}`))
      : Promise.resolve(null),
    safe(blsPost(['CES0500000003'], previousYear(), currentYear(), blsKey)),
    cbsa
      ? safe(fredGet(fredKey, `/series/observations?series_id=ATNHPIUS${cbsa}Q&sort_order=desc&limit=8`))
      : Promise.resolve(null),
  ];

  const [mortgageData, caseShillerData, medianPriceData, hudIL, blsEarnings, metroHpiData] =
    await Promise.all(promises);

  // This tool carried NO date anywhere in its response (fleet #2002) — and it
  // is the sharpest case in the pack, because it does not merely place mixed
  // vintages side by side, it MULTIPLIES them: estimated_monthly_payment is a
  // weekly mortgage rate applied to a QUARTERLY median price. Keep each
  // observation date as we extract it, so the derived figure can say which
  // vintages it was built from instead of reading as a live quote.
  let mortgageDate: string | null = null;
  let caseShillerDate: string | null = null;
  let medianPriceDate: string | null = null;
  let earningsDate: string | null = null;

  // Extract mortgage rate
  let mortgageRate: number | null = null;
  if (!isError(mortgageData)) {
    const obs = extractFredObs(mortgageData, 1);
    if (obs.length > 0) { mortgageRate = obs[0].value; mortgageDate = obs[0].date; }
  }

  // Extract Case-Shiller
  let caseShillerIndex: number | null = null;
  if (!isError(caseShillerData)) {
    const obs = extractFredObs(caseShillerData, 1);
    if (obs.length > 0) { caseShillerIndex = obs[0].value; caseShillerDate = obs[0].date; }
  }

  // Extract median home price
  let medianHomePrice: number | null = null;
  if (!isError(medianPriceData)) {
    const obs = extractFredObs(medianPriceData, 1);
    if (obs.length > 0) { medianHomePrice = obs[0].value; medianPriceDate = obs[0].date; } // MSPUS is already in dollars (e.g., 405300)
  }

  // Extract average hourly earnings from BLS
  let avgHourlyEarnings: number | null = null;
  if (!isError(blsEarnings)) {
    const series = extractBlsSeries(blsEarnings, 'CES0500000003');
    if (series.length > 0) {
      avgHourlyEarnings = series[series.length - 1].value;
      earningsDate = series[series.length - 1].date;
    }
  }

  // Calculate estimated monthly payment (30yr fixed, 20% down)
  let estimatedMonthlyPayment: number | null = null;
  let incomeNeeded: number | null = null;
  if (mortgageRate !== null && medianHomePrice !== null) {
    const principal = medianHomePrice * 0.8; // 20% down
    const monthlyRate = mortgageRate / 100 / 12;
    const n = 360; // 30 years
    if (monthlyRate > 0) {
      estimatedMonthlyPayment = Math.round(
        (principal * (monthlyRate * Math.pow(1 + monthlyRate, n))) /
          (Math.pow(1 + monthlyRate, n) - 1),
      );
    } else {
      estimatedMonthlyPayment = Math.round(principal / n);
    }
    // Income needed: payment should be < 28% of gross monthly income
    incomeNeeded = Math.round((estimatedMonthlyPayment / 0.28) * 12);
  }

  // HUD income limits — raw API response: { data: { year, median_income, very_low, low, extremely_low } }
  // (our HUD pack wraps it as { state, data: { data: {...} } } but here we call HUD directly)
  let hudIncomeLimits: Record<string, unknown> | null = null;
  if (hudIL && !isError(hudIL)) {
    const raw = hudIL as Record<string, unknown>;
    // Navigate: could be raw.data.data.median_income or raw.data.median_income
    let ilData: Record<string, unknown> | null = null;
    if (raw.data && typeof raw.data === 'object') {
      const d1 = raw.data as Record<string, unknown>;
      if (d1.median_income) {
        ilData = d1;
      } else if (d1.data && typeof d1.data === 'object' && !Array.isArray(d1.data)) {
        const d2 = d1.data as Record<string, unknown>;
        if (d2.median_income) ilData = d2;
      }
    } else if (raw.median_income) {
      ilData = raw;
    }

    if (ilData && ilData.median_income) {
      const veryLow = (ilData.very_low as Record<string, number>) ?? {};
      const low = (ilData.low as Record<string, number>) ?? {};
      const extremelyLow = (ilData.extremely_low as Record<string, number>) ?? {};
      hudIncomeLimits = {
        state: stateCode,
        year: ilData.year ?? null,
        median_income: ilData.median_income,
        very_low_4person: veryLow.il50_p4 ?? null,
        low_4person: low.il80_p4 ?? null,
        extremely_low_4person: extremelyLow.il30_p4 ?? null,
        note: 'Income limits shown for 4-person household. p1-p8 = 1 to 8 person households.',
      };
    } else {
      hudIncomeLimits = { raw_response: raw, note: 'Could not parse HUD income limits structure' };
    }
  } else if (isError(hudIL)) {
    hudIncomeLimits = hudIL;
  }

  // Metro FHFA HPI
  let metroHpi: Record<string, unknown> | null = null;
  if (cbsa && metroHpiData && !isError(metroHpiData)) {
    const obs = extractFredObs(metroHpiData, 8);
    if (obs.length > 0) {
      metroHpi = {
        metro: metroRaw,
        series: `ATNHPIUS${cbsa}Q`,
        observation_date: obs[obs.length - 1].date,
        cadence: 'QUARTERLY (FHFA), released about two months after the quarter ends.',
        current: obs[obs.length - 1].value,
        trend: trendLabel(obs.map(o => o.value).slice(-4)),
      };
    }
  }

  const asOfIso = today();
  const affordVintages = [
    vintage('mortgage_rate (Freddie Mac PMMS, 30-year fixed)', mortgageDate, 'weekly', asOfIso),
    vintage('median_home_price (Census/HUD MSPUS)', medianPriceDate, 'quarterly', asOfIso),
    vintage('case_shiller_index (S&P CoreLogic national, 3-month moving average)', caseShillerDate, 'monthly', asOfIso),
    vintage('avg_hourly_earnings (BLS CES)', earningsDate, 'monthly', asOfIso),
    vintage('metro_hpi (FHFA)', (metroHpi?.observation_date as string | undefined) ?? null, 'quarterly', asOfIso),
  ]
    .filter((v): v is Vintage => v !== null)
    .sort((a, b) => a.observation_date.localeCompare(b.observation_date));

  const affordOldest = affordVintages[0] ?? null;
  const affordNewest = affordVintages[affordVintages.length - 1] ?? null;
  const affordSpan = affordOldest && affordNewest
    ? daysBetween(affordOldest.observation_date, affordNewest.observation_date)
    : null;

  const derivedFrom = mortgageDate && medianPriceDate
    ? `estimated_monthly_payment and income_needed multiply a ${mortgageDate} WEEKLY mortgage rate by a ${medianPriceDate} QUARTERLY median price`
      + ` — ${daysBetween(medianPriceDate, mortgageDate)} days apart. Treat them as an illustrative ratio of two published statistics, not a quote for a house you could buy today.`
    : null;

  const affordStatement = affordOldest === null || affordNewest === null
    ? 'No input returned a usable observation date, so the age of this estimate cannot be stated.'
    : [
        `These inputs are NOT all from the same date. They span ${affordSpan} day${affordSpan === 1 ? '' : 's'},`
          + ` from ${affordOldest.component} — observed ${affordOldest.observation_date}, ${affordOldest.age_days} days ago, published ${affordOldest.cadence} —`
          + ` to ${affordNewest.component}, observed ${affordNewest.observation_date} (${affordNewest.age_days} days ago).`,
        derivedFrom,
        'Each series is current for its own cadence; official statistics publish on a lag. Nothing here is extrapolated or nowcast.',
      ].filter(Boolean).join(' ');

  return {
    freshness: {
      as_of: asOfIso,
      span_days: affordSpan,
      oldest_component: affordOldest?.component ?? null,
      oldest_observation_date: affordOldest?.observation_date ?? null,
      oldest_age_days: affordOldest?.age_days ?? null,
      newest_component: affordNewest?.component ?? null,
      newest_observation_date: affordNewest?.observation_date ?? null,
      components: affordVintages,
      statement: affordStatement,
    },
    mortgage_rate: mortgageRate,
    mortgage_rate_as_of: mortgageDate,
    median_home_price: medianHomePrice,
    median_home_price_as_of: medianPriceDate,
    case_shiller_index_as_of: caseShillerDate,
    avg_hourly_earnings_as_of: earningsDate,
    median_home_price_note: 'National median (MSPUS), published QUARTERLY about two months after the quarter ends. Metro-specific pricing not available via FRED.',
    metro_hpi: metroHpi,
    case_shiller_index: caseShillerIndex,
    avg_hourly_earnings: avgHourlyEarnings,
    estimated_monthly_payment: estimatedMonthlyPayment,
    income_needed: incomeNeeded,
    income_needed_note: 'Based on 28% DTI ratio, 20% down, 30yr fixed.',
    hud_income_limits: hudIncomeLimits,
    // Say what the state resolved to, and why HUD limits are absent when they
    // are — otherwise a null reads as "HUD has no data for this state" rather
    // than "you didn't name a state" or "we hold no HUD key".
    state_resolved: stateCode,
    hud_income_limits_note: hudIncomeLimits
      ? null
      : !stateCode
          ? 'HUD income limits omitted: no state given. Pass `state` (e.g. "California" or "CA") to include them. Every other figure here is national and unaffected.'
          : 'HUD income limits unavailable for this request; the rest of the response is unaffected.',
  };
}

async function housingEmploymentOutlook(args: Record<string, unknown>) {
  const blsKey = args._blsKey as string | undefined;

  const seriesIds = [
    'CES0000000001', // total nonfarm
    'CES2000000001', // construction
    'CES2023610001', // residential building
    'LNS14000000', // unemployment rate
    'JTS000000000000000JOL', // JOLTS openings
    'JTS000000000000000HIR', // JOLTS hires
  ];

  const blsData = await safe(blsPost(seriesIds, previousYear(), currentYear(), blsKey));

  if (isError(blsData)) {
    return { error: blsData.error };
  }

  // All six series here are BLS monthly releases (CES/LAUS/JOLTS). JOLTS has
  // an extra publication lag over CES/LAUS, so they do not always share a
  // month even though every series is nominally "monthly" — same class as
  // #2002/#2011: a correct `current` value with no date attached to it reads
  // as today's number.
  const seriesLabels: Record<string, { label: string; unit: string; cadence: string }> = {
    CES0000000001: { label: 'total_nonfarm', unit: 'thousands', cadence: 'monthly' },
    CES2000000001: { label: 'construction', unit: 'thousands', cadence: 'monthly' },
    CES2023610001: { label: 'residential_building', unit: 'thousands', cadence: 'monthly' },
    LNS14000000: { label: 'unemployment_rate', unit: 'percent', cadence: 'monthly' },
    JTS000000000000000JOL: { label: 'jolts_openings', unit: 'thousands', cadence: 'monthly (JOLTS runs an extra month behind CES/LAUS)' },
    JTS000000000000000HIR: { label: 'jolts_hires', unit: 'thousands', cadence: 'monthly (JOLTS runs an extra month behind CES/LAUS)' },
  };

  const asOfIso = today();
  const result: Record<string, unknown> = {
    snapshot_date: asOfIso,
  };

  const vintages: Vintage[] = [];
  for (const [seriesId, meta] of Object.entries(seriesLabels)) {
    const data = extractBlsSeries(blsData, seriesId);
    if (data.length > 0) {
      const values = data.map((d) => d.value);
      const latestDate = isoDay(data[data.length - 1].date);
      result[meta.label] = {
        current: values[values.length - 1],
        observation_date: latestDate,
        unit: meta.unit,
        cadence: meta.cadence,
        trend: trendLabel(values.slice(-6)),
        recent_data: data.slice(-6).map((d) => ({ date: d.date, value: d.value })),
      };
      const v = vintage(meta.label, latestDate, meta.cadence, asOfIso);
      if (v) vintages.push(v);
    } else {
      result[meta.label] = { error: `No data returned for ${seriesId}` };
    }
  }

  vintages.sort((a, b) => a.observation_date.localeCompare(b.observation_date));
  const oldest = vintages[0] ?? null;
  const newest = vintages[vintages.length - 1] ?? null;
  const spanDays = oldest && newest ? daysBetween(oldest.observation_date, newest.observation_date) : null;

  result.freshness = {
    as_of: asOfIso,
    span_days: spanDays,
    statement: oldest === null || newest === null
      ? 'No series returned a usable observation date.'
      : [
          `snapshot_date (${asOfIso}) is the date of THIS CALL, not the date of any series below — each series carries its own observation_date.`,
          spanDays === 0
            ? `All six series share the same observation month, ${monthYear(oldest.observation_date)}.`
            : `The series span ${spanDays} day${spanDays === 1 ? '' : 's'}, from ${oldest.component} (${oldest.observation_date}) to ${newest.component} (${newest.observation_date}).`,
          `The oldest figure describes ${monthYear(oldest.observation_date)}, ${oldest.age_days} days ago — not today.`,
        ].join(' '),
  };

  return result;
}

async function housingSignalScan(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const blsKey = args._blsKey as string | undefined;

  // cadence: the publication frequency for THIS series, stated in the
  // caller's words rather than just a date field — see the class note above
  // the Vintage helpers (fleet #2002 / #2011). Case-Shiller is additionally a
  // 3-month moving average; MSPUS (median sales price) is quarterly, not
  // monthly, despite sharing the FRED "series" shape with the monthly ones.
  //
  // sort_order=desc is LOAD-BEARING, on every line below (fleet #2011).
  // FRED applies `limit` AFTER `sort_order`, so `asc&limit=24` returns the
  // OLDEST 24 observations of the series, not the newest — and this scan read
  // `asc` on all 31 series until 2026-09-15. Nothing errored: every series
  // came back 200 with real numbers, so the scan reported the 30-year mortgage
  // rate as 7.31% (its value on 1972-03-24, the 52nd weekly print) under
  // today's scan_date while the actual rate was 6.76%, and every "turned
  // negative" signal described the 1960s. extractFredObs re-sorts
  // chronologically and slices -count, so `desc` is what yields the newest N.
  // If you ever want oldest-first output, sort in extractFredObs — do NOT put
  // `asc` back in the request.
  const seriesConfig = [
    // Core housing
    { id: 'MORTGAGE30US', label: '30-Year Mortgage Rate', cadence: 'weekly', fredPath: '/series/observations?series_id=MORTGAGE30US&sort_order=desc&limit=52' },
    { id: 'HOUST', label: 'Housing Starts (Total)', cadence: 'monthly', fredPath: '/series/observations?series_id=HOUST&sort_order=desc&limit=24' },
    { id: 'HOUST1F', label: 'Housing Starts (Single-Family)', cadence: 'monthly', fredPath: '/series/observations?series_id=HOUST1F&sort_order=desc&limit=24' },
    { id: 'PERMIT', label: 'Building Permits', cadence: 'monthly', fredPath: '/series/observations?series_id=PERMIT&sort_order=desc&limit=24' },
    { id: 'MSACSR', label: 'Months Supply of Houses', cadence: 'monthly', fredPath: '/series/observations?series_id=MSACSR&sort_order=desc&limit=24' },
    { id: 'MSPUS', label: 'Median Sales Price', cadence: 'quarterly', fredPath: '/series/observations?series_id=MSPUS&sort_order=desc&limit=16' },
    // NAR existing home sales
    { id: 'EXHOSLUSM495S', label: 'NAR Existing Home Sales', cadence: 'monthly', fredPath: '/series/observations?series_id=EXHOSLUSM495S&sort_order=desc&limit=24' },
    { id: 'HOSINVUSM495N', label: 'NAR Housing Inventory', cadence: 'monthly', fredPath: '/series/observations?series_id=HOSINVUSM495N&sort_order=desc&limit=24' },
    // Case-Shiller (national + 20 metros)
    { id: 'CSUSHPISA', label: 'Case-Shiller National HPI', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=CSUSHPISA&sort_order=desc&limit=24' },
    { id: 'SFXRNSA', label: 'Case-Shiller San Francisco', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=SFXRNSA&sort_order=desc&limit=24' },
    { id: 'LXXRNSA', label: 'Case-Shiller Los Angeles', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=LXXRNSA&sort_order=desc&limit=24' },
    { id: 'SEXRNSA', label: 'Case-Shiller Seattle', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=SEXRNSA&sort_order=desc&limit=24' },
    { id: 'DNXRNSA', label: 'Case-Shiller Denver', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=DNXRNSA&sort_order=desc&limit=24' },
    { id: 'NYXRNSA', label: 'Case-Shiller New York', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=NYXRNSA&sort_order=desc&limit=24' },
    { id: 'MIXRNSA', label: 'Case-Shiller Miami', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=MIXRNSA&sort_order=desc&limit=24' },
    { id: 'DAXRNSA', label: 'Case-Shiller Dallas', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=DAXRNSA&sort_order=desc&limit=24' },
    { id: 'PHXRNSA', label: 'Case-Shiller Phoenix', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=PHXRNSA&sort_order=desc&limit=24' },
    { id: 'TPXRNSA', label: 'Case-Shiller Tampa', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=TPXRNSA&sort_order=desc&limit=24' },
    { id: 'CHXRNSA', label: 'Case-Shiller Chicago', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=CHXRNSA&sort_order=desc&limit=24' },
    { id: 'ATXRNSA', label: 'Case-Shiller Atlanta', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=ATXRNSA&sort_order=desc&limit=24' },
    { id: 'BOXRNSA', label: 'Case-Shiller Boston', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=BOXRNSA&sort_order=desc&limit=24' },
    { id: 'WDXRNSA', label: 'Case-Shiller Washington DC', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=WDXRNSA&sort_order=desc&limit=24' },
    { id: 'LVXRNSA', label: 'Case-Shiller Las Vegas', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=LVXRNSA&sort_order=desc&limit=24' },
    { id: 'SDXRNSA', label: 'Case-Shiller San Diego', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=SDXRNSA&sort_order=desc&limit=24' },
    { id: 'POXRNSA', label: 'Case-Shiller Portland', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=POXRNSA&sort_order=desc&limit=24' },
    { id: 'MNXRNSA', label: 'Case-Shiller Minneapolis', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=MNXRNSA&sort_order=desc&limit=24' },
    { id: 'DEXRNSA', label: 'Case-Shiller Detroit', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=DEXRNSA&sort_order=desc&limit=24' },
    { id: 'CRXRNSA', label: 'Case-Shiller Charlotte', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=CRXRNSA&sort_order=desc&limit=24' },
    { id: 'CEXRNSA', label: 'Case-Shiller Cleveland', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=CEXRNSA&sort_order=desc&limit=24' },
    // Consumer confidence
    { id: 'CSCICP03USM665S', label: 'Consumer Confidence Index', cadence: 'monthly', fredPath: '/series/observations?series_id=CSCICP03USM665S&sort_order=desc&limit=24' },
    // Atlanta Fed Wage Tracker
    { id: 'FRBATLWGT3MMAUMHWGO', label: 'Atlanta Fed Wage Growth (3mo MA)', cadence: 'monthly (3-month moving average)', fredPath: '/series/observations?series_id=FRBATLWGT3MMAUMHWGO&sort_order=desc&limit=24' },
  ];

  // Batch FRED requests (CF Workers have subrequest limits, so batch in groups of 10)
  const fredResults: (unknown | { error: string })[] = [];
  for (let i = 0; i < seriesConfig.length; i += 10) {
    const batch = seriesConfig.slice(i, i + 10);
    const batchResults = await Promise.all(
      batch.map(s => safe(fredGet(fredKey, s.fredPath)))
    );
    fredResults.push(...batchResults);
  }

  // Fetch BLS series — employment, CPI shelter, metro CPI
  const blsResult = await safe(blsPost(
    [
      'LNS14000000',    // Unemployment rate
      'CUUR0000SEHC',   // Owners equivalent rent (national)
      'CUUR0000SEHA',   // Rent of primary residence (national)
      'CES2000000001',  // Construction employment
      'CES2023610001',  // Residential building employment
    ],
    String(new Date().getFullYear() - 2),
    currentYear(),
    blsKey,
  ));

  // Metro CPI — separate BLS call (max 50 series per request)
  const metroCpiResult = await safe(blsPost(
    [
      'CUURS12ASA0',    // New York
      'CUURS11ASA0',    // Boston
      'CUURS23ASA0',    // Chicago
      'CUURS37ASA0',    // Dallas
      'CUURS49ASA0',    // Los Angeles (West Region A)
      'CUURS49BSA0',    // Los Angeles (West Region B — actually Riverside)
      'CUURS35ASA0',    // Denver (actually Denver-Aurora-Lakewood)
      'CUURS24ASA0',    // Minneapolis
      'CUURS35BSA0',    // Phoenix
      'CUURS35CSA0',    // Seattle (West Size Class B)
      'CUURS12BSA0',    // Philadelphia
      'CUURS35DSA0',    // Portland
      'CUURS33ASA0',    // Washington DC
      'CUURS33BSA0',    // Miami (South Size Class B — actually Tampa area)
    ],
    String(new Date().getFullYear() - 2),
    currentYear(),
    blsKey,
  ));

  const scanResults: {
    series: string;
    label: string;
    current: number | null;
    prior: number | null;
    periodChange: number | null;
    yoy: { change: number; pctChange: number } | null;
    trend: string;
    signals: Signal[];
    observation_date: string | null;
    cadence: string;
  }[] = [];

  // Process FRED series
  for (let i = 0; i < seriesConfig.length; i++) {
    const config = seriesConfig[i];
    const data = fredResults[i];
    if (isError(data)) {
      scanResults.push({ series: config.id, label: config.label, current: null, prior: null, periodChange: null, yoy: null, trend: 'unknown', signals: [{ type: 'unusual', message: `Error fetching ${config.label}` }], observation_date: null, cadence: config.cadence });
      continue;
    }
    const obs = extractFredObs(data, 52);
    const values = obs.map(o => o.value);
    if (values.length < 2) continue;

    const current = values[values.length - 1];
    const prior = values[values.length - 2];
    const yoy = computeYoY(obs);

    scanResults.push({
      series: config.id,
      label: config.label,
      current,
      prior,
      periodChange: current - prior,
      yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
      trend: trendLabel(values.slice(-6)),
      signals: detectSignals(values, config.label),
      observation_date: isoDay(obs[obs.length - 1].date),
      cadence: config.cadence,
    });
  }

  // Process BLS series
  if (!isError(blsResult)) {
    const blsSeries = [
      { id: 'LNS14000000', label: 'Unemployment Rate' },
      { id: 'CUUR0000SEHC', label: 'Owners Equivalent Rent CPI' },
      { id: 'CUUR0000SEHA', label: 'Rent of Primary Residence CPI' },
      { id: 'CES2000000001', label: 'Construction Employment' },
      { id: 'CES2023610001', label: 'Residential Building Employment' },
    ];

    for (const s of blsSeries) {
      const obs = extractBlsSeries(blsResult, s.id);
      const values = obs.map(o => o.value);
      if (values.length < 2) continue;

      const current = values[values.length - 1];
      const prior = values[values.length - 2];
      const yoy = obs.length >= 13 ? computeYoY(obs) : null;

      scanResults.push({
        series: s.id,
        label: s.label,
        current,
        prior,
        periodChange: current - prior,
        yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
        trend: trendLabel(values.slice(-6)),
        signals: detectSignals(values, s.label),
        observation_date: isoDay(obs[obs.length - 1].date),
        cadence: 'monthly',
      });
    }
  }

  // Process metro CPI
  if (!isError(metroCpiResult)) {
    const metroCpiSeries = [
      { id: 'CUURS12ASA0', label: 'CPI New York' },
      { id: 'CUURS11ASA0', label: 'CPI Boston' },
      { id: 'CUURS23ASA0', label: 'CPI Chicago' },
      { id: 'CUURS37ASA0', label: 'CPI Dallas' },
      { id: 'CUURS49ASA0', label: 'CPI Los Angeles' },
      { id: 'CUURS49BSA0', label: 'CPI Riverside' },
      { id: 'CUURS35ASA0', label: 'CPI Denver' },
      { id: 'CUURS24ASA0', label: 'CPI Minneapolis' },
      { id: 'CUURS35BSA0', label: 'CPI Phoenix' },
      { id: 'CUURS35CSA0', label: 'CPI Seattle' },
      { id: 'CUURS12BSA0', label: 'CPI Philadelphia' },
      { id: 'CUURS35DSA0', label: 'CPI Portland' },
      { id: 'CUURS33ASA0', label: 'CPI Washington DC' },
      { id: 'CUURS33BSA0', label: 'CPI Tampa' },
    ];

    for (const s of metroCpiSeries) {
      const obs = extractBlsSeries(metroCpiResult, s.id);
      const values = obs.map(o => o.value);
      if (values.length < 2) continue;

      const current = values[values.length - 1];
      const prior = values[values.length - 2];
      const yoy = obs.length >= 13 ? computeYoY(obs) : null;

      scanResults.push({
        series: s.id,
        label: s.label,
        current,
        prior,
        periodChange: current - prior,
        yoy: yoy ? { change: yoy.change, pctChange: Math.round(yoy.pctChange * 100) / 100 } : null,
        trend: trendLabel(values.slice(-6)),
        signals: detectSignals(values, s.label),
        observation_date: isoDay(obs[obs.length - 1].date),
        cadence: 'monthly',
      });
    }
  }

  // Collect all signals. Each signal is a claim about TIME ("turned negative",
  // "downtick breaks recent advance") and previously carried no date anywhere
  // in the payload — `scan_date` (today) sat at the top with 45+ series
  // underneath it, none dated, so a caller reasonably read every signal as
  // "this month". It is not: some series here are quarterly (median sale
  // price) and Case-Shiller is additionally a 3-month moving average. The
  // signal now carries the SAME observation_date and cadence as the series it
  // was computed from (fleet #2011, following #2002's disclosure shape).
  const allSignals = scanResults.flatMap(r =>
    r.signals.map(s => ({ ...s, series: r.label, observation_date: r.observation_date, cadence: r.cadence })),
  );
  const flagged = scanResults.filter(r => r.signals.length > 0);

  const asOfIso = today();
  const dated = scanResults
    .filter((r): r is typeof r & { observation_date: string } => r.observation_date !== null)
    .sort((a, b) => a.observation_date.localeCompare(b.observation_date));
  const oldest = dated[0] ?? null;
  const newest = dated[dated.length - 1] ?? null;
  const spanDays = oldest && newest ? daysBetween(oldest.observation_date, newest.observation_date) : null;

  const freshnessStatement = oldest === null || newest === null
    ? 'No series returned a usable observation date, so the age of this scan cannot be stated.'
    : [
        `scan_date (${asOfIso}) is the date of THIS CALL, not the date of any signal below.`,
        `The ${scanResults.length} series scanned span ${spanDays} day${spanDays === 1 ? '' : 's'} of observations,`
          + ` from ${oldest.label} — observed ${oldest.observation_date} (${daysBetween(oldest.observation_date, asOfIso)} days ago), published ${oldest.cadence} —`
          + ` to ${newest.label}, observed ${newest.observation_date}.`,
        'Every signal below ("turned negative", "reversal", "accelerating"...) carries its own observation_date and cadence —'
          + ' read those before assuming a signal describes this month. A quarterly series (Median Sales Price) or a 3-month'
          + ' moving average (Case-Shiller) can show a "turn" that is months old by the time you read it.',
      ].join(' ');

  return {
    scan_date: asOfIso,
    total_series_scanned: scanResults.length,
    flagged_count: flagged.length,
    freshness: {
      as_of: asOfIso,
      span_days: spanDays,
      oldest_component: oldest ? { series: oldest.label, observation_date: oldest.observation_date, cadence: oldest.cadence } : null,
      statement: freshnessStatement,
    },
    signals: allSignals,
    flagged_series: flagged,
    all_series: scanResults.map(r => ({
      series: r.series,
      label: r.label,
      current: r.current,
      periodChange: r.periodChange != null ? Math.round(r.periodChange * 1000) / 1000 : null,
      yoy: r.yoy,
      trend: r.trend,
      signal_count: r.signals.length,
      observation_date: r.observation_date,
      cadence: r.cadence,
    })),
  };
}

// ── housing_mortgage_history implementation ──────────────────────────
//
// Backed by the freddie_mac_pmms table (ingested weekly by the Pipeworx
// data pipeline from https://www.freddiemac.com/pmms/docs/PMMS_history.csv).
// FRED also republishes MORTGAGE30US, but going direct to Freddie gives us
// 15y + 5/1 ARM in the same query and removes a hop.

const WINDOW_DAYS: Record<string, number | null> = {
  '1m': 31, '3m': 93, '6m': 186, '1y': 366, '5y': 5 * 366, all: null,
};

interface PmmsRow {
  observation_date: string;
  rate_30y_fixed: number | string | null;
  points_30y: number | string | null;
  rate_15y_fixed: number | string | null;
  points_15y: number | string | null;
  rate_5_1_arm: number | string | null;
}

function n(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

// ── PMMS freshness + the driver that moves between prints ────────────────
//
// PMMS is a WEEKLY SURVEY published Thursdays, so its latest observation is
// routinely several days old and is nonetheless CURRENT FOR ITS CADENCE. That
// combination is what made this answer wrong without any field being wrong
// (fleet #1999): a caller who has just read a daily-index headline sees our
// 6.76% against their 7.17% and concludes we are stale or broken, when the gap
// is a real move that happened after our last print PLUS the structural
// survey-vs-daily-lock spread.
//
// We already serve the driver daily. DGS10 is the 10-year Treasury, which
// mortgage rates track, and _fredKey is already injected into this pack — so
// reporting its move SINCE the PMMS observation costs one subcall and turns a
// frozen-looking number into an explainable one.
//
// DELIBERATELY NOT DONE: no daily mortgage rate is invented, and none is
// derived from the 10-year. The spread is not stable, and a modelled rate
// presented as a rate is worse than the staleness it would paper over.
interface TreasuryMove {
  series_id: string;
  from_date: string;
  from_pct: number;
  to_date: string;
  to_pct: number;
  change_bp: number;
  observations: number;
}

async function tenYearMoveSince(
  fredKey: string | undefined,
  sinceDate: string,
): Promise<TreasuryMove | { unavailable: string }> {
  if (!fredKey) return { unavailable: 'no_fred_key: the 10-year Treasury context needs a FRED key, which this deployment did not supply.' };
  try {
    const raw = (await fredGet(
      fredKey,
      `/series/observations?series_id=DGS10&observation_start=${sinceDate}`,
    )) as { observations?: Array<{ date?: string; value?: string }> };
    // DGS10 carries "." on market holidays — those are not zeroes, drop them.
    const pts = (raw.observations ?? [])
      .map((o) => ({ date: String(o.date ?? ''), v: Number(o.value) }))
      .filter((o) => o.date !== '' && Number.isFinite(o.v));
    if (pts.length < 2) {
      return { unavailable: `insufficient_observations: DGS10 returned ${pts.length} usable point(s) since ${sinceDate}.` };
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    return {
      series_id: 'DGS10',
      from_date: first.date,
      from_pct: first.v,
      to_date: last.date,
      to_pct: last.v,
      change_bp: Math.round((last.v - first.v) * 100),
      observations: pts.length,
    };
  } catch (e) {
    // Never let the context call fail the answer it was meant to enrich.
    //
    // dropClassPrefix, not a bare wrap: fredGet throws messages that START with
    // a routing class token (`upstream_down: ...`). This string is a FRAGMENT
    // inside an `unavailable` field and can never reach position 0 of the
    // pack's error, so prefixing it would bury the token where the classifier
    // cannot see it and book an upstream outage as something else.
    return { unavailable: `fetch_failed: ${dropClassPrefix(e instanceof Error ? e.message : String(e))}` };
  }
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** The Thursday strictly after `iso`. PMMS prints weekly on Thursdays. */
function nextThursdayAfter(iso: string): string | null {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 4);
  return d.toISOString().slice(0, 10);
}

async function housingMortgageHistory(args: Record<string, unknown>) {
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  const fredKey = args._fredKey as string | undefined;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('housing-intel is not fully configured on this deployment — an operator must enable its data credentials.');
  }
  const windowKey = String(args.window ?? '1y');
  if (!(windowKey in WINDOW_DAYS)) {
    throw new Error(`window must be one of: ${Object.keys(WINDOW_DAYS).join(', ')}`);
  }
  const asOfArg = args.as_of as string | undefined;
  const asOf = asOfArg && /^\d{4}-\d{2}-\d{2}$/.test(asOfArg) ? asOfArg : null;

  // Latest snapshot (or as_of point-in-time)
  const snapshotQuery = asOf
    ? `observation_date=lte.${asOf}&order=observation_date.desc&limit=1`
    : 'order=observation_date.desc&limit=1';
  const snapshotUrl = `${supabaseUrl}/rest/v1/freddie_mac_pmms?select=*&${snapshotQuery}`;

  // Time series for the requested window
  const days = WINDOW_DAYS[windowKey];
  const seriesFromDate = days === null
    ? '1971-04-01'
    : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const seriesUrl = `${supabaseUrl}/rest/v1/freddie_mac_pmms?select=observation_date,rate_30y_fixed,rate_15y_fixed,rate_5_1_arm&observation_date=gte.${seriesFromDate}&order=observation_date.asc&limit=500`;

  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
  const [snapRes, seriesRes] = await Promise.all([pwFetch(snapshotUrl, { headers }), pwFetch(seriesUrl, { headers })]);
  if (!snapRes.ok || !seriesRes.ok) {
    throw new Error(`Freddie Mac PMMS lookup failed: snap=${snapRes.status} series=${seriesRes.status}`);
  }
  const snapRows = (await snapRes.json()) as PmmsRow[];
  let seriesRows = (await seriesRes.json()) as PmmsRow[];

  // "all" window: PostgREST max_rows (~500) truncated the series to 1971–1980; paginate to collect all ~2,900 rows
  if (days === null && seriesRows.length === 500) {
    let offset = 500;
    while (offset < 4000) {
      const pageUrl = `${supabaseUrl}/rest/v1/freddie_mac_pmms?select=observation_date,rate_30y_fixed,rate_15y_fixed,rate_5_1_arm&observation_date=gte.1971-04-01&order=observation_date.asc&limit=500&offset=${offset}`;
      const pageRes = await pwFetch(pageUrl, { headers });
      if (!pageRes.ok) break;
      const page = (await pageRes.json()) as PmmsRow[];
      seriesRows = seriesRows.concat(page);
      if (page.length < 500) break;
      offset += 500;
    }
  }

  const snap = snapRows[0];
  if (!snap) {
    return { error: 'no_data', message: asOf ? `No PMMS observation on or before ${asOf}.` : 'PMMS table is empty.' };
  }

  // Compute stats over the window for the 30y series (most-requested).
  const rates30 = seriesRows.map((r) => n(r.rate_30y_fixed)).filter((x): x is number => x !== null);
  const stats = rates30.length === 0 ? null : {
    window: windowKey,
    from_date: seriesRows[0]?.observation_date ?? null,
    to_date: seriesRows[seriesRows.length - 1]?.observation_date ?? null,
    observations: rates30.length,
    min_30y: Math.min(...rates30),
    max_30y: Math.max(...rates30),
    avg_30y: Math.round((rates30.reduce((s, v) => s + v, 0) / rates30.length) * 1000) / 1000,
  };

  // Freshness and the driver's move are computed only for a LIVE question.
  // An explicit as_of is a point-in-time historical lookup, where "how old is
  // this" is the caller's own premise and today's Treasury is irrelevant.
  const todayIso = new Date().toISOString().slice(0, 10);
  const ageDays = asOf ? null : daysBetween(snap.observation_date, todayIso);
  const treasury = asOf || ageDays === null || ageDays < 2
    ? null
    : await tenYearMoveSince(fredKey, snap.observation_date);

  const moved = treasury && !('unavailable' in treasury) ? treasury : null;
  const direction = moved === null
    ? null
    : moved.change_bp > 0 ? 'risen' : moved.change_bp < 0 ? 'fallen' : 'been flat';

  // Say it in the caller's words. An observation_date field they have to notice
  // is what produced fleet #1999 in the first place.
  const statement = asOf
    ? `Point-in-time lookup: the last PMMS print on or before ${asOf} was ${snap.observation_date}.`
    : [
        `This is a WEEKLY SURVEY, not a daily rate. Last observed ${snap.observation_date}`
          + (ageDays !== null ? ` (${ageDays} day${ageDays === 1 ? '' : 's'} ago)` : '')
          + ` at ${n(snap.rate_30y_fixed)}%.`,
        moved
          ? `Since that print the 10-year Treasury, which mortgage rates track, has ${direction}`
            + ` from ${moved.from_pct}% to ${moved.to_pct}%`
            + (moved.change_bp === 0 ? '' : ` (${moved.change_bp > 0 ? '+' : ''}${moved.change_bp}bp)`)
            + ` as of ${moved.to_date}.`
          : null,
        'Daily lock-quote indices (e.g. Mortgage News Daily) are a different instrument and typically read HIGHER than this survey average, so a daily headline quoting a higher number is not in conflict with this figure.',
        moved && moved.change_bp > 0
          ? 'Expect today\'s daily quotes to sit above this survey figure by more than the usual spread.'
          : null,
      ].filter(Boolean).join(' ');

  return {
    source: 'Freddie Mac Primary Mortgage Market Survey (PMMS)',
    note: 'Weekly survey published every Thursday. Series begins April 1971.',
    freshness: {
      observation_date: snap.observation_date,
      age_days: ageDays,
      cadence: 'weekly',
      publishes: 'Thursdays',
      next_publication_expected: asOf ? null : nextThursdayAfter(snap.observation_date),
      current_for_cadence: ageDays === null ? null : ageDays <= 7,
      instrument: 'survey_average_of_lender_quotes',
      statement,
    },
    // The driver, reported as direction and magnitude only. No mortgage rate is
    // derived from this — see the note on tenYearMoveSince.
    treasury_10y_since_observation: treasury,
    snapshot: {
      observation_date: snap.observation_date,
      rate_30y_fixed: n(snap.rate_30y_fixed),
      points_30y: n(snap.points_30y),
      rate_15y_fixed: n(snap.rate_15y_fixed),
      points_15y: n(snap.points_15y),
      rate_5_1_arm: n(snap.rate_5_1_arm),
      as_of_requested: asOf,
    },
    stats,
    series: seriesRows.map((r) => ({
      date: r.observation_date,
      rate_30y_fixed: n(r.rate_30y_fixed),
      rate_15y_fixed: n(r.rate_15y_fixed),
      rate_5_1_arm: n(r.rate_5_1_arm),
    })),
  };
}

// ── case_shiller_metro_compare implementation ──────────────────────────

// FRED series IDs for the Case-Shiller 20-city composite (SA-adjusted).
// Lower-case keys for case-insensitive lookup; multiple aliases per metro
// allowed (Washington / Washington DC / DC).
const CASE_SHILLER_METRO: Record<string, { series_id: string; name: string }> = {
  atlanta: { series_id: 'ATXRSA', name: 'Atlanta' },
  boston: { series_id: 'BOXRSA', name: 'Boston' },
  charlotte: { series_id: 'CRXRSA', name: 'Charlotte' },
  chicago: { series_id: 'CHXRSA', name: 'Chicago' },
  cleveland: { series_id: 'CEXRSA', name: 'Cleveland' },
  dallas: { series_id: 'DAXRSA', name: 'Dallas' },
  denver: { series_id: 'DNXRSA', name: 'Denver' },
  detroit: { series_id: 'DEXRSA', name: 'Detroit' },
  'las vegas': { series_id: 'LVXRSA', name: 'Las Vegas' },
  vegas: { series_id: 'LVXRSA', name: 'Las Vegas' },
  'los angeles': { series_id: 'LXXRSA', name: 'Los Angeles' },
  la: { series_id: 'LXXRSA', name: 'Los Angeles' },
  miami: { series_id: 'MIXRSA', name: 'Miami' },
  minneapolis: { series_id: 'MNXRSA', name: 'Minneapolis' },
  'new york': { series_id: 'NYXRSA', name: 'New York' },
  nyc: { series_id: 'NYXRSA', name: 'New York' },
  phoenix: { series_id: 'PHXRSA', name: 'Phoenix' },
  portland: { series_id: 'POXRSA', name: 'Portland' },
  'san diego': { series_id: 'SDXRSA', name: 'San Diego' },
  'san francisco': { series_id: 'SFXRSA', name: 'San Francisco' },
  sf: { series_id: 'SFXRSA', name: 'San Francisco' },
  seattle: { series_id: 'SEXRSA', name: 'Seattle' },
  tampa: { series_id: 'TPXRSA', name: 'Tampa' },
  washington: { series_id: 'WDXRSA', name: 'Washington DC' },
  'washington dc': { series_id: 'WDXRSA', name: 'Washington DC' },
  'washington d.c.': { series_id: 'WDXRSA', name: 'Washington DC' },
  dc: { series_id: 'WDXRSA', name: 'Washington DC' },
};

type MetroResult = {
  requested: string;
  matched_name: string;
  series_id: string;
  latest_date: string | null;
  /** Days between latest_date and the day of the call — fleet #2002. */
  latest_age_days: number | null;
  latest_value: number | null;
  change_3m_pct: number | null;
  change_12m_pct: number | null;
  peak_value: number | null;
  peak_date: string | null;
  drawdown_from_peak_pct: number | null;
  softening: boolean;
  error?: string;
};

async function caseShillerMetroCompare(args: Record<string, unknown>) {
  const fredKey = args._fredKey as string;
  if (!fredKey) throw new Error('FRED API key required (_fredKey).');
  const metroInputs = args.metros;
  if (!Array.isArray(metroInputs) || metroInputs.length === 0) {
    throw new Error('Pass an array of metro names, e.g. metros: ["Denver", "Phoenix", "Tampa"].');
  }
  const availableMetros = [...new Set(Object.values(CASE_SHILLER_METRO).map((m) => m.name))].sort();
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const asOfIso = today();

  const results: MetroResult[] = await Promise.all(
    (metroInputs as unknown[]).map(async (raw): Promise<MetroResult> => {
      const requested = String(raw);
      const key = requested.trim().toLowerCase();
      const meta = CASE_SHILLER_METRO[key];
      if (!meta) {
        return {
          requested, matched_name: requested, series_id: '',
          latest_date: null, latest_age_days: null, latest_value: null,
          change_3m_pct: null, change_12m_pct: null,
          peak_value: null, peak_date: null, drawdown_from_peak_pct: null,
          softening: false,
          error: `Metro "${requested}" not in Case-Shiller 20-city composite. Available: ${availableMetros.join(', ')}.`,
        };
      }
      try {
        // Pull 120 monthly obs (~10 years) — enough for both recent-change
        // metrics and a robust peak/drawdown calculation in one fetch.
        const data = (await fredGet(
          fredKey,
          `/series/observations?series_id=${meta.series_id}&sort_order=desc&limit=120`,
        )) as { observations: { date: string; value: string }[] };
        const obs = (data.observations ?? [])
          .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
          .filter((o) => !isNaN(o.value));
        if (obs.length === 0) {
          return {
            requested, matched_name: meta.name, series_id: meta.series_id,
            latest_date: null, latest_age_days: null, latest_value: null,
            change_3m_pct: null, change_12m_pct: null,
            peak_value: null, peak_date: null, drawdown_from_peak_pct: null,
            softening: false, error: 'No observations returned by FRED.',
          };
        }
        const latest = obs[0];
        const m3 = obs[3] ?? null;
        const m12 = obs[12] ?? null;
        let peak = obs[0];
        for (const o of obs) if (o.value > peak.value) peak = o;
        const change3 = m3 ? ((latest.value - m3.value) / m3.value) * 100 : null;
        const change12 = m12 ? ((latest.value - m12.value) / m12.value) * 100 : null;
        const drawdown = peak.value > 0 ? ((latest.value - peak.value) / peak.value) * 100 : null;
        const softening = (change3 !== null && change3 < 0) || (drawdown !== null && drawdown <= -2);
        return {
          requested, matched_name: meta.name, series_id: meta.series_id,
          latest_date: latest.date, latest_age_days: daysBetween(latest.date, asOfIso),
          latest_value: round2(latest.value),
          change_3m_pct: change3 !== null ? round2(change3) : null,
          change_12m_pct: change12 !== null ? round2(change12) : null,
          peak_value: round2(peak.value), peak_date: peak.date,
          drawdown_from_peak_pct: drawdown !== null ? round2(drawdown) : null,
          softening,
        };
      } catch (err) {
        return {
          requested, matched_name: meta.name, series_id: meta.series_id,
          latest_date: null, latest_age_days: null, latest_value: null,
          change_3m_pct: null, change_12m_pct: null,
          peak_value: null, peak_date: null, drawdown_from_peak_pct: null,
          softening: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  // Soft → strong: most-negative drawdown first.
  const ranked = [...results]
    .filter((r) => !r.error && r.drawdown_from_peak_pct !== null)
    .sort((a, b) => (a.drawdown_from_peak_pct ?? 0) - (b.drawdown_from_peak_pct ?? 0))
    .map((r) => r.matched_name);

  // ── Time disclosure (fleet #2002) ────────────────────────────────────
  //
  // Case-Shiller ran ~106 days behind with no note, no cadence statement and
  // nothing in the tool description. `latest_date` was in the payload and
  // that was the whole disclosure — a caller asking "which metros are
  // softening" got an answer about early summer, presented as the present,
  // with every field accurate. Two distinct things have to be said and only
  // one of them is an age: the index also SMOOTHS, so even the newest value
  // is a trailing three-month window rather than a point-in-time price.
  const dated = results
    .filter((r) => r.latest_date !== null)
    .sort((a, b) => (a.latest_date as string).localeCompare(b.latest_date as string));
  const newestObs = dated[dated.length - 1]?.latest_date ?? null;
  const oldestObs = dated[0]?.latest_date ?? null;
  const ageDays = newestObs ? daysBetween(newestObs, asOfIso) : null;

  const statement = newestObs === null
    ? 'No metro returned an observation, so the age of this comparison cannot be stated.'
    : [
        `This is NOT today's market. Case-Shiller is a MONTHLY index published on the last Tuesday of each month,`
          + ` covering sales that closed about two months earlier — so the newest observation here is ${newestObs},`
          + ` ${ageDays} day${ageDays === 1 ? '' : 's'} old. These are ${monthYear(newestObs)} prices.`,
        `Each value is additionally a THREE-MONTH MOVING AVERAGE of repeat sales, so ${monthYear(newestObs)} means the three months ending ${monthYear(newestObs)} — a trailing window, not a price on a day.`,
        'That combination is why "softening", the 3-month and 12-month changes, and the ranking below all describe that window:'
          + ' a metro that turned in the last quarter cannot appear here yet, and one shown as softening may already have stopped.',
        oldestObs !== null && oldestObs !== newestObs
          ? `Metros here do not all share a date: the oldest is ${oldestObs}. Per-metro ages are in latest_age_days.`
          : null,
      ].filter(Boolean).join(' ');

  return {
    metros: results,
    softest_to_strongest: ranked,
    freshness: {
      as_of: asOfIso,
      newest_observation_date: newestObs,
      oldest_observation_date: oldestObs,
      age_days: ageDays,
      cadence: 'monthly',
      release_schedule: 'S&P publishes on the last Tuesday of each month, covering closings about two months earlier.',
      smoothing: 'three-month moving average of repeat sales',
      statement,
    },
    methodology:
      'softening = 3-month change < 0% OR drawdown from all-time peak ≤ -2%. Ranking is by drawdown from peak (most negative first). Source: S&P CoreLogic Case-Shiller 20-city composite, monthly SA, via FRED. Values are a 3-month moving average released on a ~2-month lag — see `freshness` for how old this comparison actually is.',
  };
}

// ── callTool dispatcher ────────────────────────────────────────────────

// Cross-metro rental-yield screen. Ranks every metro by gross rent yield in a
// fixed number of Supabase queries (latest date per metric, then all metros at
// that date) — NO per-metro fan-out, so it can't blow the worker's resource
// budget the way a 25-metro × N-metric orchestration would.
async function housingMarketScreen(args: Record<string, unknown>) {
  const supabaseUrl = args._supabaseUrl as string | undefined;
  const supabaseKey = args._supabaseKey as string | undefined;
  if (!supabaseUrl || !supabaseKey) {
    return { error: 'unavailable', message: 'Zillow data source is not configured on this connection.' };
  }
  const direction = (args.direction as string) === 'bottom' ? 'bottom' : 'top';
  const limit = Math.min(Math.max((args.limit as number) ?? 25, 1), 100);
  const minVal = typeof args.min_home_value === 'number' ? args.min_home_value : undefined;
  const maxVal = typeof args.max_home_value === 'number' ? args.max_home_value : undefined;

  // Zillow publishes every metro on the same monthly date, so one row gives the
  // latest date for each metric.
  const [zoriDateRows, zhviDateRows] = await Promise.all([
    zillowGet<Array<{ observation_date: string }>>(supabaseUrl, supabaseKey, 'metric=eq.zori&region_type=eq.metro&select=observation_date&order=observation_date.desc&limit=1'),
    zillowGet<Array<{ observation_date: string }>>(supabaseUrl, supabaseKey, 'metric=eq.zhvi&region_type=eq.metro&select=observation_date&order=observation_date.desc&limit=1'),
  ]);
  const rentDate = zoriDateRows[0]?.observation_date;
  const valueDate = zhviDateRows[0]?.observation_date;
  if (!rentDate || !valueDate) {
    return { error: 'unavailable', message: 'No Zillow rent (ZORI) / home-value (ZHVI) metro data available.' };
  }

  // All metros' latest rent + value — two queries, joined in memory.
  const [rents, values] = await Promise.all([
    zillowGet<Array<{ region_id: number; region_name: string; value: number | null }>>(supabaseUrl, supabaseKey, `metric=eq.zori&region_type=eq.metro&observation_date=eq.${rentDate}&select=region_id,region_name,value&limit=2000`),
    zillowGet<Array<{ region_id: number; value: number | null }>>(supabaseUrl, supabaseKey, `metric=eq.zhvi&region_type=eq.metro&observation_date=eq.${valueDate}&select=region_id,value&limit=2000`),
  ]);

  const valueById = new Map<number, number>();
  for (const v of values) if (typeof v.value === 'number') valueById.set(v.region_id, v.value);

  const markets: Array<{ metro: string; monthly_rent: number; typical_home_value: number; gross_rent_yield_pct: number }> = [];
  for (const r of rents) {
    const home = valueById.get(r.region_id);
    if (typeof r.value !== 'number' || !home) continue;
    if (minVal !== undefined && home < minVal) continue;
    if (maxVal !== undefined && home > maxVal) continue;
    markets.push({
      metro: r.region_name,
      monthly_rent: Math.round(r.value),
      typical_home_value: Math.round(home),
      gross_rent_yield_pct: Math.round((r.value * 12) / home * 10000) / 100,
    });
  }
  markets.sort((a, b) =>
    direction === 'top'
      ? b.gross_rent_yield_pct - a.gross_rent_yield_pct
      : a.gross_rent_yield_pct - b.gross_rent_yield_pct,
  );

  // ── Time disclosure (fleet #2011, milder case of #2002's shape) ────────
  //
  // rent_as_of and home_value_as_of were already in the payload — the gap is
  // that gross_rent_yield_pct is a RATIO of two Zillow series (ZORI, ZHVI)
  // fetched with two independent "latest date" queries, so they need not
  // share a date, and nothing said how old either one is or what to do if
  // they diverge.
  const asOfIso = today();
  const rentVintage = vintage('rent (Zillow ZORI)', rentDate, 'monthly', asOfIso);
  const valueVintage = vintage('home_value (Zillow ZHVI)', valueDate, 'monthly', asOfIso);
  const datesMatch = rentDate === valueDate;

  return {
    analysis: 'housing_market_screen',
    ranked_by: 'gross_rent_yield_pct',
    direction,
    rent_as_of: rentDate,
    home_value_as_of: valueDate,
    metros_evaluated: markets.length,
    markets: markets.slice(0, limit),
    note: 'gross_rent_yield_pct = Zillow ZORI median monthly rent × 12 ÷ Zillow ZHVI typical home value. Cash-flow-first screen for rental markets (higher = better gross yield). Gross only — excludes taxes, insurance, vacancy, management, and financing. Drill into a chosen metro with housing_market_snapshot.',
    freshness: {
      as_of: asOfIso,
      dates_match: datesMatch,
      statement: !rentVintage || !valueVintage
        ? 'Could not compute an age for one of rent_as_of / home_value_as_of.'
        : datesMatch
          ? `rent_as_of and home_value_as_of are the SAME Zillow release (${rentDate}, ${rentVintage.age_days} days old, published monthly), so gross_rent_yield_pct compares two numbers from the same month.`
          : `rent_as_of (${rentDate}, ${rentVintage.age_days} days old) and home_value_as_of (${valueDate}, ${valueVintage.age_days} days old) are DIFFERENT Zillow releases this call — gross_rent_yield_pct is a ratio of two numbers from different months, not one snapshot.`,
    },
  };
}

const MSA_GEO = 'metropolitan statistical area/micropolitan statistical area';

// Resolve a metro name (e.g. "Lubbock, TX" from housing_market_screen) to its
// CBSA code via the embedded map — avoids the all-MSA Census wildcard, which is
// intermittently >50s from CF egress and unusable live. Tries exact normalized
// match, then primary-city + state (handles multi-name metros like "New York,
// NY" → "New York-Newark-Jersey City, NY-NJ-PA"), then a city substring.
function resolveCbsa(metro: string): string | null {
  const q = metro.toLowerCase().replace(/ (metro|micro) area$/, '').trim();
  if (MSA_CBSA[q]) return MSA_CBSA[q];
  const [qCity, qState] = q.split(',').map((s) => s.trim());
  if (qCity) {
    for (const [name, cbsa] of Object.entries(MSA_CBSA)) {
      const [nCity, nState] = name.split(',').map((s) => s.trim());
      if (nCity?.split('-')[0] === qCity && (!qState || (nState ?? '').split('-')[0] === qState)) return cbsa;
    }
    for (const [name, cbsa] of Object.entries(MSA_CBSA)) {
      if (name.includes(qCity) && (!qState || name.includes(qState))) return cbsa;
    }
  }
  return null;
}

// Census ACS 5-year for a SPECIFIC set of CBSAs (fast: ~2s, vs the all-MSA
// wildcard which is wildly intermittent). Reshapes [header, ...rows] → objects
// keyed by the geography (CBSA) column.
async function censusAcsByCbsa(key: string, year: number, vars: string, cbsas: string[]): Promise<Record<string, Record<string, string>>> {
  if (cbsas.length === 0) return {};
  const url = `https://api.census.gov/data/${year}/acs/acs5?get=${encodeURIComponent(vars)}&for=${encodeURIComponent(MSA_GEO + ':' + cbsas.join(','))}&key=${encodeURIComponent(key)}`;
  const res = await pwFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Census ACS ${year}: ${res.status}`);
  const data = (await res.json()) as string[][];
  const [header, ...rows] = data;
  const byCbsa: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    const obj = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    byCbsa[obj[MSA_GEO]] = obj;
  }
  return byCbsa;
}

// Metro demand / rent-durability enrichment — the deterministic Stage-2 signal
// the FRED router couldn't give (opaque per-metro series IDs). Resolves the
// requested metros to CBSAs from the embedded map, then ONE fast per-CBSA ACS
// query (current + a prior year for growth). No all-MSA wildcard, no fan-out.
async function housingMetroDemand(args: Record<string, unknown>) {
  const key = args._censusKey as string | undefined;
  if (!key) return { error: 'unavailable', message: 'Census key not configured on this connection (platform key missing).' };

  const requested = Array.isArray(args.metros)
    ? (args.metros as unknown[]).map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (requested.length === 0) {
    return { error: 'metros_required', message: 'Pass `metros` — an array of metro names to enrich, e.g. the top results from housing_market_screen (["Lubbock, TX","Pittsburgh, PA"]).' };
  }
  const limit = Math.min(Math.max((args.limit as number) ?? 25, 1), 100);

  // Resolve names → CBSAs (dedup), tracking anything we couldn't match.
  const resolved: Array<{ metro: string; cbsa: string }> = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const m of requested.slice(0, limit)) {
    const cbsa = resolveCbsa(m);
    if (!cbsa) { unresolved.push(m); continue; }
    if (seen.has(cbsa)) continue;
    seen.add(cbsa);
    resolved.push({ metro: m, cbsa });
  }
  if (resolved.length === 0) {
    return { error: 'no_metros_resolved', message: `None of the requested metros matched a known CBSA: ${unresolved.join(', ')}. Use "City, ST" form.`, unresolved };
  }

  const cbsas = resolved.map((r) => r.cbsa);
  const VARS = 'NAME,B01003_001E,B19013_001E,B25003_001E,B25003_003E,B23025_003E,B23025_005E';
  const [cur, prior] = await Promise.all([
    safe(censusAcsByCbsa(key, 2022, VARS, cbsas)),
    safe(censusAcsByCbsa(key, 2017, 'NAME,B01003_001E', cbsas)),
  ]);
  if (isError(cur)) return { error: 'unavailable', message: `Census ACS unavailable: ${cur.error}` };

  // Prior-year population, keyed by CBSA. ACS 5-yr endpoints accept the same
  // CBSA codes for 2017 and 2022, so a direct code join is reliable here.
  const priorPop: Record<string, number> = {};
  if (!isError(prior)) {
    for (const [cbsa, row] of Object.entries(prior)) {
      const p = Number(row.B01003_001E);
      if (Number.isFinite(p)) priorPop[cbsa] = p;
    }
  }
  const growthBasis = isError(prior)
    ? `unavailable (prior-year ACS not loaded: ${prior.error})`
    : Object.keys(priorPop).length > 0
      ? '2017 → 2022 ACS 5-yr'
      : 'unavailable (prior-year ACS returned no rows)';

  const n = (v: string | undefined): number | null => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const r1 = (x: number) => Math.round(x * 10) / 10;

  const metros = resolved.map(({ metro, cbsa }) => {
    const r = cur[cbsa];
    if (!r) return { metro, cbsa, status: 'no_acs_data', population_growth_5yr_pct: null as number | null };
    const pop = n(r.B01003_001E);
    const occ = n(r.B25003_001E); const renters = n(r.B25003_003E);
    const lf = n(r.B23025_003E); const unemp = n(r.B23025_005E);
    const prev = priorPop[cbsa];
    return {
      metro: r.NAME ?? metro,
      cbsa,
      population: pop,
      population_growth_5yr_pct: prev && pop ? r1((pop - prev) / prev * 100) : null,
      median_household_income: n(r.B19013_001E),
      renter_share_pct: occ && renters != null ? r1((renters / occ) * 100) : null,
      unemployment_rate_pct: lf && unemp != null ? r1((unemp / lf) * 100) : null,
    };
  });
  metros.sort((a, b) => (b.population_growth_5yr_pct ?? -999) - (a.population_growth_5yr_pct ?? -999));

  // ── Time disclosure for ACS 5-yr estimates (fleet #2011) ──────────────
  //
  // Census ACS 5-year estimates are the highest-lag source in this pack: the
  // "2022" vintage below is a 5-YEAR ROLLING AVERAGE covering 2018-2022,
  // centered on ~2020, and the Census Bureau did not release it until
  // 2023-12-07. Every number in `metros` is real and correctly labeled
  // `acs_year: 2022` — but nothing previously said that "2022" here means a
  // half-decade-old average released nearly two years after its own window
  // closed, so a caller reasonably reads it as a 2022 point estimate rather
  // than what it is.
  const ACS_2022_5YR_RELEASE_DATE = '2023-12-07';
  const asOfIso = today();
  const acsAgeDays = daysBetween(ACS_2022_5YR_RELEASE_DATE, asOfIso);

  return {
    analysis: 'housing_metro_demand',
    acs_year: 2022,
    population_growth_basis: growthBasis,
    matched: metros.length,
    ...(unresolved.length ? { unresolved } : {}),
    metros,
    note: 'Demand + rent-durability per metro from Census ACS 5-yr (CBSA-resolved locally — no slow all-MSA query, no FRED series-ID guessing). population_growth_5yr = tenant-demand proxy; renter_share = renters-by-necessity; unemployment + median income = demand durability/affordability. Supply (building permits) is NOT here — pair with FRED PERMIT* for the oversupply check.',
    freshness: {
      as_of: asOfIso,
      acs_5yr_release_date: ACS_2022_5YR_RELEASE_DATE,
      age_days_since_release: acsAgeDays,
      statement: `\`acs_year: 2022\` is NOT a 2022 point-in-time snapshot. It is the Census Bureau's 2018-2022 ACS 5-YEAR estimate — a rolling average centered on roughly 2020 — released ${ACS_2022_5YR_RELEASE_DATE}, ${acsAgeDays} days before this call. `
        + `This is the highest-lag source in the housing-intel pack: population, income, renter share and unemployment here can be several years stale relative to a fast-moving metro. `
        + `population_growth_5yr_pct compounds this further — it compares the 2018-2022 average against the 2013-2017 average (${growthBasis}), so it describes a decade-old-to-half-decade-old trend, not a recent one. `
        + 'Use this tool for structural demand (is the metro growing at all), not for a current-quarter read — pair with housing_market_screen (Zillow, monthly) for anything time-sensitive.',
    },
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Clean gateway-injected context
  delete args._context;

  switch (name) {
    case 'case_shiller_metro_compare':
      return caseShillerMetroCompare(args);
    case 'housing_market_snapshot':
      return housingMarketSnapshot(args);
    case 'housing_property_report':
      return housingPropertyReport(args);
    case 'housing_rental_analysis':
      return housingRentalAnalysis(args);
    case 'housing_affordability_check':
      return housingAffordabilityCheck(args);
    case 'housing_employment_outlook':
      return housingEmploymentOutlook(args);
    case 'housing_signal_scan':
      return housingSignalScan(args);
    case 'housing_mortgage_history':
      return housingMortgageHistory(args);
    case 'housing_market_screen':
      return housingMarketScreen(args);
    case 'housing_metro_demand':
      return housingMetroDemand(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 50 } } satisfies McpToolExport;
