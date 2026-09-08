import { DiscoveryEditor } from "./DiscoveryEditor";
import { useEffect, useState, type FormEvent } from "react";
import { api, type Member } from "./api";
import "./DiscoveryWork.css";
type Row = { id: string; revision: number; [key: string]: unknown };
type Metric = Row & {
  name: string;
  unit: string;
  description: string | null;
  baseline: number | null;
  target: number | null;
  observations: {
    id: string;
    observedOn: string;
    value: number;
    note: string | null;
    evidenceId: string | null;
  }[];
};
type Discovery = {
  sessions: Row[];
  useCases: Row[];
  assumptions: Row[];
  approaches: Row[];
  outcomes: Metric[];
  acceptedScope:
    | (Row & {
        scopeId: string;
        version: number;
        estimate: string;
        commitments: string[];
      })
    | null;
};
const fd = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget).entries());
  },
  err = (e: unknown) => (e instanceof Error ? e.message : "Request failed."),
  label = (s: string) =>
    s.replaceAll("_", " ").replace(/^./, (x) => x.toUpperCase());
export function DiscoveryWork({ engagementId }: { engagementId: string }) {
  const base = `/api/engagements/${encodeURIComponent(engagementId)}/discovery`,
    [data, setData] = useState<Discovery | null>(null),
    [members, setMembers] = useState<Member[]>([]),
    [scopes, setScopes] = useState<
      { id: string; version: number; state: string; estimate: string }[]
    >([]),
    [evidence, setEvidence] = useState<{ id: string; title: string }[]>([]),
    [tab, setTab] = useState("sessions"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [keys] = useState(() => new Map<string, string>());
  async function refresh() {
    const [d, m, v, w] = await Promise.all([
      api<{ discovery: Discovery }>(base),
      api<{ members: Member[] }>(`/api/engagements/${engagementId}/members`),
      api<{
        delivery: {
          scopes: {
            id: string;
            version: number;
            state: string;
            estimate: string;
          }[];
        };
      }>(`/api/engagements/${engagementId}/delivery`),
      api<{ work: { evidence: { id: string; title: string }[] } }>(
        `/api/engagements/${engagementId}/work`,
      ),
    ]);
    setData(d.discovery);
    setMembers(
      Array.from(new Map(m.members.map((x) => [x.userId, x])).values()),
    );
    setScopes(v.delivery.scopes);
    setEvidence(w.work.evidence);
    setError("");
  }
  useEffect(() => {
    void refresh().catch((e) => setError(err(e)));
  }, [engagementId]);
  async function post(
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
    try {
      await api(path, { ...payload, requestKey });
      await refresh();
      keys.delete(intent);
      setNotice(success);
      setError("");
      return true;
    } catch (e) {
      setError(err(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit(
    e: FormEvent<HTMLFormElement>,
    path: string,
    make: (d: Record<string, FormDataEntryValue>) => Record<string, unknown>,
    success: string,
  ) {
    const form = e.currentTarget,
      d = fd(e);
    if (await post(path, make(d), success)) form.reset();
  }
  if (!data)
    return (
      <section>
        <h2>Discovery and outcomes</h2>
        <p>{error || "Loading…"}</p>
      </section>
    );
  const tabs = [
    "sessions",
    "use cases",
    "assumptions",
    "approaches",
    "outcomes",
  ];
  return (
    <section className="discovery">
      <header>
        <div>
          <p className="eyebrow">Evidence-led shaping</p>
          <h2>Discovery and outcomes</h2>
          <p>
            Capture what was learned, compare approaches, and measure actual
            outcomes.
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={busy}>
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
      <nav aria-label="Discovery sections">
        {tabs.map((x) => (
          <button
            aria-pressed={tab === x}
            className={tab === x ? "selected" : ""}
            onClick={() => setTab(x)}
            key={x}
          >
            {label(x)}
          </button>
        ))}
      </nav>
      <section hidden={tab !== "sessions"}>
        <h3>Discovery sessions</h3>
        {data.sessions.map((x) => (
          <article key={x.id}>
            <h4>{String(x.purpose)}</h4>
            <p>
              {String(x.sessionDate)} ·{" "}
              {(x.participantUserIds as string[])
                .map(
                  (id) =>
                    members.find((m) => m.userId === id)?.displayName ??
                    "Participant",
                )
                .join(", ") || "No participants recorded"}
            </p>
            <p>{String(x.summary)}</p>
            <DiscoveryEditor
              kind="sessions"
              row={x}
              members={members}
              busy={busy}
              onSave={(payload) =>
                post(`${base}/sessions/${x.id}`, payload, "Session updated.")
              }
            />
          </article>
        ))}
        <details>
          <summary>Add discovery session</summary>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                d = new FormData(form);
              void (async () => {
                if (
                  await post(
                    base + "/sessions",
                    {
                      purpose: d.get("purpose"),
                      sessionDate: d.get("sessionDate"),
                      summary: d.get("summary"),
                      participantUserIds: d.getAll("participants"),
                    },
                    "Session added.",
                  )
                )
                  form.reset();
              })();
            }}
          >
            <label>
              Purpose
              <input name="purpose" required maxLength={5000} />
            </label>
            <label>
              Date
              <input name="sessionDate" type="date" required />
            </label>
            <fieldset>
              <legend>Participants</legend>
              {members.map((m) => (
                <label className="check" key={m.userId}>
                  <input type="checkbox" name="participants" value={m.userId} />
                  {m.displayName ?? m.email}
                </label>
              ))}
            </fieldset>
            <label>
              Summary
              <textarea name="summary" required maxLength={20000} />
            </label>
            <button disabled={busy}>Add session</button>
          </form>
        </details>
      </section>
      <section hidden={tab !== "use cases"}>
        <h3>Use cases</h3>
        {data.useCases.map((x) => (
          <article key={x.id}>
            <h4>{String(x.title)}</h4>
            <p>
              <strong>{String(x.actorDescription)}</strong> —{" "}
              {String(x.problemStatement)}
            </p>
            <p>Desired outcome: {String(x.desiredOutcome)}</p>
            <DiscoveryEditor
              kind="use-cases"
              row={x}
              members={members}
              busy={busy}
              onSave={(payload) =>
                post(`${base}/use-cases/${x.id}`, payload, "Use case updated.")
              }
            />
          </article>
        ))}
        <details>
          <summary>Add use case</summary>
          <form
            onSubmit={(e) =>
              void submit(
                e,
                base + "/use-cases",
                (d) => ({
                  title: d.title,
                  actor: d.actor,
                  problemStatement: d.problemStatement,
                  desiredOutcome: d.desiredOutcome,
                }),
                "Use case added.",
              )
            }
          >
            <label>
              Title
              <input name="title" required maxLength={300} />
            </label>
            <label>
              Person or role
              <input name="actor" required maxLength={2000} />
            </label>
            <label>
              Problem statement
              <textarea name="problemStatement" required />
            </label>
            <label>
              Desired outcome
              <textarea name="desiredOutcome" required />
            </label>
            <button disabled={busy}>Add use case</button>
          </form>
        </details>
      </section>
      <section hidden={tab !== "assumptions"}>
        <h3>Assumptions</h3>
        {data.assumptions.map((x) => (
          <article key={x.id}>
            <span>{label(String(x.status))}</span>
            <p>{String(x.statement)}</p>
            {x.rationale != null && <p>{String(x.rationale)}</p>}
            <DiscoveryEditor
              kind="assumptions"
              row={x}
              members={members}
              busy={busy}
              onSave={(payload) =>
                post(
                  `${base}/assumptions/${x.id}`,
                  payload,
                  "Assumption updated.",
                )
              }
            />
          </article>
        ))}
        <details>
          <summary>Add assumption</summary>
          <form
            onSubmit={(e) =>
              void submit(
                e,
                base + "/assumptions",
                (d) => ({
                  statement: d.statement,
                  status: d.status,
                  ...(d.rationale ? { rationale: d.rationale } : {}),
                }),
                "Assumption added.",
              )
            }
          >
            <label>
              Assumption
              <textarea name="statement" required />
            </label>
            <label>
              Status
              <select name="status">
                <option value="open">Open</option>
                <option value="validated">Validated</option>
                <option value="invalidated">Invalidated</option>
              </select>
            </label>
            <label>
              Rationale
              <textarea name="rationale" />
            </label>
            <button disabled={busy}>Add assumption</button>
          </form>
        </details>
      </section>
      <section hidden={tab !== "approaches"}>
        <h3>Approaches</h3>
        {data.approaches.map((x) => (
          <article key={x.id}>
            <h4>{String(x.title)}</h4>
            <span>{label(String(x.status))}</span>
            <p>{String(x.description)}</p>
            {x.effortValue != null && (
              <p>
                Estimated effort: {String(x.effortValue)} {String(x.effortUnit)}
              </p>
            )}
            <DiscoveryEditor
              kind="approaches"
              row={x}
              members={members}
              busy={busy}
              onSave={(payload) =>
                post(`${base}/approaches/${x.id}`, payload, "Approach updated.")
              }
            />
          </article>
        ))}
        <details>
          <summary>Add approach</summary>
          <form
            onSubmit={(e) =>
              void submit(
                e,
                base + "/approaches",
                (d) => ({
                  title: d.title,
                  description: d.description,
                  status: d.status,
                  ...(d.rationale ? { rationale: d.rationale } : {}),
                  ...(d.effortValue && d.effortUnit
                    ? {
                        effort: {
                          value: Number(d.effortValue),
                          unit: d.effortUnit,
                        },
                      }
                    : {}),
                }),
                "Approach added.",
              )
            }
          >
            <label>
              Title
              <input name="title" required />
            </label>
            <label>
              Status
              <select name="status">
                <option value="considered">Considered</option>
                <option value="selected">Selected</option>
                <option value="rejected">Rejected</option>
              </select>
            </label>
            <label>
              Description
              <textarea name="description" required />
            </label>
            <label>
              Effort value
              <input name="effortValue" type="number" step="any" />
            </label>
            <label>
              Effort unit
              <input name="effortUnit" placeholder="person-days" />
            </label>
            <label>
              Rationale
              <textarea name="rationale" />
            </label>
            <button disabled={busy}>Add approach</button>
          </form>
        </details>
      </section>
      <section hidden={tab !== "outcomes"}>
        <h3>Outcome measures</h3>
        <div className="scope-link">
          <h4>Accepted delivery scope</h4>
          {data.acceptedScope ? (
            <p>
              Version {data.acceptedScope.version} ·{" "}
              {data.acceptedScope.estimate}
            </p>
          ) : (
            <p>No accepted scope linked.</p>
          )}
          <form
            onSubmit={(e) => {
              const d = fd(e);
              void post(
                base + "/scope",
                {
                  expectedRevision: Number(data.acceptedScope?.revision ?? 0),
                  scopeId: d.scopeId,
                },
                "Accepted scope linked.",
              );
            }}
          >
            <label>
              Scope version
              <select name="scopeId" required>
                {scopes
                  .filter((x) => x.state === "accepted")
                  .map((x) => (
                    <option value={x.id} key={x.id}>
                      Version {x.version} · {x.estimate}
                    </option>
                  ))}
              </select>
            </label>
            <button disabled={busy}>Link accepted scope</button>
          </form>
        </div>
        {data.outcomes.map((x) => (
          <article key={x.id}>
            <h4>{x.name}</h4>
            <DiscoveryEditor
              kind="metrics"
              row={x}
              members={members}
              busy={busy}
              onSave={(payload) =>
                post(
                  `${base}/metrics/${x.id}`,
                  payload,
                  "Outcome measure updated.",
                )
              }
            />
            <p>
              Baseline {x.baseline ?? "Not recorded"} {x.unit} · Target{" "}
              {x.target ?? "Not recorded"} {x.unit}
            </p>
            {x.observations.map((o) => (
              <p key={o.id}>
                <strong>
                  {o.value} {x.unit}
                </strong>{" "}
                on {o.observedOn}
                {o.note ? ` — ${o.note}` : ""}
              </p>
            ))}
            <details>
              <summary>Add observation</summary>
              <form
                onSubmit={(e) =>
                  void submit(
                    e,
                    `${base}/metrics/${x.id}/observations`,
                    (d) => ({
                      observedOn: d.observedOn,
                      value: Number(d.value),
                      ...(d.note ? { note: d.note } : {}),
                      ...(d.evidenceId ? { evidenceId: d.evidenceId } : {}),
                    }),
                    "Observation added.",
                  )
                }
              >
                <label>
                  Observed date
                  <input type="date" name="observedOn" required />
                </label>
                <label>
                  Value ({x.unit})
                  <input type="number" step="any" name="value" required />
                </label>
                <label>
                  Note
                  <textarea name="note" />
                </label>
                <label>
                  Evidence
                  <select name="evidenceId">
                    <option value="">No evidence linked</option>
                    {evidence.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.title}
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy}>Add observation</button>
              </form>
            </details>
          </article>
        ))}
        <details>
          <summary>Add outcome measure</summary>
          <form
            onSubmit={(e) =>
              void submit(
                e,
                base + "/metrics",
                (d) => ({
                  name: d.name,
                  unit: d.unit,
                  ...(d.description ? { description: d.description } : {}),
                  ...(d.baseline !== ""
                    ? { baseline: Number(d.baseline) }
                    : {}),
                  ...(d.target !== "" ? { target: Number(d.target) } : {}),
                }),
                "Outcome measure added.",
              )
            }
          >
            <label>
              Name
              <input name="name" required />
            </label>
            <label>
              Unit
              <input name="unit" required placeholder="minutes" />
            </label>
            <label>
              Baseline
              <input type="number" step="any" name="baseline" />
            </label>
            <label>
              Target
              <input type="number" step="any" name="target" />
            </label>
            <label>
              Description
              <textarea name="description" />
            </label>
            <button disabled={busy}>Add outcome measure</button>
          </form>
        </details>
      </section>
    </section>
  );
}
