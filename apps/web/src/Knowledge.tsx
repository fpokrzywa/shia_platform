import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, ApiError, type User } from "./api";
import "./Knowledge.css";

type Kind = "recipe" | "discovery_guide" | "architecture_pattern";
type SourceRef = { title: string; url: string };
type Definition = {
  key: string;
  version: number;
  kind: Kind;
  title: string;
  summary: string;
  body: string;
  sourceRefs: SourceRef[];
};
type Version = {
  knowledge_key: string;
  kind: Kind;
  title: string;
  archived_at: string | null;
  set_revision: number | string;
  version: number;
  state: "draft" | "submitted" | "published" | "retired";
  revision: number | string;
  author_id: string;
  definition: Definition;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_rationale: string | null;
};
type Link = {
  id: string;
  knowledge_key: string;
  knowledge_version: number;
  rationale: string;
  linked_at: string;
  definition: Definition;
  state: string;
};
type Source = { id: string; type: "note" | "learning_log"; label: string };
const message = (error: unknown) =>
  error instanceof Error ? error.message : "The request failed.";
const fields = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget).entries());
};
const label = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
const blankRef = (): SourceRef => ({ title: "", url: "" });

export function Knowledge({
  user,
  engagementId,
  sources = [],
}: {
  user: User;
  engagementId?: string;
  sources?: Source[];
}) {
  const admin = user.role === "practice_admin",
    [versions, setVersions] = useState<Version[]>([]),
    [links, setLinks] = useState<Link[]>([]),
    [selected, setSelected] = useState<Version | null>(null),
    [status, setStatus] = useState("active"),
    [state, setState] = useState("all"),
    [kind, setKind] = useState("all"),
    [refs, setRefs] = useState<SourceRef[]>([blankRef()]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [keys] = useState(() => new Map<string, string>());
  async function refresh() {
    const library = await api<{ versions: Version[] }>("/api/knowledge");
    setVersions(library.versions);
    if (engagementId)
      setLinks(
        (
          await api<{ links: Link[] }>(
            `/api/engagements/${engagementId}/knowledge`,
          )
        ).links,
      );
    setError("");
  }
  useEffect(() => {
    void refresh().catch((e) => setError(message(e)));
  }, [engagementId, user.id]);
  async function mutate(
    path: string,
    payload: Record<string, unknown>,
    success: string,
  ) {
    const intent = JSON.stringify([path, payload]);
    let requestKey = keys.get(intent);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      keys.set(intent, requestKey);
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<any>(path, { ...payload, requestKey });
      keys.delete(intent);
      await refresh();
      setNotice(success);
      return result;
    } catch (e) {
      setError(message(e));
      if (e instanceof ApiError && e.status === 409)
        setNotice("This version changed. Refresh before trying again.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const shown = useMemo(
    () =>
      versions.filter(
        (v) =>
          (status === "all" ||
            (status === "archived") === Boolean(v.archived_at)) &&
          (state === "all" || v.state === state) &&
          (kind === "all" || v.kind === kind),
      ),
    [versions, status, state, kind],
  );
  const canAuthor = (v: Version) => admin || v.author_id === user.id;
  async function create(e: FormEvent<HTMLFormElement>, source?: Source) {
    const form = e.currentTarget,
      d = fields(e),
      sourceRefs = refs.filter((x) => x.title.trim() || x.url.trim());
    const payload = {
      key: d.key,
      kind: d.kind,
      title: d.title,
      summary: d.summary,
      body: d.body,
      sourceRefs,
    };
    const path =
      source && engagementId
        ? `/api/engagements/${engagementId}/knowledge/submit`
        : "/api/knowledge";
    const result = await mutate(
      path,
      source
        ? { ...payload, source: { type: source.type, id: source.id } }
        : payload,
      "Knowledge draft created.",
    );
    if (result) {
      form.reset();
      setRefs([blankRef()]);
    }
  }
  function sourceFields() {
    return (
      <>
        <label>
          Knowledge key
          <input name="key" required maxLength={200} />
        </label>
        <label>
          Type
          <select name="kind" defaultValue="recipe">
            <option value="recipe">Recipe</option>
            <option value="discovery_guide">Discovery guide</option>
            <option value="architecture_pattern">Architecture pattern</option>
          </select>
        </label>
        <label className="knowledge-wide">
          Title
          <input name="title" required maxLength={300} />
        </label>
        <label className="knowledge-wide">
          Summary
          <textarea name="summary" required maxLength={5000} />
        </label>
        <label className="knowledge-wide">
          Reusable content
          <textarea name="body" required maxLength={50000} />
        </label>
        <fieldset className="knowledge-wide">
          <legend>Source references</legend>
          {refs.map((ref, index) => (
            <div className="source-row" key={index}>
              <input
                aria-label={`Source ${index + 1} title`}
                placeholder="Reference title"
                value={ref.title}
                onChange={(e) =>
                  setRefs((current) =>
                    current.map((x, i) =>
                      i === index ? { ...x, title: e.target.value } : x,
                    ),
                  )
                }
              />
              <input
                aria-label={`Source ${index + 1} URL`}
                placeholder="https://"
                type="url"
                value={ref.url}
                onChange={(e) =>
                  setRefs((current) =>
                    current.map((x, i) =>
                      i === index ? { ...x, url: e.target.value } : x,
                    ),
                  )
                }
              />
              {refs.length > 1 && (
                <button
                  type="button"
                  onClick={() =>
                    setRefs((x) => x.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setRefs((x) => [...x, blankRef()])}
          >
            Add reference
          </button>
        </fieldset>
      </>
    );
  }
  return (
    <section className="knowledge">
      <header className="knowledge-header">
        <div>
          <h2>Knowledge library</h2>
          <p>
            Turn reviewed delivery experience into reusable guidance with a
            clear source and version history.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() => void refresh().catch((e) => setError(message(e)))}
        >
          Refresh
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="knowledge-tools">
        <label>
          Library
          <select
            aria-label="Library status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </select>
        </label>
        <label>
          Review status
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="submitted">Awaiting review</option>
            <option value="published">Published</option>
            <option value="retired">Retired</option>
          </select>
        </label>
        <label>
          Knowledge type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All types</option>
            <option value="recipe">Recipes</option>
            <option value="discovery_guide">Discovery guides</option>
            <option value="architecture_pattern">Architecture patterns</option>
          </select>
        </label>
      </div>
      <div className="knowledge-layout">
        <aside className="knowledge-index">
          {shown.length ? (
            shown.map((v) => (
              <button
                className={
                  selected?.knowledge_key === v.knowledge_key &&
                  selected.version === v.version
                    ? "selected"
                    : ""
                }
                key={`${v.knowledge_key}-${v.version}`}
                onClick={() => setSelected(v)}
              >
                <strong>{v.definition.title}</strong>
                <span>
                  {label(v.kind)} · Version {v.version}
                </span>
                <span className={`knowledge-state ${v.state}`}>
                  {label(v.state)}
                </span>
              </button>
            ))
          ) : (
            <p>No knowledge matches these filters.</p>
          )}
        </aside>
        <main className="knowledge-reader">
          {selected ? (
            <VersionView
              version={selected}
              admin={admin}
              canAuthor={canAuthor(selected)}
              busy={busy}
              {...(engagementId ? { engagementId } : {})}
              linked={links.some(
                (x) =>
                  x.knowledge_key === selected.knowledge_key &&
                  x.knowledge_version === selected.version,
              )}
              mutate={mutate}
            />
          ) : (
            <div className="knowledge-empty">
              <h3>Choose a guide</h3>
              <p>
                Select a version to read its content, source references, and
                review history.
              </p>
            </div>
          )}
        </main>
      </div>
      <details className="knowledge-create">
        <summary>Create reusable knowledge</summary>
        <form onSubmit={(e) => void create(e)}>
          {sourceFields()}
          <button disabled={busy}>Create draft</button>
        </form>
      </details>
      {engagementId && sources.length > 0 && (
        <details className="knowledge-create">
          <summary>Submit an engagement lesson</summary>
          <p>
            Only the reusable text entered below is shared. The original note or
            learning log stays private to the engagement.
          </p>
          <form
            onSubmit={(e) => {
              const d = new FormData(e.currentTarget),
                source = sources.find((x) => x.id === d.get("sourceId"));
              if (source) void create(e, source);
            }}
          >
            <label className="knowledge-wide">
              Private source
              <select name="sourceId" required>
                {sources.map((x) => (
                  <option key={`${x.type}-${x.id}`} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            {sourceFields()}
            <button disabled={busy}>Create sanitized draft</button>
          </form>
        </details>
      )}
    </section>
  );
}

function VersionView({
  version,
  admin,
  canAuthor,
  busy,
  engagementId,
  linked,
  mutate,
}: {
  version: Version;
  admin: boolean;
  canAuthor: boolean;
  busy: boolean;
  engagementId?: string;
  linked: boolean;
  mutate: (
    path: string,
    payload: Record<string, unknown>,
    success: string,
  ) => Promise<any>;
}) {
  const path = `/api/knowledge/${encodeURIComponent(version.knowledge_key)}/${version.version}`,
    d = version.definition;
  return (
    <article>
      <header>
        <div>
          <span className={`knowledge-state ${version.state}`}>
            {label(version.state)}
          </span>
          <h3>{d.title}</h3>
          <p>{d.summary}</p>
        </div>
        <p className="version-mark">
          Version {version.version}
          <br />
          {label(d.kind)}
        </p>
      </header>
      <div className="knowledge-body">
        {d.body.split(/\n\n+/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {d.sourceRefs.length > 0 && (
        <section>
          <h4>Sources</h4>
          <ul>
            {d.sourceRefs.map((ref, i) => (
              <li key={`${ref.url}-${i}`}>
                <a href={ref.url} target="_blank" rel="noreferrer">
                  {ref.title}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {version.reviewed_at && (
        <p className="review-note">
          <strong>Review rationale</strong>
          {version.review_rationale}
        </p>
      )}
      <div className="knowledge-actions">
        {canAuthor && version.state === "draft" && (
          <details>
            <summary>Edit draft</summary>
            <form
              onSubmit={(e) => {
                const form = e.currentTarget,
                  x = fields(e);
                void mutate(
                  `${path}/edit`,
                  {
                    expectedRevision: Number(version.revision),
                    title: x.title,
                    summary: x.summary,
                    body: x.body,
                  },
                  "Draft updated.",
                ).then((ok) => ok && form.reset());
              }}
            >
              <label>
                Title
                <input name="title" defaultValue={d.title} required />
              </label>
              <label>
                Summary
                <textarea name="summary" defaultValue={d.summary} required />
              </label>
              <label>
                Reusable content
                <textarea name="body" defaultValue={d.body} required />
              </label>
              <button disabled={busy}>Save draft</button>
            </form>
          </details>
        )}
        {canAuthor && version.state === "draft" && (
          <Action
            title="Submit for review"
            label="Submission rationale"
            button="Send for review"
            busy={busy}
            run={(r) =>
              mutate(
                `${path}/submit`,
                { expectedRevision: Number(version.revision), rationale: r },
                "Sent for review.",
              )
            }
          />
        )}{" "}
        {(admin || version.state === "submitted") &&
          version.state === "submitted" && (
            <Action
              title="Review this version"
              label="Review rationale"
              button="Publish"
              busy={busy}
              run={(r) =>
                mutate(
                  `${path}/publish`,
                  { expectedRevision: Number(version.revision), rationale: r },
                  "Knowledge published.",
                )
              }
            />
          )}{" "}
        {canAuthor && version.state === "published" && (
          <Action
            title="Create a new version"
            label="Reason for change"
            button="Create draft version"
            busy={busy}
            run={(r) =>
              mutate(
                `${path}/versions`,
                { expectedRevision: Number(version.revision), rationale: r },
                "New draft version created.",
              )
            }
          />
        )}{" "}
        {admin && version.state === "published" && (
          <Action
            title="Retire this version"
            label="Retirement rationale"
            button="Retire version"
            busy={busy}
            run={(r) =>
              mutate(
                `${path}/retire`,
                { expectedRevision: Number(version.revision), rationale: r },
                "Version retired.",
              )
            }
          />
        )}{" "}
        {admin && (
          <button
            disabled={busy}
            onClick={() =>
              void mutate(
                `${path}/${version.archived_at ? "restore" : "archive"}`,
                { expectedRevision: Number(version.set_revision) },
                version.archived_at
                  ? "Knowledge restored."
                  : "Knowledge archived.",
              )
            }
          >
            {version.archived_at
              ? "Restore library item"
              : "Archive library item"}
          </button>
        )}{" "}
        {engagementId &&
          version.state === "published" &&
          !version.archived_at &&
          !linked && (
            <Action
              title="Use in this engagement"
              label="Why this guidance applies"
              button="Link published version"
              busy={busy}
              run={(r) =>
                mutate(
                  `/api/engagements/${engagementId}/knowledge`,
                  {
                    key: version.knowledge_key,
                    version: version.version,
                    rationale: r,
                  },
                  "Knowledge linked to engagement.",
                )
              }
            />
          )}{" "}
        {linked && (
          <span className="linked-mark">Linked to this engagement</span>
        )}
      </div>
    </article>
  );
}
function Action({
  title,
  label: fieldLabel,
  button,
  busy,
  run,
}: {
  title: string;
  label: string;
  button: string;
  busy: boolean;
  run: (r: string) => Promise<any>;
}) {
  return (
    <details>
      <summary>{title}</summary>
      <form
        onSubmit={(e) => {
          const form = e.currentTarget,
            d = fields(e);
          void run(String(d.rationale)).then((ok) => ok && form.reset());
        }}
      >
        <label>
          {fieldLabel}
          <textarea name="rationale" required maxLength={5000} />
        </label>
        <button disabled={busy}>{button}</button>
      </form>
    </details>
  );
}
